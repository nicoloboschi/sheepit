/**
 * The browser half of a pane inside the desktop app: a native Chromium view
 * the shell lays over this element's box (see electron/main.cjs). Same props
 * and commands as LiveBrowserSurface, so PreviewPane's bar drives either.
 *
 * Nothing is drawn here — the page is a real view in the window, with its own
 * input, IME, clipboard and scrolling — so this component's only job is
 * telling the shell where the pane is, and hiding the view when it is not.
 */
import { useEffect, useRef, useState } from 'react';
import type { BrowserDownload, LiveBrowserCommands, LiveBrowserState } from './LiveBrowserSurface';
import { perf } from '../perf';

interface DesktopBrowser {
  open(id: string, url: string): void;
  bounds(id: string, rect: { x: number; y: number; width: number; height: number } | null): void;
  close(id: string): void;
  navigate(id: string, url: string): void;
  back(id: string): void;
  forward(id: string): void;
  reload(id: string): void;
  zoom(id: string, factor: number): void;
  screenshot(id: string): Promise<string>;
  find(id: string, text: string, forward: boolean, findNext: boolean): void;
  stopFind(id: string): void;
  onFindOpen(cb: (id: string) => void): () => void;
  onFindResult(cb: (id: string, result: FindResult) => void): () => void;
  onDownload(cb: (id: string, download: BrowserDownload) => void): () => void;
  onState(cb: (id: string, state: Pick<LiveBrowserState, 'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward' | 'error'>) => void): () => void;
}

/** What the page found: how many matches, and which one is selected. */
export interface FindResult { matches: number; active: number }

/** Present only inside the desktop shell. */
export const desktopBrowser = (window as unknown as { sheepitDesktop?: { browser: DesktopBrowser } })
  .sheepitDesktop?.browser;

let nextId = 1;

const GRID = 4;

/** Whether anything is drawn over this box — ⌘K, a menu, a floating panel, a
 *  dialog. A native view sits above the whole page and cannot be layered under
 *  any of them, so it hides instead, and no overlay has to know it exists.
 *  ponytail: a 4×4 grid of hit tests, so a popover smaller than the gap between
 *  points can still slip underneath; add points if one ever does. */
function coveredTimed(el: HTMLElement, r: DOMRect): boolean {
  const end = perf.span('nativeBrowser:covered');
  try { return covered(el, r); } finally { end(); }
}

function covered(el: HTMLElement, r: DOMRect): boolean {
  const inset = 6; // clear of the loading bar and the pane's own border
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = r.left + inset + ((r.width - 2 * inset) * i) / (GRID - 1);
      const y = r.top + inset + ((r.height - 2 * inset) * j) / (GRID - 1);
      const hit = document.elementFromPoint(x, y);
      perf.count('nativeBrowser:elementFromPoint');
      if (hit && !el.contains(hit)) return true;
    }
  }
  return false;
}

export default function NativeBrowserSurface({ url, navSeq = 0, zoom = 1, onState, onDownload, commands, onFindOpen, onFindResult }: {
  url?: string | null;
  navSeq?: number;
  zoom?: number;
  onState: (state: LiveBrowserState) => void;
  onDownload?: (download: BrowserDownload) => void;
  commands: { current: LiveBrowserCommands | null };
  /** ⌘F pressed inside the page. The bar cannot be drawn over the view — a
   *  native view is above the whole page — so the pane owns it. */
  onFindOpen?: () => void;
  onFindResult?: (result: FindResult) => void;
}): React.ReactElement {
  const b = desktopBrowser!;
  const [id] = useState(() => `view-${Date.now()}-${nextId++}`);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const onStateRef = useRef(onState);
  onStateRef.current = onState;

  useEffect(() => {
    b.open(id, 'about:blank');
    const off = b.onState((viewId, s) => {
      if (viewId === id) onStateRef.current({ ...s, status: s.error ? 'error' : 'ready', streaming: true });
    });
    return () => { off(); b.close(id); };
  }, [b, id]);

  useEffect(() => {
    if (url) b.navigate(id, url);
  }, [b, id, url, navSeq]);

  useEffect(() => { b.zoom(id, zoom); }, [b, id, zoom]);

  // Follow the box while the pane is on screen, and not at all while it is not.
  //
  // A pane that is showing has to be followed closely: it moves without
  // resizing — the sidebar drags, a panel opens — and a ResizeObserver sees
  // none of that. How closely is decided by the gate further down, which runs
  // every frame while anything is happening and backs off when nothing is.
  //
  // A pane that is *not* showing used to be polled anyway, four times a second,
  // and that was the single most expensive thing the desktop app did that the
  // browser build does not do at all. Every pane in a pen stays mounted, so most
  // of these belong to panes nobody can see, and each poll was a
  // `getBoundingClientRect` — a forced layout flush over the whole document — to
  // re-learn that the pane is still hidden. Measured on a real session: 5 panes,
  // 20 forced layouts a second on an 18,500-node tree, 7.3ms of every second,
  // forever, for no information.
  //
  // An IntersectionObserver answers the same question for free, because the
  // compositor already knows: a `display: none` box does not intersect, and
  // being shown fires the callback with the new rect attached. So a hidden pane
  // now costs nothing at all, and the rAF exists only while there is something
  // to follow.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    let last = '';
    let raf = 0;
    let onScreen = false;

    // What this loop is watching for, and when it can stop looking.
    //
    // Two things can change what the native view should be doing: the pane's
    // box moves (the sidebar drags, a panel opens), or something is drawn over
    // it (⌘K, a menu, a dialog). Checking both costs a lot more than it sounds
    // like on this app's document — around 20,000 nodes with terminals writing
    // into it, so the layout is dirty on nearly every frame and both
    // `getBoundingClientRect` and `elementFromPoint` pay a full recalculation.
    // Measured in a real window: **0.79ms for one pass of the hit test, 59ms of
    // every second — 5.9% of the main thread** — while a browser pane was open.
    //
    // But a box only moves when the layout changes, and an overlay only appears
    // because somebody did something. When the box has held still for
    // STILL_AFTER frames *and* nothing has been typed, clicked, scrolled or
    // resized for QUIET_AFTER_MS, there is nothing for this loop to notice. Any
    // input, or any movement, snaps it back to every frame immediately — so a
    // drag is still followed without lag, and an overlay is still caught in the
    // frame after the keystroke that opened it.
    //
    // **Quiet backs off on a clock, not on a frame count.** It was one frame in
    // six, which sounds like a big saving and is not: six frames is 100ms, so a
    // pane nobody was touching still forced 10 full layouts a second — measured
    // at 2.33ms each on a 23,000-node tree, 18.5ms of every second, the single
    // most expensive span in the app. The frame count was the wrong unit
    // because the thing being waited for is not a frame, it is a person; at
    // QUIET_MS the same loop costs a quarter of that and notices everything it
    // noticed before, because every way the box can move now wakes it.
    //
    // The ceiling, stated plainly: an overlay that appears with no input at all
    // — opened by a timer or a server message — can sit under the native view
    // for up to QUIET_MS. Nothing in sheepit does that today.
    const STILL_AFTER = 10;
    const QUIET_AFTER_MS = 800;
    const QUIET_MS = 250;

    let rect = el.getBoundingClientRect();
    let still = 0;
    let lastInputAt = performance.now();
    let lastTickAt = 0;

    // Only input that could actually put something over this pane counts.
    //
    // Plain typing does not: every global shortcut in App.tsx begins with
    // `if (!e.metaKey) return`, and every other overlay — menus, dialogs, the
    // row menu — opens from a pointer. So the characters you type into a
    // terminal, which is most of the keyboard traffic in this app and was
    // keeping the loop awake continuously, no longer do.
    const noteInput = () => { lastInputAt = performance.now(); still = 0; };
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || e.key === 'Escape') noteInput();
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('pointerdown', noteInput, true);
    window.addEventListener('wheel', noteInput, true);
    // A window resize moves and resizes the box while nobody touches the page,
    // so it is the one way out of quiet that is not somebody's input. Without
    // it the first quarter-second of a drag on the window edge left the native
    // view behind.
    window.addEventListener('resize', noteInput);

    const tick = () => {
      perf.count('nativeBrowser:frame');
      const now = performance.now();
      const quiet = still >= STILL_AFTER && now - lastInputAt > QUIET_AFTER_MS;
      if (quiet && now - lastTickAt < QUIET_MS) { raf = requestAnimationFrame(tick); return; }
      lastTickAt = now;

      const endTick = perf.span('nativeBrowser:tick');
      const next = el.getBoundingClientRect();
      const moved = next.x !== rect.x || next.y !== rect.y
        || next.width !== rect.width || next.height !== rect.height;
      still = moved ? 0 : still + 1;
      rect = next;
      const r = rect;
      const visible = r.width > 0 && r.height > 0
        && document.visibilityState === 'visible' && !coveredTimed(el, r);
      const key = visible ? `${r.x},${r.y},${r.width},${r.height}` : 'hidden';
      if (key !== last) {
        last = key;
        perf.count('ipc:browser:bounds');
        // Split from the hit test on purpose: these are two different costs
        // with two different fixes — one is layout, one is crossing into the
        // main process, which is also what moves the native view.
        const endIpc = perf.span('ipc:bounds');
        b.bounds(id, visible ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
        endIpc();
      }
      endTick();
      if (onScreen) raf = requestAnimationFrame(tick);
    };

    const stop = () => {
      onScreen = false;
      cancelAnimationFrame(raf);
      raf = 0;
      // Say so once, rather than leaving the native view over whatever is now
      // in the pane's place.
      if (last !== 'hidden') { last = 'hidden'; b.bounds(id, null); }
    };

    const start = () => {
      if (onScreen) return;
      onScreen = true;
      // Becoming visible is a move: the next tick measures rather than trusting
      // a box remembered from before the pane was hidden.
      still = 0;
      raf = requestAnimationFrame(tick);
    };

    // `threshold: 0` is "any part of it is in the viewport". A pane under
    // `display: none`, in a pen that is not shown, or scrolled away, is all the
    // same answer here — not intersecting — which is exactly the question.
    const io = new IntersectionObserver(entries => {
      const latest = entries[entries.length - 1];
      if (latest?.isIntersecting) start(); else stop();
    }, { threshold: 0 });
    io.observe(el);

    // A backgrounded window produces no frames, so the loop would stall holding
    // a stale box. Going away also hides the view, which is what the old
    // per-frame `visibilityState` test did — kept, because a native view left
    // placed over a window nobody is looking at is a view that reappears in the
    // wrong place. Coming back re-measures before the next paint (`last = ''`).
    const onVisibility = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      if (document.visibilityState !== 'visible') {
        if (last !== 'hidden') { last = 'hidden'; b.bounds(id, null); }
        return;
      }
      last = '';
      still = 0;
      if (onScreen) raf = requestAnimationFrame(tick);
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('resize', noteInput);
    window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('pointerdown', noteInput, true);
      window.removeEventListener('wheel', noteInput, true);
      cancelAnimationFrame(raf);
    };
  }, [b, id]);

  const findRef = useRef({ open: onFindOpen, result: onFindResult, download: onDownload });
  findRef.current = { open: onFindOpen, result: onFindResult, download: onDownload };
  useEffect(() => {
    const offOpen = b.onFindOpen(viewId => { if (viewId === id) findRef.current.open?.(); });
    const offResult = b.onFindResult((viewId, r) => { if (viewId === id) findRef.current.result?.(r); });
    const offDownload = b.onDownload((viewId, download) => { if (viewId === id) findRef.current.download?.(download); });
    return () => { offOpen(); offResult(); offDownload(); };
  }, [b, id]);

  useEffect(() => {
    commands.current = {
      navigate: u => b.navigate(id, u),
      reload: () => b.reload(id),
      back: () => b.back(id),
      forward: () => b.forward(id),
      screenshot: () => b.screenshot(id),
      find: (text, forward, findNext) => b.find(id, text, forward, findNext),
      stopFind: () => b.stopFind(id),
    };
    return () => { commands.current = null; };
  }, [b, id, commands]);

  return <div ref={boxRef} className="live-browser-surface" />;
}
