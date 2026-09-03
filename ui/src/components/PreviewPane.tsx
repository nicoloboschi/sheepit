/**
 * A browser in the pane — enough of one to watch what the work produces.
 *
 * Not a real browser and not pretending to be: no tabs, no history, no
 * cookies, no login. An address bar, the ports this pane is listening on, and
 * an iframe.
 *
 * A page arrives one of two ways, and which one is decided by asking the
 * server rather than by guessing:
 *
 *   - **direct** — the URL goes straight into the iframe, so the page keeps
 *     its own origin, its cookies and its websockets, and a dev server's
 *     hot reload still works. This is the good path and the default.
 *   - **through sheepit** — for a page that refuses to be framed (google and
 *     github both do), or for a loopback port when you are looking from
 *     another device, where the browser's own 127.0.0.1 is not this machine.
 *
 * Anything that comes back through sheepit is served from sheepit's origin, so
 * it is rendered in a sandbox WITHOUT `allow-same-origin`. That is the line
 * that matters: without it, a proxied page's scripts would sit inside
 * sheepit's own origin and could call its API.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCw, ExternalLink, Globe, ServerCog, ShieldAlert } from 'lucide-react';

interface Listener { port: number; pid: number; name: string }

/** How the current page is being loaded. */
type Route = 'direct' | 'proxy';

/** Is the browser looking at this from another machine? A loopback URL means
 *  something different there, and has to come through the server. */
function browsingRemotely(): boolean {
  const h = window.location.hostname;
  return !(h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '[::1]');
}

function isLoopbackTarget(raw: string): boolean {
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`);
    const h = u.hostname.toLowerCase();
    return h === 'localhost' || h === '::1' || h === '0.0.0.0' || h.startsWith('127.');
  } catch { return false; }
}

export default function PreviewPane({ sessionId, initialUrl }: {
  sessionId: string;
  /** Opened from the file tree, e.g. an .html file. */
  initialUrl?: string | null;
}): React.ReactElement {
  const [draft, setDraft] = useState(initialUrl ?? '');
  const [src, setSrc] = useState<string | null>(null);
  const [route, setRoute] = useState<Route>('direct');
  const [target, setTarget] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listeners, setListeners] = useState<{ own: Listener[]; others: Listener[] }>({ own: [], others: [] });
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const [nonce, setNonce] = useState(0);

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

    try {
      const probe = await fetch(`/api/preview/probe?url=${encodeURIComponent(url)}`).then(r => r.json());
      if (probe.error && !probe.framable) setError(probe.error);
      // Loopback seen from another device has to come through the server
      // whatever the probe says: the frame would resolve 127.0.0.1 to the
      // device you are holding.
      const mustProxy = isLoopbackTarget(url) && browsingRemotely();
      const chosen: Route = force ?? (probe.framable && !mustProxy ? 'direct' : 'proxy');
      setRoute(chosen);
      const href = probe.finalUrl ?? (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) ? url : `http://${url}`);
      setSrc(chosen === 'direct' ? href : `/api/preview?url=${encodeURIComponent(href)}`);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setSrc(null);
    } finally {
      setBusy(false);
    }
  }, []);

  // Opened with a file from the tree.
  useEffect(() => { if (initialUrl) { setDraft(initialUrl); void load(initialUrl); } }, [initialUrl, load]);

  const openHref = target && !target.startsWith('/api/')
    ? (/^[a-z][a-z0-9+.-]*:\/\//i.test(target) ? target : `http://${target}`)
    : src ?? undefined;

  const chips = [...listeners.own.map(l => ({ ...l, own: true })), ...listeners.others.map(l => ({ ...l, own: false }))];

  return (
    <div className="preview-pane" onClick={e => e.stopPropagation()}>
      <div className="preview-bar">
        <button
          className="preview-btn"
          title="Reload"
          onClick={() => { if (target) { setNonce(n => n + 1); void load(target, route); } }}
        >
          <RotateCw size={12} className={busy ? 'preview-spin' : undefined} />
        </button>
        <input
          className="preview-address"
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') void load(draft); }}
          placeholder="localhost:3000, or any URL"
          spellCheck={false}
        />
        {/* Which way the page came. Never hidden: a proxied page is a
            different thing from the real one — no cookies, no login — and you
            should not have to wonder which you are looking at. */}
        <button
          className={`preview-route${route === 'proxy' ? ' preview-route-on' : ''}`}
          title={route === 'proxy'
            ? 'Coming through sheepit: headers stripped, sandboxed, no cookies. Click for a direct frame.'
            : 'Loaded directly. Click to route it through sheepit instead.'}
          onClick={() => { if (target) void load(target, route === 'proxy' ? 'direct' : 'proxy'); }}
        >
          {route === 'proxy' ? <ServerCog size={12} /> : <Globe size={12} />}
          {route === 'proxy' ? 'via sheepit' : 'direct'}
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
        {src ? (
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
