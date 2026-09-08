/**
 * A browser in the pane — the real one.
 *
 * A Chromium on this machine, driven over CDP, streamed in as frames with your
 * clicks and keys sent back (`LiveBrowserSurface`). It has a persistent
 * profile, so a site you are logged into stays logged in, which is what makes
 * reading a pull request, opening Files changed and leaving a comment possible
 * beside the terminal that produced them.
 *
 * There were two other ways to get a page here, and both are gone:
 *
 *   - **direct** — the URL straight into an iframe. Native rendering and no
 *     cost, but not a browser: no session of yours, forms that went nowhere,
 *     nothing at all on a site that refuses to be framed (github answers
 *     `X-Frame-Options: deny`), and `localhost:3000` meaning the phone you
 *     were holding rather than this machine.
 *   - **via sheepit** — a one-document proxy that stripped the headers which
 *     refused the frame. It showed a page; it could not log in, submit
 *     anything, or run an app. It also made sheepit an open web proxy for
 *     anything that could reach it, and that surface is now gone entirely
 *     rather than merely bounded.
 *
 * More than one answer to "show me this page" cost a probe on every open and
 * could still land on the crippled one. **Chromium is assumed present** —
 * Chrome, Brave, Edge or Chromium, or `SHEEPIT_BROWSER` pointing at one. Where
 * there is none the pane says so, rather than degrading into something that
 * looks like a browser and is not.
 *
 * Sheepit's own files (an `.html` opened from the tree) are fetched by that
 * browser over loopback, because it runs here — which is the same reason a
 * `localhost` port works whatever device you are looking from.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, ExternalLink, ArrowLeft, ArrowRight, ShieldAlert } from 'lucide-react';
import LiveBrowserSurface, { type LiveBrowserCommands, type LiveBrowserState } from './LiveBrowserSurface';
import useStore from '../store';
import { preferences } from '../preferences';

interface Listener { port: number; pid: number; name: string }

/** Where a pane's last page is remembered, one key per pane.
 *
 *  Its own key rather than a shared map: the profile is shared by every
 *  browser looking at this machine and a single blob is last-writer-wins, so
 *  two tabs each browsing in a different pane would take turns erasing each
 *  other's page. See "One key per pen" in CLAUDE.md. */
function urlKey(sessionId: string): string {
  return `sheepit:pane-url:${sessionId}`;
}

function rememberedUrl(sessionId: string): string | null {
  try { return preferences.getItem(urlKey(sessionId)) || null; } catch { return null; }
}

/** What someone typing in the address bar meant. */
function normalizeTyped(raw: string): string {
  const trimmed = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed;
  // A dev server is the common case here and it is not on https. Anything
  // loopback, or anything with an explicit port, is http; the rest of the web
  // is https.
  if (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?([/?#]|$)/i.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w-]+(\.[\w-]+)*:\d+([/?#]|$)/.test(trimmed)) return `http://${trimmed}`;
  if (/^[\w-]+(\.[\w-]+)+([/?#]|$)/.test(trimmed)) return `https://${trimmed}`;
  return `https://duckduckgo.com/?q=${encodeURIComponent(trimmed)}`;
}

export default function PreviewPane({ sessionId, initialUrl, navSeq = 0 }: {
  sessionId: string;
  /** Opened from the file tree, e.g. an .html file, or clicked in the pane's
   *  own terminal — see handleWebLink in TerminalCell. */
  initialUrl?: string | null;
  /** Bumped on every open, so clicking the same link twice loads it twice.
   *  Without it, going back to a URL you had navigated away from inside the
   *  page would do nothing at all: the prop never changed. */
  navSeq?: number;
}): React.ReactElement {
  // The page this pane was last showing. Read once, synchronously: the browser
  // opens on it, so a reload of sheepit puts you back where you were rather
  // than on a blank pane you have to re-navigate.
  const [draft, setDraft] = useState(() => (initialUrl ? '' : rememberedUrl(sessionId) ?? ''));
  const [src, setSrc] = useState<string | null>(() => (initialUrl ? null : rememberedUrl(sessionId)));
  const [nav, setNav] = useState(0);
  const [listeners, setListeners] = useState<{ own: Listener[]; others: Listener[] }>({ own: [], others: [] });
  const [live, setLive] = useState<LiveBrowserState | null>(null);
  const liveCommands = useRef<LiveBrowserCommands | null>(null);
  const addressRef = useRef<HTMLInputElement | null>(null);
  /** Sheepit's own port, so the browser on this machine can be pointed at
   *  sheepit's file endpoint over loopback; and whether there is a browser to
   *  run at all. */
  const [server, setServer] = useState<{ available: boolean; port: number | null }>({ available: true, port: null });

  useEffect(() => {
    let alive = true;
    fetch('/api/browser/status')
      .then(r => r.json())
      .then(d => { if (alive) setServer({ available: Boolean(d.available), port: d.serverPort ?? null }); })
      .catch(() => { /* stay optimistic; the surface reports the real error */ });
    return () => { alive = false; };
  }, []);

  // What this pane's own processes are listening on — usually the dev server
  // the agent just started — and then everything else on the machine, because
  // a server you started in another window is still worth looking at.
  useEffect(() => {
    let alive = true;
    fetch(`/api/fs/${encodeURIComponent(sessionId)}/ports`)
      .then(r => r.json())
      .then(d => { if (alive) setListeners({ own: d.own ?? [], others: d.others ?? [] }); })
      .catch(() => { /* lsof missing: the address bar still works */ });
    return () => { alive = false; };
  }, [sessionId]);

  /** Point the browser at something. A relative sheepit path becomes absolute
   *  on loopback: the browser is on this machine, so `/api/...` is this
   *  server's, never the phone's. */
  const go = useCallback((raw: string) => {
    const url = raw.trim();
    if (!url) return;
    const absolute = url.startsWith('/')
      ? `http://127.0.0.1:${server.port ?? window.location.port}${url}`
      : normalizeTyped(url);
    setSrc(absolute);
    setNav(n => n + 1);
    setDraft(absolute);
  }, [server.port]);

  // A link clicked in the terminal, or a file opened from the tree. A sheepit
  // path waits for the port: sent before it is known it would resolve against
  // the page's own port, which in dev is vite's and not the server's.
  useEffect(() => {
    if (!initialUrl) return;
    if (initialUrl.startsWith('/') && server.port === null) return;
    go(initialUrl);
  }, [initialUrl, navSeq, go, server.port]);

  // The page navigates on its own — every link you click is a navigation
  // nothing here initiated — so the bar follows it, except while you type.
  useEffect(() => {
    if (!live?.url || live.url === 'about:blank') return;
    if (document.activeElement === addressRef.current) return;
    setDraft(live.url);
  }, [live?.url]);

  // Tell the app where this pane is, so the URL can carry it (Back and Forward
  // then walk this pane's pages), and remember it for the next time sheepit is
  // opened. Both are the same fact, reported once.
  const setBrowserUrl = useStore(s => s.setBrowserUrl);
  useEffect(() => {
    const url = live?.url;
    if (!url || url === 'about:blank') return;
    setBrowserUrl(sessionId, url);
    try { preferences.setItem(urlKey(sessionId), url); } catch { /* quota */ }
  }, [live?.url, sessionId, setBrowserUrl]);

  // A pane that is not showing a browser has no page, and the URL must not
  // claim otherwise.
  useEffect(() => () => setBrowserUrl(sessionId, null), [sessionId, setBrowserUrl]);

  // The other direction: Back, Forward, or a link opened into this pane.
  const browserNav = useStore(s => s.browserNav);
  useEffect(() => {
    if (!browserNav || browserNav.sessionId !== sessionId) return;
    go(browserNav.url);
    // `seq` is in the deps on purpose — going back to the page you are already
    // on still has to navigate.
  }, [browserNav?.seq, browserNav?.sessionId, sessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const chips = [...listeners.own.map(l => ({ ...l, own: true })), ...listeners.others.map(l => ({ ...l, own: false }))];

  return (
    <div className="preview-pane" onClick={e => e.stopPropagation()}>
      <div className="preview-bar">
        <button className="preview-btn" title="Back" disabled={!live?.canGoBack}
          onClick={() => liveCommands.current?.back()}><ArrowLeft size={12} /></button>
        <button className="preview-btn" title="Forward" disabled={!live?.canGoForward}
          onClick={() => liveCommands.current?.forward()}><ArrowRight size={12} /></button>
        <button className="preview-btn" title={live?.loading ? 'Loading…' : 'Reload'}
          onClick={() => liveCommands.current?.reload()}>
          <RotateCw size={12} className={live?.loading ? 'preview-spin' : undefined} />
        </button>
        <input
          className="preview-address"
          ref={addressRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') go(draft); e.stopPropagation(); }}
          placeholder="localhost:3000, or any URL"
          spellCheck={false}
        />
        {/* Your own browser, for what this one is not: a download, a password
            manager, a tab you want to keep. */}
        <a
          className="preview-btn"
          href={live?.url && live.url !== 'about:blank' ? live.url : undefined}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in your own browser"
        >
          <ExternalLink size={12} />
        </a>
      </div>

      {chips.length > 0 && (
        <div className="preview-ports">
          {chips.slice(0, 12).map(l => (
            <button
              key={`${l.pid}-${l.port}`}
              className={`preview-port${l.own ? ' preview-port-own' : ''}`}
              title={`${l.name} (pid ${l.pid})${l.own ? ' — started in this pane' : ''}`}
              // 127.0.0.1, not this page's hostname: the browser runs on the
              // machine the port is on, so this is right from a phone too.
              onClick={() => go(`http://127.0.0.1:${l.port}`)}
            >
              :{l.port}<span className="preview-port-name">{l.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="preview-body">
        {server.available ? (
          <>
            {/* The page is a picture until its first frame lands, and a picture
                of the last page while the next one loads — so the only way to
                know something is happening is to say so. */}
            {live?.loading && <div className="preview-loading" />}
            <LiveBrowserSurface url={src} navSeq={nav} onState={setLive} commands={liveCommands} />
          </>
        ) : (
          <div className="preview-empty">
            <ShieldAlert size={14} />
            No Chromium-family browser found. Install Chrome, Brave, Edge or
            Chromium, or set SHEEPIT_BROWSER to one.
          </div>
        )}
      </div>
    </div>
  );
}
