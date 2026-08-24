/**
 * PTY Daemon — a long-lived process that holds PTY file descriptors.
 *
 * Runs as a detached child process, survives parent (sheepit server)
 * restarts. Communicates with the main server via a unix domain socket.
 *
 * Protocol: newline-delimited JSON messages over the socket.
 *
 * Survival: ignores SIGHUP/SIGTERM/SIGINT and keeps running through
 * uncaught exceptions. The only clean ways to shut it down are the
 * explicit `shutdown` socket message or SIGKILL. This is deliberate —
 * if the daemon dies, every PTY (and every Claude Code process inside)
 * dies with it, and users lose their sessions on server restart.
 *
 * Usage: node pty-daemon.ts (started automatically by DirectBridge)
 */

import * as net from 'net';
import * as pty from 'node-pty';
import type { IPty } from 'node-pty';
import { existsSync, unlinkSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { configDir } from './paths.js';

const CONFIG_DIR = configDir();
const SOCKET_PATH = join(CONFIG_DIR, 'pty-daemon.sock');
const PID_FILE = join(CONFIG_DIR, 'pty-daemon.pid');
const LOG_FILE = join(CONFIG_DIR, 'pty-daemon.log');

mkdirSync(CONFIG_DIR, { recursive: true });

function daemonLog(msg: string): void {
  try { appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`); } catch {}
}

// ── State ────────────────────────────────────────────────────────────────────

interface DaemonSession {
  id: string;
  pty: IPty;
  pid: number;
  cwd: string;
}

/** Pool-warmed shell. Spawned in $HOME with rc files already sourced, waiting
 *  to be claimed. On claim the daemon re-keys it to the client-requested id
 *  and writes `cd <target> && clear` so the client sees a fresh prompt in
 *  the target directory without paying the spawn + rc-file cost. */
interface PooledShell {
  pty: IPty;
  pid: number;
  cols: number;
  rows: number;
  /** Captured from onData until the shell is claimed, then discarded so the
   *  client never sees the initial rc-file/prompt output. */
  preClaimBuf: string;
}

const POOL_SIZE = (() => {
  const raw = process.env.SHEEPIT_SHELL_POOL_SIZE;
  if (raw === undefined) return 2;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 2;
})();
const POOL_SHELL = process.env.SHELL || 'bash';
const POOL_DEFAULT_COLS = 120;
const POOL_DEFAULT_ROWS = 40;

const shellPool: PooledShell[] = [];

/** Parse OSC 7 (file://host/path) from terminal output */
const OSC7_RE = /\x1b\]7;file:\/\/[^/]*([^\x07\x1b]*?)(?:\x07|\x1b\\)/g;

function parseOsc7(data: string): string | null {
  let last: string | null = null;
  for (const m of data.matchAll(OSC7_RE)) {
    if (m[1]) last = decodeURIComponent(m[1]);
  }
  return last;
}

const sessions = new Map<string, DaemonSession>();
const subscribers = new Map<string, Set<net.Socket>>(); // sessionId → sockets listening for output

// ── Message types ────────────────────────────────────────────────────────────

interface DaemonRequest {
  type: 'create' | 'kill' | 'write' | 'resize' | 'list' | 'subscribe' | 'unsubscribe' | 'ping' | 'shutdown';
  id?: string;
  reqId?: string;
  shell?: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  data?: string;
  env?: Record<string, string>;
  /** Opt-in: if true, the daemon will try to claim a pre-spawned shell from
   *  the pool instead of spawning fresh. On hit, the pool shell is re-keyed
   *  to `req.id`, resized to `req.cols`/`req.rows`, and told to `cd <cwd>`.
   *  On miss (or when pooling is disabled), falls back to a fresh spawn. */
  fromPool?: boolean;
}

interface DaemonResponse {
  type: 'ok' | 'error' | 'output' | 'exit' | 'list' | 'pong' | 'cwd_changed';
  reqId?: string;
  id?: string;
  pid?: number;
  data?: string;
  sessions?: { id: string; pid: number; cwd?: string }[];
  error?: string;
}

function sendMsg(socket: net.Socket, msg: DaemonResponse): void {
  try {
    socket.write(JSON.stringify(msg) + '\n');
  } catch { /* socket closed */ }
}

// ── Handlers ─────────────────────────────────────────────────────────────────

/** Wire up data/exit handlers for a daemon session. These look up `sess.id`
 *  (not a captured variable), so re-keying a pooled shell works transparently:
 *  after the re-key, future output goes to subscribers of the new id. */
function attachSessionHandlers(sess: DaemonSession): void {
  sess.pty.onData((data) => {
    // Detect cwd changes via OSC 7
    const newCwd = parseOsc7(data);
    if (newCwd && newCwd !== sess.cwd) {
      sess.cwd = newCwd;
      const subs = subscribers.get(sess.id);
      if (subs) {
        for (const s of subs) sendMsg(s, { type: 'cwd_changed', id: sess.id, data: newCwd });
      }
    }

    const subs = subscribers.get(sess.id);
    if (subs) {
      for (const s of subs) sendMsg(s, { type: 'output', id: sess.id, data });
    }
  });

  sess.pty.onExit(() => {
    sessions.delete(sess.id);
    const subs = subscribers.get(sess.id);
    if (subs) {
      for (const s of subs) sendMsg(s, { type: 'exit', id: sess.id });
      subscribers.delete(sess.id);
    }
  });
}

/** Escape a path for use inside single-quoted shell context. */
function shEscape(p: string): string {
  return `'${p.replace(/'/g, "'\\''")}'`;
}

/** Pop a pool shell if one is ready. Triggers a background top-up. */
function claimFromPool(): PooledShell | null {
  const shell = shellPool.shift() ?? null;
  if (shell) setImmediate(topUpPool);
  return shell;
}

/** Spawn a single shell into the pool, sitting in $HOME with a settled
 *  prompt. Output is captured into `preClaimBuf` (which is discarded at
 *  claim time) so the client never sees the pool shell's boot chatter. */
function spawnPoolShell(): void {
  try {
    const p = pty.spawn(POOL_SHELL, ['-l'], {
      name: 'xterm-256color',
      cols: POOL_DEFAULT_COLS,
      rows: POOL_DEFAULT_ROWS,
      cwd: homedir(),
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>,
    });
    const slot: PooledShell = {
      pty: p, pid: p.pid,
      cols: POOL_DEFAULT_COLS, rows: POOL_DEFAULT_ROWS,
      preClaimBuf: '',
    };
    // Temporary onData capture — discarded on claim. Cap buffer so a runaway
    // MOTD can't eat memory.
    const dataDisposable = p.onData((data) => {
      if (slot.preClaimBuf.length < 64 * 1024) slot.preClaimBuf += data;
    });
    const exitDisposable = p.onExit(() => {
      const idx = shellPool.indexOf(slot);
      if (idx >= 0) shellPool.splice(idx, 1);
      dataDisposable.dispose();
      exitDisposable.dispose();
      daemonLog(`pool shell ${slot.pid} exited before claim`);
      setImmediate(topUpPool);
    });
    (slot as PooledShell & { _dispose: () => void })._dispose = () => {
      dataDisposable.dispose();
      exitDisposable.dispose();
    };
    shellPool.push(slot);
    daemonLog(`pool shell spawned pid=${p.pid} pool=${shellPool.length}/${POOL_SIZE}`);
  } catch (e) {
    daemonLog(`pool shell spawn FAILED: ${e}`);
  }
}

/** Keep the pool at POOL_SIZE. Called at start, after claims, and after
 *  a pool shell exits unexpectedly. */
function topUpPool(): void {
  while (shellPool.length < POOL_SIZE) spawnPoolShell();
}

function handleCreate(req: DaemonRequest, socket: net.Socket): void {
  const id = req.id!;
  if (sessions.has(id)) {
    sendMsg(socket, { type: 'ok', reqId: req.reqId, id, pid: sessions.get(id)!.pid });
    return;
  }

  const cols = req.cols || 120;
  const rows = req.rows || 40;
  const targetCwd = req.cwd || homedir();

  // ── Pool path ──────────────────────────────────────────────────────────
  if (req.fromPool && POOL_SIZE > 0) {
    const claimed = claimFromPool();
    if (claimed) {
      // Drop the temporary capture handlers so attachSessionHandlers becomes
      // the sole listener on this PTY.
      const slot = claimed as PooledShell & { _dispose?: () => void };
      if (slot._dispose) slot._dispose();

      // Resize to match the client's requested geometry.
      if (cols !== claimed.cols || rows !== claimed.rows) {
        try { claimed.pty.resize(cols, rows); } catch {}
      }

      const sess: DaemonSession = {
        id, pty: claimed.pty, pid: claimed.pid, cwd: targetCwd,
      };
      sessions.set(id, sess);
      attachSessionHandlers(sess);

      // A pooled shell was spawned before this session id existed, so req.env
      // never reached it. Export the variables here instead: the same write
      // that repoints the shell also seeds its environment, so an agent
      // launched in this pane — and the hooks it runs — can tell which
      // sheepit session they belong to. `clear` below hides this line.
      const exports = Object.entries(req.env ?? {})
        .map(([k, v]) => `export ${k}=${shEscape(String(v))}; `)
        .join('');

      // cd into the target, then clear the screen so the client sees a fresh
      // prompt in the right directory. `&& clear` fails loudly if the target
      // doesn't exist — better than silently landing in $HOME.
      claimed.pty.write(`${exports}cd ${shEscape(targetCwd)} && clear\r`);

      daemonLog(`create ${id} via pool pid=${claimed.pid} cwd=${targetCwd} size=${cols}x${rows}`);
      sendMsg(socket, { type: 'ok', reqId: req.reqId, id, pid: claimed.pid });
      return;
    }
    // Pool miss — fall through to fresh spawn.
  }

  // ── Fresh spawn path (original behavior) ───────────────────────────────
  const shell = req.shell || process.env.SHELL || 'bash';
  daemonLog(`create ${id} shell=${shell} cols=${cols} rows=${rows} cwd=${targetCwd}`);
  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: targetCwd,
    env: { ...process.env, ...req.env, TERM: 'xterm-256color' } as Record<string, string>,
  });

  const sess: DaemonSession = { id, pty: p, pid: p.pid, cwd: targetCwd };
  sessions.set(id, sess);
  attachSessionHandlers(sess);

  sendMsg(socket, { type: 'ok', reqId: req.reqId, id, pid: p.pid });
}

function handleRequest(req: DaemonRequest, socket: net.Socket): void {
  switch (req.type) {
    case 'ping':
      sendMsg(socket, { type: 'pong', reqId: req.reqId });
      break;

    case 'create':
      handleCreate(req, socket);
      break;

    case 'kill': {
      const sess = sessions.get(req.id!);
      if (sess) {
        try { sess.pty.kill(); } catch {}
        sessions.delete(req.id!);
      }
      sendMsg(socket, { type: 'ok', reqId: req.reqId, id: req.id });
      break;
    }

    case 'write': {
      const sess = sessions.get(req.id!);
      if (sess) sess.pty.write(req.data!);
      break; // No response needed for writes (perf)
    }

    case 'resize': {
      const sess = sessions.get(req.id!);
      if (sess) {
        try {
          sess.pty.resize(req.cols!, req.rows!);
          daemonLog(`resize ${req.id} to ${req.cols}x${req.rows}`);
        } catch (e) {
          daemonLog(`resize FAILED ${req.id}: ${e}`);
        }
      } else {
        daemonLog(`resize ${req.id}: session NOT FOUND`);
      }
      break;
    }

    case 'subscribe': {
      const id = req.id!;
      if (!subscribers.has(id)) subscribers.set(id, new Set());
      subscribers.get(id)!.add(socket);
      sendMsg(socket, { type: 'ok', reqId: req.reqId, id });
      break;
    }

    case 'unsubscribe': {
      const id = req.id!;
      subscribers.get(id)?.delete(socket);
      break;
    }

    case 'list': {
      const list = [...sessions.entries()].map(([id, s]) => ({ id, pid: s.pid, cwd: s.cwd }));
      sendMsg(socket, { type: 'list', reqId: req.reqId, sessions: list });
      break;
    }

    case 'shutdown': {
      daemonLog(`shutdown requested via socket`);
      sendMsg(socket, { type: 'ok', reqId: req.reqId });
      // Give the response a tick to flush, then exit (the `exit` handler
      // will kill every PTY and clean up the socket/pid files).
      setTimeout(() => process.exit(0), 10);
      break;
    }
  }
}

// ── Server ───────────────────────────────────────────────────────────────────

// Clean up stale socket
if (existsSync(SOCKET_PATH)) {
  try { unlinkSync(SOCKET_PATH); } catch {}
}

const server = net.createServer((socket) => {
  daemonLog(`client connected`);
  let buf = '';

  socket.on('data', (chunk) => {
    buf += chunk.toString();
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      try {
        const req = JSON.parse(line) as DaemonRequest;
        handleRequest(req, socket);
      } catch { /* malformed message */ }
    }
  });

  socket.on('close', () => {
    daemonLog(`client disconnected`);
    // Remove this socket from all subscriber lists. The PTYs themselves
    // stay alive — that's the whole point of the daemon.
    for (const [, subs] of subscribers) {
      subs.delete(socket);
    }
  });

  socket.on('error', (err) => {
    daemonLog(`client socket error: ${err?.message || err}`);
    for (const [, subs] of subscribers) {
      subs.delete(socket);
    }
  });
});

server.listen(SOCKET_PATH, () => {
  // Write PID file so the main server can check if we're running
  writeFileSync(PID_FILE, String(process.pid));
  daemonLog(`daemon started pid=${process.pid} socket=${SOCKET_PATH} poolSize=${POOL_SIZE}`);
  // Warm the shell pool asynchronously — non-blocking so the daemon is
  // immediately ready to handle create requests even while shells are
  // still spinning up in the background.
  if (POOL_SIZE > 0) setImmediate(topUpPool);
});

// Clean up on exit
process.on('exit', () => {
  daemonLog(`daemon exiting pid=${process.pid}`);
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  for (const [, sess] of sessions) {
    try { sess.pty.kill(); } catch {}
  }
  // Drain the warm pool too — these are daemon-owned shells with no client.
  for (const slot of shellPool) {
    try { slot.pty.kill(); } catch {}
  }
});

// ── Signal & crash resilience ────────────────────────────────────────────────
//
// Ignore every termination signal we can catch. The only clean shutdown path
// is the `shutdown` socket message; anything else must be SIGKILL. Without
// this, signal propagation from the parent process tree (tsx watch restarts,
// Ctrl+C in dev.sh, terminal close, etc.) can take down every PTY with it.
//
// We log signals so that if the daemon does die, ~/.config/sheepit/pty-daemon.log
// tells us which signal (if any) preceded the death.
process.on('SIGHUP', () => daemonLog('received SIGHUP — ignoring'));
process.on('SIGTERM', () => daemonLog('received SIGTERM — ignoring'));
process.on('SIGINT', () => daemonLog('received SIGINT — ignoring'));

// Without these, an uncaught error would crash the daemon silently (stdio
// is 'ignore', so there's nowhere for the stack trace to go). Log and keep
// running — a half-broken daemon is still better than a dead one.
process.on('uncaughtException', (err) => {
  daemonLog(`uncaughtException: ${err?.stack || err}`);
});
process.on('unhandledRejection', (reason) => {
  daemonLog(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`);
});
