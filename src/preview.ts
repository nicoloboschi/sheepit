/**
 * The preview tab's plumbing: what may be loaded, and what has to be changed
 * about a page before it will render inside a pane.
 *
 * A pane can show its terminal, its working tree, its files and its git log —
 * everything except the thing the work produces. This is the missing one: an
 * iframe pointed at a dev server, or at an HTML file from the tree.
 *
 * Two ways a page gets there, and the difference matters:
 *
 *   - **direct** — the URL goes straight into the iframe. The page keeps its
 *     own origin, its cookies and its websockets, so HMR still works. This is
 *     the default and by far the better one.
 *   - **through sheepit** — for a target that refuses to be framed. The server
 *     fetches it and returns it without the headers that refused.
 *
 * Everything here is pure so it can be tested without a socket; api.ts does
 * the I/O.
 */

/** Headers that exist to stop a page being framed. Removed on the proxy path —
 *  that removal is the entire reason the proxy path exists. */
export const FRAMING_HEADERS = [
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
];

/** Headers that describe a body we have already consumed or re-encoded, and
 *  which would make the browser mis-read what we send. */
const BODY_HEADERS = ['content-length', 'content-encoding', 'transfer-encoding'];

/**
 * What the address bar typed means, or null if it is not something we will
 * load.
 *
 * `localhost:3000` with no scheme is the common case and is treated as http.
 * Everything that is not http(s) is refused: `file:` would read the disk
 * through the server, and `data:`/`javascript:` are only ever an attempt to
 * run something in sheepit's own page.
 *
 * `selfPort` closes the loop where sheepit previews itself through its own
 * proxy, which nests until something gives up.
 */
export function parsePreviewUrl(raw: string, opts: { selfPort?: number } = {}): URL | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;

  // A bare host:port or /path is meant as http — nobody types the scheme for
  // their own dev server.
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`;

  let url: URL;
  try { url = new URL(withScheme); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;

  const port = url.port ? parseInt(url.port, 10) : (url.protocol === 'https:' ? 443 : 80);
  if (opts.selfPort && isLoopback(url) && port === opts.selfPort) return null;

  return url;
}

/** Is this the machine sheepit is running on?
 *
 *  Decides whether a page's sub-resources have to be proxied too: a browser on
 *  a phone cannot reach 127.0.0.1, so for a loopback target the assets need
 *  the same route as the document. */
export function isLoopback(url: URL): boolean {
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || h === '0.0.0.0'
    || /^127\./.test(h) || h.endsWith('.localhost');
}

/**
 * Would this response refuse to be framed?
 *
 * Asked of the server rather than guessed at in the browser, because a blocked
 * iframe still fires `load` and gives the page no way to tell. `frame-ancestors
 * *` is the one CSP that permits us; `'self'`, `'none'` and a host list all
 * refuse, since sheepit is never the same origin as what it is showing.
 */
export function refusesFraming(headers: { get(name: string): string | null }): boolean {
  const xfo = headers.get('x-frame-options');
  if (xfo && xfo.trim()) return true;

  for (const name of ['content-security-policy', 'content-security-policy-report-only']) {
    const csp = headers.get(name);
    if (!csp) continue;
    const directive = csp.split(';').map(d => d.trim()).find(d => d.toLowerCase().startsWith('frame-ancestors'));
    if (!directive) continue;
    const sources = directive.split(/\s+/).slice(1);
    if (!sources.includes('*')) return true;
  }
  return false;
}

/** The response headers to pass on: everything except the ones that refused
 *  the frame and the ones describing a body we have rewritten. */
export function forwardableHeaders(headers: { forEach(cb: (v: string, k: string) => void): void }): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (FRAMING_HEADERS.includes(k) || BODY_HEADERS.includes(k)) return;
    out[k] = value;
  });
  return out;
}

/**
 * Point the page's relative URLs back at the server it came from.
 *
 * This is what makes a one-document proxy render at all: with a `<base>`, the
 * browser loads images, CSS and scripts **directly from the origin**, and only
 * the top document travels through sheepit. Without it every relative path
 * resolves against sheepit and 404s.
 *
 * Injected first inside `<head>`, because the first `<base>` in a document is
 * the one that counts — a page with its own would otherwise win.
 *
 * CSP `<meta>` tags go at the same time. `frame-ancestors` in a meta is
 * ignored by browsers anyway, but the other directives are enforced and would
 * block the very sub-resources the base tag just redirected.
 */
export function injectBase(html: string, baseUrl: string): string {
  const withoutCspMeta = html.replace(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '',
  );
  const base = `<base href="${baseUrl.replace(/"/g, '&quot;')}">`;
  const headOpen = withoutCspMeta.match(/<head[^>]*>/i);
  if (headOpen && headOpen.index !== undefined) {
    const at = headOpen.index + headOpen[0].length;
    return withoutCspMeta.slice(0, at) + base + withoutCspMeta.slice(at);
  }
  const htmlOpen = withoutCspMeta.match(/<html[^>]*>/i);
  if (htmlOpen && htmlOpen.index !== undefined) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return withoutCspMeta.slice(0, at) + `<head>${base}</head>` + withoutCspMeta.slice(at);
  }
  return base + withoutCspMeta;
}

/**
 * Send a loopback page's own sub-resources back through the proxy.
 *
 * Only for loopback targets, and only because of who might be looking: the
 * browser could be a phone, and a phone's 127.0.0.1 is the phone. For an
 * external site the `<base>` above is better — the assets come from the origin
 * at full speed and sheepit stays out of the way.
 *
 * Deliberately shallow: root-relative `src`/`href` attributes and `url(/…)` in
 * inline CSS. A page that builds its URLs in JavaScript is beyond what a
 * preview tab should be pretending to do.
 */
export function rewriteLoopbackPaths(html: string, origin: string): string {
  const proxied = (path: string) => `/api/preview?url=${encodeURIComponent(origin + path)}`;
  return html
    // `src="/x"` and `href="/x"`, but never `//host` (protocol-relative).
    .replace(/\b(src|href)=(["'])\/(?!\/)([^"']*)\2/gi,
      (_m, attr: string, q: string, path: string) => `${attr}=${q}${proxied('/' + path)}${q}`)
    .replace(/url\((["']?)\/(?!\/)([^)"']*)\1\)/gi,
      (_m, q: string, path: string) => `url(${q}${proxied('/' + path)}${q})`);
}

/** Is this response something we should rewrite rather than pass through? */
export function isHtml(contentType: string | null | undefined): boolean {
  return !!contentType && /^text\/html|^application\/xhtml\+xml/i.test(contentType.trim());
}
