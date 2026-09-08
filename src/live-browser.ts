/**
 * A real browser, on this machine, streamed into a pane.
 *
 * The embedded preview iframe is deliberately not a browser — no cookies, no
 * login, and a page that refuses framing cannot be shown at all. That is fine
 * for a dev server and useless for the thing people actually want to do beside
 * their terminal: read the pull request they just pushed, look at the files
 * changed, leave a comment. github.com sends `X-Frame-Options: deny`, so no
 * amount of proxying gets there; a proxy that could would be a login-stealing
 * MITM for a site with CSRF tokens and 2FA.
 *
 * So this drives a genuine Chromium over CDP and ships the pixels out:
 *
 *  - **The browser is the one already on the machine** (Chrome, Brave, Edge,
 *    Chromium — see `findBrowser`). No 300 MB download, and the same rendering
 *    engine the user already trusts.
 *  - **The profile is persistent** (`browserProfileDir()`), which is the whole
 *    point: sign in to GitHub once and you are still signed in next week, and
 *    across server restarts, because the cookies are on disk and not in this
 *    process. It is a *separate* profile from the user's own browser — we
 *    never touch that one, and two processes cannot share a user-data-dir.
 *  - **It is headless**, because the point is looking at it from somewhere
 *    else. A window opening on the host would be a window nobody is sitting in
 *    front of.
 *
 * Security, stated plainly: anything that can reach sheepit can drive this
 * browser and is therefore inside every session it holds. That is a real
 * escalation over the preview iframe — and it is not an escalation over
 * sheepit itself, which hands the same caller a shell on the same machine as
 * the same user. The shell is strictly the bigger key. Do not add a way to
 * reach the browser that does not go through sheepit's own front door.
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import { createServer } from 'net';
import { platform } from 'os';
import { join } from 'path';
import { CdpConnection } from './cdp.js';
import { configDir } from './paths.js';

/** The live browser's Chromium profile — cookies, logins, history. This is the
 *  whole point of it being a real browser: sign in once and you are still
 *  signed in next week, across server restarts, because the cookies are on
 *  disk rather than in this process.
 *
 *  It lives HERE and not in `paths.ts`, which is where every other sheepit
 *  path lives, for one blunt reason: `paths.ts` is one of the two files
 *  `dev.sh` hashes to decide whether the PTY daemon is running stale code
 *  (`DAEMON_SOURCES`). Adding this function there changed that hash, so the
 *  next `dev.sh` replaced the daemon — and the daemon holds every session's
 *  PTY master, so that closed every shell and killed every agent running in
 *  them. A path the daemon never reads must not be able to do that. */
function browserProfileDir(): string {
  return join(configDir(), 'browser-profile');
}

/** Where a Chromium-family browser usually is, best first. `SHEEPIT_BROWSER`
 *  overrides everything, for a machine that keeps its browser somewhere else. */
function candidatePaths(): string[] {
  const override = process.env.SHEEPIT_BROWSER;
  if (override) return [override];
  if (platform() === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ];
  }
  return [
    '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
    '/usr/bin/brave-browser', '/usr/bin/microsoft-edge',
    '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ];
}

export function findBrowser(): string | null {
  return candidatePaths().find(p => existsSync(p)) ?? null;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function debuggerUrl(port: number): Promise<string | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return null;
    const info = await res.json() as { webSocketDebuggerUrl?: string };
    return info.webSocketDebuggerUrl ?? null;
  } catch {
    return null;
  }
}

/** The port a previous run left behind. Chromium writes it into the profile,
 *  so a server restart re-attaches to the browser that is already open with
 *  every tab and every session still in it, rather than starting a second one. */
function portFromProfile(): number | null {
  try {
    const raw = readFileSync(join(browserProfileDir(), 'DevToolsActivePort'), 'utf-8');
    const port = parseInt(raw.split('\n')[0] ?? '', 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

export interface ViewFrame {
  /** base64 JPEG. */
  data: string;
  /** CSS pixels of the page viewport this frame covers. */
  width: number;
  height: number;
}

export interface ViewState {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

interface View {
  id: string;
  targetId: string;
  sessionId: string;
  width: number;
  height: number;
  onFrame: (frame: ViewFrame) => void;
  onState: (state: ViewState) => void;
  lastUrl: string;
  lastTitle: string;
}

export class LiveBrowser {
  private proc: ChildProcess | null = null;
  private cdp: CdpConnection | null = null;
  private starting: Promise<CdpConnection> | null = null;
  private views = new Map<string, View>();
  private log: (msg: string) => void;

  constructor(log: (msg: string) => void = () => {}) { this.log = log; }

  available(): boolean { return findBrowser() !== null; }

  /** One browser for the whole server, started on first use — nobody should
   *  pay for a Chromium they never opened. */
  private async connection(): Promise<CdpConnection> {
    if (this.cdp?.isOpen) return this.cdp;
    if (this.starting) return this.starting;
    this.starting = this.start().finally(() => { this.starting = null; });
    return this.starting;
  }

  private async start(): Promise<CdpConnection> {
    // A browser from a previous server run is still holding the profile, so
    // launching a second one against the same --user-data-dir would fail. Ask
    // the one that is there first.
    const existing = portFromProfile();
    if (existing) {
      const url = await debuggerUrl(existing);
      if (url) {
        this.log(`live browser: re-attached on port ${existing}`);
        return this.connect(url);
      }
    }

    const binary = findBrowser();
    if (!binary) throw new Error('No Chromium-family browser found. Set SHEEPIT_BROWSER to one.');
    const profile = browserProfileDir();
    mkdirSync(profile, { recursive: true });
    const port = await freePort();

    this.proc = spawn(binary, [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      // The point is to look at it from elsewhere, so there is no window.
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--hide-crash-restore-bubble',
      'about:blank',
    ], { stdio: ['ignore', 'ignore', 'pipe'], detached: false });
    // Chromium's own reason for refusing to start — a profile another process
    // still holds, a missing sandbox — is on stderr and nowhere else, and a
    // silent 'ignore' here turned every one of them into the same unhelpful
    // "did not answer on its debugging port".
    let stderrTail = '';
    this.proc.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });
    this.proc.on('exit', code => {
      this.log(`live browser: exited (${code})`);
      this.proc = null;
      this.cdp?.close();
      this.cdp = null;
      this.views.clear();
    });

    // It writes DevToolsActivePort when it is ready to talk; poll the endpoint
    // rather than guessing a delay.
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const url = await debuggerUrl(port);
      if (url) {
        this.log(`live browser: started ${binary} on port ${port}`);
        return this.connect(url);
      }
      await new Promise(r => setTimeout(r, 120));
    }
    const why = stderrTail.trim().split('\n').filter(Boolean).slice(-2).join(' / ');
    throw new Error(`Browser did not answer on its debugging port${why ? `: ${why}` : ''}`);
  }

  private async connect(url: string): Promise<CdpConnection> {
    const cdp = new CdpConnection(url);
    await cdp.ready;
    this.cdp = cdp;

    cdp.on('Page.screencastFrame', (params, sessionId) => {
      const view = sessionId ? this.viewBySession(sessionId) : undefined;
      // Ack first: Chromium sends the next frame only once this one is
      // acknowledged, so a dropped ack freezes the stream, not just a frame.
      cdp.post('Page.screencastFrameAck', { sessionId: params.sessionId as number }, sessionId);
      if (!view) return;
      const meta = (params.metadata ?? {}) as { deviceWidth?: number; deviceHeight?: number };
      view.onFrame({
        data: String(params.data ?? ''),
        width: meta.deviceWidth ?? view.width,
        height: meta.deviceHeight ?? view.height,
      });
    });

    const restate = (_params: Record<string, unknown>, sessionId?: string) => {
      const view = sessionId ? this.viewBySession(sessionId) : undefined;
      if (view) void this.pushState(view);
    };
    cdp.on('Page.frameNavigated', restate);
    cdp.on('Page.loadEventFired', restate);
    cdp.on('Page.navigatedWithinDocument', restate);

    cdp.on('__closed__', () => { this.cdp = null; this.views.clear(); });
    return cdp;
  }

  private viewBySession(sessionId: string): View | undefined {
    for (const view of this.views.values()) if (view.sessionId === sessionId) return view;
    return undefined;
  }

  private async pushState(view: View): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    try {
      const history = await cdp.send<{ currentIndex: number; entries: { url: string; title: string }[] }>(
        'Page.getNavigationHistory', {}, view.sessionId);
      const current = history.entries[history.currentIndex];
      view.lastUrl = current?.url ?? view.lastUrl;
      view.lastTitle = current?.title ?? view.lastTitle;
      view.onState({
        url: view.lastUrl,
        title: view.lastTitle,
        loading: false,
        canGoBack: history.currentIndex > 0,
        canGoForward: history.currentIndex < history.entries.length - 1,
      });
    } catch { /* the tab went away mid-question */ }
  }

  /** A tab of its own per pane, so two panes are two pages and not one page
   *  fought over. Returns once it is streaming. */
  async openView(opts: {
    id: string;
    url: string;
    width: number;
    height: number;
    scale: number;
    onFrame: (frame: ViewFrame) => void;
    onState: (state: ViewState) => void;
  }): Promise<void> {
    const cdp = await this.connection();
    await this.closeView(opts.id);

    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });

    const view: View = {
      id: opts.id, targetId, sessionId,
      width: Math.max(200, Math.round(opts.width)),
      height: Math.max(200, Math.round(opts.height)),
      onFrame: opts.onFrame, onState: opts.onState,
      lastUrl: '', lastTitle: '',
    };
    this.views.set(opts.id, view);

    await cdp.send('Page.enable', {}, sessionId);
    await this.applyMetrics(view, opts.scale);
    if (opts.url) await cdp.send('Page.navigate', { url: opts.url }, sessionId).catch(() => {});
    await this.startCast(view, opts.scale);
  }

  private async applyMetrics(view: View, scale: number): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    // The page is laid out in the pane's own CSS pixels, so a click at (x, y)
    // on the image is a click at (x, y) in the page — no mapping to get wrong.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: view.width, height: view.height,
      deviceScaleFactor: Math.min(2, Math.max(1, scale)),
      mobile: false,
    }, view.sessionId);
  }

  private async startCast(view: View, scale: number): Promise<void> {
    const cdp = this.cdp;
    if (!cdp) return;
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      // Text has to stay readable — this is a page you read, not a video —
      // and JPEG at 80 over a LAN is cheaper than the PNG it replaces.
      quality: 80,
      maxWidth: Math.round(view.width * Math.min(2, Math.max(1, scale))),
      maxHeight: Math.round(view.height * Math.min(2, Math.max(1, scale))),
      everyNthFrame: 1,
    }, view.sessionId);
    void this.pushState(view);
  }

  async resizeView(id: string, width: number, height: number, scale: number): Promise<void> {
    const view = this.views.get(id);
    const cdp = this.cdp;
    if (!view || !cdp) return;
    view.width = Math.max(200, Math.round(width));
    view.height = Math.max(200, Math.round(height));
    await cdp.send('Page.stopScreencast', {}, view.sessionId).catch(() => {});
    await this.applyMetrics(view, scale);
    await this.startCast(view, scale);
  }

  navigate(id: string, url: string): void {
    const view = this.views.get(id);
    if (view) this.cdp?.post('Page.navigate', { url }, view.sessionId);
  }

  reload(id: string): void {
    const view = this.views.get(id);
    if (view) this.cdp?.post('Page.reload', {}, view.sessionId);
  }

  async history(id: string, delta: -1 | 1): Promise<void> {
    const view = this.views.get(id);
    const cdp = this.cdp;
    if (!view || !cdp) return;
    try {
      const h = await cdp.send<{ currentIndex: number; entries: { id: number }[] }>(
        'Page.getNavigationHistory', {}, view.sessionId);
      const entry = h.entries[h.currentIndex + delta];
      if (entry) cdp.post('Page.navigateToHistoryEntry', { entryId: entry.id }, view.sessionId);
    } catch { /* nothing to go back to */ }
  }

  /** Raw CDP Input.* passthrough. The client speaks this dialect directly —
   *  translating mouse and key events twice, once in the browser and once
   *  here, only creates two places for a modifier bit to go missing. */
  input(id: string, method: string, params: Record<string, unknown>): void {
    const view = this.views.get(id);
    if (!view) return;
    if (!method.startsWith('Input.')) return;
    this.cdp?.post(method, params, view.sessionId);
  }

  async closeView(id: string): Promise<void> {
    const view = this.views.get(id);
    if (!view) return;
    this.views.delete(id);
    try { await this.cdp?.send('Target.closeTarget', { targetId: view.targetId }); } catch { /* gone */ }
  }

  /** Leaves the browser process running: its whole value is the profile, and a
   *  server restart re-attaches to it. Kill it only on request. */
  async shutdown(): Promise<void> {
    for (const id of [...this.views.keys()]) await this.closeView(id);
    this.cdp?.close();
    this.cdp = null;
  }
}
