import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, statSync, watchFile, unwatchFile } from 'fs';
import { DirectBridge } from './direct-bridge.js';
import { createApiRouter, expandHomePath as expandHome } from './api.js';
import type { BridgeMessage } from './protocol.js';
import type { AIService } from './ai.js';
import { stateDir } from './paths.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Logger ───────────────────────────────────────────────────────────────────

export interface LogEntry {
  ts: string;
  level: string;
  msg: string;
}

export class LogBuffer {
  private buf: LogEntry[] = [];
  private subs = new Set<(e: LogEntry) => void>();
  private maxSize: number;

  constructor(maxSize = 500) { this.maxSize = maxSize; }

  log(level: string, msg: string): void {
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

export async function createApp(bridge: DirectBridge, ai: AIService) {
  const app = express();
  // UI preferences can contain workspace layouts, per-pane tabs, and other
  // durable state from an established browser profile. The default 100 KB
  // parser limit rejects a perfectly valid first migration before /api can
  // validate it, so allow a bounded 2 MB request body instead.
  app.use(express.json({ limit: '2mb' }));

  // REST API
  app.use('/api', createApiRouter(bridge, logBuffer, ai));

  const server = createServer(app);

  // Static UI (production build only — in dev, Vite runs separately)
  const uiDist = join(__dirname, '..', 'ui', 'dist');
  if (existsSync(uiDist) && process.env.NODE_ENV !== 'development') {
    app.use(express.static(uiDist));
    app.get('*', (_req, res) => res.sendFile(join(uiDist, 'index.html')));
  }

  const wss = new WebSocketServer({ server, path: '/ws' });

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
    const clientInfo = { ws, state, connectedAt: Date.now(), messageCount: 0, bytesSent: 0 };
    activeClients.add(clientInfo);
    logger.debug(`WS client connected (total: ${activeClients.size})`);

    // Subscribe to session list updates (once per client)
    state.unsubSessions = bridge.pubsub.subscribe('__sessions__', (msg) => {
      if (msg.type === 'sessions' || msg.type === 'current_input' || msg.type === 'preview' || msg.type === 'attention') {
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
            const isHeadless = msg.headless === true;
            // A headless session is a singleton: callers can safely ask for one
            // repeatedly without accidentally accumulating hidden PTYs.
            if (isHeadless) {
              const existing = (await bridge.listSessions()).find(s => s.isHeadless);
              if (existing) {
                send({ type: 'session_created', session_id: existing.id, path: existing.path, headless: true, existing: true });
                break;
              }
            }
            if (path === '__vibe__') {
              const { mkdirSync } = await import('fs');
              const { join } = await import('path');
              const adjectives = ['cosmic', 'neon', 'quantum', 'cyber', 'stellar', 'lunar', 'solar', 'atomic', 'hyper', 'turbo', 'ultra', 'mega', 'super', 'blazing', 'radiant', 'vivid', 'primal', 'astral', 'mystic', 'pixel'];
              const nouns = ['phoenix', 'nebula', 'vortex', 'spark', 'pulse', 'nova', 'flux', 'drift', 'surge', 'wave', 'storm', 'forge', 'core', 'orbit', 'prism', 'cipher', 'vertex', 'synth', 'echo', 'glyph'];
              const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)]!;
              const name = `${pick(adjectives)}-${pick(nouns)}`;
              const vibeDir = join(stateDir(), 'vibe-sessions', name);
              mkdirSync(vibeDir, { recursive: true });
              path = vibeDir;
            }
            const cols = msg.cols as number | undefined;
            const rows = msg.rows as number | undefined;
            const sessionId = await bridge.createSession(path, cols, rows, isHeadless);
            send({ type: 'session_created', session_id: sessionId, path: path || null, headless: isHeadless });
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
      activeClients.delete(clientInfo);
      logger.debug(`WS client disconnected (total: ${activeClients.size})`);
    });
  });

  return server;
}
