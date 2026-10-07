/**
 * The password in front of sheepit, for when it is reachable from outside.
 *
 * sheepit hands anything that reaches it a shell on this machine as this user,
 * so exposing it needs *something* in front. The obvious something is the
 * tunnel's own basic auth — and that was the first answer here, until it met
 * the Android app:
 *
 *   **A WebView cannot authenticate a WebSocket.** A browser can: it prompts,
 *   caches the credential for the origin, and sends `Authorization` on the
 *   upgrade for you. The app cannot, because its UI is served from a
 *   `localhost` origin and talks to a *different* one, so there is no cached
 *   credential — and no API exists to set a header on a WebSocket handshake
 *   from script. Verified against the live tunnel: the upgrade returns 401
 *   without the header and connects with it, and the app has no way to add it.
 *
 * So the tunnel is left open and the authentication happens here, where both
 * halves can be served: a header for HTTP, and a **query parameter** for the
 * WebSocket, which is the only channel a browser gives you on a handshake.
 *
 * ## What counts as authenticated
 *
 * Either of:
 *   - `Authorization: Basic <base64 of anything:password>` — the username is
 *     ignored, so a browser's own prompt works whatever is typed in it.
 *   - `?k=<password>` — for the WebSocket, and for a plain `<img>`/download
 *     URL that cannot carry a header either.
 *
 * ## And what is exempt
 *
 * A request that arrived **directly on loopback** is let through: it came from
 * this machine, where the password protects nothing — whoever sent it can
 * already open a terminal. A tunnelled request also arrives from 127.0.0.1,
 * which is why the test is loopback *and no forwarding header*: ngrok and every
 * other proxy sets `x-forwarded-for`, and a direct connection cannot forge one
 * in a way that makes the check weaker.
 */
import type { Request, Response, NextFunction } from 'express';
import type { IncomingMessage } from 'http';
import { timingSafeEqual } from 'crypto';
import { logger } from './server.js';

let password: string | null = null;

/** Set at startup. An empty or missing value means no auth at all, which is
 *  the default and is right for a laptop on its own LAN. */
export function configureAuth(value: string | null | undefined): void {
  password = value && value.length ? value : null;
  logger.info(password ? 'auth: password required for non-local requests' : 'auth: open (no password set)');
}

export function authEnabled(): boolean { return password !== null; }

/** Constant-time, and length-safe — `timingSafeEqual` throws on a mismatch. */
function matches(given: string): boolean {
  if (!password) return true;
  const a = Buffer.from(given);
  const b = Buffer.from(password);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isDirectLocal(req: IncomingMessage): boolean {
  // Any forwarding header at all means a proxy handled this, so the socket
  // address is the proxy's and says nothing about who is calling.
  if (req.headers['x-forwarded-for'] || req.headers['x-forwarded-host'] || req.headers['forwarded']) {
    return false;
  }
  const ip = req.socket.remoteAddress ?? '';
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
}

/** The password this request carries, from either channel. */
function presented(req: IncomingMessage, url: URL | null): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Basic ')) {
    try {
      const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
      // The username is ignored: a browser's own prompt asks for one and
      // there is nothing here for it to mean.
      const i = decoded.indexOf(':');
      return i < 0 ? decoded : decoded.slice(i + 1);
    } catch { /* malformed */ }
  }
  const k = url?.searchParams.get('k');
  return k ?? null;
}

export function isAuthorized(req: IncomingMessage, url: URL | null): boolean {
  if (!password) return true;
  if (isDirectLocal(req)) return true;
  const given = presented(req, url);
  return given !== null && matches(given);
}

/** Express middleware. Mount before everything it protects. */
export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  let url: URL | null = null;
  try { url = new URL(req.url, 'http://x'); } catch { /* keep null */ }
  if (isAuthorized(req, url)) return next();
  // The WWW-Authenticate header is what makes a browser put up its own prompt,
  // which is how the download page is reachable before there is an app.
  res.setHeader('WWW-Authenticate', 'Basic realm="sheepit", charset="UTF-8"');
  res.status(401).type('text').send('sheepit: password required');
}
