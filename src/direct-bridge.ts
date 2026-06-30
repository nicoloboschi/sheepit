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
import type { BridgeMessage, Session } from './bridge.js';
import { mkdirSync, existsSync, writeFileSync, readFileSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import os from 'os';
import { logger } from './server.js';
import type { MemoryStore } from './memory.js';

const execAsync = promisify(exec);
const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Configuration ────────────────────────────────────────────────────────────

const CONFIG_DIR = join(os.homedir(), '.config', 'vipershell');
const SESSIONS_FILE = join(CONFIG_DIR, 'direct-sessions.json');
const RING_DIR = join(CONFIG_DIR, 'ring-buffers');
const RING_SIZE = 256 * 1024;
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

class RingBuffer {
  private buf: Buffer;
  private pos = 0;
  private full = false;

  constructor(size: number) { this.buf = Buffer.alloc(size); }

  write(data: string): void {
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

/** Update `active` from DECSET (?Nh) / DECRST (?Nl) sequences in `data`. */
function trackPrivateModes(active: Set<number>, data: string): void {
  const re = /\x1b\[\?([0-9;]+)([hl])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(data)) !== null) {
    const enable = m[2] === 'h';
    for (const part of m[1]!.split(';')) {
      const n = parseInt(part, 10);
      if (!STICKY_PRIVATE_MODES.has(n)) continue;
      if (enable) active.add(n); else active.delete(n);
    }
  }
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
// We force these modes OFF immediately after the replayed snapshot; a genuinely
// live full-screen app re-arms them through its own output (it redraws on the
// resize we send at subscribe, and on the next keystroke). We deliberately do NOT
// try to restore mouse state from history — the ring can't tell "stale on" from
// "really on", so the safe default is off-until-the-app-asks.
const MOUSE_FOCUS_MODES = [1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016];
const MOUSE_FOCUS_RESET = MOUSE_FOCUS_MODES.map(n => `\x1b[?${n}l`).join('');

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
  const lastIndexOf = (re: RegExp): number => {
    let idx = -1, m: RegExpExecArray | null;
    const g = new RegExp(re.source, 'g');
    while ((m = g.exec(snapshot)) !== null) idx = m.index;
    return idx;
  };
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
  /** Active sticky DEC private modes, tracked from output (see above). */
  modes?: Set<number>;
}

interface SavedDirectSession {
  name: string;
  path: string;
  sessionType?: string | null;
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

  constructor() {
    mkdirSync(CONFIG_DIR, { recursive: true });
    mkdirSync(RING_DIR, { recursive: true });
  }

  // Reserved for future memory-aware features; kept on the API surface so
  // index.ts can wire in a MemoryStore without needing a conditional.
  setMemory(_memory: MemoryStore): void { /* noop for now */ }

  async start(): Promise<void> {
    this.daemon.setHandlers(
      (id, data) => {
        const sess = this.sessions.get(id);
        if (sess) {
          trackPrivateModes(sess.modes ??= new Set(), data);
          sess.ring.write(data);
          this.pubsub.publish(id, { type: 'output', data });
        }
      },
      (id) => {
        this.sessions.delete(id);
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

    this.ringFlushInterval = setInterval(() => this.flushRings(), 10_000);
    this.sessionListInterval = setInterval(() => this.discoverSessions(), 2000);
    this.previewInterval = setInterval(() => this.publishPreviews(), 1000);
    this.gitCacheInterval = setInterval(() => this._refreshGitCache(), 10_000);
    this.prCacheInterval = setInterval(() => this._refreshPRCache(), 30_000);

    // Populate git cache BEFORE first session discovery so git info is available
    await this._refreshGitCache();
    await this.discoverSessions();

    logger.info('DirectBridge started (daemon mode)');
  }

  stop(): void {
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
      if (!liveIds.has(id)) { this.knownSessions.delete(id); this.inputBuffers.delete(id); }
    }
    for (const s of sessions) {
      if (!this.knownSessions.has(s.id)) { this.knownSessions.add(s.id); this.persist(); }
    }
    this.pubsub.publish('__sessions__', { type: 'sessions', sessions });
  }

  getCachedSessions(): Session[] { return this.cachedSessions; }

  /** Publish last 2 lines of each session as a preview (triggers unseen indicators) */
  private publishPreviews(): void {
    for (const sess of this.sessions.values()) {
      const raw = sess.ring.read();
      if (!raw) continue;
      // Strip ANSI escapes and get last 2 non-empty lines
      const stripped = stripEscapeSequences(raw);
      const lines = stripped.split('\n').filter(l => l.trim());
      const preview = lines.slice(-2).join('\n');

      // Only publish if changed
      const prev = this.lastPreviews.get(sess.id);
      if (preview === prev) continue;
      this.lastPreviews.set(sess.id, preview);

      const cached = this.cachedSessions.find(s => s.id === sess.id);
      this.pubsub.publish('__sessions__', {
        type: 'preview',
        session_id: sess.id,
        preview,
        busy: cached?.busy ?? false,
      });
    }
  }

  // ── Session lifecycle ────────────────────────────────────────────────────

  async createSession(path?: string, initialCols?: number, initialRows?: number): Promise<string> {
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
    });

    const sess: DirectSession = {
      id, name, path: sessionPath, pid: resp.pid ?? 0, ring,
      cols, rows, createdAt: Date.now(),
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
    const ringPath = join(RING_DIR, `${sessionId}.buf`);
    try { if (existsSync(ringPath)) unlinkSync(ringPath); } catch {}
    this.persist();
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
    // Order: re-assert sticky modes (alt-screen first) → replay snapshot → force
    // mouse/focus tracking OFF, and drop a stale alternate-screen buffer, so the
    // reconnected pane lands on the live shell rather than a frozen dead frame or
    // an input-grabbing mouse state (see MOUSE_FOCUS_RESET / ALT_SCREEN_RESET).
    const modePrefix = privateModePrefix(sess.modes ?? new Set());
    const altReset = altScreenStale(snapshot) ? ALT_SCREEN_RESET : '';
    if (modePrefix || snapshot) onOutput(modePrefix + snapshot + MOUSE_FOCUS_RESET + altReset);
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
        this.pubsub.publish('__sessions__', { type: 'current_input', session_id: sessionId, input: '' });
      } else if (ch === '\x7f' || ch === '\b') {
        const cur = this.inputBuffers.get(sessionId) ?? '';
        this.inputBuffers.set(sessionId, cur.slice(0, -1));
        this.pubsub.publish('__sessions__', { type: 'current_input', session_id: sessionId, input: this.inputBuffers.get(sessionId) ?? '' });
      } else if (ch >= ' ' || ch === '\t') {
        this.inputBuffers.set(sessionId, (this.inputBuffers.get(sessionId) ?? '') + ch);
        this.pubsub.publish('__sessions__', { type: 'current_input', session_id: sessionId, input: this.inputBuffers.get(sessionId) ?? '' });
      }
    }
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

  async listSessions(): Promise<Session[]> {
    const username = os.userInfo().username;
    const isLinux = os.platform() === 'linux';

    const pids = [...this.sessions.values()].filter(s => s.pid > 0).map(s => ({ id: s.id, pid: s.pid }));
    const processInfo = new Map<string, { isClaudeCode: boolean; isCodex: boolean; cpuPercent: number; memMb: number; busy: boolean }>();

    await Promise.all(pids.map(async ({ id, pid }) => {
      try {
        const cmd = isLinux
          ? `ps -o pid=,pcpu=,rss=,args= --ppid ${pid} 2>/dev/null`
          : `pgrep -P ${pid} 2>/dev/null | xargs -I{} ps -p {} -o pid=,pcpu=,rss=,args= 2>/dev/null`;
        const { stdout } = await execAsync(cmd, { timeout: 3000 });
        let isClaudeCode = false, isCodex = false, cpuPercent = 0, memMb = 0, busy = false;
        for (const line of stdout.trim().split('\n').filter(Boolean)) {
          const parts = line.trim().split(/\s+/);
          if (parts.length < 4) continue;
          const cpu = parseFloat(parts[1] ?? '0');
          const rss = parseInt(parts[2] ?? '0', 10);
          const comm = parts.slice(3).join(' ');
          if (/\bclaude\b/i.test(comm)) isClaudeCode = true;
          if (/\bcodex\b/i.test(comm)) isCodex = true;
          if (cpu > 5) busy = true;
          cpuPercent += cpu; memMb += rss / 1024;
        }
        processInfo.set(id, { isClaudeCode, isCodex, cpuPercent: Math.round(cpuPercent * 10) / 10, memMb: Math.round(memMb), busy });
      } catch {}
    }));

    return [...this.sessions.values()].map(sess => {
      const procs = processInfo.get(sess.id);
      const git = this.getGitInfo(sess.path);
      if (procs) {
        const newType = procs.isClaudeCode ? 'claude' : procs.isCodex ? 'codex' : null;
        if (newType && sess.sessionType !== newType) { sess.sessionType = newType; this.persist(); }
      }
      return {
        id: sess.id, name: sess.name, path: sess.path, username,
        last_activity: Math.floor(sess.createdAt / 1000),
        busy: procs?.busy ?? false, isClaudeCode: procs?.isClaudeCode ?? false,
        isCodex: procs?.isCodex ?? false,
        cpuPercent: procs?.cpuPercent ?? 0, memMb: procs?.memMb ?? 0, ...git,
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
    const results = await Promise.all(Array.from(paths).map(async (cwd) => {
      try {
        const [toplevel, commonDir, branch, status] = await Promise.all([
          execAsync(`git -C ${sh(cwd)} rev-parse --show-toplevel 2>/dev/null`, { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => ''),
          execAsync(`git -C ${sh(cwd)} rev-parse --git-common-dir 2>/dev/null`, { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => ''),
          execAsync(`git -C ${sh(cwd)} rev-parse --abbrev-ref HEAD 2>/dev/null`, { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => ''),
          execAsync(`git -C ${sh(cwd)} status --short 2>/dev/null`, { timeout: 3000 }).then(r => r.stdout.trim()).catch(() => ''),
        ]);
        if (!toplevel) return { cwd, gitRoot: null, branch: null, dirty: false };
        let gitRoot = toplevel;
        if (commonDir && commonDir !== '.git') {
          const absCommon = commonDir.startsWith('/') ? commonDir : join(cwd, commonDir);
          gitRoot = absCommon.replace(/\/\.git\/?$/, '');
        }
        return { cwd, gitRoot, branch: branch === 'HEAD' ? null : branch || null, dirty: status.length > 0 };
      } catch { return { cwd, gitRoot: null, branch: null, dirty: false }; }
    }));
    for (const r of results) this.gitCache.set(r.cwd, { gitRoot: r.gitRoot, branch: r.branch, dirty: r.dirty });
  }

  private async _refreshPRCache(): Promise<void> {
    const entries = Array.from(this.gitCache.entries()).filter(([, v]) => v.branch);
    const results = await Promise.all(entries.map(async ([cwd]) => {
      try {
        const { stdout } = await execAsync(`gh pr view --json url,number,state 2>/dev/null`, { cwd, timeout: 5000 });
        const pr = JSON.parse(stdout.trim());
        if (pr.number && pr.state) return { cwd, pr: { prNum: pr.number, prState: pr.state, prUrl: pr.url || '' } };
      } catch {}
      return { cwd, pr: null };
    }));
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

  private persist(): void {
    const saved: Record<string, SavedDirectSession> = {};
    for (const [id, sess] of this.sessions) {
      saved[id] = { name: sess.name, path: sess.path, sessionType: sess.sessionType };
    }
    try { writeFileSync(SESSIONS_FILE, JSON.stringify(saved, null, 2)); } catch {}
  }

  private async restoreSessions(): Promise<void> {
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
      const ring = new RingBuffer(RING_SIZE);
      ring.loadFrom(join(RING_DIR, `${id}.buf`));

      if (daemonMap.has(id)) {
        // Session still alive in daemon — just reconnect, use daemon's current cwd
        const ds = daemonMap.get(id)!;
        const sess: DirectSession = {
          id, name: info.name, path: ds.cwd || info.path, pid: ds.pid,
          ring, cols: 120, rows: 40, createdAt: Date.now(), sessionType: info.sessionType,
        };
        // Seed sticky modes from the persisted ring — the app (still alive) set
        // them before this restart, so reconnect can restore alt-screen/mouse.
        trackPrivateModes(sess.modes = new Set(), ring.read());
        this.sessions.set(id, sess);
        await this.daemon.request({ type: 'subscribe', id });
        const num = parseInt(id.replace('direct-', ''), 10);
        if (num >= this.nextId) this.nextId = num + 1;
        logger.info(`Reconnected to live session: ${id} (${info.name})`);
      } else {
        // Session died (reboot). Recreate with fresh shell, restore scrollback.
        try {
          const resp = await this.daemon.request({ type: 'create', id, cwd: info.path, cols: 120, rows: 40 });
          const sess: DirectSession = {
            id, name: info.name, path: info.path, pid: resp.pid ?? 0,
            ring, cols: 120, rows: 40, createdAt: Date.now(), sessionType: info.sessionType,
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
  }

  private loadSaved(): Record<string, SavedDirectSession> {
    try {
      if (existsSync(SESSIONS_FILE)) return JSON.parse(readFileSync(SESSIONS_FILE, 'utf-8'));
    } catch {}
    return {};
  }

  private flushRings(): void {
    for (const [id, sess] of this.sessions) {
      try { sess.ring.saveTo(join(RING_DIR, `${id}.buf`)); } catch {}
    }
  }
}
