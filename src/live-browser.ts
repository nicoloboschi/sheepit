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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

/** Where we record the browser we started: its pid and its debugging port.
 *
 *  Chromium writes `DevToolsActivePort` into the profile and that is what a
 *  re-attach reads first — but it is Chromium's file, and it is gone the moment
 *  the browser is not shut down cleanly. What is left then is the worst state
 *  there is: a live browser holding the profile's `SingletonLock`, unreachable
 *  because nothing knows its port, and every launch after it exiting with code
 *  21 because it cannot take a lock the orphan still holds. One test run left
 *  the feature wedged exactly that way. So we keep our own note. */
function browserRecordFile(): string {
  return join(configDir(), 'browser.json');
}

interface BrowserRecord { pid: number; port: number }

function readRecord(): BrowserRecord | null {
  try {
    const raw = JSON.parse(readFileSync(browserRecordFile(), 'utf-8')) as BrowserRecord;
    return Number.isFinite(raw.pid) && Number.isFinite(raw.port) ? raw : null;
  } catch {
    return null;
  }
}

/** Chromium's own note, which is there after a clean run and absent after a
 *  crash — read as a fallback to ours. */
function portFromProfile(): number | null {
  try {
    const raw = readFileSync(join(browserProfileDir(), 'DevToolsActivePort'), 'utf-8');
    const port = parseInt(raw.split('\n')[0] ?? '', 10);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/** The lock files a dead Chromium leaves behind. Removing them is safe only
 *  once nothing is holding the profile, which is the caller's job to ensure. */
function clearProfileLocks(): void {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    try { rmSync(join(browserProfileDir(), name), { force: true }); } catch { /* not there */ }
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
  onActive: (active: boolean) => void;
  lastUrl: string;
  lastTitle: string;
}

export class LiveBrowser {
  private proc: ChildProcess | null = null;
  private cdp: CdpConnection | null = null;
  private starting: Promise<CdpConnection> | null = null;
  private views = new Map<string, View>();
  /**
   * Only one tab can stream at a time, so this is which one.
   *
   * Headless Chromium casts the *active* page and nothing else: measured,
   * `Page.startScreencast` on a freshly launched browser fails outright with
   * "Not attached to an active page" until `Target.activateTarget` has been
   * called, and activating a second tab stops the first one's frames dead —
   * even across a reload. Frames follow activation exactly, and switching back
   * resumes it.
   *
   * So a pane streams while you are in it, and the others hold their last
   * frame until you click into them — which is what a background tab does in
   * any browser. What must never happen is silence with no explanation, so the
   * pane that loses the stream is told (`onActive(false)`) and says so.
   */
  private activeViewId: string | null = null;
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
    // launching a second one against the same --user-data-dir cannot work.
    // Talk to the one that is there — our note first, Chromium's second.
    const record = readRecord();
    for (const port of [record?.port, portFromProfile()]) {
      if (!port) continue;
      const url = await debuggerUrl(port);
      if (url) {
        this.log(`live browser: re-attached on port ${port}`);
        return this.connect(url);
      }
    }

    // Nothing answers. If the browser we started is nonetheless still running,
    // it is an orphan we can no longer speak to and it is holding the profile
    // — so it has to go, or every launch from here on exits 21.
    if (record && alive(record.pid)) {
      this.log(`live browser: killing unreachable browser (pid ${record.pid})`);
      try { process.kill(record.pid, 'SIGKILL'); } catch { /* already gone */ }
      for (let i = 0; i < 25 && alive(record.pid); i++) await new Promise(r => setTimeout(r, 100));
    }
    // Whatever held them is gone by now: either it was never running, or we
    // just killed it. A stale lock left behind refuses the next launch.
    clearProfileLocks();

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
      // Exit codes here are Chromium's and mean nothing on their own — 21 is
      // "could not take the profile lock" — so the stderr goes with them.
      const why = stderrTail.trim().split('\n').filter(Boolean).slice(-2).join(' / ');
      this.log(`live browser: exited (${code})${why ? `: ${why}` : ''}`);
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
        const pid = this.proc?.pid;
        if (pid) {
          try { writeFileSync(browserRecordFile(), JSON.stringify({ pid, port })); } catch { /* best effort */ }
        }
        return this.connect(url);
      }
      // A browser that has already exited will not start answering.
      if (!this.proc) break;
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
    onActive: (active: boolean) => void;
  }): Promise<void> {
    const cdp = await this.connection();
    await this.closeView(opts.id);

    const { targetId } = await cdp.send<{ targetId: string }>('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send<{ sessionId: string }>('Target.attachToTarget', { targetId, flatten: true });

    const view: View = {
      id: opts.id, targetId, sessionId,
      width: Math.max(200, Math.round(opts.width)),
      height: Math.max(200, Math.round(opts.height)),
      onFrame: opts.onFrame, onState: opts.onState, onActive: opts.onActive,
      lastUrl: '', lastTitle: '',
    };
    this.views.set(opts.id, view);

    await cdp.send('Page.enable', {}, sessionId);
    await this.applyMetrics(view, opts.scale);
    if (opts.url) await cdp.send('Page.navigate', { url: opts.url }, sessionId).catch(() => {});
    await this.activate(opts.id, opts.scale);
  }

  /** Make this view the one that streams. Everything else stops, because the
   *  browser only casts its active page — see `activeViewId`. */
  async activate(id: string, scale = 1): Promise<void> {
    const view = this.views.get(id);
    const cdp = this.cdp;
    if (!view || !cdp) return;
    if (this.activeViewId === id) return;

    const previous = this.activeViewId ? this.views.get(this.activeViewId) : undefined;
    this.activeViewId = id;
    if (previous && previous.id !== id) {
      await cdp.send('Page.stopScreencast', {}, previous.sessionId).catch(() => {});
      previous.onActive(false);
    }
    await cdp.send('Target.activateTarget', { targetId: view.targetId }).catch(() => {});
    await this.startCast(view, scale);
    view.onActive(true);
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
    if (!view) return;
    // Typing an address is using the pane, so it takes the stream too —
    // otherwise the page would load where you cannot see it.
    void this.activate(id);
    this.cdp?.post('Page.navigate', { url }, view.sessionId);
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
    if (this.activeViewId === id) {
      this.activeViewId = null;
      // Hand the stream to whoever is left rather than leaving every open pane
      // frozen because the one that closed was the active one.
      const next = this.views.keys().next();
      if (!next.done) void this.activate(next.value);
    }
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
