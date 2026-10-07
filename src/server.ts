import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { LiveBrowser } from './live-browser.js';
import { attachBrowserWs, BROWSER_WS_PATH } from './browser-ws.js';
import { createServer } from 'http';
import { join, dirname, extname, sep } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, readFileSync, statSync, watchFile, unwatchFile } from 'fs';
import { gzipSync } from 'zlib';
import { DirectBridge } from './direct-bridge.js';
import { createApiRouter, expandHomePath as expandHome } from './api.js';
import { MAX_HEADLESS, MAX_SIDE_TERMINALS, type BridgeMessage } from './protocol.js';
import type { AIService } from './ai.js';
import { vibeSessionsDir } from './paths.js';
import { NativeSessions } from './claude-native.js';
import { createDownloadRouter } from './download.js';
import { configureAuth, requireAuth, isAuthorized } from './auth.js';
import { config as appConfig } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Logger ───────────────────────────────────────────────────────────────────

export interface LogEntry {
  ts: string;
  level: string;
  msg: string;
}

const LEVELS: Record<string, number | undefined> = { debug: 10, info: 20, warning: 30, error: 40 };
const DEFAULT_LEVEL = 20;  // info

export class LogBuffer {
  private buf: LogEntry[] = [];
  private subs = new Set<(e: LogEntry) => void>();
  private maxSize: number;
  private threshold = DEFAULT_LEVEL;

  constructor(maxSize = 500) { this.maxSize = maxSize; }

  /** --log-level / SHEEPIT_LOG_LEVEL; unknown values leave the level as-is. */
  setLevel(level: string): void {
    const t = LEVELS[level?.toLowerCase()];
    if (t !== undefined) this.threshold = t;
  }

  log(level: string, msg: string): void {
    if ((LEVELS[level.toLowerCase()] ?? DEFAULT_LEVEL) < this.threshold) return;
    const entry: LogEntry = {
      ts: new Date().toISOString().slice(11, 23),
      level,
      msg,
    };
    this.buf.push(entry);
    if (this.buf.length > this.maxSize) this.buf.shift();
    this.subs.forEach(fn => { try { fn(entry); } catch { /* ignore */ } });
    // Also print to stderr
    process.stderr.write(`[${entry.ts}] ${level.padEnd(7)} ${msg}\n`);
  }

  subscribe(fn: (e: LogEntry) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  entries(): LogEntry[] { return [...this.buf]; }
}

export const logBuffer = new LogBuffer();

export const logger = {
  debug: (msg: string) => logBuffer.log('DEBUG', msg),
  info:  (msg: string) => logBuffer.log('INFO', msg),
  warn:  (msg: string) => logBuffer.log('WARNING', msg),
  error: (msg: string) => logBuffer.log('ERROR', msg),
};

// ── WebSocket client state ────────────────────────────────────────────────────

interface ClientState {
  /** Per-session output subscriptions (session_id → unsubscribe fn) */
  subscribedSessions: Map<string, () => void>;
  /** Global session-list subscription unsub */
  unsubSessions: (() => void) | null;
  /** Watched file paths (path → stop fn). Multiplexed over this one socket —
   *  see the `watch_file` case for why these can't be SSE streams. */
  watchedFiles: Map<string, () => void>;
}


// ── Server factory ────────────────────────────────────────────────────────────

// ── Static assets ─────────────────────────────────────────────────────────────

const COMPRESSIBLE = /\.(js|mjs|css|html|json|svg|map|txt)$/;

/**
 * express.static ships the UI bundle uncompressed — roughly 900 KB per cold
 * load, which is the single biggest cost on a phone. Assets are content-hashed
 * by Vite, so gzip each file once and serve every later request from memory.
 */
function gzipStatic(uiDist: string) {
  const cache = new Map<string, { body: Buffer; etag: string }>();
  const root = uiDist.endsWith(sep) ? uiDist : uiDist + sep;

  return (req: express.Request, res: express.Response, next: express.NextFunction): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!COMPRESSIBLE.test(req.path)) return next();
    if (!String(req.headers['accept-encoding'] ?? '').includes('gzip')) return next();

    const file = join(uiDist, req.path);
    if (!file.startsWith(root)) return next();  // path traversal

    let st;
    try { st = statSync(file); } catch { return next(); }
    if (!st.isFile()) return next();

    const key = `${file}:${st.mtimeMs}:${st.size}`;
    let entry = cache.get(key);
    if (!entry) {
      entry = {
        body: gzipSync(readFileSync(file)),
        etag: `W/"${st.size.toString(16)}-${Math.round(st.mtimeMs).toString(16)}-gz"`,
      };
      cache.set(key, entry);
    }

    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Vary', 'Accept-Encoding');
    res.setHeader('ETag', entry.etag);
    // Vite fingerprints /assets/*, so those can be cached indefinitely.
    res.setHeader('Cache-Control', req.path.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-cache');
    res.type(extname(file));

    if (req.headers['if-none-match'] === entry.etag) {
      res.status(304).end();
      return;
    }
    res.send(req.method === 'HEAD' ? undefined : entry.body);
  };
}

export async function createApp(bridge: DirectBridge, ai: AIService) {
  const app = express();
  // UI preferences can contain workspace layouts, per-pane tabs, and other
  // durable state from an established browser profile. The default 100 KB
  // parser limit rejects a perfectly valid first migration before /api can
  // validate it, so allow a bounded 2 MB request body instead.
  app.use(express.json({ limit: '2mb' }));

  // The password, in front of everything. Mounted before the API, the download
  // page and the static UI, because all three are the same machine. A request
  // that arrived directly on loopback is exempt — see src/auth.ts.
  configureAuth(appConfig.password);
  app.use(requireAuth);

  // REST API
  app.use('/api', createApiRouter(bridge, logBuffer, ai));

  // The Android app, from the server you are about to point it at. Mounted
  // before the static UI so the catch-all below cannot swallow it.
  app.use('/download', createDownloadRouter());

  const server = createServer(app);

  // Static UI (production build only — in dev, Vite runs separately)
  const uiDist = join(__dirname, '..', 'ui', 'dist');
  if (existsSync(uiDist) && process.env.NODE_ENV !== 'development') {
    app.use(gzipStatic(uiDist));
    app.use(express.static(uiDist));
    app.get('*', (_req, res) => res.sendFile(join(uiDist, 'index.html')));
  }

  // ── Two WebSocket servers, ONE upgrade listener ───────────────────────────
  // Both are `noServer` and the route below decides which gets the socket.
  // This is not a style choice. A `WebSocketServer({ server, path })` installs
  // its own 'upgrade' listener, and that listener DESTROYS any socket whose
  // path it does not recognise (ws/lib/websocket-server.js: `abortHandshake`
  // when `shouldHandle` is false). With two of them on one HTTP server, every
  // upgrade reaches both, so each one killed the other's connections: the
  // terminal socket connected and dropped in the same millisecond, over and
  // over, and the whole app was dead. Add a third path here, not a third
  // WebSocketServer.
  const wss = new WebSocketServer({ noServer: true });

  // The live browser gets a socket of its own — screencast frames must not
  // queue in front of a keystroke on its way to a PTY. See browser-ws.ts.
  const liveBrowser = new LiveBrowser(msg => logger.info(msg));
  const browserWss = attachBrowserWs(liveBrowser, msg => logger.warn(msg));

  server.on('upgrade', (req, socket, head) => {
    const pathname = new URL(req.url ?? '/', 'http://localhost').pathname;
    const target = pathname === '/ws' ? wss
      : pathname === BROWSER_WS_PATH ? browserWss
      : null;
    if (!target) { socket.destroy(); return; }
    // **The WebSocket is the whole API**, so it is checked here too — and it
    // is checked against the query string, because script cannot put a header
    // on a handshake. See src/auth.ts.
    if (!isAuthorized(req, new URL(req.url ?? '/', 'http://localhost'))) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="sheepit"\r\n\r\n');
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, ws => target.emit('connection', ws, req));
  });

  /** A pane's Claude Code session read as a conversation — what the native
   *  view is made of. It owns no process: the agent is the one already running
   *  in the pane, typed into and tailed. See claude-native.ts. */
  const native = new NativeSessions();

  // Track active WebSocket clients for diagnostics
  const activeClients = new Set<{ ws: WebSocket; state: ClientState; connectedAt: number; messageCount: number; bytesSent: number }>();

  // Expose WS diagnostics via the bridge (so /api/diagnostics can include it)
  (bridge as any)._wsClientsDiag = () => {
    const clients: { subscribedSessions: string[]; connectedAt: number; messageCount: number; bytesSent: number }[] = [];
    for (const c of activeClients) {
      clients.push({
        subscribedSessions: [...c.state.subscribedSessions.keys()],
        connectedAt: c.connectedAt,
        messageCount: c.messageCount,
        bytesSent: c.bytesSent,
      });
    }
    return { totalConnections: activeClients.size, clients };
  };

  wss.on('connection', (ws: WebSocket) => {
    const state: ClientState = { subscribedSessions: new Map(), unsubSessions: null, watchedFiles: new Map() };
    /** This client's native-view subscriptions, by pane. */
    const nativeSubs = new Map<string, () => void>();
    const clientInfo = { ws, state, connectedAt: Date.now(), messageCount: 0, bytesSent: 0 };
    activeClients.add(clientInfo);
    logger.debug(`WS client connected (total: ${activeClients.size})`);

    // Subscribe to session list updates (once per client)
    state.unsubSessions = bridge.pubsub.subscribe('__sessions__', (msg) => {
      if (msg.type === 'sessions' || msg.type === 'activity'
          || msg.type === 'attention' || msg.type === 'preferences') {
        send(msg);
      }
    });

    function send(msg: BridgeMessage | object): void {
      if (ws.readyState === WebSocket.OPEN) {
        const data = JSON.stringify(msg);
        clientInfo.messageCount++;
        clientInfo.bytesSent += data.length;
        ws.send(data);
      }
    }

    ws.on('message', async (raw) => {
      let msg: Record<string, unknown>;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      try {
        switch (msg.type) {
          case 'list_sessions': {
            const sessions = await bridge.listSessions();
            send({ type: 'sessions', sessions });
            break;
          }

          case 'subscribe':
          case 'connect': {
            const sessionId = msg.session_id as string;
            state.subscribedSessions.get(sessionId)?.();
            state.subscribedSessions.delete(sessionId);

            // Atomic subscribe — ring buffer read + pubsub subscribe
            // in the same tick. Zero lost or duplicated output by design.
            const unsub = bridge.subscribeSession(
              sessionId,
              () => send({ type: 'connected', session_id: sessionId }),
              (data) => send({ type: 'output', session_id: sessionId, data }),
              msg.cols as number | undefined,
              msg.rows as number | undefined,
            );
            if (unsub) state.subscribedSessions.set(sessionId, unsub);
            break;
          }

          case 'unsubscribe': {
            const sessionId = msg.session_id as string;
            state.subscribedSessions.get(sessionId)?.();
            state.subscribedSessions.delete(sessionId);
            break;
          }

          // ── The native view ────────────────────────────────────────────
          // A real Claude Code session, driven over its stream-json stdio
          // protocol instead of drawn into a PTY. See claude-native.ts; the
          // raw protocol stops there and only NativeEvents come through here.
          case 'native_open': {
            const sessionId = msg.session_id as string;
            if (nativeSubs.has(sessionId)) break;
            const sess = (await bridge.listSessions()).find(s => s.id === sessionId);
            if (!sess) break;
            const s = await native.open(
              sessionId,
              sess.path || process.cwd(),
              // Re-asked every poll rather than captured: a `/clear` starts a
              // new transcript, and the pane's hooks are what know about it.
              () => bridge.resolveAgentTranscript(sessionId),
              (data) => bridge.sendInput(sessionId, data),
            );
            nativeSubs.set(sessionId, s.subscribe(event => send({ type: 'native_event', session_id: sessionId, event })));
            break;
          }

          case 'native_close': {
            const sessionId = msg.session_id as string;
            nativeSubs.get(sessionId)?.();
            nativeSubs.delete(sessionId);
            // Drops the reader once nobody is watching. There is nothing to
            // lose: the conversation is the transcript, not this object.
            native.release(sessionId);
            break;
          }

          case 'native_send': {
            native.get(msg.session_id as string)?.send(String(msg.text ?? ''));
            break;
          }

          case 'native_interrupt': {
            native.get(msg.session_id as string)?.interrupt();
            break;
          }

          // Raw keys, for the TUI dialogs the conversation view cannot draw.
          case 'native_key': {
            native.get(msg.session_id as string)?.raw(String(msg.data ?? ''));
            break;
          }

          // Live file watching, multiplexed over this socket.
          //
          // This used to be one SSE stream per open file (`GET /api/fs/watch`).
          // A browser allows only ~6 HTTP/1.1 connections per host, and an SSE
          // stream never completes — so a handful of open files consumed the
          // entire budget and EVERY other request to the origin queued forever,
          // surfacing as "Failed to fetch" across the whole app. The WebSocket
          // is already open and has no such limit, so watches ride on it.
          case 'watch_file': {
            const filePath = expandHome(msg.path as string | undefined ?? '');
            if (!filePath || state.watchedFiles.has(filePath)) break;
            if (!existsSync(filePath)) break;

            let lastMtime = -1;
            try { lastMtime = statSync(filePath).mtimeMs; } catch { /* ignore */ }
            const onChange = () => {
              try {
                const mtime = statSync(filePath).mtimeMs;
                if (mtime === lastMtime) return;
                lastMtime = mtime;
                send({ type: 'file_changed', path: filePath, mtime });
              } catch {
                send({ type: 'file_deleted', path: filePath });
              }
            };
            watchFile(filePath, { interval: 500 }, onChange);
            state.watchedFiles.set(filePath, () => unwatchFile(filePath, onChange));
            break;
          }

          case 'unwatch_file': {
            const filePath = expandHome(msg.path as string | undefined ?? '');
            state.watchedFiles.get(filePath)?.();
            state.watchedFiles.delete(filePath);
            break;
          }

          case 'create_session': {
            let path = msg.path as string | undefined;
            const initCommand = msg.init_command as string | undefined;
            // A **side terminal**: a shell for one pane's Terminals split. It
            // is headless (it never gets a pen) but belongs to that pane, runs
            // in its directory, and is closed with it.
            const sideOf = typeof msg.side_of === 'string' ? msg.side_of : undefined;
            const isHeadless = msg.headless === true || !!sideOf;
            if (isHeadless) {
              const all = await bridge.listSessions();

              // `restart` is the "it has hung, start over" path, and it names
              // its target: with more than one headless shell there is no "the"
              // headless session to mean. Closing and re-asking from the client
              // cannot do this itself — the two messages race the lookup below,
              // and a create that lands before the close is handed back the
              // very session it was trying to replace, so both halves happen
              // here in one step.
              //
              // It runs BEFORE the branch on `sideOf`, because a side terminal
              // is restarted too and its old shell has to go either way. While
              // this sat inside the global branch, restarting a pane's terminal
              // left the old one running and made a second beside it.
              const restartId = msg.restart === true ? (msg.session_id as string | undefined) : undefined;
              const doomed = restartId ? all.find(s => s.isHeadless && s.id === restartId) : undefined;
              if (doomed) {
                state.subscribedSessions.get(doomed.id)?.();
                state.subscribedSessions.delete(doomed.id);
                await bridge.closeSession(doomed.id);
              }
              // Counted after the close, so a restart at the cap is a swap and
              // not a refusal.
              const live = doomed ? all.filter(s => s.id !== doomed.id) : all;

              if (sideOf) {
                const owner = live.find(s => s.id === sideOf);
                // The pane has to exist: the id arrives from a client and ends
                // up as a parent nothing can verify later.
                if (!owner) { send({ type: 'error', message: 'No such pane' }); break; }
                if (live.filter(s => s.sideOf === sideOf).length >= MAX_SIDE_TERMINALS) {
                  send({ type: 'error', message: `A pane holds at most ${MAX_SIDE_TERMINALS} terminals` });
                  break;
                }
                // Its directory is the pane's, not the caller's: a shell beside
                // an agent is wanted *in the repo that agent is working in*,
                // and the pane's own cwd is what OSC 7 has been keeping current.
                path = owner.path || path;
              } else {
                // Global scratch shells are capped rather than unique. There
                // was exactly one, so asking for it repeatedly was safe and the
                // client never had to track it; there are up to MAX_HEADLESS
                // now, because one scratch terminal is not enough to run a
                // build in and tail a log beside it. The cap is what keeps
                // "ask for another" from accumulating hidden PTYs nobody can
                // see to close.
                if (live.filter(s => s.isHeadless && !s.sideOf).length >= MAX_HEADLESS) {
                  // Full. Hand back the oldest rather than failing silently:
                  // the caller asked to see a scratch terminal and there is one.
                  const existing = live.find(s => s.isHeadless && !s.sideOf)!;
                  send({ type: 'session_created', session_id: existing.id, path: existing.path, headless: true, existing: true });
                  break;
                }
              }
            }
            if (path === '__vibe__') {
              const { mkdirSync } = await import('fs');
              const { join } = await import('path');
              const adjectives = ['cosmic', 'neon', 'quantum', 'cyber', 'stellar', 'lunar', 'solar', 'atomic', 'hyper', 'turbo', 'ultra', 'mega', 'super', 'blazing', 'radiant', 'vivid', 'primal', 'astral', 'mystic', 'pixel'];
              const nouns = ['phoenix', 'nebula', 'vortex', 'spark', 'pulse', 'nova', 'flux', 'drift', 'surge', 'wave', 'storm', 'forge', 'core', 'orbit', 'prism', 'cipher', 'vertex', 'synth', 'echo', 'glyph'];
              const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]!;
              const name = `${pick(adjectives)}-${pick(nouns)}`;
              const vibeDir = join(vibeSessionsDir(), name);
              mkdirSync(vibeDir, { recursive: true });
              path = vibeDir;
            }
            const cols = msg.cols as number | undefined;
            const rows = msg.rows as number | undefined;
            const sessionId = await bridge.createSession(path, cols, rows, isHeadless, sideOf);
            send({ type: 'session_created', session_id: sessionId, path: path || null, headless: isHeadless, ...(sideOf ? { side_of: sideOf } : {}) });
            if (initCommand) {
              await bridge.sendKeys(sessionId, initCommand);
            }
            const sessions = await bridge.listSessions();
            send({ type: 'sessions', sessions });
            break;
          }

          case 'close_session': {
            const sessionId = msg.session_id as string;
            state.subscribedSessions.get(sessionId)?.();
            state.subscribedSessions.delete(sessionId);
            await bridge.closeSession(sessionId);
            const sessions = await bridge.listSessions();
            send({ type: 'sessions', sessions });
            break;
          }

          case 'input': {
            const sessionId = msg.session_id as string;
            if (sessionId) bridge.sendInput(sessionId, msg.data as string);
            break;
          }

          case 'resize': {
            const sessionId = msg.session_id as string;
            if (sessionId) bridge.resize(sessionId, msg.cols as number, msg.rows as number);
            break;
          }

        }
      } catch (e) {
        logger.error(`WS handler error: ${e}`);
      }
    });

    ws.on('close', () => {
      for (const unsub of state.subscribedSessions.values()) unsub();
      state.subscribedSessions.clear();
      // Polling watchers outlive the socket unless we stop them explicitly.
      for (const stop of state.watchedFiles.values()) stop();
      state.watchedFiles.clear();
      state.unsubSessions?.();
      for (const [sid, unsub] of nativeSubs) { unsub(); native.release(sid); }
      nativeSubs.clear();
      activeClients.delete(clientInfo);
      logger.debug(`WS client disconnected (total: ${activeClients.size})`);
    });
  });

  return server;
}
