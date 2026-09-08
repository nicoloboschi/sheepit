import { homedir } from 'os';
import { join } from 'path';

/**
 * The one path the PTY daemon needs — and the whole file it is allowed to
 * depend on.
 *
 * `dev.sh` decides whether the running daemon is stale by hashing its sources
 * (`DAEMON_SOURCES`) and comparing that to the hash the daemon recorded when it
 * started. A difference means "replace the daemon", and replacing the daemon
 * closes every shell it holds and kills every agent running in one.
 *
 * That check used to hash `src/paths.ts`, which holds every path in the
 * product — notes, ring buffers, vibe worktrees, a browser profile. The daemon
 * reads exactly one of them, but the hash covered all of them, so adding an
 * unrelated directory for an unrelated feature armed a trap that the next
 * ordinary `dev.sh` sprang: 24 sessions closed by a one-line addition the
 * daemon never even calls.
 *
 * So the daemon's dependency is this file, and this file holds one function.
 * `paths.ts` re-exports it, so there is still a single definition of where
 * sheepit keeps its state — but a new path added there cannot change what the
 * daemon hashes to. **Nothing else belongs in here.** A change to this file
 * should mean the daemon genuinely needs to restart.
 */

/** `~/.config/sheepit` — the single root: config, sessions, notes, buffers. */
export function configDir(): string {
  return join(homedir(), '.config', 'sheepit');
}
