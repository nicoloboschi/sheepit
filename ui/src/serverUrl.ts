/**
 * Server URL management for standalone/TWA mode.
 *
 * When served from the sheepit backend directly (dev or production),
 * the server URL is empty (same origin). When running as a standalone
 * PWA/TWA, the user configures the server URL on first launch.
 */

import { isStandalone } from './platform';

const LS_KEY = 'sheepit:server-url';

let _serverUrl = '';

export function getServerUrl(): string {
  return _serverUrl;
}

export function initServerUrl(): void {
  if (isStandalone()) {
    _serverUrl = localStorage.getItem(LS_KEY) ?? '';
  }
}

export function setServerUrl(url: string): void {
  _serverUrl = url;
  localStorage.setItem(LS_KEY, url);
}

export function clearServerUrl(): void {
  _serverUrl = '';
  localStorage.removeItem(LS_KEY);
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
  if (_serverUrl) {
    return _serverUrl.replace(/^http/, 'ws') + '/ws';
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

/**
 * Install a fetch interceptor that rewrites /api/* requests to the
 * configured server URL. This avoids changing every fetch() call site.
 */
export function installFetchInterceptor(): void {
  if (!_serverUrl) return;
  const originalFetch = window.fetch;
  window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      input = `${_serverUrl}${input}`;
    }
    return originalFetch.call(this, input, init);
  };
}
