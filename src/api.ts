import { Router } from 'express';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { rgPath } from '@vscode/ripgrep';
import { existsSync, createReadStream, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync, renameSync, copyFileSync } from 'fs';
import nodePath from 'path';
import os from 'os';
import { configDir, notesDir } from './paths.js';
import type { DirectBridge, AgentState } from './direct-bridge.js';
import { AGENT_STATES } from './direct-bridge.js';
import { getPluginStatus, reinstallAgentPlugin } from './plugin-install.js';
import { recordHook, hookTrace, HOOK_TRACE_RETENTION_MS } from './hook-trace.js';
import { extractPrRefs } from './pr-refs.js';
import { parseQuery, matchFacts, snippetAround, transcriptLineText, transcriptScore, transcriptPattern, containsPattern } from './search.js';
import { CLEARED_SESSION_NAME, isRenameable } from './ai.js';
import type { LogBuffer } from './server.js';
import type { AIService } from './ai.js';

const execAsync = promisify(exec);

// ── Per-working-directory coalescing ────────────────────────────────────────
// Every pane polls these endpoints for itself, and the panes of a pen nearly
// always sit in the same worktree — so without this, four panes fork four
// identical `git status` runs every 5s, and make four identical GitHub API
// calls every 30s. Keying on the directory collapses each set to one.
//
// Two things are shared, not one: a short result cache, and the in-flight
// promise. The promise matters more — the duplicate requests arrive together,
// so they would all miss a result cache that nothing has filled yet.
interface Coalescer<T> {
  cache: Map<string, { at: number; value: T }>;
  inFlight: Map<string, Promise<T>>;
  ttlMs: number;
}

function makeCoalescer<T>(ttlMs: number): Coalescer<T> {
  return { cache: new Map(), inFlight: new Map(), ttlMs };
}

/** Drop entries whose TTL has passed. Keys are working directories, so the set
 *  is small and bounded by live sessions — but the server outlives them, and a
 *  map that only ever grows is a leak however slow. */
function prune<T>(c: Coalescer<T>): void {
  const now = Date.now();
  for (const [k, v] of c.cache) if (now - v.at >= c.ttlMs) c.cache.delete(k);
}

async function coalesced<T>(c: Coalescer<T>, key: string, work: () => Promise<T>): Promise<T> {
  if (c.cache.size > 64) prune(c);
  const hit = c.cache.get(key);
  if (hit && Date.now() - hit.at < c.ttlMs) return hit.value;
  const pending = c.inFlight.get(key);
  if (pending) return pending;
  const p = work()
    .then(value => { c.cache.set(key, { at: Date.now(), value }); return value; })
    .finally(() => { c.inFlight.delete(key); });
  c.inFlight.set(key, p);
  return p;
}

interface GitStatusValue {
  branch: string; detached: boolean; dirty: boolean; ahead: number; behind: number;
}
// Shorter than the client's 5s poll, so nothing is staler than it already was.
const gitStatus = makeCoalescer<GitStatusValue | null>(2000);
// `gh pr view` is a live GitHub API round-trip (~900ms) and burns rate limit.
// Just under the client's 30s poll, so each cycle still refreshes once.
const githubPr = makeCoalescer<unknown>(25_000);

function buildGitStatus(
  { branch, status, aheadBehind }: { branch: string; status: string; aheadBehind: string },
): GitStatusValue {
  const abParts = aheadBehind.split('\t');
  return {
    branch,
    detached: false,
    dirty: status.length > 0,
    ahead: parseInt(abParts[1] ?? '0', 10) || 0,
    behind: parseInt(abParts[0] ?? '0', 10) || 0,
  };
}

const PKG_VERSION: string = (() => {
  try { return JSON.parse(readFileSync(nodePath.join(__dirname, '..', 'package.json'), 'utf-8')).version; }
  catch { return 'unknown'; }
})();
const PREFERENCES_PATH = nodePath.join(configDir(), 'preferences.json');

function loadPreferences(): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(PREFERENCES_PATH, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] =>
      typeof entry[0] === 'string' && typeof entry[1] === 'string'));
  } catch { return {}; }
}

/** Rolling backups of preferences.json, newest first. */
const PREFERENCES_BACKUPS = 5;

/**
 * Rotate a copy of the current preferences aside before overwriting.
 *
 * The profile is shared by every client on this machine, and a single
 * misbehaving one can rewrite structural keys (workspace layouts, tab
 * assignments) in one PATCH. Because the save below is an atomic rename there
 * is otherwise no previous version left on disk to recover from. Keeping a few
 * generations makes that mistake undoable.
 */
function rotatePreferenceBackups(): void {
  try {
    if (!existsSync(PREFERENCES_PATH)) return;
    for (let i = PREFERENCES_BACKUPS - 1; i >= 1; i--) {
      const from = `${PREFERENCES_PATH}.${i}.bak`;
      if (existsSync(from)) renameSync(from, `${PREFERENCES_PATH}.${i + 1}.bak`);
    }
    copyFileSync(PREFERENCES_PATH, `${PREFERENCES_PATH}.1.bak`);
  } catch {
    // A failed backup must never block the write itself.
  }
}

/**
 * Preference keys written by versions of the UI that no longer exist.
 *
 * Listed explicitly rather than inferred from what the code currently reads:
 * "no reference found" is a grep result, not a fact, and being wrong here
 * deletes someone's settings. Each of these was traced to the commit that
 * stopped using it.
 *
 * sheepit:cmd-history is the reason this exists at all — 962 KB of a 980 KB
 * profile, rewritten in full every time anyone dragged a splitter, for a
 * feature removed in a19760b.
 */
const RETIRED_PREFERENCE_KEYS = [
  'cmd-history',        // a19760b
  'compose-mode',       // a19760b
  'session-last-file',  // a19760b
  'session-tabs',       // a19760b
  'workspace-order',    // 8f54b12
];
/** Same, for the older dash-separated naming. */
const RETIRED_PREFERENCE_KEYS_DASH = ['panes', 'theme'];

/** Key families scoped to one session, which should not outlive it. */
const PER_SESSION_PREFIXES = ['files-tabs:'];

const PREFIXES = ['sheepit:', 'vipershell:'];
const DASH_PREFIXES = ['sheepit-', 'vipershell-'];

/**
 * Drop preferences nothing can read any more.
 *
 * Two kinds: keys retired with the feature that wrote them, and per-session
 * keys whose session is long gone. The second kind is why the profile grew
 * without bound — a shared blob has no idea when a session ends, so every
 * pane that ever opened a file left an entry behind for the life of the
 * machine.
 *
 * Nothing is written unless something is actually removed, and the previous
 * file survives as preferences.json.1.bak.
 */
/** Drop every preference scoped to one session. Called when it closes. */
export function dropSessionPreferences(sessionId: string): void {
  const values = loadPreferences();
  let removed = 0;
  for (const key of Object.keys(values)) {
    for (const prefix of PER_SESSION_PREFIXES) {
      for (const base of PREFIXES) {
        if (key === base + prefix + sessionId) { delete values[key]; removed++; }
      }
    }
  }
  if (removed > 0) savePreferences(values);
}

export function pruneStalePreferences(liveSessionIds: Set<string>, log?: (m: string) => void): void {
  const values = loadPreferences();
  const before = Object.keys(values).length;
  if (before === 0) return;

  let freed = 0;
  for (const key of Object.keys(values)) {
    const retired =
      PREFIXES.some(p => RETIRED_PREFERENCE_KEYS.includes(key.slice(p.length)) && key.startsWith(p)) ||
      DASH_PREFIXES.some(p => RETIRED_PREFERENCE_KEYS_DASH.includes(key.slice(p.length)) && key.startsWith(p));

    let orphaned = false;
    for (const prefix of PER_SESSION_PREFIXES) {
      for (const base of PREFIXES) {
        const full = base + prefix;
        if (!key.startsWith(full)) continue;
        const sessionId = key.slice(full.length);
        if (sessionId && !liveSessionIds.has(sessionId)) orphaned = true;
      }
    }

    if (retired || orphaned) {
      freed += values[key]!.length;
      delete values[key];
    }
  }

  const removed = before - Object.keys(values).length;
  if (removed === 0) return;
  savePreferences(values);
  log?.(`Pruned ${removed} stale preference key(s), ${Math.round(freed / 1024)}KB (previous file kept as preferences.json.1.bak)`);
}

function savePreferences(values: Record<string, string>): void {
  mkdirSync(nodePath.dirname(PREFERENCES_PATH), { recursive: true });
  rotatePreferenceBackups();
  const tempPath = `${PREFERENCES_PATH}.tmp`;
  writeFileSync(tempPath, JSON.stringify(values, null, 2) + '\n', 'utf8');
  renameSync(tempPath, PREFERENCES_PATH);
}

/** Expand a leading `~` to the user's home directory. Shared with server.ts,
 *  which resolves the same user-supplied paths for WebSocket file watches. */
export function expandHomePath(p: string): string {
  if (p.startsWith('~/')) return nodePath.join(os.homedir(), p.slice(2));
  return p === '~' ? os.homedir() : p;
}

export function createApiRouter(bridge: DirectBridge, logBuffer: LogBuffer, ai: AIService): Router {
  const router = Router();

  router.get('/preferences', (_req, res) => {
    res.json({ values: loadPreferences() });
  });

  router.patch('/preferences', (req, res) => {
    const supplied = (req.body as { values?: unknown })?.values;
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) {
      return res.status(400).json({ error: 'Expected a preference values object' });
    }
    const current = loadPreferences();
    for (const [key, value] of Object.entries(supplied as Record<string, unknown>)) {
      // Every stored preference is namespaced `sheepit:` (or the older
      // `sheepit-` spelling), so anything else is not ours to persist.
      if (!key.startsWith('sheepit') || key.length > 200 || typeof value !== 'string' || value.length > 1_000_000) {
        return res.status(400).json({ error: 'Invalid preference value' });
      }
      if (value === '') delete current[key]; else current[key] = value;
    }
    try {
      savePreferences(current);
      res.json({ values: current });
    } catch (error) {
      res.status(500).json({ error: String(error) });
    }
  });

  /** Get a session's working directory path (replaces tmux display-message) */
  function getSessionCwd(sessionId: string): string {
    const sessions = bridge.getCachedSessions();
    return sessions.find(s => s.id === sessionId)?.path ?? os.homedir();
  }

  router.get('/version', (_req, res) => {
    res.json({ version: PKG_VERSION });
  });

  router.get('/sessions', async (_req, res) => {
    try {
      const sessions = await bridge.listSessions();
      res.json(sessions);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/sessions/git-roots', async (_req, res) => {
    try {
      const sessions = await bridge.listSessions();
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const entries = await Promise.all(sessions.map(async (s) => {
        try {
          const { stdout: pathOut } = await execAsync(
            `echo ${sh(s.path ?? '')}`
          );
          const cwd = pathOut.trim();
          if (!cwd) return [s.id, null];
          const { stdout } = await execAsync(`git -C ${sh(cwd)} rev-parse --git-common-dir 2>/dev/null`);
          const commonDir = stdout.trim();
          if (!commonDir) return [s.id, null];
          // --git-common-dir can be relative (e.g. ".git") for the main worktree
          const absCommonDir = commonDir.startsWith('/') ? commonDir : nodePath.join(cwd, commonDir);
          return [s.id, absCommonDir];
        } catch {
          return [s.id, null];
        }
      }));
      res.json(Object.fromEntries(entries));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // The pane's own child processes — nothing else. This used to also report
  // machine-wide CPU and memory via systeminformation, which cost ~85ms of the
  // ~230ms per call and was rendered nowhere: the pane bar carries identity,
  // not telemetry, and the only figures drawn are the per-process ones below,
  // which come from `ps`. Polled once per visible pane, that was about a third
  // of a core spent computing numbers no one saw.
  router.get('/stats', async (req, res) => {
    try {
      const sessionId = req.query.session_id as string | undefined;

      let processes: { pid: number; name: string; cpu_percent: number; mem_mb: number }[] = [];
      if (sessionId) {
        const panePid = await bridge.getSessionPid(sessionId);
        if (panePid) {
          try {
            const isLinux = os.platform() === 'linux';
            const cmd = isLinux
              ? `ps -o pid=,comm=,pcpu=,rss= --ppid ${panePid} 2>/dev/null`
              : `ps -o pid=,comm=,pcpu=,rss= -p $(pgrep -P ${panePid} 2>/dev/null | tr '\\n' ',') 2>/dev/null`;
            const { stdout } = await execAsync(cmd);
            processes = stdout.trim().split('\n').filter(Boolean).map(line => {
              const parts = line.trim().split(/\s+/);
              return {
                pid: parseInt(parts[0]!, 10),
                name: parts[1] ?? '',
                cpu_percent: parseFloat(parts[2] ?? '0'),
                mem_mb: parseInt(parts[3] ?? '0', 10) / 1024,
              };
            }).filter(p => !isNaN(p.pid));
          } catch { /* ignore */ }
        }
      }

      res.json({ processes });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.delete('/stats/process/:pid', async (req, res) => {
    try {
      const pid = parseInt(req.params.pid, 10);
      if (isNaN(pid) || pid <= 1) return res.status(400).json({ error: 'Invalid PID' });
      process.kill(pid, 'SIGTERM');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/diagnostics', (_req, res) => {
    try {
      const diag = bridge.diagnostics();
      const uptime = process.uptime();
      res.json({ ...diag, uptimeSeconds: uptime });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post('/pick-directory', async (_req, res) => {
    try {
      if (os.platform() !== 'darwin') return res.json({ path: null });
      const { stdout } = await execAsync(
        `osascript -e 'POSIX path of (choose folder with prompt "Choose a directory")' 2>/dev/null`
      );
      const path = stdout.trim().replace(/\/$/, '') || null;
      res.json({ path });
    } catch {
      res.json({ path: null });
    }
  });

  router.get('/browse', (req, res) => {
    try {
      const raw = (req.query.path as string | undefined) ?? '~';
      const dir = expandHome(raw);
      const resolved = nodePath.resolve(dir);

      const entries = readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: nodePath.join(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({ path: resolved, parent: nodePath.dirname(resolved), dirs });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.post('/sessions', async (req, res) => {
    try {
      const { path } = req.body as { path?: string };
      const sessionId = await bridge.createSession(path ?? undefined);
      res.json({ ok: true, session_id: sessionId });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  router.post('/sessions/:id/rename', async (req, res) => {
    try {
      const { name } = req.body as { name?: string };
      if (!name?.trim()) return res.status(400).json({ error: 'name required' });
      await bridge.renameSession(req.params.id, name.trim());
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /** A coding agent reporting its own state, driven by that agent's hooks.
   *
   *  Authoritative, and the reason it exists: inferring "finished" from output
   *  silence is late by design and fails outright for network-bound agents
   *  that print nothing and burn no CPU while they think.
   *
   *  Kept agent-agnostic on purpose — `source` distinguishes the reporter so
   *  Codex can post the same shapes through its own notify mechanism.
   */
  router.post('/sessions/:id/agent-state', (req, res) => {
    try {
      const { state, source, event, prompt, response, refs, transcriptPath, agentSessionId } = req.body as
        { state?: string; source?: string; event?: string; prompt?: string; response?: string; refs?: unknown;
          transcriptPath?: string; agentSessionId?: string };
      // Traced from here, before anything can reject it: a report that never
      // lands is precisely the case the trace exists for, and by the time the
      // bridge would log it that outcome is already gone.
      const trace = {
        endpoint: 'agent-state',
        sessionId: req.params.id,
        source: typeof source === 'string' ? source.slice(0, 32) : null,
        event: typeof event === 'string' ? event.slice(0, 32) : null,
        state: typeof state === 'string' ? state.slice(0, 32) : null,
        // Presence only — the text itself is a user's prompt and does not
        // belong in a panel anyone can leave open on a shared screen.
        turn: [
          typeof prompt === 'string' && prompt.trim() ? 'prompt' : null,
          typeof response === 'string' && response.trim() ? 'response' : null,
        ].filter(Boolean).join('+') || null,
        // Filled in below, once the references have been read out of the
        // report. Unlike the turn text these are safe to show: a PR number is
        // already on the pane bar.
        refs: null as string | null,
      };
      if (!state || !AGENT_STATES.includes(state as AgentState)) {
        recordHook({ ...trace, outcome: 'rejected', detail: `not a known state` });
        return res.status(400).json({ error: `state must be one of ${AGENT_STATES.join(', ')}` });
      }
      // A hook firing just after its pane closed is ordinary, not an error
      // worth logging loudly — but the caller should still know it missed.
      const ok = bridge.setAgentState(
        req.params.id,
        state as AgentState,
        `${source?.slice(0, 32) || 'unknown'}${event ? `/${String(event).slice(0, 32)}` : ''}`,
        {
          // Bounded here too: the endpoint is reachable by anything local, and
          // this text ends up in an LLM prompt.
          prompt: typeof prompt === 'string' ? prompt.slice(0, 4000) : undefined,
          response: typeof response === 'string' ? response.slice(0, 4000) : undefined,
        },
      );

      // PR/issue references, from what the agent reported and nothing else.
      //
      // Two sources, both hooks: `refs` is what post.sh grepped out of the
      // tool call and its result (a URL, or a `gh pr view 42` command line),
      // and the turn text is what the user and the model actually wrote. The
      // bare `#42` form is read from the turn only — in a tool result it is
      // far more often a colour, a comment or a line number than a PR.
      if (ok) {
        // Joined, not parsed one at a time: post.sh sends the fragments its
        // grep matched, so `--repo owner/name` arrives as its own string and
        // only means something next to the command it qualifies.
        const fromTools = extractPrRefs(
          (Array.isArray(refs) ? refs : [])
            .filter((r): r is string => typeof r === 'string')
            .slice(0, 20)
            .map(r => r.slice(0, 400))
            .join(' '),
        );
        const fromTurn = [prompt, response]
          .filter((t): t is string => typeof t === 'string' && t.length > 0)
          .flatMap(t => extractPrRefs(t.slice(0, 4000), { bare: true }));
        const found = [...fromTurn, ...fromTools];
        if (found.length) {
          trace.refs = found.slice(0, 3).map(r => `${r.kind}#${r.num}`).join(' ');
          bridge.addPrRefs(req.params.id, found);
        }

        // Where this agent's transcript lives, for search. Bounded, and the
        // path is allow-listed inside setAgentSession before anything opens
        // it — this endpoint is reachable by anything local.
        if (typeof transcriptPath === 'string' || typeof agentSessionId === 'string') {
          bridge.setAgentSession(req.params.id, {
            transcriptPath: typeof transcriptPath === 'string' ? transcriptPath.slice(0, 1024) : undefined,
            agentSessionId: typeof agentSessionId === 'string' ? agentSessionId.slice(0, 128) : undefined,
            source: typeof source === 'string' ? source.slice(0, 32) : undefined,
          });
        }
      }

      recordHook({ ...trace, outcome: ok ? 'ok' : 'unknown-session' });
      if (!ok) return res.status(404).json({ error: 'unknown session' });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /**
   * Every hook that reached us in the last hour, and what became of it.
   *
   * The one place to look when the answer to "is the plugin working" is not
   * obvious from the panes. Read it for what is *absent* as much as for what
   * is there: the agents do not name the same moments the same way, so an
   * event one of them never posts is the usual finding.
   */
  router.get('/hook-trace', (_req, res) => {
    res.json({ retentionMs: HOOK_TRACE_RETENTION_MS, entries: hookTrace() });
  });

  /** Which session owns this process? Used by agent hooks that have no
   *  SHEEPIT_SESSION_ID — panes created before it existed, or an agent
   *  started outside the shell we seeded. The caller sends its process
   *  ancestry, nearest first. */
  /** What the agent-state plugin is, and what each agent currently has. */
  router.get('/plugin', async (_req, res) => {
    try {
      res.json(await getPluginStatus());
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /**
   * Reinstall the plugin into every agent found, ignoring version equality.
   *
   * Startup installs only when the version differs, which is right for a
   * release and wrong for a checkout: editing `plugin/` does not move the
   * version, so the code on disk and the code the agent loads drift apart.
   * This is how you push the current one out without inventing a version.
   *
   * Slow by nature — it shells out to `claude` and `codex`, each up to a
   * minute — so it gets a generous window and the client shows a spinner.
   */
  router.post('/plugin/reinstall', async (_req, res) => {
    try {
      // installIntoClaude/installIntoCodex already log what they did, and the
      // response carries the verified after-state, so nothing to add here.
      res.json(await reinstallAgentPlugin());
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /**
   * `/clear` wiped this agent's context, so the session's name is now a lie.
   *
   * Fired by a SessionStart hook matched on `clear`, which is why nothing here
   * parses a payload: the matcher already decided, so the hook is a two-line
   * shell POST rather than a node process.
   */
  router.post('/sessions/:id/cleared', async (req, res) => {
    try {
      const { id } = req.params;
      const session = (await bridge.listSessions()).find(s => s.id === id);
      const trace = { endpoint: 'cleared', sessionId: id, source: null, event: 'SessionStart', state: null, turn: null, refs: null };
      if (!session) {
        recordHook({ ...trace, outcome: 'unknown-session' });
        return res.status(404).json({ error: 'no such session' });
      }
      recordHook({ ...trace, outcome: 'ok' });

      bridge.clearAgentTurn(id);
      bridge.markSessionFresh(id);

      // Never rename over a name a human chose — `/clear` wipes the agent's
      // context, not the user's intent for what this pane is called.
      const renamed = isRenameable(session.name, session.path, ai.assignedName(id));
      if (renamed) {
        ai.noteSessionCleared(id);
        await bridge.renameSession(id, CLEARED_SESSION_NAME);
      }
      res.json({ ok: true, renamed, name: renamed ? CLEARED_SESSION_NAME : session.name });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /**
   * A genuinely new agent session started in this pane.
   *
   * Same emptiness as after a `/clear`, but the name is left alone: a new
   * session's pane is still called after its directory, which is accurate and
   * more useful than announcing that it is empty. All this buys is the `fresh`
   * flag — which stops the namer christening the session after whatever
   * another plugin injected at startup, and lets the card show that the pane
   * is waiting for you rather than done with something.
   */
  router.post('/sessions/:id/fresh', (req, res) => {
    try {
      const { id } = req.params;
      const trace = { endpoint: 'fresh', sessionId: id, source: null, event: 'SessionStart', state: null, turn: null, refs: null };
      if (!bridge.hasSession(id)) {
        recordHook({ ...trace, outcome: 'unknown-session' });
        return res.status(404).json({ error: 'no such session' });
      }
      recordHook({ ...trace, outcome: 'ok' });
      bridge.clearAgentTurn(id);
      bridge.markSessionFresh(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post('/sessions/resolve', (req, res) => {
    try {
      const { pids } = req.body as { pids?: unknown };
      if (!Array.isArray(pids) || pids.some(p => !Number.isInteger(p))) {
        return res.status(400).json({ error: 'pids must be an array of integers' });
      }
      const walked = pids.slice(0, 32) as number[];
      const sessionId = bridge.resolveSessionByPids(walked);
      // A failed resolve is the quietest failure in the whole chain: both
      // reporters exit 0 on it, so the hook that follows simply never happens.
      // Record the ancestry that missed — it is the only way to tell this
      // apart from a hook that was never wired.
      if (!sessionId) {
        recordHook({
          endpoint: 'resolve', sessionId: null, source: null, event: null, state: null, turn: null,
          refs: null, outcome: 'unresolved', detail: `pids ${walked.slice(0, 8).join(',')}`,
        });
        return res.status(404).json({ error: 'no session owns those pids' });
      }
      recordHook({
        endpoint: 'resolve', sessionId, source: null, event: null, state: null, turn: null, refs: null, outcome: 'ok',
      });
      res.json({ sessionId });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/git/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json(null);

      const value = await coalesced(gitStatus, cwd, async () => {
        const run = (cmd: string) => execAsync(cmd, { cwd }).then(r => r.stdout.trim()).catch(() => '');

        const [branch, status, aheadBehind] = await Promise.all([
          run('git rev-parse --abbrev-ref HEAD'),
          run('git status --short'),
          run('git rev-list --left-right --count @{u}...HEAD 2>/dev/null'),
        ]);

        if (!branch || branch === 'HEAD') {
          // Detached HEAD — try short hash
          const hash = await run('git rev-parse --short HEAD');
          if (!hash) return null;
          return { branch: hash, detached: true, dirty: status.length > 0, ahead: 0, behind: 0 };
        }
        return buildGitStatus({ branch, status, aheadBehind });
      });
      res.json(value);
    } catch {
      res.json(null);
    }
  });



  router.get('/git/:sessionId/github', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json(null);

      const value = await coalesced(githubPr, cwd, async () => {
      const run = (cmd: string) => execAsync(cmd, { cwd }).then(r => r.stdout.trim()).catch(() => '');

      const remoteUrl = await run('git remote get-url origin 2>/dev/null');
      if (!remoteUrl) return null;

      const m = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!m) return null;
      const owner = m[1]!;
      const repo  = m[2]!.replace(/\.git$/, '');
      const repoUrl = `https://github.com/${owner}/${repo}`;

      const branch = await run('git rev-parse --abbrev-ref HEAD');

      let prUrl: string | null = null;
      let prNum: number | null = null;
      let prState: string | null = null;  // OPEN, MERGED, CLOSED
      let prChecks: string | null = null; // PASS, FAIL, PENDING, null
      let prReviewDecision: string | null = null; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, null
      try {
        const { stdout } = await execAsync(
          `gh pr view --json url,number,state,statusCheckRollup,reviewDecision 2>/dev/null`,
          { cwd }
        );
        const pr = JSON.parse(stdout.trim());
        if (pr.url) prUrl = pr.url;
        if (pr.number) prNum = pr.number;
        if (pr.state) prState = pr.state;
        if (pr.reviewDecision) prReviewDecision = pr.reviewDecision;
        // Derive checks status from statusCheckRollup
        if (Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length > 0) {
          const statuses = pr.statusCheckRollup.map((c: any) => (c.conclusion ?? c.status ?? '').toUpperCase());
          if (statuses.some((s: string) => s === 'FAILURE' || s === 'ERROR' || s === 'CANCELLED'))
            prChecks = 'FAIL';
          else if (statuses.some((s: string) => s === 'PENDING' || s === 'QUEUED' || s === 'IN_PROGRESS' || s === 'WAITING'))
            prChecks = 'PENDING';
          else if (statuses.every((s: string) => s === 'SUCCESS' || s === 'NEUTRAL' || s === 'SKIPPED'))
            prChecks = 'PASS';
        }
      } catch {
        // gh not available — try GitHub API as fallback
        try {
          const { stdout } = await execAsync(
            `curl -sf -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open&per_page=1" 2>/dev/null`,
            { cwd, timeout: 5000 }
          );
          const prs = JSON.parse(stdout.trim());
          if (Array.isArray(prs) && prs.length > 0) {
            prUrl = prs[0].html_url;
            prNum = prs[0].number;
            prState = 'OPEN';
          }
        } catch { /* no gh, no API access */ }
      }

      return { repoUrl, prUrl, prNum, prState, prChecks, prReviewDecision, branch, owner, repo };
      });
      res.json(value);
    } catch {
      res.json(null);
    }
  });

  router.get('/git/:sessionId/worktrees', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json([]);
      const { stdout: rootOut } = await execAsync(`git -C ${sh(cwd)} rev-parse --show-toplevel 2>/dev/null`);
      const gitRoot = rootOut.trim();
      if (!gitRoot) return res.json([]);
      const { stdout } = await execAsync(`git -C ${sh(gitRoot)} worktree list --porcelain 2>/dev/null`);
      // Parse porcelain output: blocks separated by blank lines
      const worktrees = stdout.trim().split(/\n\n+/).filter(Boolean).map(block => {
        const lines = block.split('\n');
        const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length) ?? '';
        const branch = lines.find(l => l.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? null;
        const bare = lines.some(l => l === 'bare');
        const detached = lines.some(l => l === 'detached');
        return { path, branch, bare, detached };
      });
      res.json(worktrees);
    } catch {
      res.json([]);
    }
  });

  router.post('/git/:sessionId/worktree', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.status(400).json({ error: 'No session path' });
      const { stdout: rootOut } = await execAsync(`git -C ${sh(cwd)} rev-parse --show-toplevel 2>/dev/null`);
      const gitRoot = rootOut.trim();
      if (!gitRoot) return res.status(400).json({ error: 'Not a git repository' });
      const parentDir = nodePath.dirname(gitRoot);
      const repoName = nodePath.basename(gitRoot);

      // Explicit name → worktree dir `<repo>-<name>` on a new branch `<name>`.
      const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const name = rawName.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^[-/]+|[-/]+$/g, '');
      if (name) {
        const worktreePath = nodePath.join(parentDir, `${repoName}-${name.replace(/\//g, '-')}`);
        if (existsSync(worktreePath)) {
          return res.status(400).json({ error: `Path already exists: ${nodePath.basename(worktreePath)}` });
        }
        try {
          // New branch named after the worktree…
          await execAsync(`git -C ${sh(gitRoot)} worktree add -b ${sh(name)} ${sh(worktreePath)}`);
        } catch {
          // …or attach an existing branch of that name.
          await execAsync(`git -C ${sh(gitRoot)} worktree add ${sh(worktreePath)} ${sh(name)}`);
        }
        return res.json({ path: worktreePath });
      }

      // No name → auto-numbered fallback.
      let worktreePath = '';
      for (let i = 1; i <= 20; i++) {
        const candidate = nodePath.join(parentDir, `${repoName}-wt${i}`);
        if (!existsSync(candidate)) { worktreePath = candidate; break; }
      }
      if (!worktreePath) return res.status(400).json({ error: 'Could not find available worktree path' });
      await execAsync(`git -C ${sh(gitRoot)} worktree add ${sh(worktreePath)}`);
      res.json({ path: worktreePath });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/git/:sessionId/root', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json({ root: null });
      const { stdout } = await execAsync(`git -C ${sh(cwd)} rev-parse --show-toplevel 2>/dev/null`);
      res.json({ root: stdout.trim() || null });
    } catch {
      res.json({ root: null });
    }
  });

  router.get('/git/:sessionId/diff', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { mode, base, commit } = req.query as Record<string, string>;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.type('text/plain').send('');

      const run = (cmd: string) => execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 })
        .then(r => r.stdout)
        .catch((e: any) => e.stdout ?? '');

      // Single-file diff (used by the file viewer's content/diff toggle): the
      // working-tree changes for one path, falling back to a vs-empty diff for
      // a new/untracked file so it still shows as all-additions.
      const { path: filePath } = req.query as Record<string, string>;
      if (filePath) {
        let d = await run(`git diff HEAD -- ${sh(filePath)}`);
        if (!d) {
          const mimeEnc = await run(`file --mime-encoding ${sh(filePath)}`);
          if (!mimeEnc.includes('binary')) d = await run(`git diff --no-index /dev/null ${sh(filePath)}`);
        }
        return res.type('text/plain; charset=utf-8').send(d);
      }

      let diff = '';
      if (mode === 'commit' && commit) {
        diff = await run(`git diff ${sh(commit)}^..${sh(commit)}`);
      } else if (mode === 'branch') {
        const baseBranch = base || 'origin/main';
        // Try the requested base; if it doesn't exist, fall back to HEAD
        diff = await run(`git diff ${sh(baseBranch)}`);
        if (!diff) {
          // Check if base ref exists — if not, show working tree diff instead
          const refExists = await run(`git rev-parse --verify ${sh(baseBranch)} 2>/dev/null`);
          if (!refExists) diff = await run('git diff HEAD');
        }
      } else {
        // Working tree: show tracked changes (staged + unstaged)
        diff = await run('git diff HEAD');
      }

      // For non-commit modes, append untracked files as synthetic diffs.
      //
      // Hot path for the working-tree view: this used to spawn TWO processes
      // per untracked file (`file --mime-encoding` + `git diff --no-index`)
      // sequentially, which cost ~1s+ on repos with dozens of untracked files.
      // Now we let `git diff --no-index` flag binaries itself ("Binary files
      // … differ") — so one spawn per file — and run them with bounded
      // concurrency instead of serially.
      if (mode !== 'commit') {
        const untrackedOut = await run("git ls-files --others --exclude-standard");
        const untrackedFiles = untrackedOut.trim().split('\n').filter(Boolean);
        const CONCURRENCY = 16;
        for (let i = 0; i < untrackedFiles.length; i += CONCURRENCY) {
          const batch = untrackedFiles.slice(i, i + CONCURRENCY);
          const parts = await Promise.all(
            batch.map((file: string) => run(`git diff --no-index /dev/null ${sh(file)}`)),
          );
          for (const content of parts) {
            // git prints "Binary files …" instead of a textual diff for binaries.
            if (content && !/^Binary files /m.test(content)) diff += '\n' + content;
          }
        }
      }

      res.type('text/plain; charset=utf-8').send(diff);
    } catch {
      res.type('text/plain; charset=utf-8').send('');
    }
  });

  router.get('/git/:sessionId/log', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { base, limit = '60' } = req.query as Record<string, string>;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json([]);

      const { full } = req.query as Record<string, string>;
      const baseRef = full ? '' : base ? `^${sh(base)}` : `^${sh('origin/main')}`;
      const { stdout } = await execAsync(
        `git -C ${sh(cwd)} log HEAD ${baseRef} --format="%H\x1f%h\x1f%s\x1f%an\x1f%ar\x1f%ad" --date=short -${limit} 2>/dev/null`
      );
      const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\x1f');
        return { hash: parts[0]!, short: parts[1]!, subject: parts[2]!, author: parts[3]!, relDate: parts[4]!, date: parts[5]! };
      });
      res.json(commits);
    } catch {
      res.json([]);
    }
  });

  router.get('/sessions/:id/scrollback', (req, res) => {
    const sessionId = req.params.id;
    const scrollbackPath = bridge.getScrollbackPath(sessionId);
    if (!existsSync(scrollbackPath)) {
      return res.status(404).type('text/plain').send('No scrollback log found for this session.');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${sessionId}.log"`);
    createReadStream(scrollbackPath).pipe(res);
  });

  router.get('/sessions/:id/history', async (req, res) => {
    const sessionId = req.params.id;
    try {
      const text = await bridge.snapshot(sessionId);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(text);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/git/:sessionId/status', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json({ files: {} });

      const run = (cmd: string) => execAsync(cmd, { cwd }).then(r => r.stdout.trim()).catch(() => '');
      const root = await run('git rev-parse --show-toplevel 2>/dev/null');
      if (!root) return res.json({ files: {} });

      const statusOut = await run('git status --short --porcelain 2>/dev/null');
      const files: Record<string, string> = {};
      for (const line of statusOut.split('\n')) {
        if (!line) continue;
        // Format: XY filename  or  XY old -> new (for renames)
        const x = line[0]; // index status
        const y = line[1]; // working tree status
        let filePath = line.slice(3);
        // Handle renames: "R  old -> new"
        const arrowIdx = filePath.indexOf(' -> ');
        if (arrowIdx !== -1) filePath = filePath.slice(arrowIdx + 4);
        filePath = filePath.replace(/^"(.*)"$/, '$1'); // remove quotes

        // Determine status: untracked, added, modified, deleted, renamed
        let status = 'modified';
        if (x === '?' && y === '?') status = 'untracked';
        else if (x === 'A') status = 'added';
        else if (x === 'D' || y === 'D') status = 'deleted';
        else if (x === 'R') status = 'renamed';

        // Store as absolute path
        files[root + '/' + filePath] = status;
      }
      res.json({ files, root });
    } catch {
      res.json({ files: {} });
    }
  });

  // ── Notes ───────────────────────────────────────────────────────────────────

  const NOTES_DIR = notesDir();
  // Migrate old single-file notes to sheets dir
  const OLD_NOTES_PATH = nodePath.join(configDir(), 'notes.md');
  try {
    if (existsSync(OLD_NOTES_PATH)) {
      mkdirSync(NOTES_DIR, { recursive: true });
      const oldContent = readFileSync(OLD_NOTES_PATH, 'utf-8');
      if (oldContent.trim()) {
        const dest = nodePath.join(NOTES_DIR, 'notes.md');
        if (!existsSync(dest)) writeFileSync(dest, oldContent, 'utf-8');
      }
      unlinkSync(OLD_NOTES_PATH);
    }
  } catch { /* ignore migration errors */ }

  // Backwards compat: old single-file endpoint redirects to default sheet
  router.get('/notes', (_req, res) => {
    try {
      const p = nodePath.join(NOTES_DIR, 'notes.md');
      if (!existsSync(p)) return res.json({ content: '' });
      res.json({ content: readFileSync(p, 'utf-8') });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.put('/notes', (req, res) => {
    try {
      const { content } = req.body as { content?: string };
      if (content === undefined) return res.status(400).json({ error: 'Missing content' });
      mkdirSync(NOTES_DIR, { recursive: true });
      writeFileSync(nodePath.join(NOTES_DIR, 'notes.md'), content, 'utf-8');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // List all note sheets
  router.get('/notes/sheets', (_req, res) => {
    try {
      mkdirSync(NOTES_DIR, { recursive: true });
      const files = readdirSync(NOTES_DIR).filter(f => f.endsWith('.md')).sort();
      if (files.length === 0) {
        // Create a default sheet
        writeFileSync(nodePath.join(NOTES_DIR, 'notes.md'), '', 'utf-8');
        files.push('notes.md');
      }
      res.json({ sheets: files.map(f => f.replace(/\.md$/, '')), dir: NOTES_DIR.replace(os.homedir(), '~') });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Read a sheet
  router.get('/notes/sheets/:name', (req, res) => {
    try {
      const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
      const p = nodePath.join(NOTES_DIR, `${name}.md`);
      if (!existsSync(p)) return res.json({ content: '' });
      res.json({ content: readFileSync(p, 'utf-8') });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Write a sheet
  router.put('/notes/sheets/:name', (req, res) => {
    try {
      const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
      const { content } = req.body as { content?: string };
      if (content === undefined) return res.status(400).json({ error: 'Missing content' });
      mkdirSync(NOTES_DIR, { recursive: true });
      writeFileSync(nodePath.join(NOTES_DIR, `${name}.md`), content, 'utf-8');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Delete a sheet
  router.delete('/notes/sheets/:name', (req, res) => {
    try {
      const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
      const p = nodePath.join(NOTES_DIR, `${name}.md`);
      if (existsSync(p)) unlinkSync(p);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Filesystem browse ────────────────────────────────────────────────────────

  const expandHome = expandHomePath;

  // Live foreground-process working directory — used to resolve relative paths
  // an app (e.g. Claude Code) prints, against ITS cwd rather than the shell's
  // tracked path. Falls back to the session's tracked cwd.
  router.get('/fs/:sessionId/cwd', async (req, res) => {
    const { sessionId } = req.params;
    const fallback = getSessionCwd(sessionId);
    try {
      const cwd = await bridge.getForegroundCwd(sessionId);
      res.json({ cwd: cwd || fallback });
    } catch {
      res.json({ cwd: fallback });
    }
  });

  router.get('/fs/:sessionId/browse', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const subpath = expandHome((req.query.path as string | undefined) ?? '');
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.status(404).json({ error: 'Session not found' });

      const dir = subpath ? nodePath.resolve(cwd, subpath) : cwd;
      const entries = readdirSync(dir, { withFileTypes: true });
      const result = entries
        .map(e => {
          const fullPath = nodePath.join(dir, e.name);
          let size = 0;
          try { if (!e.isDirectory()) size = statSync(fullPath).size; } catch { /* ignore */ }
          return { name: e.name, isDir: e.isDirectory(), path: fullPath, size };
        })
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.json({ cwd, dir, entries: result });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /**
   * Search the open panes: which one is working on this?
   *
   * Two halves. The facts — name, cwd, branch, the PR references the hooks
   * reported, the last few exchanges — are already in memory and are matched
   * without touching the disk. The other half is each agent's own transcript,
   * searched with the same bundled ripgrep the file search uses.
   *
   * What is NOT searched is the terminal. Scrollback is bytes to render, not a
   * source of facts (see "Nothing reads the terminal as text" in CLAUDE.md);
   * this reads what the agents recorded about the conversation.
   *
   * One row per pane, with the single best reason it matched — the palette
   * asks "which pane", so a pane that matches four ways is one answer.
   */
  router.get('/search', async (req, res) => {
    try {
      const query = parseQuery((req.query.q as string | undefined) ?? '');
      if (query.terms.length === 0) return res.json({ results: [] });

      // The cached list, not listSessions(): that one does a machine-wide `ps`
      // whenever its TTL has lapsed, and a keystroke is the last place to pay
      // for that — a blocked event loop is a keystroke that has not reached
      // the PTY yet. The cache is refreshed every 2s by discoverSessions, and
      // two-second-old names and branches are fine for a search. It is empty
      // only in the first seconds after a server start, where the real list is
      // worth the one call.
      const sessions = bridge.getCachedSessions().length
        ? bridge.getCachedSessions()
        : await bridge.listSessions();
      const hits = new Map<string, { sessionId: string; source: string; snippet: string; score: number; matchCount: number; at?: number; highlight: string[] }>();

      // 1. The facts. Free, and the answer for most queries.
      for (const s of sessions) {
        const m = matchFacts(
          { id: s.id, name: s.name, path: s.path, gitBranch: s.gitBranch, prRefs: s.prRefs },
          bridge.getAgentTurns(s.id).map(t => ({ prompt: t.prompt, response: t.response, at: t.at })),
          query,
        );
        if (m) hits.set(s.id, { sessionId: s.id, source: m.source, snippet: m.snippet, score: m.score, matchCount: 1, at: m.at, highlight: query.terms });
      }

      // 2. The transcripts. One ripgrep over every pane's file rather than one
      //    per pane: 24 of them, ~100 MB, is 30-90ms as a single run.
      const files = new Map<string, string>();   // path -> sessionId
      for (const s of sessions) {
        const path = bridge.resolveAgentTranscript(s.id);
        // Two panes cannot share a transcript, but a stale record could point
        // two at one file; first writer wins and the other keeps its facts.
        if (path && !files.has(path)) files.set(path, s.id);
      }

      if (files.size > 0) {
        const pattern = transcriptPattern(query);
        // Per-file cap, not per-run: most matched lines are tool results and
        // attachments that transcriptLineText drops, so a small cap would let
        // discarded lines hide the real one further down the file.
        const args = [
          '--json', '--smart-case', '-F', '--max-filesize', '64M', '-m', '25',
          '--', pattern, ...files.keys(),
        ];
        const perFile = new Map<string, { role: 'user' | 'assistant'; text: string; count: number; at?: number }>();
        await new Promise<void>((resolve) => {
          const child = spawn(rgPath, args);
          let buf = '';
          let done = false;
          const finish = () => { if (!done) { done = true; try { child.kill(); } catch {} resolve(); } };
          // Short on purpose: this runs on every keystroke, and a search that
          // arrives after you have typed the next letter is not an answer.
          const timer = setTimeout(finish, 2000);
          child.stdout.on('data', (chunk: Buffer) => {
            buf += chunk.toString('utf8');
            let nl: number;
            while ((nl = buf.indexOf('\n')) !== -1) {
              const line = buf.slice(0, nl);
              buf = buf.slice(nl + 1);
              if (!line) continue;
              try {
                const ev = JSON.parse(line);
                if (ev.type !== 'match') continue;
                const file = ev.data.path?.text ?? '';
                const said = transcriptLineText(ev.data.lines?.text ?? '');
                if (!said) continue;
                // ripgrep searched the raw JSONL row, so the hit may be in a
                // uuid or a tool result rather than in what anyone said. A
                // snippet that does not contain the term reads as a wrong
                // answer, so such a line is not a match at all.
                if (!containsPattern(said.text, pattern)) continue;
                const prev = perFile.get(file);
                // Keep the first thing the *user* said over anything the agent
                // said, however many times the agent said it.
                if (!prev) perFile.set(file, { ...said, count: 1 });
                else {
                  prev.count++;
                  if (prev.role === 'assistant' && said.role === 'user') {
                    prev.role = 'user'; prev.text = said.text; prev.at = said.at;
                  }
                }
              } catch { /* not a line we can read */ }
            }
          });
          child.on('error', finish);
          child.on('close', () => { clearTimeout(timer); finish(); });
        });

        for (const [file, said] of perFile) {
          const sessionId = files.get(file);
          if (!sessionId) continue;
          const score = transcriptScore(said.role, said.count);
          // Centred on what ripgrep actually matched, not on the query's
          // words: for `pr 3993` that is the number, and highlighting "pr"
          // would send the window to the wrong place.
          const snippet = snippetAround(said.text, [pattern.toLowerCase()]);
          const prev = hits.get(sessionId);
          // A transcript hit never outranks a fact, but it does add its count
          // to a pane that matched on both.
          // What to light up is what was actually matched, and for `pr 3993`
          // that is the number alone: highlighting "pr" as a substring paints
          // half of every "prompt" in the snippet.
          if (!prev) hits.set(sessionId, { sessionId, source: 'transcript', snippet, score, matchCount: said.count, at: said.at, highlight: [pattern] });
          else hits.set(sessionId, { ...prev, matchCount: prev.matchCount + said.count });
        }
      }

      const results = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 40);
      res.json({ results });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/fs/:sessionId/search', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const query = (req.query.q as string | undefined ?? '').trim();
      const glob  = (req.query.glob as string | undefined ?? '').trim();
      const dir   = (req.query.dir as string | undefined ?? '').trim();
      if (!query) return res.json({ results: [] });

      const sessionCwd = getSessionCwd(sessionId);
      if (!sessionCwd) return res.status(404).json({ error: 'Session not found' });

      // Scope the ripgrep run to `dir` when provided so users can search from
      // a subfolder. We resolve and require the dir exists (`statSync.isDirectory`)
      // — but we DON'T require it to live under sessionCwd: the file browser
      // can navigate anywhere the user has read access to, and search should
      // follow. Falling back to sessionCwd otherwise.
      let cwd = sessionCwd;
      if (dir) {
        try {
          const resolved = nodePath.resolve(dir);
          if (statSync(resolved).isDirectory()) cwd = resolved;
        } catch { /* fall through to sessionCwd */ }
      }

      const MAX_RESULTS = 500;
      const args = [
        '--json',
        '--smart-case',
        '--max-filesize', '1M',
        '--max-count', String(MAX_RESULTS),
        ...(glob ? ['-g', glob] : []),
        '--', query, '.',
      ];

      const results: { file: string; line: number; text: string }[] = [];
      await new Promise<void>((resolve) => {
        const child = spawn(rgPath, args, { cwd });
        let buf = '';
        let done = false;
        const finish = () => { if (!done) { done = true; try { child.kill(); } catch {} resolve(); } };
        const timer = setTimeout(finish, 10_000);

        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              if (ev.type !== 'match') continue;
              const file = ev.data.path?.text ?? '';
              const lineNum = ev.data.line_number ?? 0;
              const text = ev.data.lines?.text?.replace(/\r?\n$/, '') ?? '';
              results.push({ file: file.replace(/^\.\//, ''), line: lineNum, text });
              if (results.length >= MAX_RESULTS) { finish(); return; }
            } catch { /* skip non-JSON line */ }
          }
        });
        child.on('error', finish);
        child.on('close', () => { clearTimeout(timer); finish(); });
      });

      res.json({ results, cwd });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/fs/:sessionId/find', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const query = (req.query.q as string | undefined ?? '').trim();
      const dir   = (req.query.dir as string | undefined ?? '').trim();
      if (!query) return res.json({ results: [] });

      const sessionCwd = getSessionCwd(sessionId);
      if (!sessionCwd) return res.status(404).json({ error: 'Session not found' });

      // Same scoping rule as /search — when `dir` is supplied, restrict the
      // filename-walk to that subtree so the user gets folder-local results.
      let cwd = sessionCwd;
      if (dir) {
        try {
          const resolved = nodePath.resolve(dir);
          if (statSync(resolved).isDirectory()) cwd = resolved;
        } catch { /* fall through to sessionCwd */ }
      }

      const MAX_RESULTS = 100;
      const needle = query.toLowerCase();
      const args = ['--files', '--hidden', '-g', '!.git'];

      const results: string[] = [];
      await new Promise<void>((resolve) => {
        const child = spawn(rgPath, args, { cwd });
        let buf = '';
        let done = false;
        const finish = () => { if (!done) { done = true; try { child.kill(); } catch {} resolve(); } };
        const timer = setTimeout(finish, 5_000);

        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const file = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!file) continue;
            if (file.toLowerCase().includes(needle)) {
              results.push(file.replace(/^\.\//, ''));
              if (results.length >= MAX_RESULTS) { finish(); return; }
            }
          }
        });
        child.on('error', finish);
        child.on('close', () => { clearTimeout(timer); finish(); });
      });

      res.json({ results, cwd });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post('/fs/upload', async (req, res) => {
    const dir = expandHome(req.query.dir as string | undefined ?? '');
    const name = req.query.name as string | undefined ?? '';
    if (!dir || !name) return res.status(400).json({ error: 'Missing dir or name' });
    const safeName = nodePath.basename(name);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    const destPath = nodePath.join(dir, safeName);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      writeFileSync(destPath, Buffer.concat(chunks));
      res.json({ ok: true, path: destPath });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post('/fs/write', (req, res) => {
    const filePath = expandHome(req.query.path as string | undefined ?? '');
    if (!filePath) return res.status(400).json({ error: 'Missing path' });
    try {
      const { content } = req.body as { content?: string };
      if (content === undefined) return res.status(400).json({ error: 'Missing content' });
      writeFileSync(filePath, content, 'utf-8');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post('/fs/mkdir', (req, res) => {
    const dirPath = expandHome(req.query.path as string | undefined ?? '');
    if (!dirPath) return res.status(400).json({ error: 'Missing path' });
    try {
      mkdirSync(dirPath, { recursive: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.delete('/fs/delete', (req, res) => {
    const filePath = expandHome(req.query.path as string | undefined ?? '');
    if (!filePath) return res.status(400).json({ error: 'Missing path' });
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    try {
      rmSync(filePath, { recursive: false });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Open a file with the host OS default application (the machine running the
  // server, not the browser). sheepit is "your machine, anywhere", so this
  // surfaces a file in the host's native GUI app.
  router.post('/fs/open', (req, res) => {
    const filePath = expandHome(req.query.path as string | undefined ?? '');
    if (!filePath) return res.status(400).json({ error: 'Missing path' });
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const platform = process.platform;
    const [cmd, args] = platform === 'darwin' ? ['open', [filePath]]
      : platform === 'win32'                  ? ['cmd', ['/c', 'start', '', filePath]]
      :                                         ['xdg-open', [filePath]];
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    let settled = false;
    child.on('error', (err) => { if (!settled) { settled = true; res.status(500).json({ error: String(err) }); } });
    child.on('spawn', () => { if (!settled) { settled = true; child.unref(); res.json({ ok: true }); } });
  });

  // NOTE: the old `GET /fs/watch` SSE endpoint lived here. It was replaced by
  // `watch_file` / `unwatch_file` messages on the shared WebSocket (see
  // server.ts): one never-ending SSE stream per open file exhausted the
  // browser's ~6 HTTP/1.1 connections per host, which made every other request
  // to the origin hang and surfaced as "Failed to fetch" across the app.

  router.get('/fs/raw', (req, res) => {
    const filePath = expandHome(req.query.path as string | undefined ?? '');
    if (!filePath) return res.status(400).send('Missing path');
    if (!existsSync(filePath)) return res.status(404).send('Not found');
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) return res.status(400).send('Path is a directory');
      if (stat.size > 2 * 1024 * 1024) return res.status(413).send('File too large (> 2 MB)');
      const ext = nodePath.extname(filePath).toLowerCase();
      const imageExts  = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.ico','.bmp']);
      const pdfExts    = new Set(['.pdf']);
      if (imageExts.has(ext)) return res.sendFile(filePath);
      if (pdfExts.has(ext))   return res.sendFile(filePath);
      // Serve as plain text for source files
      res.type('text/plain; charset=utf-8').send(readFileSync(filePath, 'utf-8'));
    } catch (e) {
      res.status(500).send(String(e));
    }
  });

  router.get('/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for (const entry of logBuffer.entries()) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const unsub = logBuffer.subscribe((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    req.on('close', () => unsub());
  });


  // ── AI Features ──────────────────────────────────────────────────────────────

  router.get('/ai/config', (_req, res) => {
    res.json(ai.getConfig());
  });

  router.post('/ai/config', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const cfg = ai.getConfig();

    ai.saveConfig({
      aiEnabled: body.aiEnabled !== undefined ? Boolean(body.aiEnabled) : cfg.aiEnabled,
      aiProvider: typeof body.aiProvider === 'string' && (body.aiProvider === 'claude-code' || body.aiProvider === 'codex')
        ? body.aiProvider : cfg.aiProvider,
      autoNaming: body.autoNaming !== undefined ? Boolean(body.autoNaming) : cfg.autoNaming,
      autoNamingIntervalSecs: typeof body.autoNamingIntervalSecs === 'number'
        ? body.autoNamingIntervalSecs : cfg.autoNamingIntervalSecs,
      claudeCommand: typeof body.claudeCommand === 'string' ? body.claudeCommand : cfg.claudeCommand,
    });

    ai.restart();
    res.json({ ok: true });
  });

  return router;
}
