import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { logger } from './server.js';

const execFileAsync = promisify(execFile);

const MARKETPLACE = 'vipershell';
const PLUGIN_ID = `${MARKETPLACE}@${MARKETPLACE}`;

/** Root of the shipped package — dist/ lives one level under it, and the
 *  plugin plus its marketplace manifest sit alongside. */
function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..');
}

function shippedVersion(root: string): string | null {
  try {
    return JSON.parse(readFileSync(join(root, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? null;
  } catch { return null; }
}

/** Version currently installed into Claude Code, if any. */
function installedVersion(): string | null {
  try {
    const raw = readFileSync(join(homedir(), '.claude', 'plugins', 'installed_plugins.json'), 'utf8');
    const entries = JSON.parse(raw)?.plugins?.[PLUGIN_ID];
    return Array.isArray(entries) && entries.length ? entries[0].version ?? null : null;
  } catch { return null; }
}

/**
 * Install (or update) the Claude Code plugin that reports agent state back to
 * us, so panes light up the moment a turn ends rather than after an
 * output-silence timeout.
 *
 * Done at server start rather than in a postinstall script: `npm install`
 * should not quietly rewrite a user's global Claude Code configuration, and at
 * this point we at least know vipershell is being *used*. Opt out with
 * VIPERSHELL_NO_PLUGIN_INSTALL=1.
 *
 * `claude plugin install` copies the plugin into a version-keyed directory
 * under ~/.claude/plugins/cache, so a new vipershell release only takes effect
 * once the version in plugin.json is bumped — which is what we compare here.
 *
 * Every failure is logged and swallowed: the plugin is an optimisation, and
 * the output heuristics still work without it.
 */
export async function ensureAgentPluginInstalled(): Promise<void> {
  if (process.env.VIPERSHELL_NO_PLUGIN_INSTALL === '1') return;

  const root = packageRoot();
  const shipped = shippedVersion(root);
  if (!shipped || !existsSync(join(root, '.claude-plugin', 'marketplace.json'))) return;

  const current = installedVersion();
  if (current === shipped) return;

  // No Claude Code on this machine — nothing to install into, and not worth a
  // warning: plenty of vipershell users do not run it.
  try {
    await execFileAsync('claude', ['--version'], { timeout: 10_000 });
  } catch { return; }

  try {
    if (current) {
      // `install` refuses to touch an already-installed plugin ("already
      // installed"), so an upgrade needs the marketplace refreshed and then an
      // explicit update — otherwise every restart would re-run this and never
      // converge.
      await execFileAsync('claude', ['plugin', 'marketplace', 'update', MARKETPLACE], { timeout: 30_000 });
      await execFileAsync('claude', ['plugin', 'update', PLUGIN_ID], { timeout: 60_000 });
    } else {
      await execFileAsync('claude', ['plugin', 'marketplace', 'add', root], { timeout: 30_000 });
      await execFileAsync('claude', ['plugin', 'install', PLUGIN_ID, '--yes'], { timeout: 60_000 });
    }

    // Trust the file, not the exit code: both commands report success in
    // situations where nothing changed, and a silent no-op here would mean
    // re-running on every start forever.
    const after = installedVersion();
    if (after !== shipped) {
      logger.info(`Claude Code plugin still at ${after ?? 'none'} after install (wanted ${shipped})`);
      return;
    }
    logger.info(
      current
        ? `Updated Claude Code plugin ${PLUGIN_ID} ${current} -> ${shipped}`
        : `Installed Claude Code plugin ${PLUGIN_ID} ${shipped}`,
    );
  } catch (e) {
    logger.info(`Could not install the Claude Code plugin (agent state falls back to heuristics): ${e}`);
  }
}
