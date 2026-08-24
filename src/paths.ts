import { existsSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * On-disk locations for sheepit's own state — one root, `~/.config/sheepit`.
 *
 * Every path here is plain and single-valued: the directory in use must never
 * depend on what else happens to exist on the filesystem. A running PTY daemon
 * is reachable only through the socket inside `configDir()`, so a server that
 * resolved this differently from the one before it would spawn a second daemon
 * and report zero sessions while the first kept holding every live shell.
 * `migrateLegacyStateDir()` below is a one-shot move, not a fallback, and it
 * deliberately never touches the config directory or the daemon.
 *
 * Upgrading a machine that ran the old `vipershell` build is a separate,
 * explicit step — see `scripts/migrate-from-vipershell.sh`.
 */

/** `~/.config/sheepit` — the single root: config, sessions, notes, buffers. */
export function configDir(): string {
  return join(homedir(), '.config', 'sheepit');
}

/** Markdown notes, one file per sheet. */
export function notesDir(): string {
  return join(configDir(), 'notes');
}

/** Scratch worktrees created by "new vibe session". */
export function vibeSessionsDir(): string {
  return join(configDir(), 'vibe-sessions');
}

/** Per-session state, one JSON per session — see session-store.ts. */
export function sessionsDir(): string {
  return join(configDir(), 'sessions');
}

/** Saved ring buffers, one per session. */
export function ringBuffersDir(): string {
  return join(configDir(), 'ring-buffers');
}

/** The legacy second root, kept only so the move below can find it. */
function legacyStateDir(): string {
  return join(homedir(), '.sheepit');
}

/**
 * Fold the old `~/.sheepit` root into `~/.config/sheepit`, once.
 *
 * Notes and vibe-session worktrees used to live in a second home-directory
 * root, so "where is my state" had two answers. This moves the two directories
 * sheepit owns and leaves everything else in place — people keep unrelated
 * files there, and a migration that empties a directory it does not own is a
 * migration nobody trusts.
 *
 * Safe to run with live sessions: a rename within one filesystem keeps the
 * inode, so a shell already sitting in a vibe-session directory carries on
 * working. Unlike a resolve-time fallback this runs once and then the new path
 * is the only answer, so two servers can never disagree about where state is.
 */
export function migrateLegacyStateDir(log?: (msg: string) => void): void {
  const legacy = legacyStateDir();
  if (!existsSync(legacy)) return;

  for (const [name, target] of [['notes', notesDir()], ['vibe-sessions', vibeSessionsDir()]] as const) {
    const from = join(legacy, name);
    if (!existsSync(from) || existsSync(target)) continue;
    try {
      mkdirSync(configDir(), { recursive: true });
      renameSync(from, target);
      log?.(`Moved ${from} -> ${target}`);
    } catch (e) {
      // Across filesystems, or a permissions problem. Leaving the old copy
      // alone is the safe failure: nothing is lost, the directory is simply
      // not visible until this succeeds.
      log?.(`Could not move ${from} (${e}); leaving it in place`);
    }
  }

  // Only tidy up if we emptied it. Anything else in there belongs to someone.
  try {
    if (readdirSync(legacy).filter(n => n !== '.metadata_never_index').length === 0) {
      log?.(`${legacy} is empty after migration; you can remove it`);
    }
  } catch { /* nothing to report */ }
}
