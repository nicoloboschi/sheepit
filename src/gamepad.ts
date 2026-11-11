/**
 * Game controller presses, read by macOS and published to the UI.
 *
 * Chromium can't see some pads on macOS (a Switch Pro over Bluetooth shows up
 * in GameController but never in `navigator.getGamepads()`), so the server
 * runs `native/gamepad.swift` and publishes each press on `__sessions__` as
 * `{ type: 'gamepad', button }`. The UI decides what a button does.
 *
 * The helper is compiled on first use with `swiftc` (Xcode command line
 * tools) into the config dir, keyed on the source's hash. No swiftc, no
 * controller — the rest of sheepit doesn't care.
 */
import { spawn, execFile } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, readFileSync, renameSync } from 'fs';
import { dirname, join } from 'path';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import { configDir } from './paths.js';

const SOURCE = join(dirname(fileURLToPath(import.meta.url)), '..', 'native', 'gamepad.swift');
const RESTART_MS = 5000;

export function startGamepad(onPress: (button: string) => void, log: (msg: string) => void): void {
  if (process.platform !== 'darwin' || !existsSync(SOURCE)) return;
  const hash = createHash('sha1').update(readFileSync(SOURCE)).digest('hex').slice(0, 10);
  const bin = join(configDir(), `gamepad-${hash}`);

  const run = () => {
    const child = spawn(bin, [], { stdio: ['pipe', 'pipe', 'ignore'] });
    createInterface({ input: child.stdout }).on('line', line => { if (line) onPress(line.trim()); });
    child.on('error', e => log(`[gamepad] ${e.message}`));
    child.on('exit', () => setTimeout(run, RESTART_MS).unref());
  };

  if (existsSync(bin)) { run(); return; }
  // Built beside, then renamed: a server killed mid-build leaves no half binary.
  const tmp = `${bin}.${process.pid}.tmp`;
  execFile('swiftc', ['-O', SOURCE, '-o', tmp], (err) => {
    if (err) { log(`[gamepad] no controller support: swiftc failed (${err.message.split('\n')[0]})`); return; }
    renameSync(tmp, bin);
    run();
  });
}
