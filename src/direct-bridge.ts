/**
 * DirectBridge — terminal backend using a separate PTY daemon process.
 *
 * PTYs live in a detached daemon process (pty-daemon.ts) that survives
 * server restarts. The bridge communicates with the daemon over a unix
 * domain socket. Output is stored in a ring buffer for instant session
 * restore. The atomic subscribe pattern guarantees zero lost/duplicated output.
 */

import * as net from 'net';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { exec } from 'child_process';
import { PubSub } from './pubsub.js';
import { config } from './config.js';
import type { BridgeMessage, Session } from './protocol.js';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { configDir, ringBuffersDir } from './paths.js';
import { SessionStore, type StoredSession } from './session-store.js';
import { logger } from './server.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────────────────────

const CONFIG_DIR = configDir();
const RING_DIR = ringBuffersDir();
const RING_SIZE = 256 * 1024;

/** Coalescing window for `current_input` broadcasts (see publishCurrentInput).
 *  Short enough that the sidebar still feels live, long enough that a fast
 *  typist produces ~20 broadcasts/second instead of one per character. */
const INPUT_PUBLISH_MS = 50;

/** Coalescing window for persisting sticky-mode changes (see schedulePersist). */
const PERSIST_DEBOUNCE_MS = 1000;

/** How long an agent-reported "busy" is trusted before the session is assumed
 *  idle again.
 *
 *  The report is authoritative but its delivery is not: a `kill -9`, a crashed
 *  agent or a hook that timed out means the matching "idle" never arrives, and
 *  since nothing else drives this flag any more, such a session would spin
 *  forever. An hour is far longer than any single model turn, so this only
 *  fires for a session whose agent genuinely went away. */
const AGENT_STATE_TTL_MS = 60 * 60_000;

/** How much of a session's ring the preview sweep decodes. A preview is two
 *  lines; this is generous even for very wide panes. */
const PREVIEW_TAIL_BYTES = 8 * 1024;

/** How many external commands a background sweep may have in flight.
 *
 *  `child_process` spawning does synchronous fork/exec work on the main thread,
 *  so firing one per repo at once blocks the event loop — and a blocked loop is
 *  a keystroke that hasn't reached the PTY yet. Measured on a 25-repo, 34-session
 *  setup: the unbounded git sweep stalled the loop for up to 1.6 seconds. */
const EXEC_CONCURRENCY = 4;

/** How long per-session process stats (the CPU/mem chips) may go stale.
 *
 *  Deliberately decoupled from the 2s session-list publish: the list must stay
 *  responsive so a newly opened pane appears promptly, but the stats behind it
 *  need a `ps` of every process on the machine, which is the expensive part. */
const PROC_INFO_TTL_MS = 10_000;

/** Run a background sweep's command at reduced scheduling priority.
 *
 *  These sweeps (ps / git / gh) are housekeeping: nothing waits on them, and
 *  they exist to keep sidebar chips fresh. On a machine loaded by the agents
 *  running *inside* sheepit — measured at load average 12–16, where even a
 *  raw `cat` echo showed a 200 ms p90 — letting them compete at normal priority
 *  with the PTYs and the browser is what turns housekeeping into input lag. */
const nice = (cmd: string) => `nice -n 10 ${cmd}`;

/** A state a coding agent reports about itself through its own hooks.
 *
 *  'waiting' is the one the output heuristics can never express: the agent is
 *  alive but blocked on the user (a permission prompt), which looks identical
 *  to "finished" from the outside — silent, no CPU.
 *  'unknown' clears the record and hands the session back to the heuristics. */
export type AgentState = 'busy' | 'idle' | 'waiting' | 'unknown';

/** The last exchange in a session, as reported by the agent itself.
 *
 *  What the user asked and what the agent answered is a far better basis for
 *  naming a session than its terminal output, which for a TUI agent is mostly
 *  spinners, footers and redraws. */
export interface AgentTurn {
  prompt?: string;
  response?: string;
  at: number;
}

export const AGENT_STATES: readonly AgentState[] = ['busy', 'idle', 'waiting', 'unknown'];

/** A desktop notification an app asked the terminal to show. */
export interface TerminalNotification {
  /** Notification id, when the protocol carries one (OSC 99 chunks share it). */
  id: string;
  text: string;
  /** False while more chunks of the same notification are still coming. */
  done: boolean;
}

/** Pull desktop notifications out of a chunk of terminal output.
 *
 *  This is how coding agents say "I'm done" — explicitly, in-band, rather than
 *  us inferring it from CPU or output timing. They don't agree on a protocol,
 *  so all three in use here are handled:
 *
 *    OSC 9    Codex        ESC ] 9 ; <the model's closing message>     BEL
 *             Claude Code  ESC ] 9 ; Claude is waiting for your input  BEL
 *    OSC 99   opencode     kitty's protocol: ESC ] 99 ; <params> ; <payload> ST
 *    OSC 777  urxvt's      ESC ] 777 ; notify ; <title> ; <body>       BEL
 *
 *  OSC 9;4 shares a prefix with OSC 9 but means something else entirely — the
 *  ConEmu progress protocol — so it is filtered out here and reported by
 *  parseOscProgress instead. OSC 99 capability *queries* (`p=?`) are likewise
 *  not notifications; see parseKittyNotificationQuery.
 *
 *  Terminated by BEL or ST, since both appear in the wild. */
export function parseOscNotifications(data: string): TerminalNotification[] {
  const out: TerminalNotification[] = [];
  if (!data.includes('\x1b]')) return out;

  // OSC 9 — a bare message.
  if (data.includes('\x1b]9;')) {
    const re = /\x1b\]9;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(data)) !== null) {
      const payload = m[1]!;
      if (payload.startsWith('4;')) continue; // progress, not a notification
      if (payload.trim()) out.push({ id: '', text: payload, done: true });
    }
  }

  // OSC 777 — `notify;<title>;<body>`; the body is the interesting half.
  if (data.includes('\x1b]777;')) {
    const re = /\x1b\]777;notify;([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(data)) !== null) {
      const [title = '', ...rest] = m[1]!.split(';');
      const text = (rest.join(';') || title).trim();
      if (text) out.push({ id: '', text, done: true });
    }
  }

  // OSC 99 — kitty's: metadata `key=value` pairs joined by ':', then the
  // payload. `e=1` marks the payload base64, `d=0` means more chunks follow,
  // `p=` selects which part (title/body) this chunk carries.
  if (data.includes('\x1b]99;')) {
    const re = /\x1b\]99;([^;\x07\x1b]*);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(data)) !== null) {
      const params = new Map(
        m[1]!.split(':').filter(Boolean).map(kv => {
          const i = kv.indexOf('=');
          return i < 0 ? [kv, ''] as const : [kv.slice(0, i), kv.slice(i + 1)] as const;
        }),
      );
      if (params.get('p') === '?') continue; // capability query, not a notification
      let text = m[2]!;
      if (params.get('e') === '1') {
        try { text = Buffer.from(text, 'base64').toString('utf-8'); } catch { /* keep raw */ }
      }
      out.push({ id: params.get('i') ?? '', text, done: params.get('d') !== '0' });
    }
  }

  return out;
}

/** Reassemble OSC 9 / OSC 777 notifications across PTY reads.
 *
 * PTY output has no message boundaries: Codex's short OSC 9 completion notice
 * is usually one chunk, but it is valid for its introducer, payload, or BEL to
 * arrive separately. We already stream-reassemble kitty OSC 99 below; this
 * gives the other supported notification protocols the same guarantee. */
export function drainOscNotificationFrames(data: string, pending = ''): { frames: string[]; pending: string } {
  const combined = pending + data;
  const frames: string[] = [];
  let pos = 0;

  while (pos < combined.length) {
    const start = combined.indexOf('\x1b]', pos);
    if (start < 0) {
      // Preserve a possible split ESC introducer at the end of this read.
      return { frames, pending: combined.endsWith('\x1b') ? '\x1b' : '' };
    }
    const isOsc9 = combined.startsWith('\x1b]9;', start);
    const isOsc777 = combined.startsWith('\x1b]777;', start);
    if (!isOsc9 && !isOsc777) {
      const tail = combined.slice(start);
      // The protocol name itself can be split (for example `ESC ] 9` then
      // `; message BEL`), so retain only prefixes that could still become a
      // supported notification on the next PTY read.
      if ('\x1b]9;'.startsWith(tail) || '\x1b]777;'.startsWith(tail)) {
        return { frames, pending: tail };
      }
      pos = start + 2;
      continue;
    }

    const bel = combined.indexOf('\x07', start + 3);
    const st = combined.indexOf('\x1b\\', start + 3);
    const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
    if (end < 0) return { frames, pending: combined.slice(start) };

    const terminatorLength = end === bel ? 1 : 2;
    frames.push(combined.slice(start, end + terminatorLength));
    pos = end + terminatorLength;
  }
  return { frames, pending: '' };
}

/** The notification id from a kitty capability query (`p=?`), if this chunk has
 *  one. Apps use it to ask whether the terminal supports OSC 99 notifications
 *  at all — opencode does this at startup and stays silent unless answered. */
export function parseKittyNotificationQuery(data: string): string | null {
  if (!data.includes('\x1b]99;')) return null;
  const m = /\x1b\]99;([^;\x07\x1b]*);[^\x07\x1b]*(?:\x07|\x1b\\)/.exec(data);
  if (!m) return null;
  const params = m[1]!.split(':').filter(Boolean);
  if (!params.some(kv => kv === 'p=?')) return null;
  const id = params.find(kv => kv.startsWith('i='));
  return id ? id.slice(2) : '';
}

/** Reply that advertises support for kitty desktop notifications.
 *
 *  Shaped to satisfy the querying app: opencode accepts any OSC 99 whose
 *  parameters echo back its `i=` and `p=?`. Answering is what makes it send
 *  notifications at all — and sheepit genuinely does support them now, in
 *  the sense that it turns them into sidebar highlights. */
export function kittyNotificationAck(id: string): string {
  return `\x1b]99;i=${id}:p=?;\x1b\\`;
}

/** Pull complete OSC 99 frames from a stream of PTY output.
 *
 * PTY reads have no escape-sequence boundaries: either half of the introducer,
 * the payload, or the two-byte ST terminator can arrive in a later read. Keep
 * only an incomplete OSC 99 frame (or a prefix of its introducer) for the next
 * read; all unrelated terminal output continues through the normal path. */
export function drainOsc99Frames(data: string, pending = ''): { frames: string[]; pending: string } {
  const input = pending + data;
  const frames: string[] = [];
  const introducer = '\x1b]99;';
  let offset = 0;

  while (true) {
    const start = input.indexOf(introducer, offset);
    if (start < 0) break;
    const bel = input.indexOf('\x07', start + introducer.length);
    const st = input.indexOf('\x1b\\', start + introducer.length);
    const end = bel < 0 ? st : st < 0 ? bel : Math.min(bel, st);
    if (end < 0) return { frames, pending: input.slice(start) };
    frames.push(input.slice(start, end + (end === st ? 2 : 1)));
    offset = end + (end === st ? 2 : 1);
  }

  // Retain a possibly fragmented ESC ] 99 ; introducer for the next read.
  const tail = input.slice(offset);
  for (let length = introducer.length - 1; length > 0; length--) {
    if (tail.endsWith(introducer.slice(0, length))) {
      return { frames, pending: tail.slice(-length) };
    }
  }
  return { frames, pending: '' };
}

/** OSC 9;4 progress state, if this chunk carried one. `true` = the app reports
 *  itself busy, `false` = it cleared progress. Claude Code drives this while it
 *  works; Codex does not, which is why it can't be the only signal. */
export function parseOscProgress(data: string): boolean | null {
  if (!data.includes('\x1b]9;4;')) return null;
  // The percentage field is often present but empty — `9;4;3;` is the shape
  // both agents actually emit, so `\d*` rather than `\d+`.
  const re = /\x1b\]9;4;(\d+)(?:;(\d*))?(?:\x07|\x1b\\)/g;
  let m: RegExpExecArray | null, last: boolean | null = null;
  while ((m = re.exec(data)) !== null) last = m[1] !== '0';
  return last;
}

/** Identify a coding agent from a process command line.
 *
 *  Only the first two argv tokens are considered — the interpreter and the
 *  script/binary it runs — and each is matched on its path, never on the rest
 *  of the arguments. Scanning the whole command line produced false positives
 *  the moment we started walking the full process tree: a session running
 *  `node -e "…isCodex…"`, or grepping for "claude", would flag itself as that
 *  agent. Two tokens is enough for both real shapes: `claude …` (direct binary)
 *  and `node …/bin/codex …` (wrapper script). */
export function detectAgentApp(args: string): 'claude' | 'codex' | 'opencode' | 'antigravity' | 'copilot' | 'grok' | 'cursor' | null {
  const tokens = args.split(/\s+/, 2);
  for (const [index, token] of tokens.entries()) {
    if (!token) continue;
    const base = token.slice(token.lastIndexOf('/') + 1);
    if (base === 'claude' || base === 'claude-code' || token.includes('/claude/')) return 'claude';
    if (base === 'codex' || token.includes('/codex/') || token.includes('/codex-')) return 'codex';
    if (base === 'opencode' || token.includes('/opencode/')) return 'opencode';
    if (base === 'agy' || base === 'antigravity' || token.includes('/antigravity-cli/')) return 'antigravity';
    if (base === 'copilot' || token.includes('/copilot/')) return 'copilot';
    if (base === 'grok' || base === 'grok-build' || token.includes('/grok-build/')) return 'grok';
    // Cursor's documented CLI executable is `agent`. Match that generic name
    // only as argv[0], while still accepting its explicit binary name/path.
    if ((index === 0 && base === 'agent') || base === 'cursor-agent' || token.includes('/cursor-agent/')) return 'cursor';
  }
  return null;
}

/** Environment handed to a session's shell so anything launched inside it can
 *  report back to this server.
 *
 *  This is what lets an agent say "session direct-42 just finished" instead of
 *  us inferring it from output silence. Hooks run as grandchildren of this
 *  shell, so the variables reach them by normal inheritance.
 *
 *  The URL carries the port because the server is configurable (config.ts) and
 *  a dev instance runs on a different one than production — a hook that
 *  assumed 4444 would report into the wrong server, or none. */
export function agentEnv(sessionId: string, port: number): Record<string, string> {
  return {
    SHEEPIT_SESSION_ID: sessionId,
    SHEEPIT_URL: `http://127.0.0.1:${port}`,
  };
}

/** Map with bounded concurrency, preserving input order in the result. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
const SOCKET_PATH = join(CONFIG_DIR, 'pty-daemon.sock');
const PID_FILE = join(CONFIG_DIR, 'pty-daemon.pid');

const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

function stripEscapeSequences(data: string): string {
  return data.replace(
    /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)?|\[[\x20-\x3f]*[\x40-\x7e]|.)/g,
    ''
  );
}

// ── Ring Buffer ──────────────────────────────────────────────────────────────

export class RingBuffer {
  private buf: Buffer;
  private pos = 0;
  private full = false;
  /** Bumped on every write. Lets periodic work (previews, disk flush) skip
   *  sessions that produced nothing since it last looked — most of them, most
   *  of the time. */
  version = 0;

  constructor(size: number) { this.buf = Buffer.alloc(size); }

  write(data: string): void {
    this.version++;
    const bytes = Buffer.from(data, 'utf-8');
    if (bytes.length >= this.buf.length) {
      bytes.copy(this.buf, 0, bytes.length - this.buf.length);
      this.pos = 0; this.full = true; return;
    }
    const space = this.buf.length - this.pos;
    if (bytes.length <= space) {
      bytes.copy(this.buf, this.pos);
      this.pos += bytes.length;
      if (this.pos === this.buf.length) { this.pos = 0; this.full = true; }
    } else {
      bytes.copy(this.buf, this.pos, 0, space);
      bytes.copy(this.buf, 0, space);
      this.pos = bytes.length - space;
      this.full = true;
    }
  }

  read(): string {
    if (!this.full) return this.buf.slice(0, this.pos).toString('utf-8');
    return Buffer.concat([this.buf.slice(this.pos), this.buf.slice(0, this.pos)]).toString('utf-8');
  }

  /** The most recent `maxBytes` of content. For callers that only need the tail
   *  (previews want two lines), this avoids concatenating and UTF-8-decoding the
   *  whole 256 KB buffer — doing that per session per second was the single
   *  biggest source of event-loop stalls, felt as input lag while typing.
   *  May clip a multi-byte character at the head; harmless for display. */
  readTail(maxBytes: number): string {
    const len = this.full ? this.buf.length : this.pos;
    const n = Math.min(maxBytes, len);
    if (n === 0) return '';
    const start = ((this.pos - n) % this.buf.length + this.buf.length) % this.buf.length;
    if (start + n <= this.buf.length) return this.buf.slice(start, start + n).toString('utf-8');
    const head = this.buf.length - start;
    return Buffer.concat([this.buf.slice(start), this.buf.slice(0, n - head)]).toString('utf-8');
  }

  saveTo(path: string): void { writeFileSync(path, this.read(), 'utf-8'); }
  loadFrom(path: string): void {
    if (!existsSync(path)) return;
    this.write(readFileSync(path, 'utf-8'));
  }
}

// ── Types ────────────────────────────────────────────────────────────────────

// DEC private modes that represent sticky terminal state an app sets ONCE (often
// before a client connects): alternate screen, mouse tracking, app-cursor keys,
// bracketed paste. We track these so a reconnect snapshot can restore them —
// otherwise full-screen apps (e.g. the updated Claude Code, vim, btop) lose
// alt-screen / mouse mode once their setup bytes roll off the ring buffer, which
// breaks scrolling and the mouse in the reconnected terminal.
const STICKY_PRIVATE_MODES = new Set([
  1,                       // DECCKM — application cursor keys
  47, 1047, 1048, 1049,    // alternate screen buffer
  1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016, // mouse tracking / encoding / focus
  2004,                    // bracketed paste
]);

/** Update `active` from DECSET (?Nh) / DECRST (?Nl) sequences in `data`.
 *  Returns true when the set actually changed, so callers can persist only on
 *  real transitions rather than on every chunk of output. */
function trackPrivateModes(active: Set<number>, data: string): boolean {
  const re = /\x1b\[\?([0-9;]+)([hl])/g;
  let m: RegExpExecArray | null;
  let changed = false;
  while ((m = re.exec(data)) !== null) {
    const enable = m[2] === 'h';
    for (const part of m[1]!.split(';')) {
      const n = parseInt(part, 10);
      if (!STICKY_PRIVATE_MODES.has(n)) continue;
      if (enable) { if (!active.has(n)) { active.add(n); changed = true; } }
      else if (active.delete(n)) changed = true;
    }
  }
  return changed;
}

// Subset of tracked modes we actually RE-ASSERT on reconnect. We deliberately
// exclude mouse-tracking / focus modes (1000/1002/1003/1004/1005/1006/1015/1016):
// replaying those re-arms the client's mouse handling from a ring-buffer scan
// that can be STALE (e.g. the app already exited to a shell, but its disable
// sequence rolled off the persisted ring). A stale mouse-on state makes the UI
// synthesize wheel reports that leak into the shell as literal `\x1b[<…M` text.
// Alt-screen, app-cursor-keys and bracketed paste are safe to restore and are
// what actually fix the reconnected terminal's rendering / scroll region. A live
// app re-arms its own mouse modes via the output stream, so we don't need to.
const REPLAY_PRIVATE_MODES = new Set([1, 47, 1047, 1048, 1049, 2004]);

/** Escape sequence that re-establishes the safe-to-replay sticky modes. Alt-screen
 *  is emitted first so replayed snapshot content lands in the alternate buffer. */
function privateModePrefix(active: Set<number>): string {
  const replay = [...active].filter(n => REPLAY_PRIVATE_MODES.has(n));
  if (replay.length === 0) return '';
  const isAlt = (n: number) => n === 47 || n === 1047 || n === 1049;
  const ordered = replay.sort((a, b) => (isAlt(a) ? 0 : 1) - (isAlt(b) ? 0 : 1));
  return ordered.map(n => `\x1b[?${n}h`).join('');
}

// Mouse / focus tracking is LIVE-interaction state, not snapshot state. A ring
// buffer can hold stale ENABLE sequences whose matching disable rolled off — a
// TUI that exited or was killed without resetting the terminal (observed in the
// wild: 29× `\x1b[?1003h` with zero disables left in the ring). Replaying the
// snapshot then re-arms xterm's mouse reporting at a plain shell prompt, so every
// mouse MOVE floods the shell with `\x1b[<…M` reports that echo as literal text.
// We force these modes OFF immediately after the replayed snapshot — UNLESS the
// ring shows an app still driving the mouse (see mouseModeTail). Forcing them
// off unconditionally left a reconnected Claude Code pane with mouse tracking
// dead in xterm, which is exactly the gate the wheel handler checks — so the
// wheel stopped scrolling the app, with no scrollback to fall back to either.
const MOUSE_FOCUS_MODES = [1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016];
const MOUSE_FOCUS_RESET = MOUSE_FOCUS_MODES.map(n => `\x1b[?${n}l`).join('');

/** Index of the last match of `re` in `s`, or -1. */
function lastIndexOfRe(s: string, re: RegExp): number {
  const g = new RegExp(re.source, 'g');
  let idx = -1, m: RegExpExecArray | null;
  while ((m = g.exec(s)) !== null) idx = m.index;
  return idx;
}

/** Bytes to append after the replayed snapshot to settle mouse/focus tracking.
 *
 *  Restoring mouse state is only safe when we can tell "stale on" (the app
 *  exited without resetting the terminal) from "really on". The ring answers
 *  that, and — unlike anything we hold in memory — it survives a server
 *  restart, so a reconnect after `tsx watch` reloads decides the same way:
 *
 *  `liveApp` (does the PTY have a child process right now?) is that answer, and
 *  unlike anything derived from the ring it can't be fooled: byte heuristics
 *  fail here because the markers aren't exclusive to shells — Claude Code emits
 *  `?2004h` too, so "prompt after the last mouse-enable" wrongly condemns a
 *  live pane. Gating on the alt-screen bit fails for the opposite reason: an
 *  app's one-time `?1049h` rolls off a busy ring within minutes. */
export function mouseModeTail(active: Set<number>, snapshot: string, liveApp: boolean): string {
  // No foreground process → the shell is at a prompt, where a leftover mouse-on
  // turns every mouse MOVE into literal `\x1b[<…M` text. Always force off.
  if (!liveApp) return MOUSE_FOCUS_RESET;
  // Something IS running. Restore exactly the modes it asked for: the tracked
  // set (persisted, so it survives a restart) with the ring replayed over it,
  // so a mode the app turned back OFF later in the window isn't resurrected.
  const effective = new Set(active);
  trackPrivateModes(effective, snapshot);
  const on = MOUSE_FOCUS_MODES.filter(n => effective.has(n));
  // A live app that never asked for the mouse (less, man) gets an explicit off:
  // the pane may be reconnecting onto a terminal that still has it armed.
  return on.length ? on.map(n => `\x1b[?${n}h`).join('') : MOUSE_FOCUS_RESET;
}

// Counterpart for the alternate screen buffer. Same staleness trap: the ring can
// hold a TUI's `?1049h` (enter alt-screen) while its matching exit rolled off —
// so replaying the snapshot drops the reconnected pane into a dead alt buffer
// showing a frozen frame of an app that already quit. We can't tell "stale" from
// "a live full-screen app" by counting toggles (a live app is also unbalanced:
// entered, not yet exited). But an interactive shell re-emits `?2004h` (bracketed
// paste) at every prompt, so a `?2004h` AFTER the last alt-enter is a reliable
// "the app exited, we're back at the shell" marker → the alt buffer is stale.
const ALT_SCREEN_RESET = '\x1b[?1049l\x1b[?1047l\x1b[?47l';

function altScreenStale(snapshot: string): boolean {
  const lastIndexOf = (re: RegExp): number => lastIndexOfRe(snapshot, re);
  const altOn = lastIndexOf(/\x1b\[\?(?:1049|1047|47)h/);
  if (altOn < 0) return false;                       // never entered alt-screen
  const altOff = lastIndexOf(/\x1b\[\?(?:1049|1047|47)l/);
  if (altOff > altOn) return false;                  // properly exited — not stale
  return lastIndexOf(/\x1b\[\?2004h/) > altOn;        // shell prompt came after → stale
}

interface DirectSession {
  id: string;
  name: string;
  path: string;
  pid: number;
  ring: RingBuffer;
  cols: number;
  rows: number;
  createdAt: number;
  sessionType?: string | null;
  /** Background-only sessions are deliberately omitted from the workspace UI. */
  isHeadless?: boolean;
  /** Active sticky DEC private modes, tracked from output (see above). */
  modes?: Set<number>;
  /** Whether the PTY currently has a child process — i.e. something is running
   *  in the foreground rather than the shell sitting at a prompt. Ground truth
   *  for "is a full-screen app alive", refreshed by the listSessions poll and
   *  primed at startup. Used by the reconnect path (see mouseModeTail). */
  liveApp?: boolean;
}


// ── Daemon Client ────────────────────────────────────────────────────────────

class DaemonClient {
  private socket: net.Socket | null = null;
  private buf = '';
  private reqCounter = 0;
  private pending = new Map<string, { resolve: (msg: any) => void; reject: (err: Error) => void }>();
  private onOutput: ((id: string, data: string) => void) | null = null;
  private onExit: ((id: string) => void) | null = null;
  private onCwdChanged: ((id: string, cwd: string) => void) | null = null;
  private connected = false;

  setHandlers(
    onOutput: (id: string, data: string) => void,
    onExit: (id: string) => void,
    onCwdChanged: (id: string, cwd: string) => void,
  ): void {
    this.onOutput = onOutput;
    this.onExit = onExit;
    this.onCwdChanged = onCwdChanged;
  }

  async ensureDaemon(): Promise<void> {
    if (existsSync(PID_FILE)) {
      try {
        const pid = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10);
        process.kill(pid, 0); // throws if process doesn't exist
      } catch {
        try { unlinkSync(PID_FILE); } catch {}
        try { unlinkSync(SOCKET_PATH); } catch {}
      }
    }

    if (!existsSync(SOCKET_PATH)) {
      logger.info('Starting PTY daemon...');
      const daemonScript = join(__dirname, 'pty-daemon.js');
      const isDev = !existsSync(daemonScript);

      // Spawn daemon with node directly (not npx) so detached: true
      // actually creates a new process group that survives parent death.
      const nodeExe = process.execPath; // path to node binary
      const args = isDev
        ? [
            '--require', join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'preflight.cjs'),
            '--import', `file://${join(__dirname, '..', 'node_modules', 'tsx', 'dist', 'loader.mjs')}`,
            join(__dirname, 'pty-daemon.ts'),
          ]
        : [daemonScript];

      const child = spawn(nodeExe, args, {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      });
      child.unref();

      for (let i = 0; i < 50; i++) {
        await new Promise(r => setTimeout(r, 100));
        if (existsSync(SOCKET_PATH)) break;
      }
      if (!existsSync(SOCKET_PATH)) throw new Error('PTY daemon failed to start');
      logger.info('PTY daemon started');
    }
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.ensureDaemon();

    return new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH, () => {
        this.connected = true;
        resolve();
      });

      socket.on('data', (chunk) => {
        this.buf += chunk.toString();
        let idx: number;
        while ((idx = this.buf.indexOf('\n')) !== -1) {
          const line = this.buf.slice(0, idx);
          this.buf = this.buf.slice(idx + 1);
          try {
            const msg = JSON.parse(line);
            if (msg.type === 'output' && this.onOutput) {
              this.onOutput(msg.id, msg.data);
            } else if (msg.type === 'cwd_changed' && this.onCwdChanged) {
              this.onCwdChanged(msg.id, msg.data);
            } else if (msg.type === 'exit' && this.onExit) {
              this.onExit(msg.id);
            } else if (msg.reqId && this.pending.has(msg.reqId)) {
              this.pending.get(msg.reqId)!.resolve(msg);
              this.pending.delete(msg.reqId);
            }
          } catch {}
        }
      });

      socket.on('error', (err) => {
        this.connected = false;
        this.socket = null;
        reject(err);
      });

      socket.on('close', () => {
        this.connected = false;
        this.socket = null;
      });

      this.socket = socket;
    });
  }

  private send(msg: any): void {
    this.socket?.write(JSON.stringify(msg) + '\n');
  }

  async request(msg: any): Promise<any> {
    await this.connect();
    const reqId = `r${++this.reqCounter}`;
    return new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
      this.send({ ...msg, reqId });
      setTimeout(() => {
        if (this.pending.has(reqId)) {
          this.pending.delete(reqId);
          reject(new Error('Daemon request timeout'));
        }
      }, 10000);
    });
  }

  sendFire(msg: any): void {
    if (this.connected) this.send(msg);
  }

  close(): void {
    this.socket?.destroy();
    this.socket = null;
    this.connected = false;
  }
}

// ── DirectBridge ─────────────────────────────────────────────────────────────

/** One row of `ps` output (see snapshotDescendants). */
interface ProcSnapshot {
  pid: number;
  cpu: number;
  rssKb: number;
  args: string;
}

export class DirectBridge {
  readonly pubsub = new PubSub<BridgeMessage>();
  private sessions = new Map<string, DirectSession>();
  private nextId = 1;
  private ringFlushInterval: ReturnType<typeof setInterval> | null = null;
  private sessionListInterval: ReturnType<typeof setInterval> | null = null;
  private previewInterval: ReturnType<typeof setInterval> | null = null;
  private gitCacheInterval: ReturnType<typeof setInterval> | null = null;
  private prCacheInterval: ReturnType<typeof setInterval> | null = null;
  private lastPreviews = new Map<string, string>();
  private cachedSessions: Session[] = [];
  private knownSessions = new Set<string>();
  private daemon = new DaemonClient();

  private gitCache = new Map<string, { gitRoot: string | null; branch: string | null; dirty: boolean }>();
  private prCache = new Map<string, { prNum: number; prState: string; prUrl: string } | null>();
  private inputBuffers = new Map<string, string>();
  /** Pending coalesced `current_input` broadcasts (see publishCurrentInput). */
  private inputPublishTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Pending coalesced persist triggered by a mode change (see schedulePersist). */
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /** Ring version last used to build a preview / written to disk, per session.
   *  Both periodic sweeps use these to skip sessions that produced no output. */
  private previewVersions = new Map<string, number>();
  private lastBusy = new Map<string, boolean>();
  /** Busy state the app reported itself via OSC 9;4 progress, when it does. */
  private oscBusy = new Map<string, boolean>();
  /** State an agent reported through its own hooks (see setAgentState). The
   *  strongest signal we have: the agent says so, rather than us guessing from
   *  output. In memory only — a restart falls back to the heuristics. */
  private agentState = new Map<string, { state: AgentState; source: string; at: number }>();
  /** Last prompt/response pair per session (see AgentTurn). */
  private agentTurns = new Map<string, AgentTurn>();
  /** Partial OSC 99 notifications, keyed `sessionId:notificationId`. */
  private pendingNotes = new Map<string, string>();
  /** Incomplete OSC 9 / OSC 777 notification frames, keyed by session id. */
  private pendingOscNotifications = new Map<string, string>();
  /** Incomplete OSC 99 frames, keyed by session id. */
  private pendingOsc99 = new Map<string, string>();
  private flushedVersions = new Map<string, number>();
  /** Per-session process stats (CPU/mem/app detection), refreshed on their own
   *  slower clock — see PROC_INFO_TTL_MS and listSessions. */
  private procInfo = new Map<string, { isClaudeCode: boolean; isCodex: boolean; isOpencode: boolean; isAntigravity: boolean; isCopilot: boolean; isGrok: boolean; isCursor: boolean; cpuPercent: number; memMb: number }>();
  private procInfoAt = 0;
  /** Per-session state on disk, one file each (see session-store.ts). */
  private store = new SessionStore();
  /** Port the HTTP server is actually listening on, told to us by index.ts.
   *  Defaults to the configured port for callers that never set it. */
  private listenPort = config.port;

  constructor() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(RING_DIR, { recursive: true });
  }

  async start(): Promise<void> {
    this.daemon.setHandlers(
      (id, data) => {
        const sess = this.sessions.get(id);
        if (sess) {
          // Sticky modes must outlive THIS process: they're set once at app
          // startup, so a server restart that loses them can't recover from the
          // ring alone (the setup bytes have long rolled off a busy session).
          if (trackPrivateModes(sess.modes ??= new Set(), data)) this.schedulePersist();

          // The agent announcing completion is worth more than any heuristic:
          // publish it straight through so the sidebar can light up the moment
          // the model is done, instead of waiting out the silence window.
          const handleNotification = (note: TerminalNotification): void => {
            // OSC 99 splits a notification across chunks; hold the pieces until
            // the app marks the last one.
            const key = `${id}:${note.id}`;
            const text = (this.pendingNotes.get(key) ?? '') + note.text;
            if (!note.done) { this.pendingNotes.set(key, text); return; }
            this.pendingNotes.delete(key);
            if (text.trim()) {
              this.pubsub.publish('__sessions__', { type: 'attention', session_id: id, message: text });
            }
          };
          // PTY reads can split every supported notification protocol. Reassemble
          // OSC 9/777 here, then let the existing OSC 99 stream parser handle
          // kitty's separately framed protocol below.
          const generic = drainOscNotificationFrames(data, this.pendingOscNotifications.get(id));
          if (generic.pending) this.pendingOscNotifications.set(id, generic.pending);
          else this.pendingOscNotifications.delete(id);
          for (const frame of generic.frames) {
            for (const note of parseOscNotifications(frame)) handleNotification(note);
          }
          const osc99 = drainOsc99Frames(data, this.pendingOsc99.get(id));
          if (osc99.pending) this.pendingOsc99.set(id, osc99.pending); else this.pendingOsc99.delete(id);
          for (const frame of osc99.frames) {
            for (const note of parseOscNotifications(frame)) {
              handleNotification(note);
              // OpenCode emits this desktop notification when it needs user
              // attention, so its completed notification is an authoritative
              // transition out of the working state.
              if (note.done) this.oscBusy.set(id, false);
            }
            const queryId = parseKittyNotificationQuery(frame);
            if (queryId !== null) {
              this.daemon.sendFire({ type: 'write', id, data: kittyNotificationAck(queryId) });
            }
          }

          // Answer "do you support desktop notifications?" — opencode asks at
          // startup and never notifies unless something answers.
          const progress = parseOscProgress(data);
          if (progress !== null) this.oscBusy.set(id, progress);

          sess.ring.write(data);
          this.pubsub.publish(id, { type: 'output', data });
        }
      },
      (id) => {
        this.sessions.delete(id);
        this.pendingOsc99.delete(id);
        this.pendingOscNotifications.delete(id);
        this.persist();
        logger.debug(`Session exited: ${id}`);
      },
      (id, cwd) => {
        const sess = this.sessions.get(id);
        if (sess && sess.path !== cwd) {
          sess.path = cwd;
          this.persist();
        }
      },
    );

    await this.daemon.connect();
    await this.restoreSessions();

    // Cadences are a freshness/cost trade. The two git sweeps shell out per repo
    // — `git status` across every session's repo, and `gh pr view` (a network
    // call) — so they run far less often than the cheap in-memory sweeps. Both
    // describe slow-moving state; polling them hard just stole time from
    // keystroke delivery.
    this.ringFlushInterval = setInterval(() => this.flushRings(), 10_000);
    this.sessionListInterval = setInterval(() => this.discoverSessions(), 2000);
    this.previewInterval = setInterval(() => this.publishPreviews(), 1000);
    this.gitCacheInterval = setInterval(() => this._refreshGitCache(), 20_000);
    this.prCacheInterval = setInterval(() => this._refreshPRCache(), 120_000);

    // Populate git cache BEFORE first session discovery so git info is available
    await this._refreshGitCache();
    await this.discoverSessions();
    // PR chips otherwise stay blank until the first (now much later) tick.
    // Not awaited: it's a network call and nothing depends on it to start.
    void this._refreshPRCache();

    logger.info('DirectBridge started (daemon mode)');
  }

  stop(): void {
    // Debounced writes would otherwise be lost on a clean shutdown.
    this.store.flush();
    if (this.ringFlushInterval) clearInterval(this.ringFlushInterval);
    if (this.sessionListInterval) clearInterval(this.sessionListInterval);
    if (this.previewInterval) clearInterval(this.previewInterval);
    if (this.gitCacheInterval) clearInterval(this.gitCacheInterval);
    if (this.prCacheInterval) clearInterval(this.prCacheInterval);
    this.flushRings();
    // Don't kill daemon or sessions — they survive restarts
    this.daemon.close();
    this.sessions.clear();
    logger.info('DirectBridge stopped (daemon keeps sessions alive)');
  }

  // ── Session discovery ────────────────────────────────────────────────────

  private async discoverSessions(): Promise<void> {
    const sessions = await this.listSessions();
    this.cachedSessions = sessions;
    const liveIds = new Set(sessions.map(s => s.id));
    for (const id of this.knownSessions) {
      if (!liveIds.has(id)) { this.knownSessions.delete(id); this.inputBuffers.delete(id); this.clearInputPublish(id); }
    }
    for (const s of sessions) {
      if (!this.knownSessions.has(s.id)) { this.knownSessions.add(s.id); this.persist(); }
    }
    this.pubsub.publish('__sessions__', { type: 'sessions', sessions });
  }

  /** Record a state an agent reported about itself.
   *
   *  Called by POST /api/sessions/:id/agent-state, which agent hooks drive.
   *  Deliberately agent-agnostic: Claude Code posts from its Stop/
   *  UserPromptSubmit hooks today, Codex is expected to post the same shapes
   *  through its own notify mechanism. Returns false for an unknown session so
   *  the caller can answer 404 rather than accumulate state for a dead pane. */
  setAgentState(sessionId: string, state: AgentState, source: string, turn?: { prompt?: string; response?: string }): boolean {
    if (!this.sessions.has(sessionId)) return false;

    // Merge rather than replace: the prompt arrives when the turn starts and
    // the response when it ends, so each report carries only half the pair.
    if (turn?.prompt || turn?.response) {
      const prev = this.agentTurns.get(sessionId);
      this.agentTurns.set(sessionId, {
        prompt: turn.prompt ?? prev?.prompt,
        response: turn.response ?? prev?.response,
        at: Date.now(),
      });
    }
    // A new prompt starts a new exchange; the previous answer is stale.
    if (turn?.prompt && !turn.response) {
      const entry = this.agentTurns.get(sessionId);
      if (entry) entry.response = undefined;
    }

    if (state === 'unknown') this.agentState.delete(sessionId);
    else this.agentState.set(sessionId, { state, source, at: Date.now() });
    logger.info(`agent-state ${sessionId} -> ${state} (${source})`);
    // Persist it: unlike previews or CPU this cannot be re-derived from
    // output, and the agent keeps running across a server restart, so a
    // report dropped here is information genuinely lost.
    this.persistSession(sessionId);

    // 'waiting' means the agent is blocked on the user — a permission prompt,
    // not a finished turn. It must be announced as attention, because the
    // busy->false transition alone is what the UI turns into "X finished", and
    // reporting a prompt as a completed turn is worse than saying nothing.
    //
    // Published BEFORE the preview below, and the ordering is load-bearing:
    // the attention handler clears the client's busy flag, so the preview that
    // follows sees it already false and does not also fire "finished".
    if (state === 'waiting') {
      this.pubsub.publish('__sessions__', {
        type: 'attention', session_id: sessionId, message: 'needs your input',
      });
    }

    // Publish immediately: waiting for the next sweep would give back the very
    // latency this whole mechanism exists to remove.
    this.publishPreviews();
    return true;
  }

  /** Last reported exchange, for naming. Undefined when the agent never
   *  reported one — a plain shell, or an agent without the plugin. */
  getAgentTurn(sessionId: string): AgentTurn | undefined {
    return this.agentTurns.get(sessionId);
  }

  /** Is this session's agent working?
   *
   *  The agent's own report, and nothing else. Output silence and CPU used to
   *  stand in for it; both were guesses, and both were wrong in the case that
   *  mattered most — an agent waiting on the network prints nothing and burns
   *  no CPU, so it read as finished mid-turn. A wrong "finished" notification
   *  is worse than none.
   *
   *  A session with no agent reporting — a plain shell, or an agent whose
   *  reporter is not installed — is simply never busy. */
  isSessionBusy(sessionId: string): boolean {
    return this.freshAgentState(sessionId) === 'busy';
  }

  /** The agent-reported state, or undefined once it has gone stale. */
  private freshAgentState(sessionId: string): AgentState | undefined {
    const entry = this.agentState.get(sessionId);
    if (!entry) return undefined;
    if (Date.now() - entry.at > AGENT_STATE_TTL_MS) {
      this.agentState.delete(sessionId);
      return undefined;
    }
    return entry.state;
  }

  /** Find the session that owns one of these process ids.
   *
   *  The fallback for panes that predate SHEEPIT_SESSION_ID, and the reason
   *  we do not have to write `export` into a live shell to retrofit them —
   *  which would type into whatever is running there. A hook instead walks its
   *  own ancestry (hook -> agent -> shell) and asks us which session that
   *  shell belongs to.
   *
   *  Ordered by the caller's chain, so the nearest ancestor wins if a session
   *  somehow nests inside another. */
  resolveSessionByPids(pids: number[]): string | null {
    for (const pid of pids) {
      for (const sess of this.sessions.values()) {
        if (sess.pid === pid) return sess.id;
      }
    }
    return null;
  }

  /** Set by index.ts so preferences scoped to a session can be dropped with
   *  it. Without this a shared blob has no idea a session ended, which is how
   *  it accumulated a key per pane for the life of the machine. */
  onSessionClosed?: (sessionId: string) => void;

  /** Told by index.ts once the real port is known, before start() — sessions
   *  restored during start() bake this into their environment. */
  setListenPort(port: number): void { this.listenPort = port; }

  getCachedSessions(): Session[] { return this.cachedSessions; }

  /** Publish last 2 lines of each session as a preview (triggers unseen indicators) */
  private publishPreviews(): void {
    for (const sess of this.sessions.values()) {
      const busy = this.isSessionBusy(sess.id);

      // A session that has gone quiet stops bumping its ring version, so the
      // skip below would never let us announce that it finished. Publish
      // whenever the busy flag flips, regardless of whether the text changed.
      const busyChanged = this.lastBusy.get(sess.id) !== busy;
      if (busyChanged) this.lastBusy.set(sess.id, busy);

      // Nothing written since the last tick → the preview cannot have changed.
      // Idle sessions are the common case, and skipping them here is what keeps
      // this once-a-second sweep off the keystroke path.
      const versionChanged = this.previewVersions.get(sess.id) !== sess.ring.version;
      if (!versionChanged && !busyChanged) continue;
      this.previewVersions.set(sess.id, sess.ring.version);

      // Two lines are all we show, so only the tail is worth decoding.
      const raw = sess.ring.readTail(PREVIEW_TAIL_BYTES);
      if (!raw) continue;
      // Strip ANSI escapes and get last 2 non-empty lines
      const stripped = stripEscapeSequences(raw);
      const lines = stripped.split('\n').filter(l => l.trim());
      const preview = lines.slice(-2).join('\n');

      // Only publish if something changed
      const prev = this.lastPreviews.get(sess.id);
      if (preview === prev && !busyChanged) continue;
      this.lastPreviews.set(sess.id, preview);

      this.pubsub.publish('__sessions__', {
        type: 'preview',
        session_id: sess.id,
        preview,
        busy,
      });
    }
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  async createSession(path?: string, initialCols?: number, initialRows?: number, isHeadless = false): Promise<string> {
    const sessionPath = path ?? os.homedir();
    const baseName = sessionPath.split('/').filter(Boolean).pop() ?? 'shell';

    const taken = new Set([...this.sessions.values()].map(s => s.name));
    let name = baseName;
    let i = 2;
    while (taken.has(name)) name = `${baseName}-${i++}`;

    const id = `direct-${this.nextId++}`;
    const ring = new RingBuffer(RING_SIZE);
    const cols = initialCols ?? 120;
    const rows = initialRows ?? 40;

    // `fromPool: true` lets the daemon claim a pre-warmed shell instead of
    // spawning fresh — saves the ~50-100ms shell startup + rc-file cost.
    // Daemon falls back to a fresh spawn transparently on pool miss, so the
    // client doesn't need to care which path was taken.
    const resp = await this.daemon.request({
      type: 'create', id, cwd: sessionPath, cols, rows, fromPool: true,
      env: agentEnv(id, this.listenPort),
    });

    const sess: DirectSession = {
      id, name, path: sessionPath, pid: resp.pid ?? 0, ring,
      cols, rows, createdAt: Date.now(),
      isHeadless,
    };
    this.sessions.set(id, sess);
    await this.daemon.request({ type: 'subscribe', id });

    this.persist();
    logger.info(`Created session: ${id} (${name}) at ${sessionPath} size=${cols}x${rows}`);
    return id;
  }

  async closeSession(sessionId: string): Promise<void> {
    this.daemon.sendFire({ type: 'kill', id: sessionId });
    this.sessions.delete(sessionId);
    this.inputBuffers.delete(sessionId);
    this.clearInputPublish(sessionId);
    const ringPath = join(RING_DIR, `${sessionId}.buf`);
    try { if (existsSync(ringPath)) unlinkSync(ringPath); } catch {}
    // Drop everything else keyed by this session too, or it accumulates for
    // the life of the machine — which is exactly what the shared blob did.
    this.agentState.delete(sessionId);
    this.agentTurns.delete(sessionId);
    this.store.delete(sessionId);
    this.onSessionClosed?.(sessionId);
  }

  // ── Atomic subscribe ─────────────────────────────────────────────────────

  subscribeSession(
    sessionId: string,
    onConnected: () => void,
    onOutput: (data: string) => void,
    cols?: number,
    rows?: number,
  ): (() => void) | null {
    const sess = this.sessions.get(sessionId);
    if (!sess) return null;

    if (cols && rows) {
      this.daemon.sendFire({ type: 'resize', id: sessionId, cols, rows });
      sess.cols = cols; sess.rows = rows;
    }

    // ATOMIC: read ring buffer + subscribe in the same tick
    const snapshot = sess.ring.read();
    const unsub = this.pubsub.subscribe(sessionId, (m: BridgeMessage) => {
      if (m.type === 'output') onOutput((m as any).data);
    });

    onConnected();
    // Re-establish sticky modes (alt-screen, mouse, …) the running app set
    // before this client connected, in case those bytes have rolled off the
    // ring — otherwise the reconnected terminal is stuck in the wrong mode.
    // Order: re-assert sticky modes (alt-screen first) → replay snapshot →
    // settle mouse/focus tracking, and drop a stale alternate-screen buffer, so
    // the reconnected pane lands on the live shell rather than a frozen dead
    // frame or an input-grabbing mouse state (see mouseModeTail /
    // ALT_SCREEN_RESET). The mouse tail comes AFTER the snapshot so stale
    // disables replayed from the ring can't win.
    const modes = sess.modes ?? new Set<number>();
    const modePrefix = privateModePrefix(modes);
    const altReset = altScreenStale(snapshot) ? ALT_SCREEN_RESET : '';
    const mouseTail = mouseModeTail(modes, snapshot, sess.liveApp ?? false);
    if (modePrefix || snapshot) onOutput(modePrefix + snapshot + mouseTail + altReset);
    return unsub;
  }

  /** Read ring buffer snapshot (for AI naming, diagnostics, etc.) */
  async snapshot(sessionId: string): Promise<string> {
    const sess = this.sessions.get(sessionId);
    if (!sess) return '';
    return sess.ring.read();
  }

  // ── I/O ──────────────────────────────────────────────────────────────────

  sendInput(sessionId: string, data: string): void {
    this.daemon.sendFire({ type: 'write', id: sessionId, data });

    const stripped = stripEscapeSequences(data);
    for (const ch of stripped) {
      if (ch === '\r' || ch === '\n') {
        this.inputBuffers.set(sessionId, '');
      } else if (ch === '\x7f' || ch === '\b') {
        const cur = this.inputBuffers.get(sessionId) ?? '';
        this.inputBuffers.set(sessionId, cur.slice(0, -1));
      } else if (ch >= ' ' || ch === '\t') {
        this.inputBuffers.set(sessionId, (this.inputBuffers.get(sessionId) ?? '') + ch);
      }
    }
    if (stripped) this.publishCurrentInput(sessionId);
  }

  /** Broadcast the session's in-progress input line, coalesced.
   *
   *  The buffer above updates per character, but subscribers only ever want the
   *  settled line — publishing inside that loop sent one broadcast to EVERY
   *  connected client per keystroke, and one per character on paste. That is
   *  work on the same path a keystroke travels, so it showed up as input lag.
   *  Trailing-edge: the first call schedules, the rest are absorbed, and the
   *  timer fires with whatever the buffer holds by then. */
  private publishCurrentInput(sessionId: string): void {
    if (this.inputPublishTimers.has(sessionId)) return;
    this.inputPublishTimers.set(sessionId, setTimeout(() => {
      this.inputPublishTimers.delete(sessionId);
      this.pubsub.publish('__sessions__', {
        type: 'current_input',
        session_id: sessionId,
        input: this.inputBuffers.get(sessionId) ?? '',
      });
    }, INPUT_PUBLISH_MS));
  }

  private clearInputPublish(sessionId: string): void {
    const t = this.inputPublishTimers.get(sessionId);
    if (t) { clearTimeout(t); this.inputPublishTimers.delete(sessionId); }
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const sess = this.sessions.get(sessionId);
    if (!sess) return;
    this.daemon.sendFire({ type: 'resize', id: sessionId, cols, rows });
    sess.cols = cols; sess.rows = rows;
  }

  async sendKeys(sessionId: string, command: string): Promise<void> {
    this.daemon.sendFire({ type: 'write', id: sessionId, data: command + '\r' });
  }

  async renameSession(sessionId: string, newName: string): Promise<void> {
    const sess = this.sessions.get(sessionId);
    if (sess) { sess.name = newName; this.persist(); }
  }

  async injectClaudeCodeCommand(command: string): Promise<string[]> {
    const sessions = await this.listSessions();
    const claudeSessions = sessions.filter(s => s.isClaudeCode);
    const injected: string[] = [];
    for (const s of claudeSessions) {
      this.daemon.sendFire({ type: 'write', id: s.id, data: '\x1b' });
      await new Promise(r => setTimeout(r, 100));
      this.daemon.sendFire({ type: 'write', id: s.id, data: command + '\r' });
      injected.push(s.id);
    }
    return injected;
  }

  // ── Session listing with process detection ───────────────────────────────

  /** Every process descended from each of `roots`, not just its direct children.
   *
   *  Depth matters: Codex runs as a thin Node wrapper (`node .../bin/codex`,
   *  ~29 MB, ~0% CPU) that spawns the real worker as a GRANDCHILD (~162 MB, and
   *  the one that actually burns CPU while the model thinks). Summing direct
   *  children only made every Codex session look permanently idle, so it never
   *  went busy and never lit up in the sidebar when the model finished. Claude
   *  Code happened to work because it runs as a direct child.
   *
   *  One `ps` call covers the whole machine — the per-session `pgrep`+`ps` pair
   *  it replaced was the dominant source of keystroke stalls. */
  private async snapshotDescendants(roots: Set<number>): Promise<Map<number, ProcSnapshot[]>> {
    const byRoot = new Map<number, ProcSnapshot[]>();
    if (roots.size === 0) return byRoot;
    try {
      const { stdout } = await execAsync(nice('ps -axo pid=,ppid=,pcpu=,rss=,args='), {
        timeout: 5000,
        maxBuffer: 16 * 1024 * 1024, // a few hundred processes with full argv
      });

      // Pass 1 — numbers only. Hand-parsed rather than regex-matched: this is
      // ~800 lines on a busy machine and some argv run to kilobytes (browsers),
      // so the argv substring is taken later, only for the handful of processes
      // that turn out to belong to a session.
      const kids = new Map<number, number[]>();
      const rows = new Map<number, { cpu: number; rssKb: number; line: string; argsAt: number }>();
      for (const line of stdout.split('\n')) {
        let i = 0;
        const num = (): number => {
          while (line.charCodeAt(i) === 32) i++;
          const start = i;
          while (i < line.length && line.charCodeAt(i) !== 32) i++;
          return start === i ? NaN : Number(line.slice(start, i));
        };
        const pid = num();
        const ppid = num();
        const cpu = num();
        const rssKb = num();
        if (!Number.isFinite(pid) || !Number.isFinite(ppid)) continue;
        rows.set(pid, {
          cpu: Number.isFinite(cpu) ? cpu : 0,
          rssKb: Number.isFinite(rssKb) ? rssKb : 0,
          line, argsAt: i + 1,
        });
        const siblings = kids.get(ppid);
        if (siblings) siblings.push(pid); else kids.set(ppid, [pid]);
      }

      // Pass 2 — walk down from each session's shell. `seen` guards against a
      // malformed tree (pid reuse between the two passes) turning into a loop.
      for (const root of roots) {
        const found: ProcSnapshot[] = [];
        const seen = new Set<number>([root]);
        const queue = [...(kids.get(root) ?? [])];
        while (queue.length) {
          const pid = queue.pop()!;
          if (seen.has(pid)) continue;
          seen.add(pid);
          const row = rows.get(pid);
          if (row) {
            found.push({ pid, cpu: row.cpu, rssKb: row.rssKb, args: row.line.slice(row.argsAt) });
          }
          const next = kids.get(pid);
          if (next) queue.push(...next);
        }
        if (found.length) byRoot.set(root, found);
      }
    } catch { /* leave empty — callers treat it as "no descendants known" */ }
    return byRoot;
  }

  async listSessions(): Promise<Session[]> {
    const username = os.userInfo().username;

    const pids = [...this.sessions.values()].filter(s => s.pid > 0).map(s => ({ id: s.id, pid: s.pid }));

    // The session LIST is published every 2s (so a new pane shows up promptly),
    // but the per-session process stats behind it cost a `ps` of the whole
    // machine. Those stats only drive the CPU/mem chips, so they refresh on
    // their own slower clock and the list reuses the last snapshot in between.
    if (Date.now() - this.procInfoAt >= PROC_INFO_TTL_MS) {
      this.procInfoAt = Date.now();
      const descendantsByPid = await this.snapshotDescendants(new Set(pids.map(p => p.pid)));
      this.procInfo.clear();
      for (const { id, pid } of pids) {
        const children = descendantsByPid.get(pid) ?? [];
        let isClaudeCode = false, isCodex = false, isOpencode = false, isAntigravity = false, isCopilot = false, isGrok = false, isCursor = false, cpuPercent = 0, memMb = 0;
        for (const c of children) {
          const app = detectAgentApp(c.args);
          if (app === 'claude') isClaudeCode = true;
          else if (app === 'codex') isCodex = true;
          else if (app === 'opencode') isOpencode = true;
          else if (app === 'antigravity') isAntigravity = true;
          else if (app === 'copilot') isCopilot = true;
          else if (app === 'grok') isGrok = true;
          else if (app === 'cursor') isCursor = true;
          cpuPercent += c.cpu; memMb += c.rssKb / 1024;
        }
        this.procInfo.set(id, { isClaudeCode, isCodex, isOpencode, isAntigravity, isCopilot, isGrok, isCursor, cpuPercent: Math.round(cpuPercent * 10) / 10, memMb: Math.round(memMb) });
        // Any child at all means the shell isn't just sitting at a prompt.
        const sess = this.sessions.get(id);
        if (sess) sess.liveApp = children.length > 0;
      }
    }
    const processInfo = this.procInfo;

    return [...this.sessions.values()].map(sess => {
      const procs = processInfo.get(sess.id);
      const git = this.getGitInfo(sess.path);
      if (procs) {
        const newType = procs.isClaudeCode ? 'claude' : procs.isCodex ? 'codex' : procs.isOpencode ? 'opencode' : procs.isAntigravity ? 'antigravity' : procs.isCopilot ? 'copilot' : procs.isGrok ? 'grok' : procs.isCursor ? 'cursor' : null;
        if (newType && sess.sessionType !== newType) { sess.sessionType = newType; this.persist(); }
      }
      return {
        id: sess.id, name: sess.name, path: sess.path, username,
        last_activity: Math.floor(sess.createdAt / 1000),
        busy: this.isSessionBusy(sess.id), isClaudeCode: procs?.isClaudeCode ?? false,
        isCodex: procs?.isCodex ?? false, isOpencode: procs?.isOpencode ?? false, isAntigravity: procs?.isAntigravity ?? false, isCopilot: procs?.isCopilot ?? false, isGrok: procs?.isGrok ?? false, isCursor: procs?.isCursor ?? false,
        cpuPercent: procs?.cpuPercent ?? 0, memMb: procs?.memMb ?? 0,
        isHeadless: sess.isHeadless, ...git,
      };
    });
  }

  // ── Git & PR cache ───────────────────────────────────────────────────────

  getGitInfo(path: string): { gitRoot?: string; gitBranch?: string; gitDirty?: boolean; prNum?: number; prState?: string; prUrl?: string } {
    const cached = this.gitCache.get(path);
    if (!cached || !cached.gitRoot) return {};
    const info: any = { gitRoot: cached.gitRoot };
    if (cached.branch) info.gitBranch = cached.branch;
    if (cached.dirty) info.gitDirty = true;
    const pr = this.prCache.get(path);
    if (pr) { info.prNum = pr.prNum; info.prState = pr.prState; info.prUrl = pr.prUrl; }
    return info;
  }

  private async _refreshGitCache(): Promise<void> {
    const paths = new Set([...this.sessions.values()].map(s => s.path).filter(Boolean));
    const results = await mapLimit(Array.from(paths), EXEC_CONCURRENCY, async (cwd) => {
      try {
        // One rev-parse for all three values (it accepts multiple options and
        // answers in order), and a bounded number of paths in flight — this
        // sweep used to fire 4 commands × every path at once.
        const [revs, status] = await Promise.all([
          execAsync(nice(`git -C ${sh(cwd)} rev-parse --show-toplevel --git-common-dir --abbrev-ref HEAD 2>/dev/null`), { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => ''),
          execAsync(nice(`git -C ${sh(cwd)} status --short 2>/dev/null`), { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => ''),
        ]);
        const [toplevel = '', commonDir = '', branch = ''] = revs.split('\n').map(l => l.trim());
        if (!toplevel) return { cwd, gitRoot: null, branch: null, dirty: false };
        let gitRoot = toplevel;
        if (commonDir && commonDir !== '.git') {
          const absCommon = commonDir.startsWith('/') ? commonDir : join(cwd, commonDir);
          gitRoot = absCommon.replace(/\/\.git\/?$/, '');
        }
        return { cwd, gitRoot, branch: branch === 'HEAD' ? null : branch || null, dirty: status.length > 0 };
      } catch { return { cwd, gitRoot: null, branch: null, dirty: false }; }
    });
    for (const r of results) this.gitCache.set(r.cwd, { gitRoot: r.gitRoot, branch: r.branch, dirty: r.dirty });
  }

  private async _refreshPRCache(): Promise<void> {
    const entries = Array.from(this.gitCache.entries()).filter(([, v]) => v.branch);
    const results = await mapLimit(entries, EXEC_CONCURRENCY, async ([cwd]) => {
      try {
        const { stdout } = await execAsync(nice(`gh pr view --json url,number,state 2>/dev/null`), { cwd, timeout: 5000 });
        const pr = JSON.parse(stdout.trim());
        if (pr.number && pr.state) return { cwd, pr: { prNum: pr.number, prState: pr.state, prUrl: pr.url || '' } };
      } catch {}
      return { cwd, pr: null };
    });
    for (const r of results) this.prCache.set(r.cwd, r.pr);
  }

  // ── Misc ─────────────────────────────────────────────────────────────────

  async getSessionPid(sessionId: string): Promise<number | null> {
    return this.sessions.get(sessionId)?.pid ?? null;
  }

  /** Live working directory of the app running in the session's foreground
   *  (e.g. Claude Code), read from the OS rather than the OSC-7-tracked shell
   *  path — so relative paths an app prints resolve against ITS cwd. We read the
   *  shell's direct child (the foreground app) and fall back to the shell itself.
   *  Returns null if nothing resolves; callers fall back to the tracked path. */
  async getForegroundCwd(sessionId: string): Promise<string | null> {
    const sess = this.sessions.get(sessionId);
    if (!sess || sess.pid <= 0) return null;
    const isLinux = os.platform() === 'linux';

    const readCwd = async (pid: number): Promise<string> => {
      try {
        if (isLinux) {
          return await execAsync(`readlink /proc/${pid}/cwd 2>/dev/null`, { timeout: 2000 })
            .then(r => r.stdout.trim());
        }
        const { stdout } = await execAsync(`lsof -a -p ${pid} -d cwd -F n 2>/dev/null`, { timeout: 3000 });
        return stdout.split('\n').find(l => l.startsWith('n'))?.slice(1) ?? '';
      } catch { return ''; }
    };

    let childPids: number[] = [];
    try {
      const { stdout } = await execAsync(`pgrep -P ${sess.pid} 2>/dev/null`, { timeout: 2000 });
      childPids = stdout.trim().split('\n').filter(Boolean).map(n => parseInt(n, 10)).filter(n => n > 0);
    } catch { /* no children → fall back to shell */ }

    // Foreground app first (last-spawned child), then the shell as fallback.
    for (const pid of [...childPids.reverse(), sess.pid]) {
      const cwd = await readCwd(pid);
      if (cwd) return cwd;
    }
    return null;
  }

  getScrollbackPath(sessionId: string): string { return join(RING_DIR, `${sessionId}.buf`); }

  diagnostics(): object {
    // Per-session PTY details (PTYs live in the daemon; these are the bridge's view).
    const managedPtyDetails: { sessionId: string; pid: number; cols: number; rows: number }[] = [];
    for (const [id, s] of this.sessions) {
      managedPtyDetails.push({ sessionId: id, pid: s.pid, cols: s.cols, rows: s.rows });
    }

    // WebSocket client info (injected by server.ts).
    const wsDiag = (this as any)._wsClientsDiag?.() ?? { totalConnections: 0, clients: [] };

    return {
      type: 'direct-daemon',
      ringBufferSize: RING_SIZE,
      managedPtys: this.sessions.size,
      managedPtyDetails,
      scrollbackStreams: this.sessions.size,
      memBuffers: this.sessions.size,
      inputBuffers: this.inputBuffers.size,
      knownSessions: this.knownSessions.size,
      pubsubChannels: this.pubsub.channelStats(),
      serverMemory: process.memoryUsage(),
      websockets: wsDiag,
    };
  }

  // ── Persistence ──────────────────────────────────────────────────────────

  /** Write one session's state. Debounced per session by the store. */
  private persistSession(id: string): void {
    const sess = this.sessions.get(id);
    if (!sess) return;
    this.store.write(id, this.toStored(sess));
  }

  /** Write every session. Used where a change is not attributable to one. */
  private persist(): void {
    for (const id of this.sessions.keys()) this.persistSession(id);
  }

  private toStored(sess: DirectSession): StoredSession {
    const agent = this.agentState.get(sess.id);
    const turn = this.agentTurns.get(sess.id);
    return {
      name: sess.name, path: sess.path, sessionType: sess.sessionType,
      isHeadless: sess.isHeadless,
      modes: sess.modes && sess.modes.size ? [...sess.modes] : undefined,
      agent, turn,
    };
  }


  /** Coalesced persist for mode changes. An interactive shell re-emits
   *  bracketed-paste (?2004h/l) around every command, so writing the file
   *  synchronously on each transition would mean two writes per command. */
  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async restoreSessions(): Promise<void> {
    // Bring the old single-file registry across before reading, once.
    this.store.migrateFromLegacyFile(msg => logger.info(msg));
    const saved = this.loadSaved();
    const entries = Object.entries(saved);
    if (entries.length === 0) return;

    // Check which sessions the daemon still has alive
    let daemonSessions: { id: string; pid: number; cwd?: string }[] = [];
    try {
      const resp = await this.daemon.request({ type: 'list' });
      daemonSessions = resp.sessions ?? [];
    } catch {}
    const daemonMap = new Map(daemonSessions.map(s => [s.id, s]));

    for (const [id, info] of entries) {
      // The agent keeps running across a server restart, so a "busy" it
      // reported before we went down is still true — that is the point of
      // persisting it. Anything past the trust window is dropped rather than
      // restored: an agent that died while we were down would otherwise come
      // back busy and stay that way, with no hook left to say otherwise.
      if (info.agent && Date.now() - info.agent.at <= AGENT_STATE_TTL_MS) {
        this.agentState.set(id, {
          state: info.agent.state as AgentState,
          source: info.agent.source,
          at: info.agent.at,
        });
      }
      if (info.turn) this.agentTurns.set(id, info.turn);

      const ring = new RingBuffer(RING_SIZE);
      ring.loadFrom(join(RING_DIR, `${id}.buf`));

      if (daemonMap.has(id)) {
        // Session still alive in daemon — just reconnect, use daemon's current cwd
        const ds = daemonMap.get(id)!;
        const sess: DirectSession = {
          id, name: info.name, path: ds.cwd || info.path, pid: ds.pid,
          ring, cols: 120, rows: 40, createdAt: Date.now(), sessionType: info.sessionType,
          isHeadless: info.isHeadless,
        };
        // Seed sticky modes from the LAST PERSISTED SET, then replay the ring
        // over it. The persisted set is what survives a long-running app whose
        // startup sequences have rolled off the ring; replaying the ring on top
        // applies anything that changed since (e.g. the app exited and reset
        // alt-screen). Ring-only seeding silently lost mouse tracking for a
        // live Claude Code on every server restart — the pane then had no
        // working scroll until the app itself was restarted.
        sess.modes = new Set(info.modes ?? []);
        trackPrivateModes(sess.modes, ring.read());
        this.sessions.set(id, sess);
        await this.daemon.request({ type: 'subscribe', id });
        const num = parseInt(id.replace('direct-', ''), 10);
        if (num >= this.nextId) this.nextId = num + 1;
        logger.info(`Reconnected to live session: ${id} (${info.name})`);
      } else {
        // Session died (reboot). Recreate with fresh shell, restore scrollback.
        try {
          const resp = await this.daemon.request({ type: 'create', id, cwd: info.path, cols: 120, rows: 40, env: agentEnv(id, this.listenPort) });
          const sess: DirectSession = {
            id, name: info.name, path: info.path, pid: resp.pid ?? 0,
            ring, cols: 120, rows: 40, createdAt: Date.now(), sessionType: info.sessionType,
            isHeadless: info.isHeadless,
          };
          this.sessions.set(id, sess);
          await this.daemon.request({ type: 'subscribe', id });
          const num = parseInt(id.replace('direct-', ''), 10);
          if (num >= this.nextId) this.nextId = num + 1;
          logger.info(`Restored session (fresh shell): ${id} (${info.name}) at ${info.path}`);
        } catch (e) {
          logger.debug(`Failed to restore session ${id}: ${e}`);
        }
      }
    }

    // Prime `liveApp` before any client can reconnect. Without this the first
    // connect after a restart (which is exactly when every pane reconnects)
    // would see `undefined`, decide "no app running", and force mouse tracking
    // off on panes whose full-screen app is very much alive.
    await this.refreshLiveApps();
  }

  /** Refresh `liveApp` for every session: does its PTY have a child process? */
  private async refreshLiveApps(): Promise<void> {
    const pids = new Set([...this.sessions.values()].map(s => s.pid).filter(p => p > 0));
    const childrenByPid = await this.snapshotDescendants(pids);
    for (const sess of this.sessions.values()) {
      sess.liveApp = sess.pid > 0 && (childrenByPid.get(sess.pid)?.length ?? 0) > 0;
    }
  }

  private loadSaved(): Record<string, StoredSession> {
    return this.store.readAll();
  }


  /** Persist rings that changed since the last flush.
   *
   *  This used to write every session unconditionally — 34 × 256 KB of
   *  synchronous `writeFileSync` every 10 seconds, which blocked the event loop
   *  (and therefore keystroke delivery) for hundreds of milliseconds. Idle
   *  sessions are skipped outright now; `stop()` still calls this to get a final
   *  flush, so nothing is lost on shutdown. */
  private flushRings(): void {
    for (const [id, sess] of this.sessions) {
      if (this.flushedVersions.get(id) === sess.ring.version) continue;
      try {
        sess.ring.saveTo(join(RING_DIR, `${id}.buf`));
        this.flushedVersions.set(id, sess.ring.version);
      } catch { /* retry on the next tick */ }
    }
  }
}
