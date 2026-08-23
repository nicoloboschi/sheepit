import { readFileSync } from 'fs';
import { join } from 'path';
import { configDir } from './paths.js';

export interface Config {
  host: string;
  port: number;
  logLevel: string;
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

/* The VIPERSHELL_* spellings are the pre-rename names. They stay as a fallback
 * so a machine whose shell profile still exports them keeps working. */
export const config: Config = {
  host: process.env.SHEEPIT_HOST ?? process.env.VIPERSHELL_HOST ?? fileConfig.host ?? '0.0.0.0',
  port: parseInt(process.env.SHEEPIT_PORT ?? process.env.VIPERSHELL_PORT ?? String(fileConfig.port ?? 4444)),
  logLevel: process.env.SHEEPIT_LOG_LEVEL ?? process.env.VIPERSHELL_LOG_LEVEL ?? fileConfig.logLevel ?? 'info',
};
