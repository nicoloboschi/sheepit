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
import { existsSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, appendFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { homedir } from 'os';
import { configDir } from './paths.js';

const CONFIG_DIR = configDir();
const SOCKET_PATH = join(CONFIG_DIR, 'pty-daemon.sock');
const PID_FILE = join(CONFIG_DIR, 'pty-daemon.pid');
/** The code this process started with, so a supervisor can tell exactly
 *  whether a running proxy predates the source on disk. Timestamps cannot:
 *  a pull, a touch, a second worktree or a clock skew all lie about it, and
 *  guessing wrong here closes every session. */
const FINGERPRINT_FILE = join(CONFIG_DIR, 'pty-daemon.fingerprint');

function codeFingerprint(): string {
  const self = fileURLToPath(import.meta.url);
  const ext = self.endsWith('.ts') ? '.ts' : '.js';
  const h = createHash('sha256');
  for (const f of [self, join(dirname(self), `paths${ext}`)]) {
    try { h.update(readFileSync(f)); } catch { h.update(f); }
  }
  return h.digest('hex').slice(0, 16);
}
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
  /** Output waiting to be coalesced into one message (see OUTPUT_FLUSH_MS). */
  pending: string[];
  pendingBytes: number;
  flushTimer: NodeJS.Timeout | null;
  lastFlushAt: number;
}

/**
 * A PTY hands back output in very small pieces — a `cat` of a large file
 * arrives as hundreds of ~40-byte chunks per second, and each one became its
 * own daemon socket write and its own WebSocket frame. Batching them for a few
 * milliseconds turns that into a handful of larger messages.
 *
 * The flush is leading-edge: the first chunk after a quiet moment goes out
 * immediately, so keystroke echo is unaffected, and only sustained output is
 * batched.
 */
/**
 * Protocol version. Bump it when the message shape changes, so a server can
 * tell that the proxy it just connected to predates what it speaks.
 *
 * Keeping this at 1 forever is the goal, not an accident: features belong in
 * the server, which restarts freely. Everything this process does is move
 * bytes and route ids, because a session lives exactly as long as the process
 * holding its PTY master fd — so every reason to redeploy this file is a
 * reason someone loses their shells. Read escape sequences, name sessions,
 * warm pools, track state: all of that is the server's job, off the same byte
 * stream. If you are about to add a feature here, add it there instead.
 */
const PROTOCOL_VERSION = 1;

const OUTPUT_FLUSH_MS = 8;
const OUTPUT_MAX_BYTES = 64 * 1024;


/** Parse OSC 7 (file://host/path) from terminal output */

const sessions = new Map<string, DaemonSession>();
const subscribers = new Map<string, Set<net.Socket>>(); // sessionId → sockets listening for output

// ── Message types ────────────────────────────────────────────────────────────

interface DaemonRequest {
  type: 'create' | 'rekey' | 'kill' | 'write' | 'resize' | 'list' | 'subscribe' | 'unsubscribe' | 'ping' | 'shutdown';
  id?: string;
  /** rekey: the id to move a session to. */
  to?: string;
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
}

interface DaemonResponse {
  type: 'ok' | 'error' | 'output' | 'exit' | 'list' | 'pong';
  reqId?: string;
  protocol?: number;
  id?: string;
  pid?: number;
  data?: string;
  sessions?: { id: string; pid: number }[];
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
  // Reads sess.id at flush time, like the direct send it replaces, so a
  // re-keyed pool shell still routes to the right subscribers.
  const flush = (): void => {
    if (sess.flushTimer) { clearTimeout(sess.flushTimer); sess.flushTimer = null; }
    if (sess.pending.length === 0) return;
    const data = sess.pending.length === 1 ? sess.pending[0] : sess.pending.join('');
    sess.pending = [];
    sess.pendingBytes = 0;
    sess.lastFlushAt = Date.now();
    const subs = subscribers.get(sess.id);
    if (subs) {
      for (const s of subs) sendMsg(s, { type: 'output', id: sess.id, data });
    }
  };

  sess.pty.onData((data) => {
    // Nothing is inspected here: cwd (OSC 7) and every other escape sequence
    // are the server's business, read off the same byte stream. This proxy
    // only moves bytes, which is what keeps it from needing to be redeployed.
    sess.pending.push(data);
    sess.pendingBytes += data.length;
    // Bound memory when a command floods the pane faster than we flush.
    if (sess.pendingBytes >= OUTPUT_MAX_BYTES) return flush();
    if (sess.flushTimer) return;
    const since = Date.now() - sess.lastFlushAt;
    if (since >= OUTPUT_FLUSH_MS) return flush();
    sess.flushTimer = setTimeout(flush, OUTPUT_FLUSH_MS - since);
  });

  sess.pty.onExit(() => {
    flush();  // trailing output must reach subscribers before the exit message
    sessions.delete(sess.id);
    const subs = subscribers.get(sess.id);
    if (subs) {
      for (const s of subs) sendMsg(s, { type: 'exit', id: sess.id });
      subscribers.delete(sess.id);
    }
  });
}

function handleCreate(req: DaemonRequest, socket: net.Socket): void {
  const id = req.id!;
  if (sessions.has(id)) {
    sendMsg(socket, { type: 'ok', reqId: req.reqId, id, pid: sessions.get(id)!.pid });
    return;
  }

  const cols = req.cols || 120;
  const rows = req.rows || 40;
  // Used to spawn, then forgotten: where a shell has since cd'd to is the
  // server's business, read off the byte stream.
  const targetCwd = req.cwd || homedir();

  const shell = req.shell || process.env.SHELL || 'bash';
  daemonLog(`create ${id} shell=${shell} cols=${cols} rows=${rows} cwd=${targetCwd}`);
  const p = pty.spawn(shell, ['-l'], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: targetCwd,
    env: { ...process.env, ...req.env, TERM: 'xterm-256color' } as Record<string, string>,
  });

  const sess: DaemonSession = {
    id, pty: p, pid: p.pid,
    pending: [], pendingBytes: 0, flushTimer: null, lastFlushAt: 0,
  };
  sessions.set(id, sess);
  attachSessionHandlers(sess);

  sendMsg(socket, { type: 'ok', reqId: req.reqId, id, pid: p.pid });
}

function handleRequest(req: DaemonRequest, socket: net.Socket): void {
  switch (req.type) {
    case 'ping':
      sendMsg(socket, { type: 'pong', reqId: req.reqId, protocol: PROTOCOL_VERSION });
      break;

    // Identity, not policy: the server pre-spawns shells under placeholder ids
    // and renames one when it becomes a session. Routing is this process's job,
    // so the rename lives here; deciding when to do it does not.
    case 'rekey': {
      const from = req.id!;
      const to = req.to!;
      const sess = sessions.get(from);
      if (!sess || sessions.has(to)) {
        sendMsg(socket, { type: 'error', reqId: req.reqId, error: `cannot rekey ${from} -> ${to}` });
        break;
      }
      sessions.delete(from);
      sess.id = to;
      sessions.set(to, sess);
      // Move subscribers with it, so whoever was listening stays listening.
      const subs = subscribers.get(from);
      if (subs) {
        subscribers.delete(from);
        const existing = subscribers.get(to);
        if (existing) for (const sk of subs) existing.add(sk);
        else subscribers.set(to, subs);
      }
      daemonLog(`rekey ${from} -> ${to}`);
      sendMsg(socket, { type: 'ok', reqId: req.reqId, id: to, pid: sess.pid });
      break;
    }

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
      const list = [...sessions.entries()].map(([id, s]) => ({ id, pid: s.pid }));
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

/** True when something is already listening on the socket. */
async function socketIsLive(): Promise<boolean> {
  if (!existsSync(SOCKET_PATH)) return false;
  return new Promise<boolean>((resolve) => {
    const probe = net.createConnection(SOCKET_PATH);
    const done = (live: boolean): void => {
      try { probe.destroy(); } catch { /* already gone */ }
      resolve(live);
    };
    probe.on('connect', () => done(true));
    probe.on('error', () => done(false));
    setTimeout(() => done(false), 1000);
  });
}

// Never take the socket from a proxy that is still alive. Unlinking it and
// binding our own would leave that process running and unreachable, holding
// every PTY it owns forever: it ignores signals, has no idle timeout, and its
// only clean exit is a message on the socket it no longer has. Two of these
// racing at startup is exactly how a machine ends up with a stack of orphans.
if (await socketIsLive()) {
  daemonLog('another proxy already owns the socket — exiting rather than orphaning it');
  process.exit(0);
}

// Nothing answered, so the socket file is a leftover.
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

let ownsSocket = false;

server.listen(SOCKET_PATH, () => {
  ownsSocket = true;
  // Write PID file so the main server can check if we're running
  writeFileSync(PID_FILE, String(process.pid));
  writeFileSync(FINGERPRINT_FILE, codeFingerprint());
  daemonLog(`daemon started pid=${process.pid} socket=${SOCKET_PATH} protocol=${PROTOCOL_VERSION}`);
});

// Clean up on exit
process.on('exit', () => {
  // A proxy that never bound owns none of this. Cleaning up regardless would
  // delete the live proxy's socket and take its sessions down with it.
  if (!ownsSocket) return;
  daemonLog(`daemon exiting pid=${process.pid}`);
  try { unlinkSync(SOCKET_PATH); } catch {}
  try { unlinkSync(PID_FILE); } catch {}
  try { unlinkSync(FINGERPRINT_FILE); } catch {}
  for (const [, sess] of sessions) {
    try { sess.pty.kill(); } catch {}
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
