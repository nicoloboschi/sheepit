import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { ArrowDown, Upload, GripVertical, Diff, FolderOpen, ScrollText } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import useStore, { activeTerminalSend, activeTerminalRefresh, activePaneCycleView, registerTerminalSend, DEFAULT_FONT_SIZE } from '../store';
import * as sharedWs from '../sharedWs';
import PaneHeader from './PaneHeader';
import VoiceInputButton from './VoiceInputButton';
import StatChips from './StatChips';
import GitDiffPane from './GitDiffPane';
import FilesPane from './FilesPane';

/** Per-pane view — each pane independently shows its terminal, git diff, or
 *  file browser, all scoped to that pane's own session/cwd. Persisted so a
 *  pane reopens on the view you left it on. */
// Unified per-pane view: terminal, the working-tree diff, the file browser, or
// the git log. ('working' replaces the old 'diff'; 'branch'/'commits' are gone.)
// 'split' = terminal on the left + the file browser on the right (resizable).
export type PaneView = 'terminal' | 'split' | 'working' | 'files' | 'log';
const PANE_VIEW_KEY = 'vipershell:pane-views';
function readPaneView(sid: string): PaneView | undefined {
  try {
    const raw = JSON.parse(localStorage.getItem(PANE_VIEW_KEY) || '{}')[sid];
    if (raw === 'diff') return 'working'; // migrate legacy persisted value
    return (['terminal', 'split', 'working', 'files', 'log'] as const).includes(raw) ? raw : undefined;
  } catch { return undefined; }
}
function savePaneView(sid: string, view: PaneView): void {
  try {
    const map = JSON.parse(localStorage.getItem(PANE_VIEW_KEY) || '{}');
    map[sid] = view;
    localStorage.setItem(PANE_VIEW_KEY, JSON.stringify(map));
  } catch { /* quota */ }
}

// Split-mode divider position (terminal width %), persisted per session.
const SPLIT_PCT_KEY = 'vipershell:pane-split-pct';
function readSplitPct(sid: string): number | undefined {
  try {
    const v = JSON.parse(localStorage.getItem(SPLIT_PCT_KEY) || '{}')[sid];
    return typeof v === 'number' ? v : undefined;
  } catch { return undefined; }
}
function saveSplitPct(sid: string, pct: number): void {
  try {
    const map = JSON.parse(localStorage.getItem(SPLIT_PCT_KEY) || '{}');
    map[sid] = pct;
    localStorage.setItem(SPLIT_PCT_KEY, JSON.stringify(map));
  } catch { /* quota */ }
}
import { useDndEnabled } from '../dndEnabled';

// No output filtering needed — direct PTY output is passed through as-is.
// (The old tmux bridge needed alt-screen stripping because tmux attach
// would dump spurious alt-screen transitions. Direct PTY doesn't have that.)

// Match URLs: scheme + domain + optional path/query/fragment (stop at whitespace, quotes, parens, angles, control chars)
const URL_RE = /https?:\/\/[a-zA-Z0-9][-a-zA-Z0-9.]*[a-zA-Z0-9](?::\d+)?(?:\/[^\s"'<>()\x1b\x07\u0007\]{}|\\^`]*)?/g;
const stripAnsi = (s: string) => s.replace(/\x1b(?:\[[0-9;]*[a-zA-Z]|\].*?(?:\x07|\x1b\\))/g, '');

/** Cap on output parked for a hidden pane (see flushOutput). Matches the
 *  daemon's reconnect ring so a revealed pane shows the same tail a reconnect
 *  would replay. */
const MAX_PARKED_OUTPUT = 256 * 1024;

// Convert a `file://` URI (as emitted by Claude Code's OSC 8 hyperlinks) to a
// local filesystem path. Handles the empty-host form `file:///abs/path` and the
// RFC 8089 host form `file://host.local/abs/path` (CC emits both). Returns null
// for any non-`file:` URI so the caller can fall back to opening it externally.
function fileUriToPath(uri: string): string | null {
  if (!/^file:\/\//i.test(uri)) return null;
  let rest = uri.slice(uri.indexOf('//') + 2);
  if (!rest.startsWith('/')) {
    // host form — drop the authority (hostname) up to the first path slash.
    const slash = rest.indexOf('/');
    rest = slash === -1 ? '' : rest.slice(slash);
  }
  try { rest = decodeURIComponent(rest); } catch { /* keep percent-encoded */ }
  return rest || null;
}

const TERMINAL_THEME = {
  background: '#111111', foreground: '#d4d4d8', cursor: '#0074d9', cursorAccent: '#ffffff',
  selectionBackground: 'rgba(0,116,217,0.25)',
  black: '#3B3B3B', brightBlack: '#525252', red: '#F87171', brightRed: '#FCA5A5',
  green: '#4ADE80', brightGreen: '#86EFAC', yellow: '#FACC15', brightYellow: '#FDE68A',
  blue: '#60A5FA', brightBlue: '#93C5FD', magenta: '#C084FC', brightMagenta: '#D8B4FE',
  cyan: '#22D3EE', brightCyan: '#67E8F9', white: '#D4D4D8', brightWhite: '#F4F4F5',
};

interface TerminalCellProps {
  sessionId: string;
  /** Synthetic workspace id this cell belongs to. All panes in the same
   *  workspace share zoom, layout, and lifecycle through this key. It is
   *  NOT equal to any session id — there's no "root pane" concept anymore. */
  gridId: string;
  /** This pane's position within the workspace's `cells` array. Needed so
   *  the drag handle and drop target can identify the pane for swap/move. */
  paneIndex: number;
  isActive: boolean;
  onActivate: () => void;
  /** Remove this pane from its workspace. If it was the last pane, the
   *  workspace dissolves (Android-folder style). */
  onClose: () => void;
}

export default function TerminalCell({ sessionId, gridId, paneIndex, isActive, onActivate, onClose }: TerminalCellProps) {
  // `gridId` holds the synthetic workspace id — zoom is keyed by workspace so
  // every pane sharing a workspace scales together.
  const zoom = useStore(s => s.fontSize);
  const session = useStore(s => s.sessionMap[sessionId]);
  const isMultiPane = useStore(s => {
    const ws = s.workspaces[gridId];
    return !!ws && ws.layout !== 'single' && ws.cells.length > 1;
  });
  const isZen = useStore(s => s.zenSessionId === sessionId);
  const toggleZen = useStore(s => s.toggleZen);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererReadyRef = useRef(false);

  // Per-pane view (terminal / git / files) + a ref the Files view fills in so
  // the git view (and terminal file links) can open a file in this same pane.
  // New panes default to the split view (terminal + file browser); panes with a
  // saved preference reopen on whatever view they were left on.
  const [view, setView] = useState<PaneView>(() => readPaneView(sessionId) ?? 'split');
  const [filesHighlightLine, setFilesHighlightLine] = useState<number | null>(null);
  const openFileRef = useRef<((path: string) => void) | null>(null);
  // Wheel-scroll pacing for full-screen apps (e.g. Claude Code) that coalesce
  // rapid wheel bursts — we queue steps and drain them spaced out (see onWheel).
  const wheelPendingRef = useRef(0);
  const wheelDrainRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Whether the foreground app enabled SGR mouse encoding (DEC private mode 1006).
  // We only synthesize SGR wheel reports (\x1b[<…M) when the app actually asked
  // for that encoding — otherwise the bytes leak into the shell as literal text.
  // Tracked from the output stream in flushOutput.
  const sgrMouseRef = useRef(false);
  // Split mode: terminal occupies this % of the pane width, files takes the rest.
  const [termPct, setTermPct] = useState(() => readSplitPct(sessionId) ?? 60);
  const paneBodyRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => { savePaneView(sessionId, view); }, [view, sessionId]);

  // While this pane is active, the global Cmd+Arrow shortcut cycles ITS view.
  useEffect(() => {
    if (!isActive) return;
    activePaneCycleView.current = (dir: 'left' | 'right') => {
      setView(prev => {
        const order: PaneView[] = ['terminal', 'split', 'working', 'files', 'log'];
        const i = order.indexOf(prev);
        return order[(i + (dir === 'right' ? 1 : -1) + order.length) % order.length]!;
      });
    };
  }, [isActive]);

  // Resolve a path clicked in the terminal (cmd/ctrl+click) against this pane's
  // cwd, then open it in this pane's own Files view.
  const handleFileLink = useCallback(async (rawPath: string) => {
    let cleaned = rawPath;
    let line: number | null = null;
    const colonMatch = cleaned.match(/^(.+?)(?::(\d+)(?::\d+)?)\s*$/);
    const parenMatch = !colonMatch && cleaned.match(/^(.+?)\((\d+)(?:[,:]\d+)?\)\s*$/);
    if (colonMatch) { cleaned = colonMatch[1]!; line = parseInt(colonMatch[2]!, 10); }
    else if (parenMatch) { cleaned = parenMatch[1]!; line = parseInt(parenMatch[2]!, 10); }
    cleaned = cleaned.replace(/[.,;)'">\]]+$/, '');
    let absPath = cleaned;
    if (!cleaned.startsWith('/') && !cleaned.startsWith('~/')) {
      try {
        // Resolve against the live foreground-process cwd (e.g. Claude Code's
        // working directory), so a relative path it printed — `out/foo.mp4` —
        // points at the file IT created, not wherever the shell happens to be.
        const res = await fetch(`/api/fs/${encodeURIComponent(sessionId)}/cwd`);
        const data = await res.json();
        const cwd = (data.cwd as string) ?? '';
        absPath = cwd ? `${cwd}/${cleaned.replace(/^\.\//, '')}` : cleaned;
      } catch { /* use cleaned as-is */ }
    }
    setFilesHighlightLine(line);
    // Open in split view (terminal + files side by side) rather than replacing
    // the whole pane with the Files view — keeps the clicked-from terminal visible.
    setView('split');
    setTimeout(() => openFileRef.current?.(absPath), 80);
  }, [sessionId]);
  const handleFileLinkRef = useRef(handleFileLink);
  handleFileLinkRef.current = handleFileLink;

  /** Safe fit — bails out if container isn't visible or terminal isn't mounted.
   *  Swallows all errors since xterm's async refresh can crash on "dimensions". */
  const safeFit = () => {
    const el = containerRef.current;
    const fit = fitAddonRef.current;
    const t = termRef.current;
    if (!el || !fit || !t) return;
    if (el.clientWidth < 1 || el.clientHeight < 1) return;
    if (!rendererReadyRef.current) return;
    try { fit.fit(); } catch { /* noop */ }
  };
  // wsRef removed — using shared WebSocket singleton
  const sendRef = useRef<(msg: Record<string, unknown>) => void>(() => {});
  const pendingResetRef = useRef(false);
  const mountedRef = useRef(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  /** File-drop state — TerminalCell only handles native file drops via the
   *  HTML5 drag-and-drop API now. Pane drops go through dnd-kit (see
   *  `useDroppable` below) which is a separate event stream and doesn't
   *  collide with this. */
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileDragCountRef = useRef(0);

  // dnd-kit droppable for pane drops. Same-workspace swap is handled in
  // App.tsx onDragEnd. `isOver` drives the overlay visual. Disabled on
  // mobile where all dnd is off.
  const dndEnabled = useDndEnabled();
  const { setNodeRef: setPaneDropRef, isOver: isPaneDragOver } = useDroppable({
    id: `terminal-cell:${gridId}:${paneIndex}`,
    data: { kind: 'terminal-cell', workspaceId: gridId, paneIdx: paneIndex },
    disabled: !dndEnabled,
  });

  // Output batching — accumulate chunks and flush once per animation frame
  const outputBufRef = useRef('');
  const flushRafRef = useRef<number>(0);
  const isRestoringRef = useRef(false);
  // While a snapshot is being replayed on (re)connect, the ring buffer can
  // contain stale terminal QUERIES the app emitted earlier — e.g. a DSR
  // cursor-position request (`\x1b[6n`). Replaying those makes xterm auto-reply
  // via onData with a CPR (`\x1b[<row>;<col>R`); forwarding that reply to the
  // PTY lands as garbage at the shell prompt ("15;3R…") and, with a live TUI
  // that re-queries on redraw, self-sustains into an endless `;3R…` stream.
  // We suppress these replies only for a short window around the replay so live
  // cursor-position queries (vim/less/shell prompt-width detection) still work.
  // (DA replies are always dropped separately in sendInput — no app needs them.)
  const cprGuardUntilRef = useRef(0);

  // Create terminal once
  useEffect(() => {
    const isMobile = window.matchMedia('(max-width: 767px)').matches;
    // Read the current zoom synchronously at mount so the terminal opens at the right size.
    const initialFontSize =
      useStore.getState().fontSize;
    const term = new Terminal({
      cursorBlink: !isMobile,
      fontFamily: '"JetBrains Mono", monospace',
      fontSize: initialFontSize,
      lineHeight: 1.2,
      scrollback: isMobile ? 1000 : 5000,
      theme: TERMINAL_THEME,
      // OSC 8 hyperlinks (Claude Code emits file references as these). A local
      // `file://` link opens in this pane's Files view; anything else opens
      // externally. `allowNonHttpProtocols` is required for `file:` to reach us.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate(_event: MouseEvent, uri: string) {
          const filePath = fileUriToPath(uri);
          if (filePath) { handleFileLinkRef.current(filePath); return; }
          // Real URL scheme (http:, https:, mailto:, …) → open externally.
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) { window.open(uri, '_blank', 'noopener'); return; }
          // Otherwise it's a bare/relative path → resolve against the app's cwd.
          handleFileLinkRef.current(uri);
        },
      },
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon((_: MouseEvent, url: string) => window.open(url, '_blank', 'noopener'));
    term.loadAddon(fit);
    term.loadAddon(links);
    termRef.current = term;
    fitAddonRef.current = fit;

    // Scrollback navigation uses MODIFIER+key (matches gnome-terminal /
    // Terminal.app convention). Plain PageUp/PageDown/Home/End fall through
    // to the shell so things like less, vim, btop, and pagers work normally.
    //   Shift+PageUp / Shift+PageDown   → scroll one page in scrollback
    //   Cmd+PageUp   / Cmd+PageDown     → jump to top / bottom
    //   Shift+Up     / Shift+Down       → scroll one line
    //   Shift+Home   / Shift+End        → jump to top / bottom
    //
    // BUT: when the alternate screen buffer is active (full-screen TUIs like
    // k9s, vim, btop, htop, less), there's no scrollback to scroll — and
    // those apps want every PgUp/PgDn variant for their own navigation. So
    // bypass the scrollback hijack entirely in alt-buffer mode.
    term.attachCustomKeyEventHandler((e: KeyboardEvent) => {
      if (e.type !== 'keydown') return true;
      // Shift+Enter → insert a newline instead of submitting. xterm sends a
      // plain CR ("\r") for both Enter and Shift+Enter, so the program on the
      // other end can't tell them apart. Emit the meta-return sequence
      // (ESC + CR) that Claude Code and other REPLs treat as "insert newline"
      // — the same thing Option+Enter and `claude /terminal-setup` produce.
      // Must run before the alt-buffer bailout so it works inside full-screen
      // TUIs (Claude Code's prompt included).
      if (e.key === 'Enter' && e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
        sendRef.current({ type: 'input', data: '\x1b\r' });
        return false;
      }
      const inAltBuffer = term.buffer.active.type === 'alternate';
      if (inAltBuffer) return true;
      const rows = term.rows || 20;
      if (e.key === 'PageUp' && e.shiftKey) {
        term.scrollLines(-Math.max(1, rows - 1));
        return false;
      }
      if (e.key === 'PageDown' && e.shiftKey) {
        term.scrollLines(Math.max(1, rows - 1));
        return false;
      }
      if (e.key === 'PageUp' && e.metaKey) {
        term.scrollToTop();
        return false;
      }
      if (e.key === 'PageDown' && e.metaKey) {
        term.scrollToBottom();
        return false;
      }
      if (e.shiftKey && e.key === 'ArrowUp') {
        term.scrollLines(-1);
        return false;
      }
      if (e.shiftKey && e.key === 'ArrowDown') {
        term.scrollLines(1);
        return false;
      }
      if (e.shiftKey && e.key === 'Home') {
        term.scrollToTop();
        return false;
      }
      if (e.shiftKey && e.key === 'End') {
        term.scrollToBottom();
        return false;
      }
      return true;
    });

    // Mount — wait until container has dimensions before calling term.open().
    // Sessions can start hidden (display:none in activeVisited cache) and only
    // become visible when the user switches to them. Use a ResizeObserver so
    // we open the terminal the moment the container gets real dimensions —
    // no RAF polling, no giving up after N attempts.
    let disposed = false;
    let opened = false;
    let renderDispose: { dispose: () => void } | null = null;
    let openObserver: ResizeObserver | null = null;

    const tryOpen = () => {
      if (disposed || opened) return;
      const el = containerRef.current;
      if (!el || el.clientWidth < 1 || el.clientHeight < 1) return;
      opened = true;
      openObserver?.disconnect();
      openObserver = null;

      term.open(el);

      renderDispose = term.onRender(() => {
        renderDispose?.dispose();
        rendererReadyRef.current = true;
        requestAnimationFrame(() => {
          if (disposed) return;
          const cur = containerRef.current;
          const f = fitAddonRef.current;
          if (!cur || !f || cur.clientWidth < 1 || cur.clientHeight < 1) return;
          try {
            f.fit();
            const t = termRef.current;
            if (t) sendRef.current({ type: 'resize', cols: t.cols, rows: t.rows });
          } catch { /* noop */ }
        });
      });
      term.write('');
    };

    // Try immediately; if container isn't ready, observe it until it is.
    if (containerRef.current && containerRef.current.clientWidth > 0 && containerRef.current.clientHeight > 0) {
      tryOpen();
    } else if (containerRef.current) {
      openObserver = new ResizeObserver(() => tryOpen());
      openObserver.observe(containerRef.current);
    }

    function sendInput(data: string) {
      // DA replies (\x1b[?…c / \x1b[>…c) are never wanted by the PTY.
      if (/^\x1b\[[\?>][\d;]*c$/.test(data)) return;
      // CPR replies (\x1b[<row>;<col>R, incl. DECXCPR's `?` variant) are dropped
      // only while replaying a reconnect snapshot — see cprGuardUntilRef.
      if (Date.now() < cprGuardUntilRef.current && /^\x1b\[\??\d+;\d+R$/.test(data)) return;
      sendRef.current({ type: 'input', data });
    }

    // On mobile, virtual keyboards (both Android IME and iOS predictive text)
    // cause xterm.js to fire onData with duplicated intermediate text.
    // Fix: on mobile, suppress xterm's onData entirely for printable text and
    // instead monitor the hidden textarea's input events, sending only the
    // actual delta (new characters) to the terminal.
    let mobileIntercepting = false;
    let mobileCleanup: (() => void) | null = null;

    if (isMobile && containerRef.current) {
      const textarea = containerRef.current.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null;
      if (textarea) {
        mobileIntercepting = true;
        let prevValue = '';
        let composing = false;

        const onCompStart = () => { composing = true; };
        const onCompEnd = () => {
          composing = false;
          // After composition ends, the textarea has the committed text.
          // Send only the delta vs what we last sent.
          const cur = textarea.value;
          if (cur.length > prevValue.length) {
            const delta = cur.slice(prevValue.length);
            sendInput(delta);
          }
          prevValue = cur;
        };

        const onInput = () => {
          if (composing) return; // handled by compositionend
          const cur = textarea.value;
          if (cur.length > prevValue.length) {
            const delta = cur.slice(prevValue.length);
            sendInput(delta);
          } else if (cur.length < prevValue.length && prevValue.length > 0) {
            // Deletion — let xterm handle via onData (backspace key events)
          }
          prevValue = cur;
        };

        // Reset tracking when the textarea is cleared (xterm clears it after processing)
        const onSelect = () => { prevValue = textarea.value; };

        textarea.addEventListener('compositionstart', onCompStart);
        textarea.addEventListener('compositionend', onCompEnd);
        textarea.addEventListener('input', onInput);
        textarea.addEventListener('select', onSelect);
        // Periodically sync prevValue in case xterm clears the textarea
        const syncInterval = setInterval(() => {
          if (!composing && textarea.value === '') prevValue = '';
        }, 200);

        mobileCleanup = () => {
          textarea.removeEventListener('compositionstart', onCompStart);
          textarea.removeEventListener('compositionend', onCompEnd);
          textarea.removeEventListener('input', onInput);
          textarea.removeEventListener('select', onSelect);
          clearInterval(syncInterval);
        };
      }
    }

    const dataDispose = term.onData((data: string) => {
      if (mobileIntercepting) {
        // On mobile, only let through control characters (Enter, backspace,
        // arrow keys, etc.) — printable text is handled via input events above.
        const isPrintable = data.length === 1 && data >= ' ' && data <= '~';
        const isMultiChar = data.length > 1 && !data.startsWith('\x1b');
        if (isPrintable || isMultiChar) return;
      }
      sendInput(data);
    });

    // Scroll position tracking — show "jump to bottom" when scrolled up
    const SCROLL_THRESHOLD = 1; // lines from bottom to trigger
    const scrollDispose = term.onScroll(() => {
      const buf = term.buffer.active;
      const linesFromBottom = buf.baseY - buf.viewportY;
      setShowScrollBottom(linesFromBottom > SCROLL_THRESHOLD);
    });

    // Bell — notify user when a background session rings (e.g. Claude Code finished)
    const bellDispose = term.onBell(() => {
      const state = useStore.getState();
      const session = state.sessionMap[sessionId];
      const name = session?.name ?? 'terminal';
      state.markUnseen(sessionId);
      import('../utils').then(({ notify }) => notify('vipershell \u{1F40D}', `${name} needs attention`));
    });

    return () => {
      mobileCleanup?.();
      scrollDispose.dispose();
      dataDispose.dispose();
      bellDispose.dispose();
      disposed = true;
      openObserver?.disconnect();
      renderDispose?.dispose();
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      rendererReadyRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // File link provider — cmd/ctrl+click opens the path in this pane's Files view.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    // Two shapes: (1) anchored paths starting with ~/ ./ ../ or / ; and
    // (2) bare relative paths Claude Code prints — one or more `dir/` segments
    // ending in a `name.ext` (the extension requirement keeps prose like
    // "and/or" or "TCP/IP" from matching). Both resolve via handleFileLink.
    const FILE_RE = /((?:~\/|\.\.?\/|\/(?![\s/]))[\w./\-@~+%:]+|(?:[\w.\-@+%]+\/)+[\w.\-@+%]+\.[A-Za-z0-9]{1,8})/g;
    const provider = term.registerLinkProvider({
      provideLinks(y: number, callback: (links: any[]) => void): void {
        const line = term.buffer.active.getLine(y - 1);
        if (!line) { callback([]); return; }
        const text = line.translateToString();
        const links: any[] = [];
        let match: RegExpExecArray | null;
        FILE_RE.lastIndex = 0;
        while ((match = FILE_RE.exec(text)) !== null) {
          const raw = match[1]!;
          if (raw.includes('://')) continue;
          links.push({
            range: { start: { x: match.index + 1, y }, end: { x: match.index + raw.length, y } },
            text: raw,
            decorations: { underline: true, pointerCursor: true },
            activate(event: MouseEvent, linkText: string) { if (event?.metaKey || event?.ctrlKey) handleFileLinkRef.current(linkText); },
          });
        }
        callback(links);
      },
    });
    return () => provider.dispose();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Flush buffered output to xterm — batched per RAF on desktop, per 150ms timer on mobile
  function flushOutput() {
    flushRafRef.current = 0;
    const batch = outputBufRef.current;
    const t = termRef.current;
    if (!t || !batch) { flushRafRef.current = 0; return; }
    // Don't write until the container has dimensions — xterm's syncScrollArea
    // will crash on 'dimensions' access otherwise.
    //
    // Panes of a workspace that isn't on screen are `display:none`, so they sit
    // at 0×0 for as long as they stay hidden. Park their output and STOP:
    // re-arming a frame here would spin one callback per hidden pane per frame,
    // forever, each forcing a layout read — main-thread work competing with the
    // keystrokes in the pane the user is actually typing into. The
    // ResizeObserver flushes the parked batch the moment the pane is shown.
    const el = containerRef.current;
    if (!el || el.clientWidth < 1 || el.clientHeight < 1) {
      // Bound what a busy hidden pane can park, mirroring the daemon's own
      // reconnect ring: on reveal it shows the tail, same as a reconnect would.
      if (outputBufRef.current.length > MAX_PARKED_OUTPUT) {
        outputBufRef.current = outputBufRef.current.slice(-MAX_PARKED_OUTPUT);
      }
      return;
    }
    // A not-yet-ready renderer IS transient (mount, renderer swap), so retrying
    // next frame is right here.
    if (!rendererReadyRef.current) {
      flushRafRef.current = requestAnimationFrame(flushOutput);
      return;
    }
    outputBufRef.current = '';
    try {
      t.write(batch, () => {
        if (isRestoringRef.current) {
          isRestoringRef.current = false;
          // Wait a frame after write completes so xterm's viewport has
          // laid out the new content, then two more times to guard against
          // additional async rendering (especially in multi-pane grids).
          requestAnimationFrame(() => {
            t.scrollToBottom();
            requestAnimationFrame(() => t.scrollToBottom());
          });
        }
      });
    } catch {
      // Renderer not ready — re-queue the batch
      outputBufRef.current = batch + outputBufRef.current;
      flushRafRef.current = requestAnimationFrame(flushOutput);
      return;
    }
    // Track SGR mouse encoding (DEC private mode 1006) from the stream so the
    // wheel handler only synthesizes SGR wheel reports when the app enabled it.
    // A combined sequence like `\x1b[?1000;1006h` toggles several modes at once.
    if (batch.includes('\x1b[?')) {
      const re = /\x1b\[\?([0-9;]+)([hl])/g;
      let mm: RegExpExecArray | null;
      while ((mm = re.exec(batch)) !== null) {
        if (mm[1]!.split(';').includes('1006')) sgrMouseRef.current = mm[2] === 'h';
      }
    }

    const plain = stripAnsi(batch);
    const urls = plain.match(URL_RE);
    if (urls) {
      const store = useStore.getState();
      for (const url of urls) {
        const clean = url.replace(/[.,;:!?)'"}\]]+$/, '');
        store.addSessionUrl(sessionId, clean);
      }
    }
  }

  function scheduleFlush() {
    if (!flushRafRef.current) {
      flushRafRef.current = requestAnimationFrame(flushOutput);
    }
  }

  // Subscribe to shared WebSocket for this session's output
  useEffect(() => {
    mountedRef.current = true;

    // Send messages tagged with this session's ID
    sendRef.current = (msg: Record<string, unknown>) => {
      sharedWs.send({ ...msg, session_id: sessionId });
    };

    const unregSend = registerTerminalSend(sessionId, (msg) => sendRef.current(msg));

    // Handle session-specific messages (output, connected)
    // Send terminal dimensions with subscribe so server resizes before snapshot
    const term = termRef.current;
    const cols = term?.cols;
    const rows = term?.rows;
    const unsubSession = sharedWs.subscribeSession(sessionId, (msg) => {
      if (!mountedRef.current) return;

      if (msg.type === 'connected') {
        pendingResetRef.current = true;
        isRestoringRef.current = true;
        // Discard any buffered output from before the reset
        outputBufRef.current = '';
        // Suppress CPR auto-replies while the snapshot (which may contain stale
        // \x1b[6n queries) is replayed and parsed by xterm.
        cprGuardUntilRef.current = Date.now() + 1500;
        // No resize needed here — cols/rows were sent with subscribe
      } else if (msg.type === 'output') {
        const term = termRef.current;
        if (!term) return;
        if (pendingResetRef.current) {
          pendingResetRef.current = false;
          term.reset();
        }
        outputBufRef.current += msg.data as string;
        scheduleFlush();
      }
    }, cols, rows);

    // Prepare for incoming snapshot — on WS reconnect the server will
    // re-send connected+snapshot; set pendingReset so old content is cleared
    const unsubGlobal = sharedWs.subscribeGlobal((msg) => {
      if (msg.type === '__ws_open__') {
        pendingResetRef.current = true;
        outputBufRef.current = '';
        cprGuardUntilRef.current = Date.now() + 1500;
      }
    });

    // Fit handled by the ResizeObserver effect — no need to call here

    return () => {
      mountedRef.current = false;
      unregSend();
      unsubSession();
      unsubGlobal();
      if (flushRafRef.current) { cancelAnimationFrame(flushRafRef.current); flushRafRef.current = 0; }
      outputBufRef.current = '';
    };
  }, [sessionId]);

  // Resize handling
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        safeFit();
        const term = termRef.current;
        if (term) sendRef.current({ type: 'resize', cols: term.cols, rows: term.rows });
      }, 80);
    };
    window.addEventListener('resize', handleResize);
    return () => { window.removeEventListener('resize', handleResize); if (timer) clearTimeout(timer); };
  }, []);

  // Apply zoom changes — update font size and refit
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    const target = zoom ?? DEFAULT_FONT_SIZE();
    if (term.options.fontSize === target) return;
    term.options.fontSize = target;
    // Small delay so xterm can measure the new font before fitting
    const id = setTimeout(() => {
      safeFit();
      const t = termRef.current;
      if (t) sendRef.current({ type: 'resize', cols: t.cols, rows: t.rows });
    }, 20);
    return () => clearTimeout(id);
  }, [zoom]);

  // ResizeObserver on container for panel resize (debounced)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let followup: ReturnType<typeof setTimeout> | null = null;
    const doFit = () => {
      safeFit();
      const t = termRef.current;
      if (t) sendRef.current({ type: 'resize', cols: t.cols, rows: t.rows });
    };
    const ro = new ResizeObserver(() => {
      // Going from 0×0 back to a real size means this pane's workspace just
      // became visible — write whatever flushOutput parked while it was hidden.
      if (el.clientWidth > 0 && el.clientHeight > 0 && outputBufRef.current) scheduleFlush();
      if (timer) clearTimeout(timer);
      if (followup) clearTimeout(followup);
      timer = setTimeout(doFit, 50);
      followup = setTimeout(doFit, 200);
    });
    ro.observe(el);
    return () => {
      ro.disconnect();
      if (timer) clearTimeout(timer);
      if (followup) clearTimeout(followup);
    };
  }, []);

  // Focus + scroll to bottom when active + register as target for mobile key bar
  useEffect(() => {
    if (isActive) {
      const t = termRef.current;
      t?.focus();
      t?.scrollToBottom();
      activeTerminalSend.current = (msg) => sendRef.current(msg);
      activeTerminalRefresh.current = () => sendRef.current({ type: 'connect', session_id: sessionId });
    }
  }, [isActive]);

  // Refit + refocus when terminal tab becomes visible again
  useEffect(() => {
    const handler = () => {
      // Fires on every workspace switch (App dispatches it after connecting),
      // so this is the second, RO-independent trigger for output that
      // flushOutput parked while this pane's workspace was hidden.
      if (outputBufRef.current) scheduleFlush();
      if (!isActive) return;
      safeFit();
      termRef.current?.focus();
      const term = termRef.current;
      if (term) sendRef.current({ type: 'resize', cols: term.cols, rows: term.rows });
    };
    window.addEventListener('vipershell:terminal-tab-active', handler);
    return () => window.removeEventListener('vipershell:terminal-tab-active', handler);
  }, [isActive]);

  // Switching this pane back to the terminal view un-hides the xterm container,
  // which had zero size while git/files was showing — refit + refocus so cols/
  // rows match the pane and the PTY is told the new size.
  useEffect(() => {
    if (view !== 'terminal' && view !== 'split') return;
    const id = setTimeout(() => {
      safeFit();
      if (isActive) termRef.current?.focus();
      const term = termRef.current;
      if (term) sendRef.current({ type: 'resize', cols: term.cols, rows: term.rows });
    }, 60);
    return () => clearTimeout(id);
  }, [view, isActive]); // eslint-disable-line react-hooks/exhaustive-deps

  // Drag the divider between the terminal and the files panel (split mode).
  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const body = paneBodyRef.current;
    if (!body) return;
    const onMove = (ev: MouseEvent) => {
      const rect = body.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setTermPct(Math.min(80, Math.max(20, pct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      safeFit();
      const t = termRef.current;
      if (t) sendRef.current({ type: 'resize', cols: t.cols, rows: t.rows });
      // Persist once on release (not during the drag) to avoid localStorage churn.
      setTermPct(pct => { saveSplitPct(sessionId, pct); return pct; });
    };
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sessionId]);

  // Refit when entering/exiting zen mode — the container dimensions change
  // dramatically so we need to recalculate cols/rows and tell the PTY.
  //
  // Do NOT re-subscribe / replay the ring-buffer snapshot here. Resizing the
  // PTY makes the running app redraw its live frame at the new width, so the
  // ring buffer ends up holding BOTH the old narrow-width rendering and the
  // new wide-width redraw. Replaying that into a reset terminal renders the
  // block twice (narrow copy + wide copy) because the old frame's cursor-up/
  // erase sequences were computed for narrow wrapping and no longer line up.
  // Instead, let xterm reflow its existing buffer on resize and let the app's
  // natural SIGWINCH repaint stream in — cursor math lines up at the new width.
  useEffect(() => {
    // Two frames: one for layout, one for fit after xterm's renderer catches up
    const id1 = requestAnimationFrame(() => {
      const id2 = requestAnimationFrame(() => {
        safeFit();
        const t = termRef.current;
        if (t) {
          sendRef.current({ type: 'resize', cols: t.cols, rows: t.rows });
          t.focus();
        }
      });
      (window as any).__zenRafId = id2;
    });
    return () => {
      cancelAnimationFrame(id1);
      const id2 = (window as any).__zenRafId;
      if (id2) cancelAnimationFrame(id2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isZen]);

  // Touch scroll with momentum (iOS-style inertial scrolling)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let startX = 0, startY = 0, lastTouchY = 0, lastTouchTime = 0;
    let accPx = 0, totalDy = 0;
    let isTouchScrolling = false, directionLocked = false;
    let velocity = 0;
    let momentumRaf = 0;

    const stopMomentum = () => {
      if (momentumRaf) { cancelAnimationFrame(momentumRaf); momentumRaf = 0; }
      velocity = 0;
    };

    // Paced drain of queued wheel steps → SGR mouse-wheel reports (see onWheel).
    const startAltDrain = () => {
      if (wheelDrainRef.current) return;
      wheelDrainRef.current = setInterval(() => {
        const t = termRef.current;
        // Re-check the gate every tick: an app may disable mouse mode mid-drain,
        // and we must NOT keep firing wheel reports into a plain shell prompt.
        // Codex keeps its TUI in the normal buffer, so alternate-buffer state
        // is not a reliable part of this gate.
        if (!t || t.modes?.mouseTrackingMode === 'none' || !sgrMouseRef.current
            || wheelPendingRef.current === 0) {
          if (wheelDrainRef.current) clearInterval(wheelDrainRef.current);
          wheelDrainRef.current = null; wheelPendingRef.current = 0;
          return;
        }
        const dir = wheelPendingRef.current < 0 ? -1 : 1;
        wheelPendingRef.current -= dir;
        sendRef.current({ type: 'input', data: `\x1b[<${dir < 0 ? 64 : 65};1;1M` });
      }, 25);
    };

    // Route a line-delta (positive = scroll down) to the right mechanism, shared
    // by wheel AND touch. In the alternate screen (full-screen TUIs like Claude
    // Code) there is no scrollback, so we translate the delta into paced SGR
    // mouse-wheel reports the app understands — this is what lets touch scroll
    // full-screen apps on mobile, matching the wheel on desktop. In the normal
    // buffer we scroll xterm's own scrollback. Returns false when an alt-screen
    // app isn't accepting wheel input (nothing scrolled).
    const scrollBy = (lines: number): boolean => {
      const t = termRef.current;
      if (!t || lines === 0) return false;
      // Mouse tracking is the authoritative signal that the application owns
      // wheel input. Codex is a normal-buffer TUI, while Claude Code uses the
      // alternate buffer; both request SGR wheel reports.
      if (t.modes?.mouseTrackingMode !== 'none' && sgrMouseRef.current) {
        const MAX = t.rows ?? 20; // at most ~one screen queued
        wheelPendingRef.current = Math.max(-MAX, Math.min(MAX, wheelPendingRef.current + lines));
        startAltDrain();
        return true;
      }
      t.scrollLines(lines);
      return true;
    };

    const onTouchStart = (e: TouchEvent): void => {
      stopMomentum();
      startX = e.touches[0]!.clientX;
      startY = e.touches[0]!.clientY;
      lastTouchY = startY;
      lastTouchTime = Date.now();
      accPx = 0; totalDy = 0;
      isTouchScrolling = false; directionLocked = false; velocity = 0;
    };
    const onTouchMove = (e: TouchEvent): void => {
      const term = termRef.current;
      if (!term) return;
      const now = Date.now();
      const x = e.touches[0]!.clientX;
      const y = e.touches[0]!.clientY;
      const dy = lastTouchY - y;
      const dt = Math.max(1, now - lastTouchTime);

      // Lock direction after a few pixels of movement
      if (!directionLocked) {
        const adx = Math.abs(x - startX);
        const ady = Math.abs(y - startY);
        if (adx + ady > 5) {
          directionLocked = true;
          isTouchScrolling = ady > adx; // vertical = scroll, horizontal = let xterm handle
        }
      }

      if (!isTouchScrolling) return;

      // Always prevent default once we've decided to scroll —
      // this stops xterm from doing text selection or its own scroll
      e.preventDefault();
      e.stopPropagation();

      // Track velocity (px/ms) with smoothing
      velocity = 0.6 * velocity + 0.4 * (dy / dt);

      lastTouchY = y;
      lastTouchTime = now;
      totalDy += dy;
      accPx += dy;
      const lineH = (term.options?.fontSize ?? 14) * (term.options?.lineHeight ?? 1.2);
      const lines = Math.trunc(accPx / lineH);
      if (lines !== 0) {
        accPx -= lines * lineH;
        scrollBy(lines);
      }
    };
    const onTouchEnd = (): void => {
      if (!isTouchScrolling) { velocity = 0; return; }
      isTouchScrolling = false;

      // Only animate momentum if velocity is significant
      if (Math.abs(velocity) < 0.3) { velocity = 0; return; }

      const term = termRef.current;
      if (!term) return;
      const lineH = (term.options?.fontSize ?? 14) * (term.options?.lineHeight ?? 1.2);
      let v = velocity * 16; // convert px/ms to px/frame (~16ms)
      let residual = 0;
      const FRICTION = 0.95;
      const MIN_V = 0.5;

      const tick = () => {
        if (Math.abs(v) < MIN_V) { velocity = 0; return; }
        residual += v;
        const lines = Math.trunc(residual / lineH);
        if (lines !== 0) {
          residual -= lines * lineH;
          if (!scrollBy(lines)) { velocity = 0; return; }
        }
        v *= FRICTION;
        momentumRaf = requestAnimationFrame(tick);
      };
      momentumRaf = requestAnimationFrame(tick);
    };
    const onWheel = (e: WheelEvent): void => {
      const term = termRef.current;
      if (!term) return;
      const lineH = (term.options?.fontSize ?? 14) * (term.options?.lineHeight ?? 1.2);
      let lines: number;
      if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        lines = Math.round(e.deltaY);
      } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        lines = Math.round(e.deltaY * (term.rows ?? 20));
      } else {
        lines = Math.round(e.deltaY / lineH);
      }
      if (lines === 0) return;

      if (term.modes?.mouseTrackingMode !== 'none' && sgrMouseRef.current) {
        // TUIs that drive mouse tracking (Codex, Claude Code, vim, btop, …)
        // scroll on mouse-wheel events. scrollBy PACES them (accumulate + drain
        // one every ~25ms) so a coalesced burst still registers as real
        // multi-line scrolling. Bail (letting nothing happen) if the app isn't
        // accepting wheel input — same gate scrollBy applies internally.
        e.preventDefault(); e.stopPropagation();
        // Cap lines per wheel event so wildly-varying deltaY isn't hyper-sensitive;
        // the paced drain + accumulation still let a fast flick scroll far.
        const PER_EVENT = 3;
        scrollBy((lines < 0 ? -1 : 1) * Math.min(Math.abs(lines), PER_EVENT));
        return;
      }

      // Normal shell scrollback is managed by xterm's own viewport wheel
      // handler. Let it receive the native event: manually calling
      // scrollLines from this capture-phase handler can race its viewport
      // scroll bookkeeping and leave the canvas rows out of order after a
      // few wheel bursts. The custom path above is only for applications that
      // explicitly enabled SGR mouse tracking.
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true, capture: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false, capture: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true, capture: true });
    el.addEventListener('wheel', onWheel, { passive: false, capture: true });

    return () => {
      stopMomentum();
      if (wheelDrainRef.current) { clearInterval(wheelDrainRef.current); wheelDrainRef.current = null; }
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchmove', onTouchMove, { capture: true });
      el.removeEventListener('touchend', onTouchEnd, { capture: true });
      el.removeEventListener('wheel', onWheel, { capture: true });
    };
  }, []);

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setFileDragOver(false);
    fileDragCountRef.current = 0;

    // Only files are handled here — pane drops come through dnd-kit and
    // resolve in App.tsx's onDragEnd.
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // Get session CWD
    let cwd = '/tmp';
    try {
      const res = await fetch(`/api/fs/${encodeURIComponent(sessionId)}/browse`);
      const data = await res.json();
      if (data.cwd) cwd = data.cwd;
    } catch { /* fallback to /tmp */ }

    // Upload each file and type the path
    const paths: string[] = [];
    for (const file of files) {
      try {
        const res = await fetch(`/api/fs/upload?dir=${encodeURIComponent(cwd)}&name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file,
        });
        const { ok, path } = await res.json();
        if (ok && path) paths.push(path);
      } catch { /* skip failed uploads */ }
    }

    // Type the paths into the terminal (space-separated, shell-escaped)
    if (paths.length > 0) {
      const escaped = paths.map(p => p.includes(' ') ? `"${p}"` : p).join(' ');
      sendRef.current({ type: 'input', data: escaped });
    }
  }

  return (
    <>
      {/* Zen backdrop — dims everything behind the pane */}
      {isZen && (
        <div
          style={{
            position: 'fixed', inset: 0, zIndex: 999,
            background: 'radial-gradient(ellipse at center, rgba(0,10,25,0.92) 0%, rgba(0,0,0,0.98) 100%)',
            backdropFilter: 'blur(8px)',
            animation: 'zen-enter 0.2s ease-out',
          }}
          onClick={() => toggleZen(sessionId)}
        />
      )}
      <div
        ref={setPaneDropRef}
        className={isZen ? '' : 'flex-1 min-h-0 min-w-0'}
        style={{
          position: isZen ? 'fixed' : 'relative',
          ...(isZen ? {
            inset: '40px',
            zIndex: 1000,
            borderRadius: 4,
            padding: 2,
            background: 'linear-gradient(135deg, rgba(0,116,217,0.7) 0%, rgba(0,146,150,0.7) 100%)',
            boxShadow: '0 0 80px rgba(0,116,217,0.35), 0 0 160px rgba(0,146,150,0.15), 0 20px 60px rgba(0,0,0,0.6)',
            animation: 'zen-enter 0.25s ease-out',
          } : {}),
          display: 'flex', flexDirection: 'column',
          background: isZen ? undefined : '#0c0c0c',
          overflow: 'hidden',
          outline: (fileDragOver || isPaneDragOver)
            ? '2px solid var(--primary)'
            : isMultiPane && isActive
              ? '1.5px solid var(--primary)'
              : 'none',
          boxShadow: !isZen && isMultiPane && isActive && !fileDragOver && !isPaneDragOver
            ? '0 0 20px rgba(0,116,217,0.25), inset 0 0 20px rgba(0,116,217,0.05)'
            : 'none',
          opacity: !isZen && isMultiPane && !isActive ? 0.45 : 1,
          transition: 'outline 0.15s ease, box-shadow 0.15s ease, opacity 0.15s ease',
        }}
        onClick={onActivate}
        // mousedown with capture — runs before xterm's own handler so we
        // always register the focus change even when xterm stops propagation.
        onMouseDownCapture={onActivate}
        // Native HTML5 drag events ONLY handle external file drops now.
        // Pane drags are intercepted by dnd-kit (useDroppable above), which
        // operates on a separate event stream and doesn't fire dragenter/over/drop.
        onDragEnter={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault();
            fileDragCountRef.current++;
            setFileDragOver(true);
          }
        }}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) e.preventDefault();
        }}
        onDragLeave={() => {
          fileDragCountRef.current--;
          if (fileDragCountRef.current <= 0) { setFileDragOver(false); fileDragCountRef.current = 0; }
        }}
        onDrop={handleDrop}
      >
      {/* Inner wrapper — in zen mode, gives the rounded dark card look */}
      <div style={{
        position: 'relative',
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        background: '#0a0a0a',
        borderRadius: isZen ? 4 : 0,
        overflow: 'hidden',
      }}>
      {/* Per-pane header — identity, stats, zen toggle, close. Rendered in
          zen too, since the zen exit button lives in this header. */}
      <PaneHeader
        sessionId={sessionId}
        workspaceId={gridId}
        paneIndex={paneIndex}
        isActive={isActive}
        isGridRoot={sessionId === gridId}
        onClose={onClose}
        view={view}
        onViewChange={setView}
      />
      {/* Terminal surface — own relative container so absolute-positioned
          .terminal-pane fills only this area (below the header), and the
          active-pane / drag overlays sit on top of the terminal only. */}
      <div ref={paneBodyRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* Terminal view — kept mounted (display toggled) so xterm preserves its
          scrollback while git/files is showing. In 'split' it shares the row
          with the file browser on the right, separated by a resizable handle. */}
      <div style={{ position: 'absolute', inset: 0, display: (view === 'terminal' || view === 'split') ? 'flex' : 'none', flexDirection: 'row' }}>
      {/* Terminal column — full width normally, fixed % in split. */}
      <div style={{ position: 'relative', minWidth: 0, overflow: 'hidden', ...(view === 'split' ? { width: `${termPct}%`, flexShrink: 0 } : { flex: 1 }) }}>
      <div
        ref={containerRef}
        className="terminal-pane"
      />
      {(isPaneDragOver || fileDragOver) && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(13,17,23,0.85)',
          pointerEvents: 'none',
        }}>
          <div style={{
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8,
            color: 'var(--primary)', fontSize: 13, fontWeight: 600,
          }}>
            {isPaneDragOver ? (
              <>
                <GripVertical size={28} />
                Drop to swap panes
              </>
            ) : (
              <>
                <Upload size={28} />
                Drop to upload
              </>
            )}
          </div>
        </div>
      )}
      {showScrollBottom && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            termRef.current?.scrollToBottom();
            setShowScrollBottom(false);
          }}
          style={{
            position: 'absolute',
            bottom: 16,
            left: '50%',
            transform: 'translateX(-50%)',
            zIndex: 10,
            display: 'flex',
            alignItems: 'center',
            gap: 5,
            padding: '6px 14px',
            borderRadius: 20,
            border: '1px solid var(--border)',
            background: 'rgba(22, 27, 34, 0.92)',
            backdropFilter: 'blur(8px)',
            color: 'var(--foreground)',
            fontSize: 11,
            cursor: 'pointer',
            boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
            transition: 'border-color 0.15s',
            animation: 'fade-in 0.15s ease',
          }}
          onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)'; }}
        >
          <ArrowDown size={12} />
          Jump to bottom
        </button>
      )}
      </div>{/* /terminal column */}

      {/* Split mode: resizable divider + the file browser on the right. */}
      {view === 'split' && (
        <>
          <div
            onMouseDown={startSplitDrag}
            className="terminal-resize-handle terminal-resize-handle-horizontal"
            style={{ width: 6, flexShrink: 0, cursor: 'col-resize', background: '#161b22' }}
          />
          <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#0a0a0a' }}>
            <FilesPane
              sessionId={sessionId}
              openFileRef={openFileRef}
              onFileSelect={() => setFilesHighlightLine(null)}
              highlightLine={filesHighlightLine}
            />
          </div>
        </>
      )}
      </div>{/* /terminal+split row */}

      {/* Unified Git view — Working tree / Files / Git log, sharing one sub-
          switcher. Scoped to this pane's session; mounted on demand. */}
      {view !== 'terminal' && view !== 'split' && (
        <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0a0a0a' }}>
          {/* Sub-switcher — the grouped Working / Files / Git Log tabs, full width. */}
          <div
            style={{ display: 'flex', alignItems: 'center', padding: '5px 8px', borderBottom: '1px solid #222222', background: '#0d1117', flexShrink: 0 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ display: 'flex', width: '100%', border: '1px solid #222222', borderRadius: 6, overflow: 'hidden' }}>
              {([
                { id: 'working', icon: <Diff size={11} />,       label: 'Working tree' },
                { id: 'files',   icon: <FolderOpen size={11} />, label: 'Files' },
                { id: 'log',     icon: <ScrollText size={11} />, label: 'Git log' },
              ] as const).map(({ id, icon, label }) => (
                <button
                  key={id}
                  onClick={() => setView(id)}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                    flex: 1, fontSize: 11, padding: '4px 9px',
                    background: view === id ? '#1f6feb' : 'none',
                    color: view === id ? '#fff' : '#737373',
                    border: 'none', borderRight: id !== 'log' ? '1px solid #222222' : 'none',
                    cursor: 'pointer',
                  }}
                >
                  {icon}{label}
                </button>
              ))}
            </div>
          </div>

          {/* Active panel */}
          <div style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
            {(view === 'working' || view === 'log') && (
              <GitDiffPane
                sessionId={sessionId}
                mode={view === 'log' ? 'log' : 'head'}
                onOpenFile={(path: string) => { setView('files'); setTimeout(() => openFileRef.current?.(path), 60); }}
              />
            )}
            {view === 'files' && (
              <FilesPane
                sessionId={sessionId}
                openFileRef={openFileRef}
                onFileSelect={() => setFilesHighlightLine(null)}
                highlightLine={filesHighlightLine}
              />
            )}
          </div>
        </div>
      )}
      {/* Active pane border overlay — at the pane-body level so it outlines the
          WHOLE pane (terminal + files in split view, or the git/files panel),
          making it clear a split is still a single pane. */}
      {isMultiPane && isActive && !isPaneDragOver && !fileDragOver && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 15,
          borderRadius: 2,
          boxShadow: '0 0 0 1.5px var(--primary), 0 0 14px rgba(0,116,217,0.35)',
          pointerEvents: 'none',
          transition: 'box-shadow 0.15s ease',
        }} />
      )}
      </div>{/* /pane body */}
      <div className="pane-footer-bar" onClick={e => e.stopPropagation()}>
        {isActive && <VoiceInputButton sessionId={sessionId} />}
        <StatChips sessionId={sessionId} send={sharedWs.send} />
        <div className="pane-footer-identity">
          <span className="pane-footer-name">{session?.name ?? 'Terminal'}</span>
          {session?.path && <span className="pane-footer-path" title={session.path}>{session.path.replace(/^\/Users\/[^/]+/, '~')}</span>}
        </div>
      </div>
      </div>{/* /inner wrapper */}
      </div>{/* /outer wrapper */}
    </>
  );
}
