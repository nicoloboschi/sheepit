import { execFile } from 'child_process';
import { existsSync, readFileSync, readdirSync, copyFileSync, cpSync, mkdirSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';
import { logger } from './server.js';

const execFileAsync = promisify(execFile);

const MARKETPLACE = 'sheepit';
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

/** Version currently installed into Codex, if any.
 *
 *  Two things have to agree. config.toml is what makes Codex load the plugin,
 *  and the cache directory is what carries its version — and they can drift:
 *  a cache directory left behind by an earlier install made this report a
 *  version for a plugin Codex was no longer loading at all, so the next start
 *  saw nothing to do and the plugin stayed silently absent. Treat a missing
 *  config entry as not installed, whatever is on disk. */
function codexInstalledVersion(): string | null {
  try {
    const config = readFileSync(join(homedir(), '.codex', 'config.toml'), 'utf8');
    if (!config.includes(`[plugins."${PLUGIN_ID}"]`)) return null;
  } catch { return null; }
  try {
    const dir = join(homedir(), '.codex', 'plugins', 'cache', MARKETPLACE, MARKETPLACE);
    const versions = readdirSync(dir).filter(v => /^\d/.test(v)).sort();
    return versions.length ? versions[versions.length - 1]! : null;
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
 * this point we at least know sheepit is being *used*. Opt out with
 * SHEEPIT_NO_PLUGIN_INSTALL=1.
 *
 * `claude plugin install` copies the plugin into a version-keyed directory
 * under ~/.claude/plugins/cache, so a new sheepit release only takes effect
 * once the version in plugin.json is bumped — which is what we compare here.
 *
 * Every failure is logged and swallowed: the plugin is an optimisation, and
 * the output heuristics still work without it.
 */
export async function ensureAgentPluginInstalled(): Promise<void> {
  if (process.env.SHEEPIT_NO_PLUGIN_INSTALL === '1') return;

  const root = packageRoot();
  const shipped = shippedVersion(root);
  if (!shipped || !existsSync(join(root, '.claude-plugin', 'marketplace.json'))) return;

  await Promise.all([
    installIntoClaude(root, shipped),
    installIntoCodex(root, shipped),
  ]);

  // Reach the sessions that are already running, not just the next one.
  const refreshed = syncPluginScriptsIntoCaches(root);
  if (refreshed) logger.debug(`Refreshed plugin scripts in ${refreshed} cached copies`);
}

/** Every version-keyed copy of this plugin on disk, across both agents. */
function pluginCacheDirs(): string[] {
  const roots = [
    join(homedir(), '.claude', 'plugins', 'cache', MARKETPLACE, MARKETPLACE),
    join(homedir(), '.codex', 'plugins', 'cache', MARKETPLACE, MARKETPLACE),
  ];
  const dirs: string[] = [];
  for (const root of roots) {
    try {
      for (const v of readdirSync(root)) {
        if (!/^\d/.test(v)) continue;
        const dir = join(root, v);
        if (statSync(dir).isDirectory()) dirs.push(dir);
      }
    } catch { /* that agent has never installed it */ }
  }
  return dirs;
}

/**
 * Overwrite the scripts in EVERY cached copy, old versions included.
 *
 * An agent resolves `CLAUDE_PLUGIN_ROOT` when it starts and keeps using that
 * directory for its whole life. Installing 0.9.0 therefore does nothing for a
 * session that started on 0.6.0 — it goes on executing 0.6.0's scripts until
 * someone restarts it, which is why a fix to the reporter never reached the
 * sessions that most needed it.
 *
 * The hook *command* is a fresh process reading the file from disk each time
 * it fires, so overwriting the script does reach a running session. That makes
 * this the one way to ship a script fix without asking for a restart.
 *
 * What it deliberately cannot do is change WHICH events fire: hooks.json is
 * read once when the agent starts, so a newly wired event still needs a
 * restart. Copying it anyway keeps the directories self-consistent for
 * whenever that restart happens.
 */
export function syncPluginScriptsIntoCaches(root: string): number {
  const from = join(root, 'plugin');
  if (!existsSync(from)) return 0;

  let updated = 0;
  for (const dir of pluginCacheDirs()) {
    for (const sub of ['bin', 'hooks']) {
      const src = join(from, sub);
      const dest = join(dir, sub);
      try {
        if (!existsSync(src)) continue;
        mkdirSync(dest, { recursive: true });
        for (const file of readdirSync(src)) copyFileSync(join(src, file), join(dest, file));
        updated++;
      } catch (e) {
        // A cache we cannot write is not worth failing a server start over.
        logger.debug(`Could not refresh plugin scripts in ${dest}: ${e}`);
      }
    }
  }
  return updated;
}

/** Whether an agent's CLI exists on this machine at all. */
async function agentAvailable(bin: string): Promise<boolean> {
  try {
    await execFileAsync(bin, ['--version'], { timeout: 10_000 });
    return true;
  } catch { return false; }
}

export interface AgentPluginState {
  /** The agent's CLI is on PATH. When false, nothing here is installable. */
  available: boolean;
  /** Version that agent currently has installed, or null for none. */
  installed: string | null;
}

export interface PluginStatus {
  /** Version bundled with the sheepit build that is running. */
  shipped: string | null;
  claude: AgentPluginState;
  codex: AgentPluginState;
}

/** Read-only: what is bundled, and what each agent currently has. */
export async function getPluginStatus(): Promise<PluginStatus> {
  const root = packageRoot();
  const [claudeAvailable, codexAvailable] = await Promise.all([
    agentAvailable('claude'),
    agentAvailable('codex'),
  ]);
  return {
    shipped: shippedVersion(root),
    claude: { available: claudeAvailable, installed: installedVersion() },
    codex: { available: codexAvailable, installed: codexInstalledVersion() },
  };
}

/**
 * Reinstall the plugin into every agent found, whatever versions say.
 *
 * The startup path deliberately skips when the installed version already
 * matches, or every server start would reinstall forever. That check is wrong
 * for someone who has edited `plugin/` in a checkout and wants that code
 * running: the version has not moved, but the files have. This is the escape
 * hatch behind the Settings button.
 *
 * Returns the status observed afterwards, so the caller can show what actually
 * landed rather than trusting an exit code — both CLIs report success in cases
 * where nothing changed.
 */
export async function reinstallAgentPlugin(): Promise<PluginStatus> {
  const root = packageRoot();
  const shipped = shippedVersion(root);
  if (!shipped || !existsSync(join(root, '.claude-plugin', 'marketplace.json'))) {
    return getPluginStatus();
  }
  await Promise.all([
    installIntoClaude(root, shipped, true),
    installIntoCodex(root, shipped, true),
  ]);
  syncPluginScriptsIntoCaches(root);
  return getPluginStatus();
}

/**
 * Codex reads the very same .claude-plugin/marketplace.json and the same
 * hooks/hooks.json, so one plugin serves both agents.
 *
 * It has no in-place upgrade for a local marketplace — `plugin add` on an
 * installed plugin is a no-op — so an update is remove-then-add. Its plugin
 * system is also independent of the legacy `notify` config key, which is
 * frequently already spoken for (Codex Computer Use sets it), and must not be
 * disturbed.
 */
async function installIntoCodex(root: string, shipped: string, force = false): Promise<void> {
  const current = codexInstalledVersion();
  // `force` is what the Settings button uses. Version equality means "the
  // build you are running already shipped this", which is exactly the wrong
  // test when someone has edited the plugin in place and wants that code out
  // there — so a forced run always reinstalls.
  if (current === shipped && !force) return;

  try {
    await execFileAsync('codex', ['--version'], { timeout: 10_000 });
  } catch { return; }

  try {
    await execFileAsync('codex', ['plugin', 'marketplace', 'add', root], { timeout: 30_000 });
    if (current) await execFileAsync('codex', ['plugin', 'remove', PLUGIN_ID], { timeout: 30_000 }).catch(() => {});
    await execFileAsync('codex', ['plugin', 'add', PLUGIN_ID], { timeout: 60_000 });

    const after = codexInstalledVersion();
    if (after !== shipped) {
      logger.info(`Codex plugin still at ${after ?? 'none'} after install (wanted ${shipped})`);
      return;
    }
    // Put the directory we just deleted back. See restoreCodexVersionDir.
    if (current && current !== shipped) restoreCodexVersionDir(current, shipped);
    logger.info(
      current
        ? `Updated Codex plugin ${PLUGIN_ID} ${current} -> ${shipped}`
        : `Installed Codex plugin ${PLUGIN_ID} ${shipped}`,
    );
  } catch (e) {
    logger.info(`Could not install the Codex plugin (agent state falls back to none): ${e}`);
  }
}

/**
 * Re-create the cache directory an upgrade just deleted, holding the new code.
 *
 * Codex has no in-place upgrade for a local marketplace, so an update is
 * remove-then-add — and `plugin remove` deletes the whole version-keyed
 * directory. Every Codex session that is *already running* resolved
 * CLAUDE_PLUGIN_ROOT to that directory when it started and keeps using the
 * path for its whole life, so removing it does not quietly downgrade those
 * sessions: it makes every one of their hooks fail. `sh` cannot find
 * post.sh, so the failure lands on PreToolUse and PostToolUse — which is to
 * say on every tool call the agent makes, with an error in the TUI each time.
 *
 * That turns a version bump into a visible break of every open Codex pane,
 * which is a far worse outcome than the stale hooks the bump was fixing.
 *
 * Claude Code never had the problem: it leaves old version directories in
 * place, which is the assumption syncPluginScriptsIntoCaches is built on.
 * This restores the same property for Codex — the old path resolves again,
 * and what it resolves to is the *new* code, so a running session gets the
 * fix rather than merely surviving.
 *
 * hooks.json is still only read at startup, so a newly wired *event* still
 * needs a restart. What this buys is that nothing breaks in the meantime.
 */
function restoreCodexVersionDir(oldVersion: string, shipped: string): void {
  const base = join(homedir(), '.codex', 'plugins', 'cache', MARKETPLACE, MARKETPLACE);
  const from = join(base, shipped);
  const to = join(base, oldVersion);
  try {
    if (!existsSync(from) || existsSync(to)) return;
    cpSync(from, to, { recursive: true });
    logger.debug(`Restored Codex plugin dir ${oldVersion} so running sessions keep their hooks`);
  } catch (e) {
    logger.info(`Could not restore Codex plugin dir ${oldVersion}: ${e}`);
  }
}

async function installIntoClaude(root: string, shipped: string, force = false): Promise<void> {
  const current = installedVersion();
  if (current === shipped && !force) return;

  // No Claude Code on this machine — nothing to install into, and not worth a
  // warning: plenty of sheepit users do not run it.
  try {
    await execFileAsync('claude', ['--version'], { timeout: 10_000 });
  } catch { return; }

  try {
    if (current && force) {
      // A forced reinstall at the SAME version cannot use `update` — there is
      // nothing newer to update to and it would report success having done
      // nothing. Tear it out and put it back so the files on disk are the
      // files in this checkout.
      await execFileAsync('claude', ['plugin', 'marketplace', 'add', root], { timeout: 30_000 }).catch(() => {});
      await execFileAsync('claude', ['plugin', 'marketplace', 'update', MARKETPLACE], { timeout: 30_000 }).catch(() => {});
      await execFileAsync('claude', ['plugin', 'uninstall', PLUGIN_ID], { timeout: 60_000 }).catch(() => {});
      await execFileAsync('claude', ['plugin', 'install', PLUGIN_ID, '--yes'], { timeout: 60_000 });
    } else if (current) {
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
