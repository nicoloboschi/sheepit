import { useCallback, useEffect, useRef } from 'react';

/**
 * A real browser, running on the machine, drawn into this pane.
 *
 * The frames come from Chromium's screencast over `/ws/browser` and the input
 * goes back as CDP's own `Input.*` events — the DOM event a mouse or a key
 * produces already carries what CDP wants, so it is passed along rather than
 * translated into a private vocabulary and back.
 *
 * Two things this is NOT, and both are deliberate. It is not the preview
 * iframe: that renders natively, costs nothing and is better for a dev server,
 * which is why it is still the default where a page allows framing. And it is
 * not a tab strip — one pane is one page, because the pane is already the unit
 * you arrange things in.
 *
 * It is a *surface*, not a pane: `PreviewPane` owns the address bar for all
 * three routes, so that one bar says where you are whether the page came
 * framed, proxied, or from the browser on the machine. This fills in
 * `commands` so those buttons can drive it.
 */

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

function modifierBits(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? MODIFIERS.alt : 0) | (e.ctrlKey ? MODIFIERS.ctrl : 0)
    | (e.metaKey ? MODIFIERS.meta : 0) | (e.shiftKey ? MODIFIERS.shift : 0);
}

const BUTTONS = ['left', 'middle', 'right'] as const;

/** Keys that must reach the page as a *key*, not as text. Everything else that
 *  produces a single character is sent as text, which is the only way an IME,
 *  a dead key or an emoji arrives intact. */
const NAMED_KEYS: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46,
};

export interface LiveBrowserState {
  url: string; title: string; canGoBack: boolean; canGoForward: boolean;
  status: 'connecting' | 'ready' | 'error';
  error: string | null;
}

export interface LiveBrowserCommands {
  navigate: (url: string) => void;
  reload: () => void;
  back: () => void;
  forward: () => void;
}

export default function LiveBrowserSurface({ url: initialUrl, navSeq = 0, onState, commands }: {
  url?: string | null;
  navSeq?: number;
  onState: (state: LiveBrowserState) => void;
  /** Filled in on mount so the pane's own bar can drive the page. */
  commands: { current: LiveBrowserCommands | null };
}): React.ReactElement {
  const wsRef = useRef<WebSocket | null>(null);
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // The last frame's own size, so a click maps correctly even in the moment
  // between a resize and the first frame that is actually the new size.
  const frameSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const stateRef = useRef<LiveBrowserState>({
    url: initialUrl ?? '', title: '', canGoBack: false, canGoForward: false,
    status: 'connecting', error: null,
  });
  const report = useCallback((patch: Partial<LiveBrowserState>) => {
    stateRef.current = { ...stateRef.current, ...patch };
    onStateRef.current(stateRef.current);
  }, []);

  const send = useCallback((msg: object) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const measure = useCallback(() => {
    const box = surfaceRef.current?.getBoundingClientRect();
    return {
      width: Math.max(200, Math.round(box?.width ?? 800)),
      height: Math.max(200, Math.round(box?.height ?? 600)),
      scale: Math.min(2, window.devicePixelRatio || 1),
    };
  }, []);

  // One socket per open pane: the view lives exactly as long as the connection,
  // so a closed pane cannot leave a headless page running with nobody looking.
  useEffect(() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws/browser`);
    wsRef.current = ws;

    ws.onopen = () => send({ type: 'open', url: initialUrl ?? 'about:blank', ...measure() });
    ws.onmessage = event => {
      const msg = JSON.parse(event.data as string);
      if (msg.type === 'frame') {
        frameSizeRef.current = { w: msg.width, h: msg.height };
        if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
      } else if (msg.type === 'state') {
        report({ url: msg.url, title: msg.title, canGoBack: msg.canGoBack, canGoForward: msg.canGoForward });
      } else if (msg.type === 'ready') {
        report({ status: 'ready' });
      } else if (msg.type === 'error') {
        report({ status: 'error', error: msg.message });
      }
    };
    ws.onclose = () => {
      if (stateRef.current.status !== 'error') report({ status: 'connecting' });
    };

    return () => { wsRef.current = null; ws.close(); };
    // Mounted once per pane; the URL is re-sent through the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A link clicked in the terminal, or a second click on the same link.
  useEffect(() => {
    if (!initialUrl) return;
    send({ type: 'navigate', url: initialUrl });
  }, [initialUrl, navSeq, send]);

  useEffect(() => {
    commands.current = {
      navigate: (url: string) => send({ type: 'navigate', url }),
      reload: () => send({ type: 'reload' }),
      back: () => send({ type: 'back' }),
      forward: () => send({ type: 'forward' }),
    };
    return () => { commands.current = null; };
  }, [commands, send]);

  // The page is laid out at the pane's own size, so what you see is a page
  // that fits rather than a shrunk photograph of a wider one.
  useEffect(() => {
    const el = surfaceRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      // Chromium re-lays-out and restarts the cast on every resize, so a drag
      // would otherwise send one of those per frame.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => send({ type: 'resize', ...measure() }), 120);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [measure, send]);

  const pointFrom = useCallback((e: React.MouseEvent | React.WheelEvent) => {
    const box = surfaceRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    const { w, h } = frameSizeRef.current;
    const sx = w && box.width ? w / box.width : 1;
    const sy = h && box.height ? h / box.height : 1;
    return { x: Math.round((e.clientX - box.left) * sx), y: Math.round((e.clientY - box.top) * sy) };
  }, []);

  const mouse = useCallback((type: string, e: React.MouseEvent, clickCount = 0) => {
    const { x, y } = pointFrom(e);
    send({
      type: 'input', method: 'Input.dispatchMouseEvent',
      params: {
        type, x, y,
        button: type === 'mouseMoved' ? 'none' : (BUTTONS[e.button] ?? 'left'),
        clickCount, modifiers: modifierBits(e), buttons: e.buttons,
      },
    });
  }, [pointFrom, send]);

  const onKey = useCallback((e: React.KeyboardEvent, down: boolean) => {
    // The page has the keyboard while it is focused — including ⌘R, which
    // should reload the page and not the whole of sheepit.
    e.preventDefault();
    e.stopPropagation();
    const modifiers = modifierBits(e);
    const named = NAMED_KEYS[e.key];
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    send({
      type: 'input', method: 'Input.dispatchKeyEvent',
      params: {
        type: down ? (printable ? 'keyDown' : 'rawKeyDown') : 'keyUp',
        key: e.key, code: e.code, modifiers,
        windowsVirtualKeyCode: named ?? (printable ? e.key.toUpperCase().charCodeAt(0) : e.keyCode),
        nativeVirtualKeyCode: named ?? (printable ? e.key.toUpperCase().charCodeAt(0) : e.keyCode),
        ...(down && printable ? { text: e.key, unmodifiedText: e.key } : {}),
      },
    });
  }, [send]);

  return (
    <div
      ref={surfaceRef}
      className="live-browser-surface"
      tabIndex={0}
      onMouseDown={e => { (e.currentTarget as HTMLElement).focus(); mouse('mousePressed', e, e.detail || 1); }}
      onMouseUp={e => mouse('mouseReleased', e, e.detail || 1)}
      onMouseMove={e => mouse('mouseMoved', e)}
      onContextMenu={e => e.preventDefault()}
      onWheel={e => {
        const { x, y } = pointFrom(e);
        send({
          type: 'input', method: 'Input.dispatchMouseEvent',
          // Inverted, because a wheel event says how far the *content* moved
          // and CDP asks how far the wheel turned.
          params: { type: 'mouseWheel', x, y, deltaX: -e.deltaX, deltaY: -e.deltaY, modifiers: modifierBits(e) },
        });
      }}
      onKeyDown={e => onKey(e, true)}
      onKeyUp={e => onKey(e, false)}
    >
      <img ref={imgRef} className="live-browser-frame" alt="" draggable={false} />
    </div>
  );
}
