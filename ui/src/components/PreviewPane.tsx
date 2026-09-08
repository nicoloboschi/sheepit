/**
 * A browser in the pane. **It is the real browser on the machine** — a
 * Chromium driven over CDP and streamed in as frames, with your clicks and
 * keys sent back (`LiveBrowserSurface`). It has a persistent profile, so a
 * site you are logged into stays logged in, which is what makes reading a pull
 * request, opening Files changed and leaving a comment possible in a pane.
 *
 * There used to be a `direct` route that put the URL straight into an iframe.
 * It rendered natively and cost nothing, and it is gone anyway, because it was
 * not a browser: no session of yours, forms that go nowhere, nothing at all on
 * a site that refuses to be framed, and `localhost:3000` meaning the phone you
 * were holding rather than this machine. Two answers to "show me this page"
 * also meant every open paid for a probe first and could still land on the
 * crippled one.
 *
 * What is left beside it is a fallback for a machine with no Chromium at all:
 *
 *   - **through sheepit** — a one-document proxy (`/api/preview`). No cookies,
 *     sandboxed, forms go nowhere. It shows a page; it is not a browser. Local
 *     `.html` files from the tree come this way too, since sheepit serves them
 *     itself.
 *
 * Anything that comes back through sheepit is served from sheepit's origin, so
 * it is rendered in a sandbox WITHOUT `allow-same-origin`. That is the line
 * that matters: without it, a proxied page's scripts would sit inside
 * sheepit's own origin and could call its API.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, ExternalLink, ServerCog, ShieldAlert, ArrowLeft, ArrowRight, MonitorPlay } from 'lucide-react';
import LiveBrowserSurface, { type LiveBrowserCommands, type LiveBrowserState } from './LiveBrowserSurface';

interface Listener { port: number; pid: number; name: string }

/** How the current page is being loaded. */
type Route = 'live' | 'proxy';

const ROUTE_LABEL: Record<Route, string> = {
  live: 'live',
  proxy: 'via sheepit',
};

const ROUTE_HELP: Record<Route, string> = {
  live: 'The real browser on this machine, with its own profile — signed-in sites stay signed in. Click to fetch the page through sheepit instead.',
  proxy: 'Coming through sheepit: headers stripped, sandboxed, no cookies, forms go nowhere. Click for the real browser.',
};

/** A switch, not a cycle: the real browser, or the proxy for the machine that
 *  has no Chromium to run. */
function nextRoute(current: Route, liveAvailable: boolean): Route {
  if (!liveAvailable) return 'proxy';
  return current === 'live' ? 'proxy' : 'live';
}

/** What someone typing in the address bar meant. `load` gets this from the
 *  probe's `finalUrl`; the live browser has no probe, so it is done here. */
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
   *  frame would do nothing at all: the prop never changed. */
  navSeq?: number;
}): React.ReactElement {
  const [draft, setDraft] = useState(initialUrl ?? '');
  const [src, setSrc] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>('live');
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listeners, setListeners] = useState<{ own: Listener[]; others: Listener[] }>({ own: [], others: [] });
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [nonce, setNonce] = useState(0);
  // The live browser: whether this machine has one at all, what its page is
  // doing, and the handle the bar drives it with.
  const [liveAvailable, setLiveAvailable] = useState(false);
  const [live, setLive] = useState<LiveBrowserState | null>(null);
  const liveCommands = useRef<LiveBrowserCommands | null>(null);

  useEffect(() => {
    let alive = true;
    fetch('/api/browser/status')
      .then(r => r.json())
      .then(d => { if (alive) setLiveAvailable(Boolean(d.available)); })
      .catch(() => { /* no browser: the other two routes still work */ });
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
  }, [sessionId, nonce]);

  const liveAvailableRef = useRef(false);
  liveAvailableRef.current = liveAvailable;

  const [liveNav, setLiveNav] = useState(0);

  const load = useCallback(async (raw: string, force?: Route) => {
    const url = raw.trim();
    if (!url) return;
    setBusy(true);
    setError(null);
    setTarget(url);

    // A local file is served by sheepit itself: nothing to probe, and it is
    // sandboxed for the same reason a proxied page is.
    if (url.startsWith('/api/fs/raw')) {
      setRoute('proxy');
      setSrc(url);
      setBusy(false);
      return;
    }

    // The real browser is the default now, and where it exists nothing else is
    // asked. It is the only route that is actually a browser — cookies, logins,
    // forms, popups, a page that navigates itself — and picking it needs no
    // probe, which also takes a network round-trip out of every open.
    //
    // It is also the answer to loopback-from-a-phone, which used to force the
    // proxy: the browser runs on this machine, so `localhost:3000` means this
    // machine's port whatever device you are holding.
    if (!force && liveAvailableRef.current) {
      setRoute('live');
      setSrc(normalizeTyped(url));
      setLiveNav(n => n + 1);
      setBusy(false);
      return;
    }

    // The proxy: no browser on this machine, or the pill asked for it. There is
    // no probe any more — its only question was whether an iframe would be
    // refused, and there is no iframe left to refuse it.
    setRoute('proxy');
    setSrc(`/api/preview?url=${encodeURIComponent(normalizeTyped(url))}`);
    setBusy(false);
  }, []);

  // Opened with a file from the tree.
  useEffect(() => { if (initialUrl) { setDraft(initialUrl); void load(initialUrl); } }, [initialUrl, navSeq, load]);

  // In the live browser the page navigates on its own — every link you click
  // is a navigation nothing else here knows about — so the bar follows it,
  // except while you are typing in it.
  const addressRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (route !== 'live' || !live?.url) return;
    if (document.activeElement === addressRef.current) return;
    if (live.url === 'about:blank') return;
    setDraft(live.url);
  }, [route, live?.url]);

  const openHref = route === 'live' && live?.url ? live.url : target && !target.startsWith('/api/')
    ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`)
    : src ?? undefined;

  const chips = [...listeners.own.map(l => ({ ...l, own: true })), ...listeners.others.map(l => ({ ...l, own: false }))];

  return (
    <div className="preview-pane" onClick={e => e.stopPropagation()}>
      <div className="preview-bar">
        {/* History belongs to the live browser alone: it is the only route with
            any. An iframe's history is the page's own and reaching into it
            cross-origin is not allowed, so these would be dead buttons on the
            other two. */}
        {route === 'live' && (
          <>
            <button className="preview-btn" title="Back" disabled={!live?.canGoBack}
              onClick={() => liveCommands.current?.back()}><ArrowLeft size={12} /></button>
            <button className="preview-btn" title="Forward" disabled={!live?.canGoForward}
              onClick={() => liveCommands.current?.forward()}><ArrowRight size={12} /></button>
          </>
        )}
        <button
          className="preview-btn"
          title="Reload"
          onClick={() => {
            if (route === 'live') { liveCommands.current?.reload(); return; }
            if (target) { setNonce(n => n + 1); void load(target, route); }
          }}
        >
          <RotateCw size={12} className={busy ? 'preview-spin' : undefined} />
        </button>
        <input
          className="preview-address"
          ref={addressRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => {
            if (e.key !== 'Enter') return;
            // In the live browser the address bar is the page's, so it goes
            // straight there — re-probing would only ask whether a page we are
            // not framing can be framed.
            if (route === 'live') { setTarget(draft); liveCommands.current?.navigate(normalizeTyped(draft)); return; }
            void load(draft);
          }}
          placeholder="localhost:3000, or any URL"
          spellCheck={false}
        />
        {/* Which way the page came. The pill never leaves, however narrow the
            pane gets — a proxied page is a different thing from the real one,
            no cookies and no login, and you should not have to wonder which
            you are looking at. Only its word goes; the icon says it too. */}
        {/* Which of the three you are looking at. It never leaves, however
            narrow the pane: a real browser with your logins in it and a
            cookie-less photocopy of a page are genuinely different things, and
            you should not have to wonder which one you are looking at. Only
            the word goes; the icon says it too. */}
        <button
          className={`preview-route${route === 'live' ? '' : ' preview-route-on'}`}
          title={ROUTE_HELP[route]}
          onClick={() => {
            const next = nextRoute(route, liveAvailable);
            if (!target) return;
            if (next === 'live') { setRoute('live'); setLiveNav(n => n + 1); setSrc(normalizeTyped(target)); return; }
            void load(target, next);
          }}
        >
          {route === 'live' ? <MonitorPlay size={12} /> : <ServerCog size={12} />}
          <span className="preview-route-label">{ROUTE_LABEL[route]}</span>
        </button>
        <a
          className="preview-btn"
          href={openHref}
          target="_blank"
          rel="noopener noreferrer"
          title="Open in a real browser tab"
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
              onClick={() => {
                const url = `${window.location.protocol}//${window.location.hostname}:${l.port}`;
                setDraft(url);
                void load(url);
              }}
            >
              :{l.port}<span className="preview-port-name">{l.name}</span>
            </button>
          ))}
        </div>
      )}

      <div className="preview-body">
        {route === 'live' ? (
          <LiveBrowserSurface
            url={src}
            navSeq={liveNav}
            onState={setLive}
            commands={liveCommands}
          />
        ) : src ? (
          <iframe
            ref={frameRef}
            key={`${src}-${nonce}`}
            src={src}
            title="Preview"
            className="preview-frame"
            // Only the proxied path is sandboxed, and it must be: those bytes
            // are served from sheepit's own origin. A direct frame is already
            // cross-origin, and sandboxing it would break the page for nothing.
            {...(route === 'proxy'
              ? { sandbox: 'allow-scripts allow-forms allow-popups allow-modals' }
              : {})}
          />
        ) : (
          <div className="preview-empty">
            {error
              ? <><ShieldAlert size={14} /> {error}</>
              : 'Type an address, or pick a port above.'}
          </div>
        )}
      </div>
    </div>
  );
}
