import { spawn } from 'child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir, tmpdir } from 'os';
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

/**
 * Patterns that match Claude Code / Codex TUI chrome lines we should drop
 * before feeding terminal content to the LLM. These are what caused nonsense
 * session names like "fluttering", "downloading", "bypass permissions" —
 * the LLM was faithfully naming the session after whatever random spinner
 * word or footer was on screen.
 *
 * Be conservative: we'd rather keep a "chrome-looking" line than lose a
 * real signal. These patterns are anchored and narrow.
 */
const CLAUDE_TUI_CHROME_PATTERNS: RegExp[] = [
  // Footer: "⏵⏵ bypass permissions on (shift+tab to cycle) · esc to interrupt"
  /⏵⏵.*bypass\s*permissions/i,
  /shift\s*\+\s*tab\s*to\s*cycle/i,
  // "new task? /clear to save 469.5k tokens"
  /new\s*task\?.*\/clear.*to\s*save/i,
  // Spinner status line ending with "(1m 15s · ↓ 372 tokens)" or similar
  /…?\s*\([^)]*tokens?\s*\)\s*$/i,
  // "thinking with low/medium/high effort"
  /thinking\s*with\s*(low|medium|high)\s*effort/i,
  // Tool-call inline spinner: "  ⎿  Running…" / "  ⎿  Waiting…"
  /^\s*⎿\s*(running|waiting|processing|working|computing|reading|writing|executing)\s*…?\s*$/i,
  // Spinner-glyph + gerund line (Topsy-turvying, fluttering, forging, Baked, Worked, etc.)
  // Matches: "✻ Baked for 34s", "* Topsy-turvying… (1m)", "✶ Forging thoughts…"
  /^\s*[✻✶✢·*]\s*[A-Za-z][A-Za-z\-]{2,20}(ing|ed|y)?\s*(…|for\s+\d|\(|$)/,
  // Horizontal separator lines
  /^\s*[─━═]{3,}\s*$/,
  // Just the input prompt marker "❯"
  /^\s*❯\s*$/,
  // Codex status: "• Working ✓ • Running command…"
  /^\s*•\s*(working|running|thinking|processing|waiting)\s*(…|✓|✗)?\s*$/i,
];

/** Return true if `line` looks like Claude/Codex TUI chrome and should be dropped. */
function isClaudeTuiChrome(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  for (const re of CLAUDE_TUI_CHROME_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  return false;
}

/**
 * Clean raw terminal output for LLM consumption.
 *
 * Raw ring buffer content from a PTY contains ANSI escape sequences,
 * cursor movements, and \r-based line rewrites. TUIs like Claude Code
 * repeatedly redraw the screen using these. The LLM gets confused by
 * the gibberish and produces generic nonsense names.
 *
 * Strategy:
 *  1. Strip OSC, CSI, and 2-byte ESC sequences (colors, cursor moves)
 *  2. Collapse \r\n → \n and handle bare \r as "overwrite current line"
 *  3. Drop remaining control chars except \n and tab
 *  4. Deduplicate consecutive identical lines (spinners, progress bars)
 *  5. Drop Claude Code / Codex TUI chrome lines (see CLAUDE_TUI_CHROME_PATTERNS)
 *  6. Trim trailing whitespace per line and collapse blank runs
 */
function cleanTerminalText(raw: string): string {
  // 1. Strip ANSI escape sequences
  let s = raw.replace(
    /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|\[[\x20-\x3f]*[\x40-\x7e]|[PX^_].*?\x1b\\|.)/g,
    ''
  );

  // 2. Normalize line endings and handle \r overwrite.
  //    A bare \r means "overwrite the current line from column 0".
  s = s.replace(/\r\n/g, '\n');
  const rawLines = s.split('\n');
  const resolved: string[] = [];
  for (const line of rawLines) {
    // Within a single line, \r restarts the line (spinners and progress bars)
    const segments = line.split('\r');
    let current = '';
    for (const seg of segments) {
      // Later segment overwrites earlier one from column 0, preserving
      // any characters beyond the segment's length.
      if (seg.length >= current.length) {
        current = seg;
      } else {
        current = seg + current.slice(seg.length);
      }
    }
    resolved.push(current);
  }
  s = resolved.join('\n');

  // 3. Drop remaining control chars (except \n and \t)
  s = s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');

  // 4. Trim trailing whitespace per line, dedupe consecutive lines, and
  //    drop TUI chrome lines (spinner words, footers, token counts, ...).
  const lines = s.split('\n').map(l => l.trimEnd());
  const deduped: string[] = [];
  let prev = '\u0000';
  for (const line of lines) {
    if (line === prev) continue;
    if (isClaudeTuiChrome(line)) continue;
    deduped.push(line);
    prev = line;
  }

  // 5. Collapse multiple blank lines to one
  return deduped
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const CONFIG_PATH = join(homedir(), '.config', 'vipershell', 'config.json');

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
    const dir = join(tmpdir(), 'vipershell-ai-namer');
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
  private _looksLikeOurOutput(name: string): boolean {
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
      const basename = session.path?.split('/').filter(Boolean).pop() ?? 'shell';
      const isDefaultName = session.name === basename
        || (session.name.startsWith(`${basename}-`)
            && /^\d+$/.test(session.name.slice(basename.length + 1)))
        || /^\d+$/.test(session.name)
        || /^(shell|zsh|bash|fish|sh)$/.test(session.name);
      const weOwnCurrentName = this.aiAssignedName.get(session.id) === session.name;
      if (!isDefaultName && !weOwnCurrentName) continue;

      this.inFlight.add(session.id);
      try {
        await this._nameSession(session.id, cfg.aiProvider);
      } finally {
        this.inFlight.delete(session.id);
        this.lastNamed.set(session.id, Date.now());
      }
    }
  }

  private async _nameSession(sessionId: string, provider: AIProvider): Promise<void> {
    try {
      // Get raw ring buffer output and normalize it. Raw output contains
      // ANSI escape sequences, cursor movements, and \r-based line rewrites
      // (TUIs like Claude Code redraw the whole screen constantly). Without
      // cleaning this up, the LLM sees gibberish and falls back to generic
      // guesses like "fluttering" or "downloading".
      const raw = await this.bridge!.snapshot(sessionId);
      const cleaned = cleanTerminalText(raw);
      if (!cleaned || cleaned.length < 10) return;

      // Take last 3000 chars of cleaned text so the LLM sees recent activity
      const snippet = cleaned.length > 3000 ? cleaned.slice(-3000) : cleaned;

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
      // Store hash immediately so unchanged content is never re-processed,
      // even if the LLM call below fails or times out.
      this.lastContentHash.set(sessionId, contentHash);

      const prompt = `You are naming a terminal session based on what the user is actually doing in it. Produce a concise name (2-5 words, lowercase, no emojis, no quotes, no punctuation).

Examples of good names:
- nextjs dev server
- git rebase main
- pytest integration tests
- refactor auth middleware
- npm install deps
- debug memory leak

IGNORE the following — these are UI chrome, not the task:
- Spinner words like "fluttering", "forging", "Topsy-turvying", "Baked for 34s", "thinking with medium effort"
- Claude Code / Codex footers like "bypass permissions", "shift+tab to cycle", "esc to interrupt"
- Token counts like "(1m 15s · ↓ 372 tokens)" or "/clear to save N tokens"
- The prompt marker "❯" on its own, horizontal separators, blank lines
- Generic single verbs like "downloading", "importing", "running", "working" unless they are clearly part of a real command

PREFER grounding the name in concrete signals:
- Commands the user ran (npm, git, cargo, pytest, curl, etc.) and their arguments
- Files or symbols being edited or searched
- Git branch name or PR title, if they describe the task
- Tool invocations the agent is making (Bash(...), Read(...), Edit(...))

If the visible output is only UI chrome, empty prompts, or otherwise gives you no real signal about the task, output exactly: idle

Do not guess. Do not invent names. Only base your answer on what you actually see.
${sessionCtx ? `\nSession context:\n${sessionCtx}\n` : ''}
Terminal output:
${snippet}

Session name:`;

      const invocation = buildNamerInvocation(provider, prompt);
      const cli = invocation.command;

      logger.debug(`AI naming ${sessionId}: calling isolated ${cli} (${snippet.length} chars of terminal)`);
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
      logger.debug(`AI naming failed for ${sessionId}: ${e}`);
    }
  }
}
