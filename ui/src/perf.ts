/**
 * The one place the UI measures itself.
 *
 * Nothing else in the UI may call `performance.now()`, stand up a
 * `PerformanceObserver`, or keep its own frame counter — a second measurement
 * is a second answer, and the point of this file is that there is one. It is
 * always on, in every build, because the bottlenecks worth finding are the ones
 * in real daily use and those never show up in a profiling session you sat down
 * to run.
 *
 * It is cheap enough to leave on: one `requestAnimationFrame` for the whole app
 * (an increment and a subtraction), one long-task observer, and a `Map` bump per
 * span. Nothing allocates per frame.
 *
 * Every `WINDOW_MS` it folds what it saw into a snapshot, keeps the last
 * `KEEP` of them for the diagnostics panel, and posts one to the server, where
 * `/api/perf` holds a rolling hour. That last part is the reason this exists at
 * all: a snapshot nobody can read later is a profile of a moment nobody cared
 * about.
 */

/** A frame over budget. 60Hz is 16.7ms; the slack keeps honest frames out. */
const SLOW_FRAME_MS = 20;
/** How long one snapshot covers. */
const WINDOW_MS = 10_000;
/** Snapshots kept in the browser for the panel (an hour at WINDOW_MS). */
const KEEP = 360;

/** One timed name: how often, how long in total, and the worst single one. */
export interface Stat { n: number; totalMs: number; maxMs: number }

export interface PerfSnapshot {
  at: number;
  /** Which page this came from. A machine routinely has several at once — the
   *  desktop window, a tab, a second window — and without this they fold into
   *  one average that describes none of them. Regenerated per page load, so a
   *  reload starts a new series rather than continuing a stale one. */
  page: string;
  /** Seconds this snapshot covers, wall-clock. */
  secs: number;
  /** Of those, how many the window was actually on screen for. Frames are only
   *  produced while it is, so this is what `fps` is a rate over — and a window
   *  that was behind something the whole time reports 0 here, which is the
   *  difference between "nothing was drawn" and "the app was stalled". */
  visibleSecs: number;
  shell: 'electron' | 'browser';
  fps: number;
  /** Frames over SLOW_FRAME_MS, and the worst one. */
  slowFrames: number;
  worstFrameMs: number;
  /** What had a span open when the worst frame landed. '' means nothing did,
   *  which points at style/layout/paint rather than at our own JavaScript. */
  worstFrameBlame: string;
  longTasks: number;
  longTaskMs: number;
  worstLongTaskMs: number;
  /** Timed spans, worst-total first. */
  spans: Record<string, Stat>;
  /** Plain counters — renders, IPC sends, store updates. */
  counts: Record<string, number>;
  /** What the app was holding while this was measured. */
  terminals: number;
  browserPanes: number;
  domNodes: number;
  heapMb: number | null;
  dpr: number;
  /** The worst long animation frames, with what the browser blamed them on.
   *  This is the one measurement that finds work nothing here thought to time:
   *  a `span` only answers for code somebody suspected. */
  loaf: LoafEntry[];
  /** Electron only: what the main process saw. The renderer cannot measure a
   *  stall in the process handling its window events, so it asks. */
  main?: MainLag | null;
}

/**
 * One long animation frame. `blocking` is how long the main thread was busy,
 * and the split matters: `styleAndLayout` points at CSS and the DOM, while a
 * named `script` points at ours. `source` is the function and file the browser
 * itself blamed, which is how a stall gets found rather than guessed at.
 */
export interface LoafEntry {
  at: number;
  durationMs: number;
  blockingMs: number;
  styleAndLayoutMs: number;
  /** The costliest script in the frame, as the browser attributes it. */
  script: string;
  scriptMs: number;
  /** Why that script ran: a listener, a timer, a promise. */
  invoker: string;
}

/** Main-process event-loop lag and IPC handler cost, since the last snapshot. */
export interface MainLag {
  ticks: number;
  stalls: number;
  worstMs: number;
  totalExcessMs: number;
  ipc: Record<string, { n: number; totalMs: number; maxMs: number }>;
}

const spans = new Map<string, Stat>();
const counts = new Map<string, number>();

let frames = 0;
let slowFrames = 0;
let worstFrameMs = 0;
let worstFrameBlame = '';
let longTasks = 0;
let longTaskMs = 0;
let worstLongTaskMs = 0;

/** Worst long frames this window, biggest first. Bounded so a bad minute
 *  cannot grow without limit. */
const loaf: LoafEntry[] = [];
const LOAF_KEEP = 8;

let windowStart = 0;
let lastFrameAt = 0;
/** Wall-clock the window has spent off screen this snapshot, and when it went. */
let hiddenMs = 0;
let hiddenSince = 0;
/** The innermost span still open, so a janky frame can name something. */
let openSpan = '';
let openDepth = 0;

/** What Chromium reports for a long animation frame. Not in lib.dom yet. */
interface LoafScript {
  name?: string; sourceURL?: string; duration: number;
  invoker?: string; invokerType?: string;
}
interface LoafFrame {
  startTime: number; duration: number; blockingDuration?: number;
  styleAndLayoutStart?: number; scripts?: LoafScript[];
}

/** A source URL short enough to read in a table: the file and its line. */
function shortUrl(url?: string): string {
  if (!url) return '?';
  return url.replace(/^https?:\/\/[^/]+\//, '').replace(/\?.*$/, '');
}

/** This page, for as long as it is loaded. */
const PAGE_ID = Math.random().toString(36).slice(2, 8);

const history: PerfSnapshot[] = [];

/**
 * The started flag lives on `window`, not in this module.
 *
 * Vite's HMR re-executes a changed module, which gives you a *new* module
 * instance with its own module-scope state — so a flag declared here reads as
 * `false` again and a second frame loop, a second observer and a second
 * snapshot timer all start up beside the first. They never stop, because the old
 * instance is still referenced by its own callbacks. Measured while writing
 * this: three loops posting three snapshots per window from one page, after
 * three hot updates. Over an afternoon of editing, the thing measuring the app
 * becomes the slowest thing in it.
 */
const STARTED = '__sheepitPerfStarted';
const alreadyStarted = (): boolean =>
  !!(window as unknown as Record<string, unknown>)[STARTED];
const markStarted = (): void => {
  (window as unknown as Record<string, unknown>)[STARTED] = true;
};

interface DesktopPerf { perfMain?: () => Promise<MainLag> }
const desktop = (): DesktopPerf | undefined =>
  typeof window === 'undefined' ? undefined
    : (window as unknown as { sheepitDesktop?: DesktopPerf }).sheepitDesktop;
const isElectron = (): boolean => !!desktop();

/** The last answer from the main process, folded into the next snapshot. */
let lastMain: MainLag | null = null;

function bump(map: Map<string, Stat>, name: string, ms: number): void {
  const s = map.get(name);
  if (!s) { map.set(name, { n: 1, totalMs: ms, maxMs: ms }); return; }
  s.n++;
  s.totalMs += ms;
  if (ms > s.maxMs) s.maxMs = ms;
}

/**
 * Time a piece of work. Returns the function that ends it.
 *
 *   const end = perf.span('renderSessions');
 *   ...
 *   end();
 *
 * Nesting is fine; the innermost open name is what a janky frame is blamed on.
 * Call the returned function exactly once — a span left open blames every
 * following frame on itself, which is loud enough to notice.
 */
export function span(name: string): () => void {
  const t0 = performance.now();
  const outer = openSpan;
  openSpan = name;
  openDepth++;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    bump(spans, name, performance.now() - t0);
    openDepth--;
    openSpan = openDepth > 0 ? outer : '';
  };
}

/**
 * A React commit, from a `<Profiler>`. Recorded as a span named
 * `commit:<id>`, so the slowest subtree shows up in the same hotspot list as
 * everything else.
 *
 * This is what a `render:` counter cannot tell you. A counter averages a burst
 * away — thirty renders in one click and nothing for the next ten seconds reads
 * as three a second — while a commit carries the duration of the work React
 * actually did, so the one 300ms commit is visible as a 300ms maximum.
 */
export function commit(id: string, ms: number): void {
  bump(spans, `commit:${id}`, ms);
}

/** Count something that has no duration: a render, an IPC send, a store write. */
export function count(name: string, by = 1): void {
  counts.set(name, (counts.get(name) ?? 0) + by);
}

/**
 * What the app is holding: terminals, browser panes, DOM nodes.
 *
 * Measured, because this is the one place the instrumentation can perturb what
 * it measures. Three whole-document queries — two `querySelectorAll` and a
 * `getElementsByTagName('*')` over 17,000+ nodes — inside a snapshot that is
 * built from a `requestAnimationFrame`. A 255ms frame blocking 200ms, carrying
 * 77ms of style and layout, was attributed to `perf.ts`'s own rAF; this is the
 * only thing in here expensive enough to be a candidate.
 *
 * So it is timed as `perf:holding` and it answers for itself in its own data.
 * If that span is ever a meaningful share of a snapshot, sample it every Nth
 * roll instead of every one — the counts are context, not a measurement
 * anything depends on.
 */
function holdingCounts(): { terminals: number; browserPanes: number; domNodes: number } {
  const end = span('perf:holding');
  try {
    return {
      terminals: document.querySelectorAll('.xterm').length,
      browserPanes: document.querySelectorAll('.live-browser-surface').length,
      domNodes: document.getElementsByTagName('*').length,
    };
  } finally {
    end();
  }
}

function snapshot(): PerfSnapshot {
  const now = performance.now();
  const secs = Math.max(0.001, (now - windowStart) / 1000);
  const hidden = hiddenMs + (hiddenSince ? now - hiddenSince : 0);
  const visibleSecs = Math.max(0, secs - hidden / 1000);
  const mem = (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory;
  const asRecord = <T>(m: Map<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [k, v] of m) out[k] = v;
    return out;
  };
  // Before the object literal, not spread inside it: `spans` is serialised in
  // the middle of that literal, so a span recorded by a later field is copied
  // out already-cleared and can never be seen. Its own measurement was
  // invisible for exactly that reason.
  const holding = holdingCounts();
  return {
    at: Date.now(),
    page: PAGE_ID,
    secs: +secs.toFixed(1),
    visibleSecs: +visibleSecs.toFixed(1),
    shell: isElectron() ? 'electron' : 'browser',
    // A rate over the time frames could actually have been produced. Dividing
    // by wall-clock instead reported a window that spent nine of ten seconds
    // behind another app as running at 7fps.
    fps: visibleSecs > 0.5 ? +(frames / visibleSecs).toFixed(1) : 0,
    slowFrames, worstFrameMs: +worstFrameMs.toFixed(1), worstFrameBlame,
    longTasks, longTaskMs: Math.round(longTaskMs), worstLongTaskMs: Math.round(worstLongTaskMs),
    spans: asRecord(spans),
    counts: asRecord(counts),
    ...holding,
    heapMb: mem ? Math.round(mem.usedJSHeapSize / 1048576) : null,
    dpr: window.devicePixelRatio,
    loaf: [...loaf],
    main: lastMain,
  };
}

function roll(): void {
  const snap = snapshot();
  lastMain = null;
  history.push(snap);
  if (history.length > KEEP) history.shift();

  spans.clear();
  counts.clear();
  frames = slowFrames = longTasks = 0;
  worstFrameMs = longTaskMs = worstLongTaskMs = 0;
  worstFrameBlame = '';
  loaf.length = 0;
  windowStart = lastFrameAt = performance.now();
  hiddenMs = 0;
  if (hiddenSince) hiddenSince = windowStart;

  // Posted so a bottleneck in real use can be read back later; a failure here
  // is never worth a console line, because the only thing it can cost is the
  // snapshot itself.
  void fetch('/api/perf', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(snap),
  }).catch(() => {});
}

/** Start measuring. Idempotent, and called once from main.tsx. */
export function startPerf(): void {
  if (typeof window === 'undefined' || alreadyStarted()) return;
  markStarted();
  windowStart = lastFrameAt = performance.now();

  const tick = () => {
    const now = performance.now();
    const delta = now - lastFrameAt;
    lastFrameAt = now;
    frames++;
    if (delta > SLOW_FRAME_MS) {
      slowFrames++;
      if (delta > worstFrameMs) { worstFrameMs = delta; worstFrameBlame = openSpan; }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // The window is closed by a timer, never by the frame loop.
  //
  // It used to roll inside the rAF callback, which meant a window nobody was
  // looking at reported *nothing at all*: the OS stops producing frames for an
  // occluded window, so the loop stopped, so no snapshot was ever posted. The
  // whole point of this file is catching what happens during a real day's work,
  // and a day's work involves plenty of time with the window behind something
  // else. A timer is throttled in the background but it still fires, so those
  // windows are now measured — with `visibleSecs` saying how much of the
  // snapshot the frame counts can speak for.
  setInterval(roll, WINDOW_MS);

  // Ask the main process for its own numbers a little before each window
  // closes, so the snapshot carries both halves. Electron only; a plain tab has
  // no second process to ask.
  const askMain = desktop()?.perfMain;
  if (askMain) {
    setInterval(() => { void askMain().then(m => { lastMain = m; }).catch(() => {}); }, WINDOW_MS);
  }

  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks++;
        longTaskMs += entry.duration;
        if (entry.duration > worstLongTaskMs) worstLongTaskMs = entry.duration;
      }
    }).observe({ entryTypes: ['longtask'] });
  } catch { /* no longtask support; frames still answer */ }

  // Long animation frames. A `longtask` says only "something took 200ms"; this
  // says which script, in which file, called from what, and how much of the
  // frame was style and layout rather than JavaScript at all. It is the only
  // measurement here that can find work nobody thought to wrap in a span —
  // which is most of it, the first time.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as LoafFrame[]) {
        const worstScript = (e.scripts ?? []).reduce<LoafScript | null>(
          (a, b) => (!a || b.duration > a.duration ? b : a), null);
        const entry: LoafEntry = {
          at: Date.now(),
          durationMs: Math.round(e.duration),
          blockingMs: Math.round(e.blockingDuration ?? 0),
          styleAndLayoutMs: Math.round(e.styleAndLayoutStart
            ? e.startTime + e.duration - e.styleAndLayoutStart : 0),
          script: worstScript
            ? `${worstScript.name || '?'} @ ${shortUrl(worstScript.sourceURL)}`
            : '(no script — style, layout or paint)',
          scriptMs: worstScript ? Math.round(worstScript.duration) : 0,
          invoker: worstScript?.invoker ?? worstScript?.invokerType ?? '',
        };
        loaf.push(entry);
        loaf.sort((a, b) => b.durationMs - a.durationMs);
        if (loaf.length > LOAF_KEEP) loaf.length = LOAF_KEEP;
      }
      // 150ms: above the stutter anyone notices, below the noise of a mount.
    }).observe({ type: 'long-animation-frame', buffered: true } as PerformanceObserverInit);
  } catch { /* pre-Chromium-123; longtask still answers, without attribution */ }

  // A backgrounded tab stops rAF, so the window it was in is not a measurement
  // of anything. Roll it out rather than letting it report 0 fps.
  // Frames only exist while the window is on screen, so the time it is not is
  // counted out of the rate rather than counted against it.
  if (document.visibilityState !== 'visible') hiddenSince = performance.now();
  document.addEventListener('visibilitychange', () => {
    const now = performance.now();
    if (document.visibilityState === 'visible') {
      if (hiddenSince) { hiddenMs += now - hiddenSince; hiddenSince = 0; }
      // The first frame back is however long the window was away; it is not a
      // stall anyone experienced.
      lastFrameAt = now;
    } else {
      hiddenSince = now;
    }
  });
}

/** What is being measured right now, without waiting for the window to close. */
export const live = (): PerfSnapshot => snapshot();

/** Worst spans across the kept history, by total time. For the panel. */
export function hotspots(limit = 12): { name: string; n: number; totalMs: number; maxMs: number }[] {
  const merged = new Map<string, Stat>();
  for (const s of history) {
    for (const [name, stat] of Object.entries(s.spans)) {
      const m = merged.get(name);
      if (!m) merged.set(name, { ...stat });
      else { m.n += stat.n; m.totalMs += stat.totalMs; m.maxMs = Math.max(m.maxMs, stat.maxMs); }
    }
  }
  return [...merged].map(([name, s]) => ({ name, ...s }))
    .sort((a, b) => b.totalMs - a.totalMs).slice(0, limit);
}

export const perf = { span, count, commit, live, hotspots, startPerf };

if (typeof window !== 'undefined') {
  (window as unknown as { sheepitPerf: typeof perf }).sheepitPerf = perf;
}

// Editing this file reloads the page, rather than hot-swapping it.
//
// The start guard above keeps a hot update from starting a second frame loop —
// but that leaves something worse than a leak: the *old* instance still owns the
// running loops and the posting timer, while every component that re-imported
// picks up the *new* one and records its spans into maps nobody publishes. The
// measurement silently splits in two, and the half you read is the half that
// stopped being written to. A reload is the only honest answer, and it costs
// nothing — no session lives in this tab.
if (import.meta.hot) {
  import.meta.hot.accept(() => { window.location.reload(); });
}
