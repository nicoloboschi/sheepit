/**
 * Server URL management for standalone/TWA mode.
 *
 * When served from the sheepit backend directly (dev or production),
 * the server URL is empty (same origin). When running as a standalone
 * PWA/TWA, the user configures the server URL on first launch.
 */

import { isStandalone } from './platform';

const LS_KEY = 'sheepit:server-url';
/** The server's password, when it has one. Device-local beside the URL it goes
 *  with — see DEVICE_LOCAL in preferences.ts. */
const KEY_KEY = 'sheepit:server-key';

let _serverUrl = '';
let _serverKey = '';

export function getServerUrl(): string {
  return _serverUrl;
}

export function initServerUrl(): void {
  if (isStandalone()) {
    _serverUrl = localStorage.getItem(LS_KEY) ?? '';
    _serverKey = localStorage.getItem(KEY_KEY) ?? '';
  }
}

export function setServerUrl(url: string, key = ''): void {
  _serverUrl = url;
  _serverKey = key;
  localStorage.setItem(LS_KEY, url);
  if (key) localStorage.setItem(KEY_KEY, key); else localStorage.removeItem(KEY_KEY);
}

export function getServerKey(): string { return _serverKey; }

export function clearServerUrl(): void {
  _serverUrl = '';
  _serverKey = '';
  localStorage.removeItem(LS_KEY);
  localStorage.removeItem(KEY_KEY);
}

/**
 * The headers every request to a configured server needs.
 *
 * `Authorization` carries the password; the username is ignored by the server,
 * so it is a label rather than a credential.
 *
 * **`ngrok-skip-browser-warning` is not optional, and it is not about ngrok
 * being untidy.** On a free ngrok domain, a request whose User-Agent looks
 * like a browser gets ngrok's own HTML interstitial — **200, `text/html`** —
 * instead of being proxied at all. The app is a WebView, so every one of its
 * API calls was answered with that page, and the connect screen reported
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`. Any header with
 * this name suppresses it. It cost two wrong diagnoses to find, because curl
 * is not a browser and so never saw it.
 *
 * Harmless everywhere else: a server that does not know the name ignores it.
 */
export function authHeader(key = _serverKey): Record<string, string> {
  return {
    'ngrok-skip-browser-warning': 'true',
    ...(key ? { Authorization: `Basic ${btoa(`sheepit:${key}`)}` } : {}),
  };
}

export function needsConnect(): boolean {
  if (!isStandalone()) return false;
  return !localStorage.getItem(LS_KEY);
}

/** Prefix a path like '/api/foo' with the server URL if configured. */
export function apiUrl(path: string): string {
  return _serverUrl ? `${_serverUrl}${path}` : path;
}

/** Get the WebSocket URL for /ws. */
export function wsUrl(): string {
  // **The password rides in the query string here, and only here.** Script
  // cannot set a header on a WebSocket handshake — there is no API for it —
  // so the header the HTTP side uses is not available. This is why the
  // authentication lives in sheepit rather than in the tunnel in front of it:
  // a tunnel can only check the header, which the app can never send.
  const q = _serverKey ? `?k=${encodeURIComponent(_serverKey)}` : '';
  if (_serverUrl) {
    return _serverUrl.replace(/^http/, 'ws') + '/ws' + q;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws${q}`;
}

/**
 * Install a fetch interceptor that rewrites /api/* requests to the
 * configured server URL. This avoids changing every fetch() call site.
 */
/**
 * Point every call at the configured server, and give it the headers it needs.
 *
 * **Two kinds of caller, and missing one of them is a silent failure.** Some
 * code fetches a bare path (`/api/preferences`) and relies on this to prefix
 * it; some calls `apiUrl()` first and arrives here already absolute. The first
 * version only matched the bare paths, so everything built by `apiUrl` —
 * which is most of the startup path, preferences included — went out with no
 * `Authorization` and no `ngrok-skip-browser-warning`, and came back as the
 * tunnel's HTML interstitial. The app reached the main screen and rendered
 * nothing, with `Unexpected token '<'` in a console no release build shows.
 *
 * So the test is "is this request for our server", either spelling, and the
 * prefixing is separate from the headers.
 */
export function installFetchInterceptor(): void {
  if (!_serverUrl) return;
  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string') {
      const relative = input.startsWith('/api/') || input.startsWith('/download');
      if (relative) input = `${_serverUrl}${input}`;
      if (relative || input.startsWith(_serverUrl)) {
        init = { ...init, headers: { ...(init?.headers as Record<string, string>), ...authHeader() } };
      }
    }
    return originalFetch.call(this, input, init);
  };
}
