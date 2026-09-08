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

interface Listener { port: number; pid: number; name: string }

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
  const [draft, setDraft] = useState('');
  const [src, setSrc] = useState<string | null>(null);
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

  const chips = [...listeners.own.map(l => ({ ...l, own: true })), ...listeners.others.map(l => ({ ...l, own: false }))];

  return (
    <div className="preview-pane" onClick={e => e.stopPropagation()}>
      <div className="preview-bar">
        <button className="preview-btn" title="Back" disabled={!live?.canGoBack}
          onClick={() => liveCommands.current?.back()}><ArrowLeft size={12} /></button>
        <button className="preview-btn" title="Forward" disabled={!live?.canGoForward}
          onClick={() => liveCommands.current?.forward()}><ArrowRight size={12} /></button>
        <button className="preview-btn" title="Reload"
          onClick={() => liveCommands.current?.reload()}><RotateCw size={12} /></button>
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
          <LiveBrowserSurface url={src} navSeq={nav} onState={setLive} commands={liveCommands} />
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
