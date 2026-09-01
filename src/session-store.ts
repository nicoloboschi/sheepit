import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { configDir, sessionsDir } from './paths.js';

/** What we keep on disk about one session. */
export interface StoredSession {
  name: string;
  path: string;
  sessionType?: string | null;
  isHeadless?: boolean;
  /** Sticky DEC private modes active at the last write. Persisted because the
   *  ring cannot be trusted to still hold an app's one-time setup sequences. */
  modes?: number[];
  /** Last state the agent reported about itself, and when. */
  agent?: { state: string; source: string; at: number };
  /** Last exchange the agent reported. Superseded by `turns`; still read on
   *  restore so an upgrade does not lose the turn a running session was about
   *  to be named from. */
  turn?: { prompt?: string; response?: string; at: number };
  /** The last few exchanges, newest first, used for naming. */
  turns?: { prompt?: string; response?: string; at: number }[];
  /** PR/issue references the agent's hooks reported, newest first. Persisted
   *  because a PR is mentioned once — when it is opened or checked out — and
   *  the pane has to keep showing it long after that turn ended. */
  refs?: { kind: 'pr' | 'issue'; num: number; url?: string; repo?: string }[];
}

const LEGACY_FILE = join(configDir(), 'direct-sessions.json');

/**
 * Per-session state, one JSON file per session.
 *
 * This replaced a single direct-sessions.json holding every session, for three
 * reasons. A torn write now costs one session rather than the whole registry —
 * and that file was rewritten in full on every change while being the only
 * record of names people typed by hand. Closing a session deletes its file,
 * so per-session state stops accumulating forever the way keys in a shared
 * blob did. And several servers against one $HOME — a dev instance beside a
 * real one, or two worktrees — no longer serialise through one file.
 *
 * Files are still written atomically. Sharding removes contention *between*
 * sessions; it does nothing about two writers racing on the same session, and
 * running several servers at once is exactly when that happens.
 */
export class SessionStore {
  private dir = sessionsDir();
  /** Coalesces bursts: a turn reports twice, and modes change per keystroke. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private pending = new Map<string, StoredSession>();

  constructor(private debounceMs = 250) {
    mkdirSync(this.dir, { recursive: true });
  }

  private fileFor(id: string): string {
    // Session ids are minted internally ("direct-42"), but this builds a path,
    // so refuse anything that could climb out of the directory.
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new Error(`unsafe session id: ${id}`);
    return join(this.dir, `${id}.json`);
  }

  read(id: string): StoredSession | null {
    try {
      return JSON.parse(readFileSync(this.fileFor(id), 'utf8')) as StoredSession;
    } catch {
      return null;
    }
  }

  readAll(): Record<string, StoredSession> {
    const out: Record<string, StoredSession> = {};
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return out; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const id = name.slice(0, -'.json'.length);
      const data = this.read(id);
      // A file we cannot parse is a session we cannot restore; skipping it
      // loses one session instead of failing the whole startup.
      if (data) out[id] = data;
    }
    return out;
  }

  /** Queue a write. Coalesced per session, so a burst costs one file write. */
  write(id: string, data: StoredSession): void {
    this.pending.set(id, data);
    if (this.timers.has(id)) return;
    this.timers.set(id, setTimeout(() => {
      this.timers.delete(id);
      const queued = this.pending.get(id);
      this.pending.delete(id);
      if (queued) this.writeNow(id, queued);
    }, this.debounceMs));
  }

  /** Write immediately, bypassing the debounce (shutdown, session close). */
  writeNow(id: string, data: StoredSession): void {
    try {
      const target = this.fileFor(id);
      // Unique temp name: two servers writing the same session at once would
      // otherwise rename each other's half-written file into place.
      const tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
      renameSync(tmp, target);
    } catch { /* losing per-session state must never take the server down */ }
  }

  delete(id: string): void {
    const timer = this.timers.get(id);
    if (timer) { clearTimeout(timer); this.timers.delete(id); }
    this.pending.delete(id);
    try { rmSync(this.fileFor(id), { force: true }); } catch { /* already gone */ }
  }

  /** Flush every queued write. Called on shutdown. */
  flush(): void {
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      const queued = this.pending.get(id);
      if (queued) this.writeNow(id, queued);
    }
    this.timers.clear();
    this.pending.clear();
  }

  /**
   * One-shot import of the old single-file registry.
   *
   * Runs only when no per-session files exist yet, so it cannot overwrite
   * newer state. The old file is renamed aside rather than deleted: it is the
   * only copy of every session name, and if this went wrong that is what
   * someone would want back.
   */
  migrateFromLegacyFile(log?: (msg: string) => void): void {
    if (!existsSync(LEGACY_FILE)) return;
    if (Object.keys(this.readAll()).length > 0) return;

    let parsed: Record<string, StoredSession>;
    try {
      parsed = JSON.parse(readFileSync(LEGACY_FILE, 'utf8')) as Record<string, StoredSession>;
    } catch {
      log?.(`Could not read ${LEGACY_FILE}; leaving it alone`);
      return;
    }

    let count = 0;
    for (const [id, data] of Object.entries(parsed)) {
      if (!data || typeof data !== 'object') continue;
      try { this.writeNow(id, data); count++; } catch { /* skip bad id */ }
    }
    try { renameSync(LEGACY_FILE, `${LEGACY_FILE}.migrated`); } catch { /* keep it */ }
    log?.(`Migrated ${count} session(s) into ${this.dir}`);
  }
}
