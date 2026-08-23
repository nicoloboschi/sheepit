#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { DirectBridge } from './direct-bridge.js';
import { AIService } from './ai.js';
import { createApp, logger } from './server.js';
import { config } from './config.js';
import { ensureAgentPluginInstalled } from './plugin-install.js';
import { writeFileSync, mkdirSync } from 'fs';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgVersion: string = (() => {
  try { return JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')).version; }
  catch { return 'unknown'; }
})();

const program = new Command();

program
  .name('vipershell')
  .description('Your machine, anywhere — terminal sessions in your browser')
  .version(pkgVersion)
  .option('--host <host>', 'Host to bind to', config.host)
  .option('--port <port>', 'Port to listen on', String(config.port))
  .option('--log-level <level>', 'Log level (debug|info|warning|error)', config.logLevel)
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    const host = opts.host;

    const bridge = new DirectBridge();
    // Before start(): restored sessions bake this port into their environment,
    // which is how an agent's hooks find their way back to this server.
    bridge.setListenPort(port);
    await bridge.start();

    const ai = new AIService();
    ai.setBridge(bridge);
    ai.start();

    const server = await createApp(bridge, ai);

    server.listen(port, host, () => {
      const url = `http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`;

      // Advertise where we are, for agent hooks that were not given
      // VIPERSHELL_URL — panes created before this existed, or an agent
      // launched outside the shell we seeded. Always loopback: a hook runs on
      // this machine, and the bind host may be 0.0.0.0.
      try {
        const dir = join(homedir(), '.config', 'vipershell');
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'server.json'),
          JSON.stringify({ url: `http://127.0.0.1:${port}`, port, pid: process.pid }, null, 2) + '\n');
      } catch { /* advertising is best-effort; the server still works */ }

      console.log('');
      console.log('  \x1b[1m\x1b[32m\u{1F40D} vipershell\x1b[0m');
      console.log('');
      console.log(`  \x1b[2mLocal:\x1b[0m   ${url}`);
      if (host === '0.0.0.0') console.log(`  \x1b[2mNetwork:\x1b[0m http://0.0.0.0:${port}`);
      console.log('');
      logger.info(`vipershell listening on ${url}`);
    });

    // Not awaited: this shells out to the Claude CLI, and nothing about
    // serving terminals should wait on it.
    void ensureAgentPluginInstalled();

    const shutdown = async () => {
      logger.info('Shutting down\u2026');
      ai.stop();
      bridge.stop();
      server.close();
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  });

program.parse();
