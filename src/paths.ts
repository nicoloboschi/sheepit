import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

/**
 * On-disk locations for sheepit's own state.
 *
 * sheepit used to be called vipershell, and a machine that ran the old build
 * still has its sessions, scrollback, config and notes under the vipershell
 * paths. Rather than move them out from under a possibly-running server, both
 * helpers prefer the new directory and fall back to the legacy one when that
 * is the only one present. New installs only ever see the sheepit paths.
 */
function pickDir(parent: string, current: string, legacy: string): string {
  const currentPath = join(parent, current);
  if (existsSync(currentPath)) return currentPath;
  const legacyPath = join(parent, legacy);
  if (existsSync(legacyPath)) return legacyPath;
  return currentPath;
}

/** `~/.config/sheepit` — config.json, sessions.json, scrollback, daemon logs. */
export function configDir(): string {
  return pickDir(join(homedir(), '.config'), 'sheepit', 'vipershell');
}

/** `~/.sheepit` — notes and vibe-session worktrees. */
export function stateDir(): string {
  return pickDir(homedir(), '.sheepit', '.vipershell');
}
