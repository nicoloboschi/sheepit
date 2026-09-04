import { readFileSync, writeFileSync, mkdirSync, openSync, readSync, closeSync, fstatSync } from 'fs';
import { join, dirname } from 'path';
import { configDir } from './paths.js';
import { logger } from './server.js';
import type { DirectBridge } from './direct-bridge.js';

/** The namer's CLI was killed rather than having failed.
 *
 *  Worth its own type because it is worth retrying and an ordinary failure is
 *  not: the CLI dying by signal 50ms after spawn, with no output, is the
 *  machine refusing to start it — on a box deep in swap, macOS kills a fresh
 *  ~150MB process at exec. Seconds later there is usually room. */
const CONFIG_PATH = join(configDir(), 'config.json');

/**
 * What is left of the naming config now that nothing calls a model.
 *
 * A pane is named from the title Claude Code writes into its own transcript
 * (see readAgentTitle), so there is no provider to choose, no CLI to point at
 * and no prompt to tune — only whether to do it, and how often to look.
 */
export interface AIConfig {
  autoNaming: boolean;
  autoNamingIntervalSecs: number;
}

const AI_DEFAULTS: AIConfig = {
  autoNaming: true,
  autoNamingIntervalSecs: 30,
};

/**
 * What a pane is called after `/clear` wiped its context.
 *
 * `/clear` shears the session: everything it knew is gone, so leaving the old
 * name on it is actively misleading — the pen card would still advertise work
 * the agent can no longer remember doing.
 *
 * A dash rather than the directory's name, which is what this used to be. The
 * pane bar already carries the cwd as the title's subtitle, so naming the pane
 * after its directory said the same thing twice, and it read as a *name* —
 * indistinguishable from a pane deliberately called after its project. A dash
 * says the honest thing: nothing yet. It is short-lived now in a way it was
 * not before, because the agent writes a title of its own within a turn or two
 * and this is only what stands there until it does.
 */
export const CLEARED_SESSION_NAME = '-';

/** What older builds wrote there, kept only so those panes can be moved on. */
const LEGACY_CLEARED_NAME = 'freshly shorn';

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
/* Uppercase is in the charset because Claude Code's own `ai-title` is Sentence
 * case ("Litellm-sdk bedrock support") and that title is now a naming source.
 * A reader that could not claim it would freeze every pane it named — the
 * failure this whole contract exists to prevent. It also reclaims the names
 * older writers produced before the identifier rule, which is why panes called
 * "check PR 1251 CI" had been stuck since it landed.
 *
 * `#` is here for the reader alone — normalizeAssignedName strips `#123`, so
 * the writer can never produce one. It is the only way to reclaim the names
 * written before the identifier rule ("merge pr #1837"), which were otherwise
 * frozen for good: disowned at every restart, and refused by isRenameable.
 *
 * The cost is real and was taken deliberately: a short name typed by hand is
 * now claimable too, so the namer may replace it. The shape test is the only
 * ownership signal there is after a restart. */
const NAME_CHARSET = /^[A-Za-z][A-Za-z0-9 ._#-]*$/;
const MAX_NAME_WORDS = 6;
const MAX_NAME_LEN = 60;

/** Could this name have come from us? Drives ownership after a restart.
 *
 *  Deliberately a shape test and not a memory: the alternative is persisting
 *  ownership, and a name we cannot recognise is one we can never fix. */
export function looksLikeAssignedName(raw: string): boolean {
  const name = stripNameDecoration(raw);
  // The cleared placeholder is ours by definition and cannot pass the charset
  // below — it has no letter to lead with. Without this line every pane that
  // was cleared would freeze on the dash at the next restart, disowned and
  // then refused by isRenameable: the exact failure this pair exists for.
  if (name === CLEARED_SESSION_NAME) return true;
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
export function normalizeAssignedName(raw: string, opts?: { keepCase?: boolean }): string | null {
  const decorated = stripNameDecoration(raw);
  let name = (opts?.keepCase ? decorated : decorated.toLowerCase())
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
    .replace(/\b(prs?|pull(?:\s+request)?s?|issues?|tickets?)\b[\s#:_-]*\d+/gi, ' ')
    .replace(/#\d+/g, ' ')
    // Uuids and commit hashes, which the prompt also forbids and which an
    // agent title volunteers: "Recall metrics for org 81db9954-2fb1-…" was a
    // live pane. A uuid is 36 characters of nothing you can read at a glance,
    // and it survived the rules above because it is one word and no `#`.
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, ' ')
    .replace(/\b(?=[0-9a-f]*\d)[0-9a-f]{7,}\b/gi, ' ')
    .replace(/[^A-Za-z0-9 ._-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    // The charset requires a letter first; a name that is only punctuation and
    // digits has nothing to lead with and is rejected below.
    .replace(/^[^A-Za-z]+/, '')
    .trim();

  const words = name.split(' ').filter(Boolean).slice(0, MAX_NAME_WORDS);
  // Drop whole words before cutting one in half — a truncated word reads as a
  // bug, a shorter name just reads as a shorter name.
  while (words.length > 1 && words.join(' ').length > MAX_NAME_LEN) words.pop();
  name = words.join(' ').slice(0, MAX_NAME_LEN).trim();

  return looksLikeAssignedName(name) ? name : null;
}

/**
 * The title Claude Code gave its own session.
 *
 * Claude writes an `ai-title` row into its transcript every turn, and it is a
 * better name than anything we can derive: it is written by the agent doing
 * the work, from the whole conversation rather than the last three exchanges,
 * and it costs no model call of ours. "Litellm-sdk bedrock support" is what it
 * produced for a pane our own namer had called "merge".
 *
 * Codex has no equivalent — its rollouts carry `session_meta`, `turn_context`
 * and `response_item` and no title anywhere — so those panes still go to the
 * namer. This returning null is the normal case for half the flock, not a
 * failure.
 *
 * Read from the tail: a transcript runs to hundreds of megabytes, the rows are
 * one per turn, and only the last one is the current title.
 */
export function readAgentTitle(transcriptPath: string): string | null {
  const TAIL = 256 * 1024;
  let fd: number | null = null;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const length = Math.min(size, TAIL);
    const buf = Buffer.alloc(length);
    readSync(fd, buf, 0, length, size - length);
    // A tail almost always starts mid-line; that first partial line is dropped
    // rather than parsed, and it can never be the last title anyway.
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 1; i--) {
      const line = lines[i]!;
      if (!line.includes('"ai-title"')) continue;
      try {
        const row = JSON.parse(line) as { type?: string; aiTitle?: unknown };
        if (row.type === 'ai-title' && typeof row.aiTitle === 'string' && row.aiTitle.trim()) {
          return row.aiTitle.trim();
        }
      } catch { /* a row we cannot read is not a title */ }
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== null) try { closeSync(fd); } catch { /* already gone */ }
  }
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
  /** When each session was last looked at, so a sweep is not a file read per
   *  pane per tick. Reading a title is cheap, but it is still a syscall. */
  private lastNamed = new Map<string, number>();
  /**
   * Names we assigned. If `session.name` still matches ours we own it and may
   * refresh it as the work moves on; if it does not, a human renamed it and we
   * leave it alone. In memory only — after a restart, ownership is worked out
   * from the name's shape (see looksLikeAssignedName).
   */
  private aiAssignedName = new Map<string, string>();

  getConfig(): AIConfig {
    try {
      const raw = readFileSync(CONFIG_PATH, 'utf8');
      const data = JSON.parse(raw);
      return {
        // `aiEnabled` was the master switch over a naming pipeline that no
        // longer exists. It is still honoured as an off switch so a profile
        // that turned naming off does not have it turned back on by upgrading.
        autoNaming: (data.aiEnabled ?? true) && (data.aiAutoNaming ?? AI_DEFAULTS.autoNaming),
        autoNamingIntervalSecs: data.aiAutoNamingIntervalSecs ?? AI_DEFAULTS.autoNamingIntervalSecs,
      };
    } catch {
      return { ...AI_DEFAULTS };
    }
  }

  saveConfig(updates: Partial<AIConfig>): void {
    let data: Record<string, unknown> = {};
    try { data = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { /* fresh */ }
    if ('autoNaming' in updates) {
      data.aiAutoNaming = updates.autoNaming;
      // The old master switch is written too, or turning naming on here would
      // be silently overruled by an `aiEnabled: false` left in the file.
      data.aiEnabled = updates.autoNaming;
    }
    if ('autoNamingIntervalSecs' in updates) data.aiAutoNamingIntervalSecs = updates.autoNamingIntervalSecs;
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(data, null, 2) + '\n');
  }

  setBridge(bridge: DirectBridge): void {
    this.bridge = bridge;
    // Ownership after a restart is worked out from each name's shape, since
    // nothing about it is persisted — see looksLikeAssignedName.
    this._seedAiAssignedNames().catch(e =>
      logger.debug(`name seed failed: ${e}`),
    );
  }

  private async _seedAiAssignedNames(): Promise<void> {
    if (!this.bridge) return;
    const sessions = await this.bridge.listSessions();
    for (const s of sessions) {
      if (looksLikeAssignedName(s.name)) {
        this.aiAssignedName.set(s.id, s.name);
        // Repair a claimed name on the spot when the agent's own title says
        // something better. Without this a pane frozen before the identifier
        // rule stays frozen in practice: the sweep only names a session whose
        // exchanges have changed, so an idle pane keeps a name like
        // "merge pr #1837" until someone happens to work in it again.
        const transcript = this.bridge.resolveAgentTranscript(s.id);
        const title = transcript ? readAgentTitle(transcript) : null;
        const better = title && normalizeAssignedName(title, { keepCase: true });
        if (better && better !== s.name) {
          this.aiAssignedName.set(s.id, better);
          await this.bridge.renameSession(s.id, better);
          logger.info(`AI naming: reclaimed ${s.id} "${s.name}" → "${better}"`);
        }
      }
      // Panes cleared by an older build carry that build's placeholder — the
      // literal string, so this is idempotent — and would otherwise sit on it
      // until someone renamed them by hand.
      if (s.name === LEGACY_CLEARED_NAME) {
        this.aiAssignedName.set(s.id, CLEARED_SESSION_NAME);
        await this.bridge.renameSession(s.id, CLEARED_SESSION_NAME);
        logger.info(`Naming: cleared pane ${s.id} → "${CLEARED_SESSION_NAME}"`);
      }
    }
    if (this.aiAssignedName.size > 0) {
      logger.debug(`AI naming: seeded ${this.aiAssignedName.size} tracked session name(s) for rescue`);
    }
  }


  start(): void {
    this.stop();
    const cfg = this.getConfig();
    if (!cfg.autoNaming) return;

    const intervalMs = (cfg.autoNamingIntervalSecs || 30) * 1000;
    this.namingTimer = setInterval(() => this._runAutoNaming(), intervalMs);
    logger.info(`Auto-naming started (every ${cfg.autoNamingIntervalSecs}s, from the agents' own titles)`);
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
    if (!cfg.autoNaming) return;

    const sessions = await this.bridge.listSessions();
    const now = Date.now();
    const minInterval = (cfg.autoNamingIntervalSecs || 30) * 1000;

    for (const session of sessions) {
      const lastTime = this.lastNamed.get(session.id) ?? 0;
      if (now - lastTime < minInterval) continue;

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

      try {
        await this._nameSession(session.id);
      } finally {
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
  }

  /**
   * Give a pane the name its agent gave itself.
   *
   * There used to be a model call here: three exchanges, a prompt with six
   * rules in it, a one-shot `claude -p` or `codex exec` per pane per sweep.
   * Claude Code writes an `ai-title` into its own transcript every turn — from
   * the whole conversation, not the last three turns — so the prompt was
   * paying a model to do worse what the file already said.
   *
   * Codex writes no title, so a Codex pane keeps whatever name it has. That is
   * the deliberate cost of the removal: the alternative was keeping a naming
   * pipeline, and its prompt, alive for the agent it named least well.
   */
  private async _nameSession(sessionId: string): Promise<void> {
    const transcript = this.bridge!.resolveAgentTranscript(sessionId);
    if (!transcript) return;
    const title = readAgentTitle(transcript);
    if (!title) return;

    // Case is kept: the title is written Sentence case on purpose and reads as
    // a title. Identifiers still come out — a PR number says nothing about the
    // work, and the pane bar already shows it.
    const assigned = normalizeAssignedName(title, { keepCase: true });
    if (!assigned || this.aiAssignedName.get(sessionId) === assigned) return;

    await this.bridge!.renameSession(sessionId, assigned);
    this.aiAssignedName.set(sessionId, assigned);
    logger.info(`Named ${sessionId} → "${assigned}" (agent title)`);
  }
}
