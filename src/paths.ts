import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * On-disk locations for sheepit's own state.
 *
 * sheepit used to be called vipershell, and a machine that ran the old build
 * still has its sessions, scrollback, config and notes under the vipershell
 * paths. Both helpers prefer the new directory and fall back to the legacy one
 * when that is the only one present, so nothing has to move for an upgrade to
 * work. New installs only ever see the sheepit paths.
 *
 * To actually adopt the new name, move the directory — `mv ~/.config/vipershell
 * ~/.config/sheepit`. That is safe even with shells running: the PTY daemon is
 * reached through a unix socket *inside* this directory, and a socket is bound
 * by inode, so it keeps serving through a rename of its parent.
 */

/** Does this directory hold a PTY daemon that is still alive? */
function hasLiveDaemon(dir: string): boolean {
  try {
    const pid = parseInt(readFileSync(join(dir, 'pty-daemon.pid'), 'utf-8').trim(), 10);
    if (!Number.isFinite(pid)) return false;
    process.kill(pid, 0); // throws unless the process exists
    return existsSync(join(dir, 'pty-daemon.sock'));
  } catch {
    return false;
  }
}

/** `~/.config/sheepit` — config.json, sessions.json, scrollback, daemon logs. */
export function configDir(): string {
  const parent = join(homedir(), '.config');
  const current = join(parent, 'sheepit');
  const legacy = join(parent, 'vipershell');

  // A running PTY daemon can only be found through the socket in the directory
  // it started in. If we switched directories while one was alive, the next
  // server would see no daemon, spawn a second one, and report zero sessions —
  // while the first daemon kept holding every live shell, now unreachable. So
  // a directory with a live daemon wins over everything else, and the choice
  // can never flip underneath a running flock.
  if (hasLiveDaemon(legacy) && !hasLiveDaemon(current)) return legacy;

  if (existsSync(current)) return current;
  if (existsSync(legacy)) return legacy;
  return current;
}

/** `~/.sheepit` — notes and vibe-session worktrees. No daemon lives here, so
 *  this is a plain "new one if it exists, else the old one" choice. */
export function stateDir(): string {
  const current = join(homedir(), '.sheepit');
  if (existsSync(current)) return current;
  const legacy = join(homedir(), '.vipershell');
  if (existsSync(legacy)) return legacy;
  return current;
}
