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
import type { LiveBrowserCommands, LiveBrowserState } from './LiveBrowserSurface';

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
  onState(cb: (id: string, state: Pick<LiveBrowserState, 'url' | 'title' | 'loading' | 'canGoBack' | 'canGoForward' | 'error'>) => void): () => void;
}

/** What the page found: how many matches, and which one is selected. */
export interface FindResult { matches: number; active: number }

/** Present only inside the desktop shell. */
export const desktopBrowser = (window as unknown as { sheepitDesktop?: { browser: DesktopBrowser } })
  .sheepitDesktop?.browser;

let nextId = 1;

const GRID = 4;

/** Whether anything is drawn over this box — zen's backdrop, ⌘K, a menu, a
 *  dialog. A native view sits above the whole page and cannot be layered under
 *  any of them, so it hides instead, and no overlay has to know it exists.
 *  ponytail: a 4×4 grid of hit tests, so a popover smaller than the gap between
 *  points can still slip underneath; add points if one ever does. */
function covered(el: HTMLElement, r: DOMRect): boolean {
  const inset = 6; // clear of the loading bar and the pane's own border
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = r.left + inset + ((r.width - 2 * inset) * i) / (GRID - 1);
      const y = r.top + inset + ((r.height - 2 * inset) * j) / (GRID - 1);
      const hit = document.elementFromPoint(x, y);
      if (hit && !el.contains(hit)) return true;
    }
  }
  return false;
}

export default function NativeBrowserSurface({ url, navSeq = 0, zoom = 1, onState, commands, onFindOpen, onFindResult }: {
  url?: string | null;
  navSeq?: number;
  zoom?: number;
  onState: (state: LiveBrowserState) => void;
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

  // Follow the box every frame. A pane moves without resizing — the sidebar
  // drags, a split shifts, zen opens — and a ResizeObserver sees none of that.
  // ponytail: rAF poll of one getBoundingClientRect; event-driven if it ever shows up in a profile.
  useEffect(() => {
    let last = '';
    let raf = 0;
    const tick = () => {
      const el = boxRef.current;
      const r = el?.getBoundingClientRect();
      const visible = el && r && r.width > 0 && r.height > 0
        && document.visibilityState === 'visible' && !covered(el, r);
      const key = visible ? `${r.x},${r.y},${r.width},${r.height}` : 'hidden';
      if (key !== last) {
        last = key;
        b.bounds(id, visible ? { x: r.x, y: r.y, width: r.width, height: r.height } : null);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [b, id]);

  const findRef = useRef({ open: onFindOpen, result: onFindResult });
  findRef.current = { open: onFindOpen, result: onFindResult };
  useEffect(() => {
    const offOpen = b.onFindOpen(viewId => { if (viewId === id) findRef.current.open?.(); });
    const offResult = b.onFindResult((viewId, r) => { if (viewId === id) findRef.current.result?.(r); });
    return () => { offOpen(); offResult(); };
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
