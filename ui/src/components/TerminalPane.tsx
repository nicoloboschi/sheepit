import { useEffect, useRef, useState, useCallback } from 'react';
import { SquareTerminal } from 'lucide-react';
import useStore from '../store';
import { notify } from '../utils';
import type { Terminal } from 'xterm';
import type { FitAddon } from 'xterm-addon-fit';

interface TerminalPaneProps {
  termRef: React.MutableRefObject<Terminal | null>;
  fitAddonRef: React.MutableRefObject<FitAddon | null>;
  sendRef: React.MutableRefObject<(msg: Record<string, unknown>) => void>;
  sessionId: string | null;
}

export default function TerminalPane({ termRef, fitAddonRef, sendRef, sessionId: sessionIdProp }: TerminalPaneProps): React.ReactElement {
  const storeSessionId   = useStore(s => s.currentSessionId);
  const currentSessionId = sessionIdProp ?? storeSessionId;
  const termContainerRef = useRef<HTMLDivElement | null>(null);

  // Mount terminal into DOM once
  useEffect(() => {
    const el = termContainerRef.current;
    if (!el || !termRef.current) return;
    termRef.current.open(el);
    fitAddonRef.current?.fit();
    return () => { el.replaceChildren(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Wire up onData and onBell
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const dataDispose = term.onData((data: string) => {
      // Filter DA responses (e.g. \x1b[?1;2c, \x1b[>0;276;0c) that xterm auto-generates
      // when tmux sends DA1/DA2 requests on connect — forwarding them to the PTY causes
      // visible garbage text like "1;2c0;276;0c" to appear in the shell.
      if (/^\x1b\[[\?>][\d;]*c$/.test(data)) return;
      const sid = sessionIdProp ?? useStore.getState().currentSessionId;
      if (sid) sendRef.current({ type: 'input', data });
    });
    const bellDispose = term.onBell(() => {
      const state = useStore.getState();
      const session = state.currentSessionId ? state.sessionMap[state.currentSessionId] : undefined;
      notify('sheepit \u{1F411}', `Bell in ${session?.name ?? 'terminal'}`);
    });
    return () => { dataDispose.dispose(); bellDispose.dispose(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Touch scroll + keep-keyboard-open refocus.
  //
  // Touch is handled in JS because xterm-screen (canvas) is a *sibling* of
  // xterm-viewport — native touch can't reach the viewport scroll container.
  // We set scrollTop directly; xterm's 'scroll' event listener updates ydisp.
  //
  // Wheel: we intercept in capture phase on the primary buffer to prevent
  // tmux's DECSET 1007 from converting wheel events to arrow sequences.
  // On the alternate buffer we return early (though with alt-screen suppression
  // this branch is rarely reached in normal tmux usage).
  useEffect(() => {
    const el = termContainerRef.current;
    if (!el) return;

    let lastScrollTime = 0;
    let lastTouchY = 0, accPx = 0, isTouchScrolling = false;

    const getVp = (): Element | null => el.querySelector('.xterm-viewport');

    const onTouchStart = (e: TouchEvent): void => {
      if (e.touches[0]!.clientX > el.getBoundingClientRect().right - 28) return;
      lastTouchY = e.touches[0]!.clientY;
      accPx = 0;
      isTouchScrolling = false;
    };

    const onTouchMove = (e: TouchEvent): void => {
      const dy = lastTouchY - e.touches[0]!.clientY;
      lastTouchY = e.touches[0]!.clientY;
      accPx += dy;
      const px = Math.trunc(accPx);
      accPx -= px;
      if (px !== 0) {
        const vp = getVp() as HTMLElement | null;
        if (vp) {
          vp.scrollTop = Math.max(0, Math.min(vp.scrollTop + px, vp.scrollHeight - vp.clientHeight));
          isTouchScrolling = true;
          lastScrollTime = Date.now();
        }
      }
      if (isTouchScrolling) { e.preventDefault(); e.stopPropagation(); }
    };

    const onTouchEnd = (): void => {
      if (isTouchScrolling) lastScrollTime = Date.now();
      isTouchScrolling = false;
    };

    const onWheel = (e: WheelEvent): void => {
      if (termRef.current?.buffer?.active?.type === 'alternate') return;
      e.preventDefault();
      e.stopPropagation();
      const vp = getVp() as HTMLElement | null;
      if (!vp) return;
      const deltaPx = e.deltaMode === WheelEvent.DOM_DELTA_LINE
        ? e.deltaY * ((termRef.current?.options?.fontSize ?? 14) * (termRef.current?.options?.lineHeight ?? 1.2))
        : e.deltaMode === WheelEvent.DOM_DELTA_PAGE
          ? e.deltaY * (termRef.current?.rows ?? 20) * ((termRef.current?.options?.fontSize ?? 14) * (termRef.current?.options?.lineHeight ?? 1.2))
          : e.deltaY; // DOM_DELTA_PIXEL — pass through directly
      vp.scrollTop = Math.max(0, Math.min(vp.scrollTop + deltaPx, vp.scrollHeight - vp.clientHeight));
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true,  capture: true });
    el.addEventListener('touchmove',  onTouchMove,  { passive: false, capture: true });
    el.addEventListener('touchend',   onTouchEnd,   { passive: true,  capture: true });
    el.addEventListener('wheel',      onWheel,      { passive: false, capture: true });

    // Refocus textarea to keep soft keyboard open after blur, but not during scroll
    // or when a Radix overlay (dropdown/dialog) is open.
    const initRefocus = (): void => {
      const textarea = el.querySelector('textarea') as HTMLTextAreaElement | null;
      if (!textarea || (el as any)._refocusAttached) return;
      (el as any)._refocusAttached = true;
      const refocus = (): void => {
        setTimeout(() => {
          if (Date.now() - lastScrollTime < 800) return;
          if (document.querySelector('[data-radix-popper-content-wrapper],[data-radix-dialog-content]')) return;
          const a = document.activeElement as HTMLElement | null;
          if (a && a !== document.body && a !== textarea &&
              (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' ||
               a.tagName === 'BUTTON' || a.tagName === 'A')) return;
          textarea.focus({ preventScroll: true });
        }, 150);
      };
      textarea.addEventListener('blur', refocus);
      (el as any)._refocusCleanup = () => {
        textarea.removeEventListener('blur', refocus);
        (el as any)._refocusAttached = false;
      };
    };

    initRefocus();
    const mo = new MutationObserver(initRefocus);
    mo.observe(el, { childList: true, subtree: true });

    return () => {
      mo.disconnect();
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchmove',  onTouchMove,  { capture: true });
      el.removeEventListener('touchend',   onTouchEnd,   { capture: true });
      el.removeEventListener('wheel',      onWheel,      { capture: true });
      (el as any)._refocusCleanup?.();
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle window resize — debounced so the terminal doesn't reflow on every pixel during a drag
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        fitAddonRef.current?.fit();
        const term = termRef.current;
        const sid  = sessionIdProp ?? useStore.getState().currentSessionId;
        if (term && sid) sendRef.current({ type: 'resize', cols: term.cols, rows: term.rows });
      }, 80);
    };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); if (timer) clearTimeout(timer); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="flex flex-col flex-1 min-h-0 overflow-hidden">

      <main
        className="flex-1 relative overflow-hidden min-h-0"
        style={{ background: 'var(--background)' }}
      >
        {!currentSessionId && (
          <div className="placeholder">
            <div className="placeholder-inner">
              <div className="placeholder-icon">
                <SquareTerminal size={40} strokeWidth={1.5} />
              </div>
              <div>Select a session to connect</div>
            </div>
          </div>
        )}
        <div className="terminal-pane" ref={termContainerRef} />
        <TerminalScrollbar termContainerRef={termContainerRef} />
      </main>
    </div>
  );
}

interface TerminalScrollbarProps {
  termContainerRef: React.RefObject<HTMLDivElement | null>;
}

function TerminalScrollbar({ termContainerRef }: TerminalScrollbarProps): React.ReactElement | null {
  const trackRef = useRef<HTMLDivElement | null>(null);
  const thumbRef = useRef<HTMLDivElement | null>(null);
  const rafRef   = useRef<number | null>(null);
  const dragging = useRef<boolean>(false);
  const [hasScrollback, setHasScrollback] = useState<boolean>(false);

  const getViewport = (): HTMLElement | null =>
    termContainerRef.current?.querySelector('.xterm-viewport') as HTMLElement | null;

  function syncThumb(): void {
    const viewport = getViewport();
    if (!viewport || !trackRef.current || !thumbRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    const ratio = clientHeight / scrollHeight;
    setHasScrollback(ratio < 0.99);
    const trackH = trackRef.current.clientHeight;
    const thumbH = Math.max(44, trackH * ratio);
    const maxTop = trackH - thumbH;
    const top = ratio >= 1 ? 0 : (scrollTop / (scrollHeight - clientHeight)) * maxTop;
    thumbRef.current.style.height = `${thumbH}px`;
    thumbRef.current.style.transform = `translateY(${top}px)`;
  }

  // Keep thumb in sync with scroll & content changes
  useEffect(() => {
    let viewport: HTMLElement | null = null;

    function onScroll(): void {
      if (rafRef.current) return;
      rafRef.current = requestAnimationFrame(() => { rafRef.current = null; syncThumb(); });
    }

    function attach(): void {
      viewport = getViewport();
      if (!viewport || (viewport as any)._scrollbarAttached) return;
      (viewport as any)._scrollbarAttached = true;
      viewport.addEventListener('scroll', onScroll, { passive: true });
      // Also re-sync when xterm writes new content (scrollHeight changes)
      const ro = new ResizeObserver(syncThumb);
      ro.observe(viewport);
      (viewport as any)._scrollbarRO = ro;
      syncThumb();
    }

    const mo = new MutationObserver(attach);
    mo.observe(termContainerRef.current!, { childList: true, subtree: true });
    attach();

    return () => {
      mo.disconnect();
      if (viewport) {
        viewport.removeEventListener('scroll', onScroll);
        (viewport as any)._scrollbarRO?.disconnect();
      }
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag the thumb OR tap the track to jump
  const onTrackPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>): void => {
    e.preventDefault();
    const viewport = getViewport();
    if (!viewport || !trackRef.current || !thumbRef.current) return;

    dragging.current = true;
    const trackRect = trackRef.current.getBoundingClientRect();
    const thumbH = thumbRef.current.clientHeight;
    const trackH = trackRef.current.clientHeight;
    const maxTravel = trackH - thumbH;
    const { scrollHeight, clientHeight } = viewport;
    const maxScroll = scrollHeight - clientHeight;

    // Jump scroll to clicked position immediately
    const jumpTo = (clientY: number): void => {
      const relY = clientY - trackRect.top - thumbH / 2;
      viewport.scrollTop = (Math.max(0, Math.min(relY, maxTravel)) / maxTravel) * maxScroll;
    };
    jumpTo(e.clientY);

    const onMove = (ev: PointerEvent): void => { if (dragging.current) jumpTo(ev.clientY); };
    const onUp   = (): void => {
      dragging.current = false;
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (!hasScrollback) return null;

  return (
    // Wide invisible track — easy to touch — with a narrow visible thumb inside
    <div
      ref={trackRef}
      className="md:hidden"
      onPointerDown={onTrackPointerDown}
      style={{
        position: 'absolute',
        right: 0,
        top: 8,
        bottom: 8,
        width: 28,          // wide touch target
        zIndex: 10,
        touchAction: 'none',
        cursor: 'pointer',
      }}
    >
      {/* Visible thumb pill — centered in the wide track */}
      <div
        ref={thumbRef}
        style={{
          position: 'absolute',
          right: 3,
          width: 5,
          borderRadius: 4,
          background: 'rgba(255,255,255,0.4)',
          minHeight: 44,
          pointerEvents: 'none', // track handles all events
        }}
      />
    </div>
  );
}
