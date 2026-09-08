import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * A real browser, running on the machine, drawn into this pane.
 *
 * The frames come from Chromium's screencast over `/ws/browser` and the input
 * goes back as CDP's own `Input.*` events — the DOM event a mouse or a key
 * produces already carries what CDP wants, so it is passed along rather than
 * translated into a private vocabulary and back.
 *
 * It is not a tab strip — one pane is one page, because the pane is already
 * the unit you arrange things in. And it is a *surface*, not a pane:
 * `PreviewPane` owns the address bar, the history buttons and the port chips,
 * and this fills in `commands` so they can drive the page.
 */

const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 };

function modifierBits(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
  return (e.altKey ? MODIFIERS.alt : 0) | (e.ctrlKey ? MODIFIERS.ctrl : 0)
    | (e.metaKey ? MODIFIERS.meta : 0) | (e.shiftKey ? MODIFIERS.shift : 0);
}

const BUTTONS = ['left', 'middle', 'right'] as const;

/** The keys that only ever modify another key.
 *
 *  These must never be cancelled. Holding Option is the *first half* of typing
 *  `@` on an Italian layout, and cancelling that keydown tells the OS the
 *  application has taken the key — so the input method never starts composing,
 *  the `ò` that follows never becomes a character, and the whole chord falls
 *  through to the browser's shortcuts. The symptom is a key that vanishes: the
 *  Alt keydown arrives, and nothing else does. */
const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Shift', 'Control', 'Meta', 'CapsLock', 'Dead', 'Process']);

/** The cursors a page may ask this pane to show. An allowlist, because the
 *  value arrives from the page being viewed and `cursor` accepts `url(...)` —
 *  which would have a page nobody vouched for fetching an image through the
 *  viewer's own browser. Every keyword CSS defines is here; anything else
 *  becomes the default. */
/** Does this keystroke make text? Anything one character long that is not a
 *  chord — including everything ⌥ composes. Those are typed into the sink and
 *  arrive as an `input` event; everything else (Enter, Tab, arrows, Escape,
 *  function keys, and any ⌘/⌃ chord) is a key the page should see as a key. */
function producesText(e: KeyboardEvent): boolean {
  if (e.metaKey || e.ctrlKey) return false;
  return e.key.length === 1 || e.key === 'Process' || e.key === 'Unidentified' || e.key === 'Dead';
}

const CURSORS = new Set([
  'auto', 'default', 'none', 'context-menu', 'help', 'pointer', 'progress', 'wait',
  'cell', 'crosshair', 'text', 'vertical-text', 'alias', 'copy', 'move', 'no-drop',
  'not-allowed', 'grab', 'grabbing', 'all-scroll', 'col-resize', 'row-resize',
  'n-resize', 'e-resize', 's-resize', 'w-resize', 'ne-resize', 'nw-resize',
  'se-resize', 'sw-resize', 'ew-resize', 'ns-resize', 'nesw-resize', 'nwse-resize',
  'zoom-in', 'zoom-out',
]);

function safeCursor(value: string): string {
  const first = value.split(',').pop()?.trim() ?? '';
  return CURSORS.has(first) ? first : 'default';
}

/** Which button a *move* is carrying, read from the `buttons` bitmask rather
 *  than from `button` — which is 0 (meaning "left") on every mousemove, held
 *  or not. Chromium decides a move is a drag from this: sent as 'none', a
 *  press-move-release reads as a hover with a click at each end, which is why
 *  selecting text with the mouse did nothing at all. */
function heldButton(buttons: number): 'none' | 'left' | 'middle' | 'right' {
  if (buttons & 1) return 'left';
  if (buttons & 2) return 'right';
  if (buttons & 4) return 'middle';
  return 'none';
}

/** Virtual key codes for the keys a browser event may report as 0 — an IME
 *  commit, a synthetic event. Everything else uses the event's own `keyCode`,
 *  which IS the Windows virtual key code CDP wants (190 for `.`, 188 for `,`),
 *  and is the only correct source for it.
 *
 *  Deriving one instead — `key.toUpperCase().charCodeAt(0)` — is right for
 *  letters and digits and wrong for punctuation, in a way that does damage
 *  rather than nothing: `.` became 46, which is VK_DELETE, so typing a full
 *  stop sent Chromium a Delete carrying the text ".". */
const FALLBACK_KEYS: Record<string, number> = {
  Backspace: 8, Tab: 9, Enter: 13, Escape: 27, ' ': 32,
  PageUp: 33, PageDown: 34, End: 35, Home: 36,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Insert: 45, Delete: 46,
};

/** Keys that are not a character but still carry text into the page. Enter is
 *  the one that matters: without `text`, Chromium raises a keydown and never
 *  the keypress that submits a form or sends a message, so Enter appeared to
 *  do nothing at all. */
const KEY_TEXT: Record<string, string> = { Enter: '\r', NumpadEnter: '\r' };

export interface LiveBrowserState {
  url: string; title: string; canGoBack: boolean; canGoForward: boolean;
  /** The page's own answer, from `Page.frameStartedLoading` on its main frame
   *  — not a guess from the last navigate we sent, which would miss every link
   *  the page followed by itself. */
  loading: boolean;
  status: 'connecting' | 'ready' | 'error';
  error: string | null;
  /** Whether frames are flowing. Normally true for every open pane — each gets
   *  its own browser window, so they all composite at once — and false only
   *  when the browser refused to cast this one. */
  streaming: boolean;
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
  /**
   * Where the keyboard actually goes — an invisible textarea, the same trick
   * xterm uses, and for the same reason.
   *
   * Focus a plain `<div>` and there is no *text input context*, so macOS never
   * runs the input method: `@` on an Italian layout is ⌥ò, and the composition
   * that turns those two into a character only happens when something editable
   * is focused. Without it the raw ⌥+key falls through to the application's
   * accelerators — Brave switched tab, and the character was never typed. Dead
   * keys, IME candidates and the emoji picker were all lost the same way.
   *
   * So the character arrives here as an `input` event, already composed, and
   * is sent as text. Keys that are not text — Enter, Tab, arrows, shortcuts —
   * are still forwarded as key events from `keydown`.
   */
  const keySinkRef = useRef<HTMLTextAreaElement | null>(null);
  // TEMPORARY: which instance is speaking, and whether it is the same one
  // across a keystroke. A remount here destroys a composition in flight.
  const whoRef = useRef(Math.random().toString(36).slice(2, 6));
  // TEMPORARY: does the whole WINDOW lose focus? `same element: true` on a
  // blur is that signature — when a window blurs, document.activeElement keeps
  // its value — and it would explain a keystroke that produces a macOS beep
  // and reaches no listener at all.
  useEffect(() => {
    const onWin = (e: Event) => {
      // eslint-disable-next-line no-console
      console.log('[sheepit window]', e.type, '| document.hasFocus():', document.hasFocus(),
        '| activeElement:', (document.activeElement as HTMLElement | null)?.className || document.activeElement?.tagName);
    };
    window.addEventListener('blur', onWin);
    window.addEventListener('focus', onWin);
    return () => {
      window.removeEventListener('blur', onWin);
      window.removeEventListener('focus', onWin);
    };
  }, []);

  useEffect(() => {
    const who = whoRef.current;
    // eslint-disable-next-line no-console
    console.log('[sheepit surface] MOUNTED', who, '— live surfaces now:', document.querySelectorAll('.live-browser-key-sink').length + 1);
    return () => { console.log('[sheepit surface] UNMOUNTED', who); }; // eslint-disable-line no-console
  }, []);
  const imgRef = useRef<HTMLImageElement | null>(null);
  // The last frame's own size, so a click maps correctly even in the moment
  // between a resize and the first frame that is actually the new size.
  const frameSizeRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
  const onStateRef = useRef(onState);
  onStateRef.current = onState;
  const stateRef = useRef<LiveBrowserState>({
    url: initialUrl ?? '', title: '', canGoBack: false, canGoForward: false,
    loading: false, status: 'connecting', error: null, streaming: false,
  });
  const [paused, setPaused] = useState(false);
  const [cursor, setCursor] = useState('default');
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

  /** The page is laid out at exactly this box, so a size measured before the
   *  pane had one — or a resize that happened while the socket was still
   *  connecting, which `send` drops on the floor — leaves the page rendering
   *  to the wrong height for good. Re-send it once the view exists. */
  const syncSize = useCallback(() => send({ type: 'resize', ...measure() }), [measure, send]);

  // The page this pane is on, kept in a ref so a reconnect can ask for it
  // again. `initialUrl` is where it started; `state.url` is wherever the page
  // has walked to since.
  const urlRef = useRef<string | null>(initialUrl ?? null);
  urlRef.current = (stateRef.current.url && stateRef.current.url !== 'about:blank')
    ? stateRef.current.url
    : (initialUrl ?? urlRef.current);

  // One socket per open pane: the view lives exactly as long as the connection,
  // so a closed pane cannot leave a headless page running with nobody looking.
  //
  // And it RECONNECTS. The backend restarts — on a deploy, on a code change in
  // dev — and every restart took every browser pane with it: the socket closed,
  // nothing reopened it, and the pane sat on its last frame (or on nothing at
  // all, which is a black rectangle) until the whole page was reloaded. The
  // terminal panes have always come back on their own; this one has to as well.
  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let attempt = 0;
    let stopped = false;

    const connect = () => {
      if (stopped) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/browser`);
      socket = ws;
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0;
        // The view is a new one on the server — the old one died with the old
        // process — so it is opened on the page this pane was already showing.
        send({ type: 'open', url: urlRef.current ?? 'about:blank', ...measure() });
      };
      ws.onmessage = event => {
        const msg = JSON.parse(event.data as string);
        if (msg.type === 'frame') {
          frameSizeRef.current = { w: msg.width, h: msg.height };
          if (imgRef.current) imgRef.current.src = `data:image/jpeg;base64,${msg.data}`;
        } else if (msg.type === 'state') {
          report({
            url: msg.url, title: msg.title, loading: Boolean(msg.loading),
            canGoBack: msg.canGoBack, canGoForward: msg.canGoForward,
          });
        } else if (msg.type === 'active') {
          setPaused(!msg.active);
          report({ streaming: Boolean(msg.active) });
        } else if (msg.type === 'ready') {
          report({ status: 'ready' });
          // The box is certainly laid out by now; the one sent with `open` may
          // have been measured before the split had settled.
          syncSize();
        } else if (msg.type === 'cursor') {
          setCursor(safeCursor(String(msg.cursor ?? 'default')));
        } else if (msg.type === 'copied') {
          const resolve = copyReplyRef.current.get(msg.id);
          if (resolve) { copyReplyRef.current.delete(msg.id); resolve(String(msg.text ?? '')); }
        } else if (msg.type === 'error') {
          report({ status: 'error', error: msg.message });
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        if (stateRef.current.status !== 'error') report({ status: 'connecting' });
        // Backing off rather than hammering: a backend that is restarting takes
        // a second or two, and one that is gone for good should not be asked
        // twenty times a second.
        const wait = Math.min(5000, 400 * 2 ** attempt++);
        retry = setTimeout(connect, wait);
      };
    };

    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      wsRef.current = null;
      socket?.close();
    };
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
      timer = setTimeout(syncSize, 120);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (timer) clearTimeout(timer); };
  }, [syncSize]);

  /** Nudge the browser to activate this view's window. Needed once, because a
   *  target that has never been activated will not start casting; after that
   *  it is a no-op and panes do not compete for it. Not sent on mousemove —
   *  there is nothing to win, and it would be a message per pointer sample. */
  const claim = useCallback(() => {
    if (!stateRef.current.streaming) {
      send({ type: 'focus', scale: Math.min(2, window.devicePixelRatio || 1) });
    }
  }, [send]);

  const pointFrom = useCallback((e: React.MouseEvent | React.WheelEvent | MouseEvent) => {
    const box = surfaceRef.current?.getBoundingClientRect();
    if (!box) return { x: 0, y: 0 };
    const { w, h } = frameSizeRef.current;
    const sx = w && box.width ? w / box.width : 1;
    const sy = h && box.height ? h / box.height : 1;
    return { x: Math.round((e.clientX - box.left) * sx), y: Math.round((e.clientY - box.top) * sy) };
  }, []);

  const mouse = useCallback((type: string, e: React.MouseEvent | MouseEvent, clickCount = 0) => {
    const { x, y } = pointFrom(e);
    send({
      type: 'input', method: 'Input.dispatchMouseEvent',
      params: {
        type, x, y,
        button: type === 'mouseMoved' ? heldButton(e.buttons) : (BUTTONS[e.button] ?? 'left'),
        clickCount, modifiers: modifierBits(e), buttons: e.buttons,
      },
    });
  }, [pointFrom, send]);

  // A selection does not stop at the edge of the pane: you press inside, drag
  // past it, and let go somewhere else entirely. React's handlers only fire
  // over this element, so the drag is followed on the window instead — without
  // this, leaving the pane mid-selection left the page believing the button
  // was still down.
  const draggingRef = useRef(false);
  /** Whether the pointer is over this pane, so a focus that fell off nothing
   *  can be handed back to the pane the user is actually looking at. */
  const hoveringRef = useRef(false);
  useEffect(() => {
    const move = (e: MouseEvent) => { if (draggingRef.current) mouse('mouseMoved', e); };
    const up = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      draggingRef.current = false;
      mouse('mouseReleased', e, e.detail || 1);
    };
    window.addEventListener('mousemove', move, true);
    window.addEventListener('mouseup', up, true);
    return () => {
      window.removeEventListener('mousemove', move, true);
      window.removeEventListener('mouseup', up, true);
    };
  }, [mouse]);

  /** ⌘C / ⌘X / ⌘V, which have to be handled here rather than forwarded.
   *
   *  The page's own copy works — into the *browser's* clipboard, on the host,
   *  where nothing on this machine can reach it. So a copy asks the server what
   *  is selected and writes that to the clipboard in front of you, inside the
   *  keydown, which is the gesture the browser requires for a clipboard write.
   *  A paste is the mirror: read this machine's clipboard and have the page
   *  type it, since the page pasting would read the wrong clipboard.
   *
   *  Cut is copy plus the keystroke: the page still has to remove the text. */
  const copyReplyRef = useRef(new Map<number, (text: string) => void>());
  const copyIdRef = useRef(1);
  const askForSelection = useCallback(() => new Promise<string>(resolve => {
    const id = copyIdRef.current++;
    copyReplyRef.current.set(id, resolve);
    send({ type: 'copy', id });
    // A page that never answers must not leave the clipboard promise hanging.
    setTimeout(() => {
      if (copyReplyRef.current.delete(id)) resolve('');
    }, 1500);
  }), [send]);

  const clipboard = useCallback(async (e: KeyboardEvent): Promise<boolean> => {
    const accel = e.metaKey || e.ctrlKey;
    if (!accel || e.altKey) return false;
    const key = e.key.toLowerCase();
    if (key === 'c' || key === 'x') {
      const text = await askForSelection();
      if (text) { try { await navigator.clipboard.writeText(text); } catch { /* denied */ } }
      // Cut still needs the page to do the removing.
      return key === 'c';
    }
    // ⌘V is deliberately NOT handled here: the sink is a real text field, so
    // the browser pastes into it and the `input` event forwards the text. That
    // needs no clipboard permission and works with what the OS pasted.
    return false;
  }, [askForSelection, send]);

  const onKey = useCallback((e: KeyboardEvent, down: boolean) => {
    // TEMPORARY, for diagnosing a key that never arrives: a modifier chord is
    // rare enough to log, and whether a line appears at all is the whole
    // question. Remove once ⌥ò is settled.
    // eslint-disable-next-line no-console
    console.log('[sheepit key]', down ? 'down' : 'up  ',
      JSON.stringify({ key: e.key, code: e.code, alt: e.altKey, keyCode: e.keyCode, composing: e.isComposing }),
      'focus:', (document.activeElement as HTMLElement | null)?.className || document.activeElement?.tagName);
    // Anything the input method is in the middle of composing belongs to it.
    if (e.isComposing || e.keyCode === 229) return;

    // A modifier on its own is forwarded but never cancelled — see
    // MODIFIER_KEYS. The page still learns the modifier is down, because every
    // event carries the modifier bits with it.
    if (MODIFIER_KEYS.has(e.key)) { forwardKey(e, down); return; }

    // Copy and paste are this machine's, not the page's, and are settled before
    // anything is forwarded.
    if (down && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      e.stopPropagation();
      void clipboard(e).then(handled => { if (!handled) forwardKey(e, true); });
      return;
    }

    // A character the keyboard composed with Option/AltGr — `@` is ⌥ò on an
    // Italian layout — is taken here, deliberately, and marked handled.
    //
    // Chromium hands a key event the renderer did NOT handle back to the
    // browser for accelerator processing. Left alone, ⌥ò reached the sink,
    // was not inserted as text, bounced back, and Brave ran its own shortcut
    // with it. `preventDefault` is what says "handled", and the character is
    // already composed in `e.key` — macOS did that part — so it goes straight
    // in as text.
    if (e.altKey && !e.metaKey && !e.ctrlKey && e.key.length === 1) {
      e.preventDefault();
      e.stopPropagation();
      if (down) send({ type: 'input', method: 'Input.insertText', params: { text: e.key } });
      return;
    }

    // Everything else that produces text is left alone: it types into the sink
    // and the `input` event sends it, which is the only path a dead key or an
    // IME candidate can take — cancelling those stops the character ever
    // existing.
    if (producesText(e)) return;

    e.preventDefault();
    e.stopPropagation();
    forwardKey(e, down);
  }, [clipboard]); // eslint-disable-line react-hooks/exhaustive-deps

  const forwardKey = useCallback((e: KeyboardEvent, down: boolean) => {
    // Text never comes through here any more — see `producesText` — so what is
    // left is keys, and only Enter still carries text with it.
    const printable = false;
    const text = printable ? e.key : KEY_TEXT[e.key];
    // The event's own keyCode is the virtual key code; the table is only for
    // the events that report 0.
    const vk = e.keyCode || FALLBACK_KEYS[e.key] || 0;
    send({
      type: 'input', method: 'Input.dispatchKeyEvent',
      params: {
        // `keyDown` when there is text to insert, `rawKeyDown` otherwise —
        // this is the distinction that decides whether a keypress is raised.
        type: down ? (text ? 'keyDown' : 'rawKeyDown') : 'keyUp',
        key: e.key, code: e.code, modifiers: modifierBits(e),
        windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk,
        ...(down && text ? { text, unmodifiedText: text } : {}),
        // Numpad and left/right modifiers: the page can tell them apart, and a
        // shortcut bound to one of them should not fire for the other.
        ...(e.location ? { location: e.location } : {}),
        ...(e.repeat ? { autoRepeat: true } : {}),
      },
    });
  }, [send]);

  /**
   * The keyboard, taken at the window in the capture phase rather than on this
   * element.
   *
   * A page can only stop a browser shortcut it sees first. Handled on the
   * element, the event has already travelled through the window by the time
   * `preventDefault` runs, and a viewing browser with its own binding acts on
   * it anyway — Brave maps `@` (Option+ò on an Italian layout) to Back, so
   * typing an email address in the pane navigated sheepit backwards. Capturing
   * at the window is the earliest a page is allowed to look, and from there the
   * key belongs to the pane.
   *
   * Only while this surface holds focus, so the address bar, ⌘K and every
   * other part of sheepit keep their own keys.
   */
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    // Attached only while the surface is focused, rather than always-on with a
    // check inside. Same effect, but a window-level capture listener that
    // swallows keys is exactly the kind of thing that gets blamed for a
    // keystroke going missing somewhere else in the app — so while you are not
    // in a browser pane, it is not there at all.
    if (!focused) return;
    // TEMPORARY: the earliest a page can see anything. If ⌥ò logs here but not
    // in onKey, our guard is dropping it; if it logs nowhere, the browser took
    // it before the page.
    const edge = (e: KeyboardEvent) => {
      // eslint-disable-next-line no-console
      console.log('[sheepit edge]', e.type, JSON.stringify({ key: e.key, code: e.code, alt: e.altKey }));
    };
    document.addEventListener('keydown', edge, true);
    document.addEventListener('keyup', edge, true);
    // What the sink itself sees, which is the only thing that proves the OS
    // composed the character rather than handing the chord to the browser.
    const typed = (e: Event) => {
      // eslint-disable-next-line no-console
      console.log('[sheepit sink]', e.type, JSON.stringify((e as InputEvent).data ?? (e.target as HTMLTextAreaElement).value));
    };
    keySinkRef.current?.addEventListener('beforeinput', typed);
    keySinkRef.current?.addEventListener('compositionstart', typed);
    keySinkRef.current?.addEventListener('compositionend', typed);
    const handle = (down: boolean) => (e: KeyboardEvent) => {
      if (document.activeElement !== keySinkRef.current) return;
      onKey(e, down);
    };
    const down = handle(true);
    const up = handle(false);
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    const sink = keySinkRef.current;
    return () => {
      sink?.removeEventListener('beforeinput', typed);
      sink?.removeEventListener('compositionstart', typed);
      sink?.removeEventListener('compositionend', typed);
      document.removeEventListener('keyup', edge, true);
      document.removeEventListener('keydown', edge, true);
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
    };
  }, [focused, onKey]);

  return (
    <div
      ref={surfaceRef}
      className="live-browser-surface"
      style={{ cursor }}
      onMouseDown={e => {
        // Cancel the default first. A mousedown's default action moves focus to
        // whatever was clicked — and this div is not focusable — so it would
        // take the focus straight back out of the sink we are about to give it
        // to, leaving a pane where the mouse works and nothing can be typed.
        // It also stops the drag from selecting the pane's own image.
        e.preventDefault();
        // Focus the text sink, not this div: that is what gives the keyboard a
        // text input context, and what makes the input method compose.
        keySinkRef.current?.focus({ preventScroll: true });
        claim();
        draggingRef.current = true;
        mouse('mousePressed', e, e.detail || 1);
      }}
      // Release and drag are followed on the window (see above); this element
      // only has to report the moves that happen while no button is down.
      onMouseMove={e => { if (!draggingRef.current) mouse('mouseMoved', e); }}
      onMouseLeave={() => { hoveringRef.current = false; }}
      onContextMenu={e => e.preventDefault()}
      onMouseEnter={() => {
        hoveringRef.current = true;
        // Nothing steals focus on hover — but if the pane already had it and
        // something took it (a re-render, a dialog closing), coming back to the
        // pane should put the keyboard back where the eyes are.
        if (focused && document.activeElement !== keySinkRef.current) {
          keySinkRef.current?.focus({ preventScroll: true });
        }
      }}
      onWheel={e => {
        claim();
        const { x, y } = pointFrom(e);
        send({
          type: 'input', method: 'Input.dispatchMouseEvent',
          // Passed through, not negated: CDP's mouseWheel uses the same sign
          // convention as a DOM wheel event — positive deltaY scrolls down in
          // both. Flipping it here (on the theory that one measures content and
          // the other the wheel) inverted scrolling in the pane.
          params: { type: 'mouseWheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY, modifiers: modifierBits(e) },
        });
      }}

    >
      <img ref={imgRef} className="live-browser-frame" alt="" draggable={false} />
      {/* The keyboard's real destination. Invisible, one pixel, and never
          holding anything: whatever lands in it is sent to the page and wiped,
          so it can never disagree with what the page is showing. */}
      <textarea
        ref={keySinkRef}
        className="live-browser-key-sink"
        aria-label="Browser keyboard input"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onFocus={() => {
          // eslint-disable-next-line no-console
          console.log('[sheepit focus]', whoRef.current);
          setFocused(true); claim();
        }}
        onBlur={() => {
          // Focus that goes *nowhere* — to the body, or to nothing at all — is
          // not somebody choosing another control; it is the pane dropping the
          // keyboard, and the next keystroke would go to the browser as a
          // shortcut instead of into the page. Take it back.
          const next = document.activeElement;
          const wentNowhere = !next || next === document.body;
          // A blur caused by JS shows a stack; a blur caused by the OS or the
          // window losing focus shows only the event dispatch.
          console.trace('[sheepit blur stack]'); // eslint-disable-line no-console
          // eslint-disable-next-line no-console
          console.log('[sheepit blur]', whoRef.current, 'focus went to:',
            (next as HTMLElement | null)?.className || next?.tagName || 'nothing',
            '| same element:', next === keySinkRef.current,
            '| sinks on page:', document.querySelectorAll('.live-browser-key-sink').length);
          if (wentNowhere && hoveringRef.current) {
            keySinkRef.current?.focus({ preventScroll: true });
            return;
          }
          setFocused(false);
        }}
        onInput={e => {
          const el = e.currentTarget;
          const text = el.value;
          el.value = '';
          if (text) send({ type: 'input', method: 'Input.insertText', params: { text } });
        }}
      />
      {/* A still page with no explanation reads as a hang. The browser can only
          cast one tab, so say which state this one is in. */}
      {paused && <div className="live-browser-paused">Not streaming — click to retry</div>}
    </div>
  );
}
