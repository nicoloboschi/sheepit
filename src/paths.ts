import { homedir } from 'os';
import { join } from 'path';

/**
 * On-disk locations for sheepit's own state.
 *
 * Both are plain, single-valued paths: the directory in use must never depend
 * on what else happens to exist on the filesystem. A running PTY daemon is
 * reachable only through the socket inside `configDir()`, so a server that
 * resolved this differently from the one before it would spawn a second daemon
 * and report zero sessions, while the first kept holding every live shell.
 *
 * Upgrading a machine that ran the old `vipershell` build is a one-time,
 * explicit move — see `scripts/migrate-from-vipershell.sh`.
 */

/** `~/.config/sheepit` — config.json, sessions.json, scrollback, daemon socket. */
export function configDir(): string {
  return join(homedir(), '.config', 'sheepit');
}

/** `~/.sheepit` — notes and vibe-session worktrees. */
export function stateDir(): string {
  return join(homedir(), '.sheepit');
}
