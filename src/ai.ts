import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { configDir } from './paths.js';
import { logger } from './server.js';
import type { DirectBridge } from './direct-bridge.js';

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
    child.on('close', (code) => {
      if (code === 0) {
        if (!stdout.trim() && stderr.trim()) {
          reject(new Error(`${cmd} returned empty stdout, stderr: ${stderr.slice(0, 300)}`));
        } else {
          resolve(stdout);
        }
      }
      else reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 300)}`));
    });
    child.stdin.write(input);
    child.stdin.end();
  });
}
/** Fast non-crypto hash for content change detection */
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

const AI_DEFAULTS: AIConfig = {
  aiEnabled: false,
  aiProvider: 'claude-code',
  claudeCommand: 'claude',
  autoNaming: true,
  autoNamingIntervalSecs: 30,
};

/** What a session is called after `/clear` wiped its context.
 *
 *  `/clear` shears the session: everything it knew is gone. Leaving the old
 *  AI-generated name on it is actively misleading — the pen card would still
 *  advertise work the agent can no longer remember doing. */
export const CLEARED_SESSION_NAME = 'freshly shorn';

/** May the namer (re)name this session?
 *
 *  Yes when the name is still a default one nobody chose, and yes when this
 *  service assigned the current name itself — but never when a human named it,
 *  which is the whole point of the ownership check.
 *
 *  Pulled out of the sweep because the `/clear` reset depends on it in a way
 *  that is easy to get wrong: CLEARED_SESSION_NAME is not a default, so a
 *  cleared session is only renameable again because noteSessionCleared() also
 *  claims ownership of it. */
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
      if (this._looksLikeOurOutput(s.name)) {
        this.aiAssignedName.set(s.id, s.name);
      }
    }
    if (this.aiAssignedName.size > 0) {
      logger.debug(`AI naming: seeded ${this.aiAssignedName.size} tracked session name(s) for rescue`);
    }
  }

  /** True if `name` looks like something our naming prompt would produce. */
  private _looksLikeOurOutput(rawName: string): boolean {
    // Compare the stripped form: a name we previously saved with decoration
    // still came from us, and refusing to claim it would leave it frozen.
    const name = stripNameDecoration(rawName);
    if (!name || name.length > 60) return false;
    // Lowercase, letters/digits/spaces/hyphens, at most 6 tokens
    if (!/^[a-z][a-z0-9 \-]*$/.test(name)) return false;
    const words = name.split(/\s+/).filter(Boolean);
    return words.length >= 1 && words.length <= 6;
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

  /** `/clear` happened: forget everything we knew about naming this session.
   *
   *  Ownership matters more than it looks. The sweep only renames a session
   *  whose name is a default OR one this service already assigned — so simply
   *  renaming to CLEARED_SESSION_NAME would freeze it there forever, since
   *  "freshly shorn" is neither. Claiming it here is what lets the next real
   *  turn rename it again. */
  noteSessionCleared(sessionId: string): void {
    this.aiAssignedName.set(sessionId, CLEARED_SESSION_NAME);
    // The pre-clear exchange must not be what the next name is derived from.
    this.lastContentHash.delete(sessionId);
  }

  private async _nameSession(sessionId: string, provider: AIProvider): Promise<void> {
    try {
      // Name from the actual exchange, reported by the agent's own hooks.
      //
      // This used to scrape 3000 characters of terminal output, which for a
      // TUI agent is mostly spinners, footers and redraws — most of the prompt
      // below existed to talk the model out of naming sessions "fluttering".
      // What the user asked and what the agent answered is the thing we
      // actually wanted all along.
      //
      // No turn means no name: a plain shell, or an agent without the plugin.
      // Guessing from raw output is what produced the bad names, so declining
      // is the better answer.
      const turn = this.bridge!.getAgentTurn(sessionId);
      if (!turn?.prompt && !turn?.response) {
        logger.debug(`AI naming ${sessionId}: no reported turn, skipping`);
        return;
      }
      const snippet = [
        turn.prompt ? `User asked:\n${turn.prompt}` : null,
        turn.response ? `Agent answered:\n${turn.response}` : null,
      ].filter(Boolean).join('\n\n');

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
          if (s.prNum) parts.push(`PR: #${s.prNum}${s.prState ? ` (${s.prState})` : ''}`);
          if (s.isClaudeCode) parts.push(`Running: claude code`);
          else if (s.isCodex) parts.push(`Running: codex`);
          if (parts.length > 0) sessionCtx = parts.join('\n');
        }
      } catch { /* best-effort — skip if listSessions fails */ }

      // Skip if terminal content hasn't changed since last naming. Key the
      // hash on the snippet AND the structured context, so that e.g. a git
      // branch change triggers a re-name even when the visible terminal
      // hasn't scrolled.
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

      const prompt = `Name this coding session after the task being worked on. Produce a concise name (2-5 words, lowercase, no emojis, no quotes, no punctuation).

Examples of good names:
- nextjs dev server
- git rebase main
- pytest integration tests
- refactor auth middleware
- debug memory leak

Base the name on the task itself, not on pleasantries, tool names, or how the
agent phrased its reply. If the exchange describes no identifiable task, output
exactly: idle
${sessionCtx ? `\nSession context:\n${sessionCtx}\n` : ''}
Last exchange:
${snippet}

Session name:`;

      const invocation = buildNamerInvocation(provider, prompt);
      const cli = invocation.command;

      logger.debug(`AI naming ${sessionId}: calling isolated ${cli} (${snippet.length} chars of exchange)`);
      const t0 = Date.now();

      let name: string;
      if (cli === 'claude') {
        // Use --verbose --output-format json to get the full message array,
        // then extract the assistant text. Plain -p returns empty result field.
        // Run from a dedicated temp cwd so Claude Code doesn't log these
        // one-shot naming prompts into the user's real project history.
        const raw = await runWithStdin(
          invocation.command,
          invocation.args,
          '',
          30_000,
          this._namerCwd,
        );
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
        name = (await runWithStdin(invocation.command, invocation.args, '', 30_000, this._namerCwd)).trim();
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

      await this.bridge!.renameSession(sessionId, name);
      // Record that we own this name — future runs can re-rename it without
      // needing the brittle "looks AI named" string heuristic.
      this.aiAssignedName.set(sessionId, name);
      logger.info(`AI renamed ${sessionId} → "${name}"`);
    } catch (e) {
      // Release the claim so the next sweep retries this exact content.
      this.lastContentHash.delete(sessionId);
      logger.debug(`AI naming failed for ${sessionId}: ${e}`);
    }
  }
}
