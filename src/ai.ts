import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { configDir } from './paths.js';
import { logger } from './server.js';
import type { DirectBridge } from './direct-bridge.js';

/** The namer's CLI was killed rather than having failed.
 *
 *  Worth its own type because it is worth retrying and an ordinary failure is
 *  not: the CLI dying by signal 50ms after spawn, with no output, is the
 *  machine refusing to start it — on a box deep in swap, macOS kills a fresh
 *  ~150MB process at exec. Seconds later there is usually room. */
export class CliKilled extends Error {
  constructor(public readonly signal: string, message: string) {
    super(message);
    this.name = 'CliKilled';
  }
}

/** Run a CLI command with stdin input, return stdout. */
function runWithStdin(cmd: string, args: string[], input: string, timeoutMs = 30_000, cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LANG: 'en_US.UTF-8' },
      timeout: timeoutMs,
      ...(cwd ? { cwd } : {}),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    // The signal is in the message on purpose: a code of `null` means the
    // child was killed rather than that it failed, and "exited with code null"
    // on its own sends you looking at the CLI instead of at whoever killed it.
    child.on('close', (code, signal) => {
      if (code === 0) {
        if (!stdout.trim() && stderr.trim()) {
          reject(new Error(`${cmd} returned empty stdout, stderr: ${stderr.slice(0, 300)}`));
        } else {
          resolve(stdout);
        }
      }
      else if (signal) reject(new CliKilled(signal, `${cmd} was killed (signal ${signal}): ${stderr.slice(0, 300)}`));
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}
/** Fast non-crypto hash for content change detection */
/** Trim a turn to `max` characters on a word boundary. Half a sentence reads
 *  as a bug to whatever is asked to summarise it; a short one just reads as
 *  short. */
function clip(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

function simpleHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return h.toString(36);
}

const CONFIG_PATH = join(configDir(), 'config.json');

export type AIProvider = 'claude-code' | 'codex';

/** CLI invocation used for one-shot naming. Keep this isolated from the
 * user's agent customizations: naming should never depend on hooks, skills,
 * project rules, or a persisted agent conversation. */
export function buildNamerInvocation(provider: AIProvider, prompt: string): { command: string; args: string[] } {
  if (provider === 'claude-code') {
    return {
      command: 'claude',
      args: ['-p', '--safe-mode', '--disable-slash-commands', '--model', 'haiku', '--verbose', '--output-format', 'json', prompt],
    };
  }
  return {
    command: 'codex',
    args: ['exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '--skip-git-repo-check', prompt],
  };
}

export interface AIConfig {
  aiEnabled: boolean;
  aiProvider: AIProvider;
  autoNaming: boolean;
  autoNamingIntervalSecs: number;
  claudeCommand: string;
}

/** How long to wait before trying a killed namer again.
 *
 *  One retry, not a loop: if the machine is out of memory this is not going to
 *  be solved by asking harder, and the sweep comes back in 30s anyway. Long
 *  enough for the pages of whatever was just killed to be reclaimed —
 *  measured, the very next spawn dies and one a few seconds later does not. */
const KILLED_RETRY_MS = 4000;

const AI_DEFAULTS: AIConfig = {
  aiEnabled: false,
  aiProvider: 'claude-code',
  claudeCommand: 'claude',
  autoNaming: true,
  autoNamingIntervalSecs: 30,
};

/** Last resort for a cleared session whose directory yields no usable name. */
export const CLEARED_SESSION_NAME = 'freshly shorn';

/**
 * What a session is called after `/clear` wiped its context.
 *
 * `/clear` shears the session: everything it knew is gone, so leaving the old
 * AI-generated name on it is actively misleading — the pen card would still
 * advertise work the agent can no longer remember doing.
 *
 * But every cleared session used to get the *same* name, and a sidebar with
 * nine rows called "freshly shorn" tells you nothing about any of them. It
 * takes the name a new pane in that directory would have instead: the pane
 * has no work to be named after, and its project is the honest answer until
 * someone asks it something. That it has nothing in it yet is already said by
 * `fresh` — see `.pane-card-fresh` — so the name does not have to say it too.
 *
 * Normalised, so the writer still cannot store a name the reader would
 * disown, and so a directory called `My Project` does not freeze its pane.
 */
export function clearedSessionName(path: string | undefined): string {
  const basename = path?.split('/').filter(Boolean).pop();
  return (basename && normalizeAssignedName(basename)) || CLEARED_SESSION_NAME;
}

/** May the namer (re)name this session?
 *
 *  Yes when the name is still a default one nobody chose, and yes when this
 *  service assigned the current name itself — but never when a human named it,
 *  which is the whole point of the ownership check.
 *
 *  Pulled out of the sweep because the `/clear` reset depends on it: a
 *  cleared session is renameable again either because its new name is the
 *  directory's (a default), or because noteSessionCleared() claimed whatever
 *  it was given. Both paths have to keep working. */
/** Strip the decoration a model wraps a short answer in.
 *
 *  Asked for a name, a model will sometimes answer with a markdown code span
 *  or a quoted string. Storing that verbatim produced a live session actually
 *  called `` `pytest` `` — and worse, the backticks then failed
 *  _looksLikeOurOutput(), so the namer no longer recognised the name as its
 *  own and refused to ever rename it again. A name that locks the namer out of
 *  fixing it is the worst possible failure here. */
export function stripNameDecoration(raw: string): string {
  let name = raw.trim();
  // Peel repeatedly: `"**name**"` happens.
  for (let i = 0; i < 4; i++) {
    const before = name;
    name = name
      .replace(/^`+([\s\S]*?)`+$/, '$1')
      .replace(/^\*\*([\s\S]*?)\*\*$/, '$1')
      .replace(/^\*([\s\S]*?)\*$/, '$1')
      .replace(/^_([\s\S]*?)_$/, '$1')
      .replace(/^"([\s\S]*?)"$/, '$1')
      .replace(/^'([\s\S]*?)'$/, '$1')
      .trim();
    if (name === before) break;
  }
  return name;
}

/**
 * The shape of a name this service assigns.
 *
 * These three constants and the two functions below are ONE definition used
 * from both ends, and that is the entire point. Ownership of a name lives only
 * in memory, so after a restart the namer works out which names are its own by
 * looking at their shape — and it used to recognise a *narrower* set than it
 * was willing to write. Any name outside the overlap was written once and then
 * disowned forever: isRenameable() said no, the sweep skipped it in silence,
 * and that pane could never be renamed again.
 *
 * Four ways a name could land outside it, all of them real: an underscore or a
 * dot (`rrf cross_encoder benchmark`, `compare 0.9.1 pr regression` — both
 * frozen live sessions), a capital letter, more than six words, or 61-80
 * characters, since the writer's cap was 80 and the reader's 60.
 *
 * So the writer no longer stores anything the reader cannot claim:
 * normalizeAssignedName() is total, and its output always satisfies
 * looksLikeAssignedName(). Widening the charset to include `_` and `.` is the
 * other half — it is what lets the already-frozen sessions be reclaimed rather
 * than merely stopping new ones freezing.
 */
const NAME_CHARSET = /^[a-z][a-z0-9 ._-]*$/;
const MAX_NAME_WORDS = 6;
const MAX_NAME_LEN = 60;

/** Could this name have come from us? Drives ownership after a restart.
 *
 *  Deliberately a shape test and not a memory: the alternative is persisting
 *  ownership, and a name we cannot recognise is one we can never fix. */
export function looksLikeAssignedName(raw: string): boolean {
  const name = stripNameDecoration(raw);
  if (!name || name.length > MAX_NAME_LEN) return false;
  if (!NAME_CHARSET.test(name)) return false;
  const words = name.split(/\s+/).filter(Boolean);
  return words.length >= 1 && words.length <= MAX_NAME_WORDS;
}

/** Coerce a model's answer into a name we will still recognise as ours.
 *
 *  Returns null when there is nothing usable left, which the caller treats as
 *  "decline to rename" — leaving the old name alone is always better than
 *  storing one that locks us out.
 *
 *  Out-of-charset runs become spaces rather than being deleted, so `feat/foo`
 *  reads as two words instead of one portmanteau. `_` and `.` survive, because
 *  they are usually part of an identifier the user would recognise. */
export function normalizeAssignedName(raw: string): string | null {
  let name = stripNameDecoration(raw).toLowerCase()
    // Identifiers out, before the charset pass turns `#3672` into a bare
    // `3672` that no later rule could tell from a version number. The prompt
    // asks for this too; a name is read a hundred times and written once, so
    // it is worth enforcing on the way in rather than hoping.
    //
    // Only the reader stays permissive: looksLikeAssignedName must keep
    // claiming names we wrote before this rule existed, or every one of them
    // freezes its pane — the exact failure this whole contract exists for.
    // The labelled form first: it takes the word with the number, so
    // "review pr #3672" loses both and reads "review" rather than "review pr".
    .replace(/\b(prs?|pull(?:\s+request)?s?|issues?|tickets?)\b[\s#:_-]*\d+/g, ' ')
    .replace(/#\d+/g, ' ')
    .replace(/[^a-z0-9 ._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // The charset requires a letter first; a name that is only punctuation and
    // digits has nothing to lead with and is rejected below.
    .replace(/^[^a-z]+/, '')
    .trim();

  const words = name.split(' ').filter(Boolean).slice(0, MAX_NAME_WORDS);
  // Drop whole words before cutting one in half — a truncated word reads as a
  // bug, a shorter name just reads as a shorter name.
  while (words.length > 1 && words.join(' ').length > MAX_NAME_LEN) words.pop();
  name = words.join(' ').slice(0, MAX_NAME_LEN).trim();

  return looksLikeAssignedName(name) ? name : null;
}

export function isRenameable(name: string, path: string | undefined, ownedName: string | undefined): boolean {
  const basename = path?.split('/').filter(Boolean).pop() ?? 'shell';
  const isDefaultName = name === basename
    || (name.startsWith(`${basename}-`) && /^\d+$/.test(name.slice(basename.length + 1)))
    || /^\d+$/.test(name)
    || /^(shell|zsh|bash|fish|sh)$/.test(name);
  return isDefaultName || ownedName === name;
}

export class AIService {
  private bridge: DirectBridge | null = null;
  private namingTimer: NodeJS.Timeout | null = null;
  /** Track which sessions were recently named to avoid hammering the LLM */
  private lastNamed = new Map<string, number>();
  /** Hash of terminal content used for the last naming — skip if unchanged */
  /** Hash of the exchanges + context a session was last named from, so an
   *  unchanged session does not pay for an LLM call every sweep. Named for a
   *  terminal snapshot it has not hashed since naming moved to the hooks. */
  private lastContentHash = new Map<string, string>();
  private inFlight = new Set<string>();
  /**
   * Names we have assigned via auto-naming. If `session.name` still matches
   * our assigned value, we "own" the name and can safely re-name the session
   * when content changes. If the user has manually renamed it since, we back
   * off (their name no longer matches what we stored).
   *
   * This replaces the old heuristic `looksAiNamed` check (emoji or >2 words),
   * which was broken because the current prompt produces 2–5 lowercase words
   * with no emoji — so every successful rename was immediately locked out of
   * future updates.
   */
  private aiAssignedName = new Map<string, string>();
  /** Dedicated cwd for AI-naming subprocess invocations. Claude Code / Codex
   *  bucket their session history per-cwd, so routing these calls through a
   *  throwaway temp dir keeps the user's real project history clean. */
  private readonly _namerCwd: string = (() => {
    const dir = join(tmpdir(), 'sheepit-ai-namer');
    try { mkdirSync(dir, { recursive: true }); } catch { /* dir already exists or tmpdir unwritable */ }
    return dir;
  })();

  getConfig(): AIConfig {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf8');
      const data = JSON.parse(raw);
      return {
        aiEnabled: data.aiEnabled ?? AI_DEFAULTS.aiEnabled,
        aiProvider: data.aiProvider ?? AI_DEFAULTS.aiProvider,
        autoNaming: data.aiAutoNaming ?? AI_DEFAULTS.autoNaming,
        autoNamingIntervalSecs: data.aiAutoNamingIntervalSecs ?? AI_DEFAULTS.autoNamingIntervalSecs,
        claudeCommand: data.claudeCommand ?? AI_DEFAULTS.claudeCommand,
      };
    } catch {
      return { ...AI_DEFAULTS };
    }
  }

  saveConfig(updates: Partial<AIConfig>): void {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* fresh */ }
    if ('aiEnabled' in updates) data.aiEnabled = updates.aiEnabled;
    if ('aiProvider' in updates) data.aiProvider = updates.aiProvider;
    if ('autoNaming' in updates) data.aiAutoNaming = updates.autoNaming;
    if ('autoNamingIntervalSecs' in updates) data.aiAutoNamingIntervalSecs = updates.autoNamingIntervalSecs;
    if ('claudeCommand' in updates) data.claudeCommand = updates.claudeCommand;
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n');
  }

  setBridge(bridge: DirectBridge): void {
    this.bridge = bridge;
    // One-time rescue of sessions that were auto-named before we started
    // tracking ownership explicitly. Any current session whose name matches
    // the shape our prompt produces (lowercase, short, letters/digits/spaces/
    // hyphens only) is presumed to be AI-assigned and added to the tracked
    // map so the next naming cycle can re-name it. Sessions with mixed-case
    // or long/complex names are assumed to be user-set and left alone.
    this._seedAiAssignedNames().catch(e =>
      logger.debug(`AI name seed failed: ${e}`),
    );
  }

  private async _seedAiAssignedNames(): Promise<void> {
    if (!this.bridge) return;
    const sessions = await this.bridge.listSessions();
    for (const s of sessions) {
      if (looksLikeAssignedName(s.name)) {
        this.aiAssignedName.set(s.id, s.name);
      }
      // Panes cleared before a clear left the directory's name behind are
      // still sharing one name between them. They cannot be named from their
      // own history — a clear is what threw it away — so they would sit there
      // identical until someone typed in each of them. Give them the name the
      // clear would give them today. Idempotent: it renames only the literal
      // old constant, and only where the namer is allowed to.
      if (s.name === CLEARED_SESSION_NAME) {
        const renamed = clearedSessionName(s.path);
        if (renamed !== CLEARED_SESSION_NAME) {
          this.aiAssignedName.set(s.id, renamed);
          await this.bridge.renameSession(s.id, renamed);
          logger.info(`AI naming: cleared pane ${s.id} → "${renamed}"`);
        }
      }
    }
    if (this.aiAssignedName.size > 0) {
      logger.debug(`AI naming: seeded ${this.aiAssignedName.size} tracked session name(s) for rescue`);
    }
  }


  start(): void {
    this.stop();
    const cfg = this.getConfig();
    if (!cfg.aiEnabled) return;

    if (cfg.autoNaming) {
      const intervalMs = (cfg.autoNamingIntervalSecs || 30) * 1000;
      this.namingTimer = setInterval(() => this._runAutoNaming(), intervalMs);
      logger.info(`AI auto-naming started (every ${cfg.autoNamingIntervalSecs}s, provider=${cfg.aiProvider})`);
    }
  }

  stop(): void {
    if (this.namingTimer) {
      clearInterval(this.namingTimer);
      this.namingTimer = null;
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  private async _runAutoNaming(): Promise<void> {
    if (!this.bridge) return;
    const cfg = this.getConfig();
    if (!cfg.aiEnabled || !cfg.autoNaming) return;

    const sessions = await this.bridge.listSessions();
    const now = Date.now();
    const minInterval = (cfg.autoNamingIntervalSecs || 30) * 1000;

    // Process one session at a time to avoid concurrent CLI calls
    for (const session of sessions) {
      const lastTime = this.lastNamed.get(session.id) ?? 0;
      if (now - lastTime < minInterval) continue;
      if (this.inFlight.has(session.id)) continue;

      // A fresh session has had nothing asked of it yet, so there is nothing
      // honest to name it after. This is not a nicety: another plugin's
      // SessionStart hook injects context, the agent answers it, and Stop
      // carries that answer to us as a turn — so a session cleared seconds ago
      // would be christened after whatever that plugin happened to talk about.
      // It stays as it is until a human asks it something, which is what
      // clears the flag (see clearSessionFresh).
      if ((session as { fresh?: boolean }).fresh) continue;

      // Eligibility: we touch a session's name only if it's still a default
      // shell-ish name, OR it currently matches a name we previously assigned
      // (so we can refresh it as the user's work evolves). If the user has
      // manually renamed it to something that isn't on our books, leave it
      // alone. `direct-bridge.createSession` names duplicates "<basename>-2",
      // "<basename>-3", so those count as default too.
      if (!isRenameable(session.name, session.path, this.aiAssignedName.get(session.id))) continue;

      this.inFlight.add(session.id);
      try {
        await this._nameSession(session.id, cfg.aiProvider);
      } finally {
        this.inFlight.delete(session.id);
        this.lastNamed.set(session.id, Date.now());
      }
    }
  }

  /** The name this service last assigned to a session, if any. */
  assignedName(sessionId: string): string | undefined {
    return this.aiAssignedName.get(sessionId);
  }

  /** `/clear` happened: forget everything we knew about naming this session.
   *
   *  Ownership matters more than it looks. The sweep only renames a session
   *  whose name is a default OR one this service already assigned, so the name
   *  a clear leaves behind has to be one of those or the pane freezes there
   *  forever. Claiming whatever it was given makes that true without this
   *  having to know which of the two it is. */
  noteSessionCleared(sessionId: string, name: string): void {
    this.aiAssignedName.set(sessionId, name);
    // The pre-clear exchange must not be what the next name is derived from.
    this.lastContentHash.delete(sessionId);
  }

  private async _nameSession(sessionId: string, provider: AIProvider): Promise<void> {
    try {
      // Name from the actual exchanges, reported by the agent's own hooks.
      //
      // This used to scrape 3000 characters of terminal output, which for a
      // TUI agent is mostly spinners, footers and redraws — most of the prompt
      // below existed to talk the model out of naming sessions "fluttering".
      // What the user asked and what the agent answered is the thing we
      // actually wanted all along.
      //
      // The last THREE exchanges, not just the latest: a session is named
      // after its subject, and the newest turn is usually a follow-up ("now
      // check the log", "same for codex") that reads as a different subject
      // on its own. Oldest first, so the model sees the arc of the work rather
      // than a single step out of context.
      //
      // No turn means no name: a plain shell, or an agent without the plugin.
      // Guessing from raw output is what produced the bad names, so declining
      // is the better answer.
      const turns = this.bridge!.getAgentTurns(sessionId)
        .filter(t => t.prompt || t.response);
      if (turns.length === 0) {
        logger.debug(`AI naming ${sessionId}: no reported turn, skipping`);
        return;
      }
      const ordered = [...turns].reverse();
      const snippet = ordered.map((t, i) => {
        const label = ordered.length === 1 ? 'Exchange'
          : i === ordered.length - 1 ? `Exchange ${i + 1} (most recent)`
          : `Exchange ${i + 1}`;
        // Older turns are trimmed harder than the newest one: they are there
        // for the subject, not for their detail, and the whole prompt has to
        // stay small enough that naming is never the slow part of a sweep.
        const cap = i === ordered.length - 1 ? 2000 : 700;
        return [
          `${label}:`,
          t.prompt ? `User asked:\n${clip(t.prompt, cap)}` : null,
          t.response ? `Agent answered:\n${clip(t.response, cap)}` : null,
        ].filter(Boolean).join('\n');
      }).join('\n\n');

      // Pull structured context (project, git branch, PR) from the session
      // itself — this is a much more reliable signal than the TUI snapshot
      // for Claude Code sessions, where the "terminal output" is mostly UI
      // chrome. Use it as a hint alongside the snippet.
      let sessionCtx: string | null = null;
      try {
        const sessions = await this.bridge!.listSessions();
        const s = sessions.find(x => x.id === sessionId);
        if (s) {
          const parts: string[] = [];
          const project = s.path?.split('/').filter(Boolean).pop();
          if (project) parts.push(`Project: ${project}`);
          if (s.gitBranch) parts.push(`Branch: ${s.gitBranch}`);
          // The PR number used to be handed over here. It carries no topic —
          // a number cannot say what the change is about — and its only effect
          // on a name was to end up inside it. The bar shows the PR; the name
          // says what the work is.

          if (s.isClaudeCode) parts.push(`Running: claude code`);
          else if (s.isCodex) parts.push(`Running: codex`);
          if (parts.length > 0) sessionCtx = parts.join('\n');
        }
      } catch { /* best-effort — skip if listSessions fails */ }

      // Skip when nothing has changed since the last naming. Keyed on the
      // exchanges AND the structured context, so a branch change re-names even
      // though the conversation has not moved on. (Nothing here reads the
      // screen; this used to hash a terminal snapshot, and the name stuck.)
      const contentHash = simpleHash(snippet + '|' + (sessionCtx ?? ''));
      if (this.lastContentHash.get(sessionId) === contentHash) {
        logger.debug(`AI naming ${sessionId}: content unchanged, skipping`);
        return;
      }
      // Claim the content up front so a sweep that overlaps this one does not
      // name the same session twice. Cleared again if the call fails, because
      // holding it would retire the session permanently: the content hash
      // would keep matching, and a transient failure — the CLI not logged in,
      // a timeout — would mean it is never named again.
      this.lastContentHash.set(sessionId, contentHash);

      const prompt = `Name this coding session after the SUBJECT of the work. Produce a concise name (2-5 words, lowercase, no emojis, no quotes, no punctuation).

Examples of good names:
- nextjs dev server
- git rebase main
- pytest integration tests
- refactor auth middleware
- debug memory leak

Rules:
- Name the topic, not the current step or its status. The session is read at a
  glance in a list of twenty; it should still be right in ten minutes.
  "flaky auth tests" — not "running test 3 again", "fixing the last error",
  "waiting for ci" or "done".
- Never put an identifier in the name: no PR or issue numbers, no #123, no
  ticket keys, no commit hashes. Say what the change is about instead.
  "mirror deletion fix" — not "pr 3672" or "review #88".
- Several exchanges are given below when they exist. Name the thread that runs
  through them, not whatever the most recent message happens to ask; a
  follow-up like "now do the same for codex" is part of the same subject.
- Base it on the work itself, not on pleasantries, tool names, or how the agent
  phrased its reply.
- If the exchanges describe no identifiable task, output exactly: idle
${sessionCtx ? `\nSession context (background — do not name the session after it):\n${sessionCtx}\n` : ''}
${snippet}

Session name:`;

      const invocation = buildNamerInvocation(provider, prompt);
      const cli = invocation.command;

      logger.debug(`AI naming ${sessionId}: calling isolated ${cli} (${snippet.length} chars of exchange)`);
      const t0 = Date.now();

      // Run from a dedicated temp cwd so Claude Code doesn't log these one-shot
      // naming prompts into the user's real project history.
      //
      // Retried once when the CLI is *killed*, which on a machine deep in swap
      // is most attempts: the process dies ~50ms after spawn, before it prints
      // anything, and a second try a few seconds later usually lands. Without
      // it a pane waits out two or three sweeps for a name it could have had,
      // which is indistinguishable from naming being broken. An ordinary
      // failure is not retried — that one is not going to go better.
      const invoke = async (): Promise<string> => {
        try {
          return await runWithStdin(invocation.command, invocation.args, '', 30_000, this._namerCwd);
        } catch (e) {
          if (!(e instanceof CliKilled)) throw e;
          logger.debug(`AI naming ${sessionId}: ${cli} killed (${e.signal}), retrying once`);
          await new Promise(r => setTimeout(r, KILLED_RETRY_MS));
          return runWithStdin(invocation.command, invocation.args, '', 30_000, this._namerCwd);
        }
      };

      let name: string;
      if (cli === 'claude') {
        // Use --verbose --output-format json to get the full message array,
        // then extract the assistant text. Plain -p returns empty result field.
        const raw = await invoke();
        name = '';
        try {
          const events = JSON.parse(raw);
          if (Array.isArray(events)) {
            for (const evt of events) {
              if (evt.type === 'assistant' && evt.message?.content) {
                for (const block of evt.message.content) {
                  if (block.type === 'text' && block.text) { name = block.text.trim(); break; }
                }
                if (name) break;
              }
            }
          } else if (events.result) {
            name = (events.result as string).trim();
          }
        } catch {
          // If JSON parse fails, try using raw output
          name = raw.trim();
        }
      } else {
        name = (await invoke()).trim();
      }

      logger.debug(`AI naming ${sessionId}: got "${name}" in ${Date.now() - t0}ms`);

      name = stripNameDecoration(name);
      if (!name || name.length > 80 || name.includes('\n')) return;
      // Reject the explicit "idle" fallback and common LLM refusals
      const lower = name.toLowerCase().trim();
      if (lower === 'idle' || lower === 'unknown' || lower === 'n/a' || lower.startsWith("i can't") || lower.startsWith('i cannot')) {
        logger.debug(`AI naming ${sessionId}: rejecting fallback name "${name}"`);
        return;
      }

      // Never store a name we would not recognise as ours after a restart.
      // See normalizeAssignedName: the writer's limits used to be looser than
      // the reader's, and every name that fell in the gap froze its pane.
      const assigned = normalizeAssignedName(name);
      if (!assigned) {
        logger.debug(`AI naming ${sessionId}: "${name}" normalises to nothing, skipping`);
        return;
      }

      await this.bridge!.renameSession(sessionId, assigned);
      // Record that we own this name — future runs can re-rename it without
      // needing the brittle "looks AI named" string heuristic.
      this.aiAssignedName.set(sessionId, assigned);
      logger.info(`AI renamed ${sessionId} → "${assigned}"`);
    } catch (e) {
      // Release the claim so the next sweep retries this exact content.
      this.lastContentHash.delete(sessionId);
      logger.debug(`AI naming failed for ${sessionId}: ${e}`);
    }
  }
}
