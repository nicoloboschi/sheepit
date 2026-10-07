import { readFileSync } from 'fs';
import { join } from 'path';
import { configDir } from './paths.js';

export interface Config {
  host: string;
  port: number;
  logLevel: string;
  /** Required for any request that did not arrive directly on loopback.
   *  Unset means no auth, which is right for a laptop on its own LAN; set it
   *  before putting sheepit behind a tunnel. See src/auth.ts. */
  password?: string;
}

function loadConfig(): Partial<Config> {
  try {
    const configPath = join(configDir(), 'config.json');
    const raw = readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

const fileConfig = loadConfig();

export const config: Config = {
  host: process.env.SHEEPIT_HOST ?? fileConfig.host ?? '0.0.0.0',
  port: parseInt(process.env.SHEEPIT_PORT ?? String(fileConfig.port ?? 4444)),
  logLevel: process.env.SHEEPIT_LOG_LEVEL ?? fileConfig.logLevel ?? 'info',
  password: process.env.SHEEPIT_PASSWORD ?? fileConfig.password,
};
