import { useCallback, useEffect, useRef, useState, useMemo, memo, Profiler } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import { WebLinksAddon } from 'xterm-addon-web-links';
import { ArrowDown, Upload, GripVertical, Diff, ScrollText, Github, FolderTree, Globe, TerminalSquare, Bot } from 'lucide-react';
import { useDroppable } from '@dnd-kit/core';
import { useShallow } from 'zustand/react/shallow';
import useStore, { activeTerminalSend, activeTerminalRefresh, activePaneCycleView, registerTerminalSend, DEFAULT_FONT_SIZE } from '../store';
import * as sharedWs from '../sharedWs';
import { perf } from '../perf';
import PaneHeader from './PaneHeader';
import { openExternal } from '../openExternal';
import { findFileLinks } from '../utils';
import GitDiffPane from './GitDiffPane';
import GithubPane, { type GhRef } from './GithubPane';
import TerminalTiles from './TerminalTiles';
import FilesPane from './FilesPane';
import PreviewPane from './PreviewPane';
import AgentPane from './AgentPane';
import SheepitPane from './SheepitPane';
import SheepIcon from './SheepIcon';
import { TERMINAL_THEMES, TERMINAL_LINE_HEIGHT } from '../theme';
import type { AppTheme } from '../theme';

/**
 * Answer OSC 10/11 colour queries ("what is your foreground/background?").
 *
 * TUIs like Claude Code pick their own palette from the terminal's reported
 * background — that is how they decide whether to draw a light or dark input
 * box. xterm.js does not answer these queries on its own, and sheepit never
 * told the PTY anything about the theme (the spawn env is just TERM=
 * xterm-256color, with no COLORFGBG). So an app assumed dark, drew a dark box
 * with grey text, and in light mode that came out unreadable.
 *
 * Answering the query is better than exporting COLORFGBG at spawn: it is read
 * at query time, so it stays correct for sessions that were already running
 * when the theme changed.
 */
function registerColorQueryHandlers(
  term: Terminal,
  getTheme: () => AppTheme,
  reply: (data: string) => void,
): void {
  // OSC responses use 16-bit-per-channel hex: rgb:RRRR/GGGG/BBBB.
  const toOscColor = (hex: string): string | null => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const v = m[1]!;
    const dup = (i: number) => (v.slice(i, i + 2) + v.slice(i, i + 2)).toLowerCase();
    return `rgb:${dup(0)}/${dup(2)}/${dup(4)}`;
  };

  const answer = (osc: 10 | 11) => (data: string): boolean => {
    // Only a query ("?") gets a reply; a set request is left to xterm.
    if (data !== '?') return false;
    const palette = TERMINAL_THEMES[getTheme()];
    const colour = toOscColor((osc === 11 ? palette.background : palette.foreground) ?? '');
    // BEL-terminated, which is the form every consumer accepts.
    if (colour) reply(`\x1b]${osc};${colour}\x07`);
    return true;
  };

  term.parser.registerOscHandler(10, answer(10));
  term.parser.registerOscHandler(11, answer(11));
}

/**
 * Swap xterm's default DOM renderer for the WebGL one.
 *
 * xterm 5.x renders to DOM nodes unless a renderer addon is loaded — roughly a
 * node per cell, re-laid-out on every frame. That is survivable on a desktop
 * and painful in an Android WebView, where a repainting TUI (Claude Code,
 * btop, vim) drops frames badly.
 *
 * Loaded after term.open() because the addon needs a rendered element to
 * attach its canvas to. Failure is non-fatal on purpose: some WebViews and VMs
 * have no usable WebGL context, and a lost context can be reported later at
 * runtime (GPU reset, app backgrounded). In both cases we dispose the addon
 * and xterm silently falls back to the DOM renderer — slower, but correct.
 */
function enableWebglRenderer(term: Terminal, onReady: (addon: WebglLike) => void): void {
  void import('xterm-addon-webgl').then(({ WebglAddon }) => {
    try {
      const addon = new WebglAddon();
      // Guarded: the terminal may already be tearing down, and disposing twice
      // walks into the same torn-down RenderService described below.
      addon.onContextLoss(() => { try { addon.dispose(); } catch { /* already gone */ } });
      term.loadAddon(addon);
      onReady(addon);
    } catch {
      /* No WebGL here — stay on the DOM renderer. */
    }
  }).catch(() => { /* chunk failed to load; DOM renderer still works */ });
}

/** Minimal shape we need; avoids importing the addon type eagerly.
 *
 *  `clearTextureAtlas` is optional because the DOM renderer has no addon at
 *  all — every caller has to cope with there being nothing to clear. */
interface WebglLike { dispose(): void; clearTextureAtlas?(): void }

/** Per-pane view — each pane independently shows its terminal, git diff, or
 *  file browser, all scoped to that pane's own session/cwd. Persisted so a
 *  pane reopens on the view you left it on. */
/**
 * What one pane is showing.
 *
 *   terminal      the terminal, alone
 *   split-preview terminal + the embedded browser
 *   split-github  terminal + pull requests and issues
 *   working       terminal + the working-tree diff
 *   log           terminal + the commit log
 *   split         terminal + the file browser
 *
 * **Nothing is ever shown alone, and the terminal is never hidden**, which is
 * why there is no 'files' or 'preview' in this union any more. Reading a file,
 * a diff or a dev server is something you do *while* working in the terminal —
 * a pane that gave the whole width to one of them had hidden the thing the
 * pane is for.
 *
 * Everything but `terminal` is **one group behind one rail** (`TOOL_TABS`):
 * GitHub, the working tree, the log, the files and the browser. `terminal`
 * means the tools are hidden; the pane bar's one button toggles them, and
 * reopens the tool that was showing last. `split` keeps its name — it is the
 * oldest of them and the persisted value.
 */
export type PaneView = 'terminal' | 'split' | 'split-preview' | 'split-github' | 'working' | 'log' | 'split-terminals' | 'split-agent' | 'split-sheepit';
const PANE_VIEW_KEY = 'sheepit:pane-views';
// `showsTerminal()` used to live here, answering "does xterm have a size right
// now". Every view keeps the terminal since the git group became a split, so
// the honest answer was always `true` — and a predicate that cannot say no is
// one every reader has to check for themselves before trusting a branch on it.
function readPaneView(sid: string): PaneView | undefined {
  try {
    const raw = JSON.parse(preferences.getItem(PANE_VIEW_KEY) || '{}')[sid];
    if (raw === 'diff') return 'working';           // legacy persisted value
    // The two views that used to take the whole pane now only exist beside the
    // terminal, so a pane persisted in one of them opens in the split it means.
    if (raw === 'files') return 'split';
    if (raw === 'preview') return 'split-preview';
    // GitHub took the whole pane for one release, and now sits beside the
    // terminal like the other two things you read while typing.
    if (raw === 'github') return 'split-github';
    return (['terminal', 'split', 'split-preview', 'split-github', 'working', 'log', 'split-terminals', 'split-agent', 'split-sheepit'] as const).includes(raw) ? raw : undefined;
  } catch { return undefined; }
}
/** The git family's tabs, as a rail rather than a strip. Vertical because the
 *  GitHub view now sits in half a pane: four labelled buttons across the top
 *  of a 400px column is most of that column, while a 28px rail down its edge
 *  costs the diff nothing. GitHub leads it — reviewing is what you come here
 *  to do, and the working tree is one click away.
 *
 *  **The file browser is the last of them**, and it is here rather than in the
 *  pane bar's switch because it answers the same question the other three do —
 *  what is in this repository — and you move between a diff and the file it
 *  changed constantly. On the rail that is one click that does not change the
 *  pane's shape; as a separate top-level view it was a different half-pane
 *  arriving in place of the one you were reading. It is last because it is the
 *  only one that is not about a change.
 *
 *  **The browser is a tab here too.** There is no view switch on the pane bar
 *  any more, only a button that shows or hides this whole group — so every
 *  thing a pane can show beside its terminal is one rail. */
const TOOL_TABS = [
  { id: 'split-github' as const, Icon: Github,     label: 'GitHub — pull requests and issues' },
  { id: 'working' as const,      Icon: Diff,       label: 'Working tree' },
  { id: 'log' as const,          Icon: ScrollText, label: 'Git log' },
  { id: 'split' as const,        Icon: FolderTree, label: 'Files' },
  { id: 'split-preview' as const, Icon: Globe,     label: 'Browser' },
  // Last, after the browser. A shell beside the agent is the thing you reach
  // for *while* it works — `npm test`, a log tail, a git command you want to
  // run yourself — and it is the only tool here that is not a way of looking
  // at something. See SideTerminals.
  { id: 'split-terminals' as const, Icon: TerminalSquare, label: 'Terminals — shells in this pane\u2019s directory' },
  // After the tools, because it is not one: the other six are ways of looking
  // at the repository or of acting on it, and this is the pane's own history —
  // what you have asked the agent, read back from the agent's own transcript.
  { id: 'split-agent' as const, Icon: Bot, label: 'Agent — what you have asked this pane' },
  // Last, and the only tab that is about sheepit rather than about the work:
  // the pane's own id, the pen holding it, the files on disk behind it. The
  // sheep is the right mark for exactly that reason — everything else on this
  // rail is somebody else's icon because it is somebody else's thing.
  { id: 'split-sheepit' as const, Icon: SheepIcon, label: 'sheepit — this pane\u2019s own ids and paths' },
];

function ToolRail({ view, onPick }: { view: PaneView; onPick: (v: PaneView) => void }) {
  return (
    <div
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 4px',
        borderRight: '1px solid var(--border)', background: 'var(--secondary)', flexShrink: 0,
      }}
    >
      {TOOL_TABS.map(({ id, Icon, label }) => (
        <button
          key={id}
          title={label}
          onClick={() => onPick(id)}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            width: 30, height: 30, borderRadius: 6, border: 'none', cursor: 'pointer',
            background: view === id ? 'var(--primary)' : 'none',
            color: view === id ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
          }}
        >
          <Icon size={16} />
        </button>
      ))}
    </div>
  );
}

/**
 * The shells that stand beside one pane, in that pane's Terminals split.
 *
 * They are the pane's own: opened in its directory (the server takes the cwd
 * from the owning session, which OSC 7 keeps current), headless so they never
 * get a pen of their own, and closed along with the pane. That is the whole
 * difference from the global scratch shells in the Terminals panel, which
 * belong to nobody and outlive every pane — `sideOf` is what separates them,
 * and both lists filter on it so neither offers to close the other's.
 *
 * This is the *side terminal* that was deliberately given up when pens lost
 * their grid. The thing that was actually wanted there was never two panes
 * side by side; it was a shell next to the agent, in the same repository, and
 * that belongs inside the pane beside the browser and the git views rather
 * than as a second pane in the sidebar.
 */
function SideTerminals({ sessionId }: { sessionId: string }) {
  const ids = useStore(useShallow(
    (s: { sessions: { id: string; sideOf?: string }[] }) =>
      s.sessions.filter(x => x.sideOf === sessionId).map(x => x.id),
  ));
  const add = useCallback(() => {
    // No path: the server uses the owning pane's cwd, which is the point. A
    // path from here would be this tab's idea of it, and OSC 7 has moved it
    // since more often than not.
    sharedWs.send({ type: 'create_session', side_of: sessionId });
  }, [sessionId]);

  return (
    <TerminalTiles
      ids={ids}
      max={MAX_SIDE_TERMINALS}
      onAdd={add}
      emptyLabel="Open a terminal here"
      addLabel="Another terminal in this pane"
    />
  );
}

/** Mirrors `MAX_SIDE_TERMINALS` in `src/protocol.ts`, where it is enforced —
 *  the server is the only side that can count without racing. Per pane, not
 *  global: twenty panes with four apiece would be eighty shells. */
const MAX_SIDE_TERMINALS = 4;

function savePaneView(sid: string, view: PaneView): void {
  try {
    const map = JSON.parse(preferences.getItem(PANE_VIEW_KEY) || '{}');
    map[sid] = view;
    preferences.setItem(PANE_VIEW_KEY, JSON.stringify(map));
  } catch { /* quota */ }
}

// Split-mode divider position (terminal width %), persisted per session.
const SPLIT_PCT_KEY = 'sheepit:pane-split-pct';
function readSplitPct(sid: string): number | undefined {
  try {
    const v = JSON.parse(preferences.getItem(SPLIT_PCT_KEY) || '{}')[sid];
    return typeof v === 'number' ? v : undefined;
  } catch { return undefined; }
}
function saveSplitPct(sid: string, pct: number): void {
  try {
    const map = JSON.parse(preferences.getItem(SPLIT_PCT_KEY) || '{}');
    map[sid] = pct;
    preferences.setItem(SPLIT_PCT_KEY, JSON.stringify(map));
  } catch { /* quota */ }
}
import { useDndEnabled } from '../dndEnabled';
import { preferences } from '../preferences';
import { isNarrowScreen } from '../platform';
import NativePane, { readPaneMode, writePaneMode, subscribePaneMode } from './NativePane';

// No output filtering needed — direct PTY output is passed through as-is.
// (The old tmux bridge needed alt-screen stripping because tmux attach
// would dump spurious alt-screen transitions. Direct PTY doesn't have that.)

// Nothing here reads the output as text any more. A URL scanner used to run
// over every batch to collect links (and, from them, the pane's PR number);
// it matched only what arrived contiguous in one chunk, so a TUI agent that
// wraps or redraws its own output defeated it, and the list died with the tab.
// PR and issue references now come from the agent's hooks — see src/pr-refs.ts.

/** Cap on output parked for a hidden pane (see flushOutput). Matches the
 *  daemon's reconnect ring so a revealed pane shows the same tail a reconnect
 *  would replay. */
const MAX_PARKED_OUTPUT = 256 * 1024;

/** Some terminal apps (notably Codex's composer) paint their own controls with
 * truecolor black/white rather than ANSI palette entries. In Light mode those
 * exact extremes become unreadable, so remap only the near-extreme SGR values.
 * Everything else, including app branding and syntax colours, passes through. */
function makeLightTruecolorReadable(data: string): string {
  // ISO 8613-6's colon form is common in Claude Code's Ink renderer. Normalize
  // it to the equivalent semicolon form so the palette handling below is shared.
  const normalized = data.replace(
    /\x1b\[([\d;]*)(38|48):2(?::)?:(\d+):(\d+):(\d+)m/g,
    (_whole, prefix: string, kind: string, red: string, green: string, blue: string) =>
      `\x1b[${prefix}${kind};2;${red};${green};${blue}m`,
  );
  return normalized.replace(/\x1b\[([\d;]*)m/g, (whole, sequence: string) => {
    const codes = sequence.split(';');
    let changed = false;
    for (let i = 0; i < codes.length; i++) {
      // Claude's composer also uses the basic black background / the dark end
      // of the 256-colour grayscale ramp. On a light terminal they are UI
      // surfaces, not semantic colours, so make them the terminal white.
      if (codes[i] === '40') { codes[i] = '107'; changed = true; continue; }
      if (codes[i] === '48' && codes[i + 1] === '5') {
        const index = Number(codes[i + 2]);
        if (index === 0 || (index >= 232 && index <= 245)) {
          codes[i + 2] = '231'; changed = true;
        }
        i += 2;
        continue;
      }
      const kind = codes[i];
      if ((kind !== '38' && kind !== '48') || codes[i + 1] !== '2' || i + 4 >= codes.length) continue;
      const red = Number(codes[i + 2]);
      const green = Number(codes[i + 3]);
      const blue = Number(codes[i + 4]);
      if (![red, green, blue].every(Number.isFinite)) continue;
      const brightness = (red * 299 + green * 587 + blue * 114) / 1000;
      if (kind === '48' && brightness < 48) {
        codes.splice(i + 2, 3, '255', '255', '255'); changed = true;
      } else if (kind === '38' && brightness > 235) {
        codes.splice(i + 2, 3, '31', '41', '55'); changed = true;
      }
      i += 4;
    }
    return changed ? `\x1b[${codes.join(';')}m` : whole;
  });
}

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

interface TerminalCellProps {
  sessionId: string;
  /** Synthetic workspace id this cell belongs to. All panes in the same
   *  workspace share zoom and lifecycle through this key. It is NOT equal to
   *  any session id — there's no "root pane" concept anymore. */
  gridId: string;
  /** This pane's position within the pen's `cells` array. Needed so the drag
   *  handle and drop target can identify the pane for move/reorder. */
  paneIndex: number;
  /** Drawn as the selected pane. Every tile passes this, since a tile is
   *  always the only thing in its box — which is why the things that are
   *  genuinely global (the ⌘←/→ view cycle, the mobile key bar's target) are
   *  gated on `isActive && !tile` rather than on `isActive` alone. Four tiles
   *  each claiming to be the active pane is four writers to one slot. */
  isActive: boolean;
  /** This is one tile of a `TerminalTiles` grid — a scratch shell or a side
   *  terminal — rather than a pane standing in a pen.
   *
   *  **A tile has no tools at all.** No rail, no toggle in its bar, no view but
   *  the terminal. The tools are for the work: you read a diff against the
   *  agent that wrote it, you open the files of the repository it is changing.
   *  A scratch shell is not that — it is somewhere to type a command while the
   *  work happens elsewhere, it is a few hundred pixels wide, and it already
   *  sits inside a pane that has all six tools of its own. Git in a tile would
   *  be a second opinion about the same repository in a quarter of the space.
   *
   *  It also persists no view (these come and go, and `sheepit:pane-views`
   *  would fill with the ids of shells that no longer exist), and it never
   *  claims the global active-pane registries — see `isActive` below. */
  tile?: boolean;
  /**
   * Both take the pane's own index rather than closing over it.
   *
   * That is what lets this component be memoised at all: a parent writing
   * `onActivate={() => setActiveCell(i)}` builds a new function on every render,
   * so every mounted pane in the pen re-rendered whenever the grid did —
   * measured at 25ms of every second in `commit:pane`. Handed the index, the
   * parent can pass one `useCallback` to all of them.
   */
  onActivate: (index: number) => void;
  /** Remove this pane from its workspace. If it was the last pane, the
   *  workspace dissolves (Android-folder style). */
  onClose: (index: number) => void;
}

/** What one commit of a pane's tool split costs. Separated from `commit:pane`
 *  because a 147ms pane commit says nothing about *which half* — the terminal
 *  and its chrome, or the diff / files / browser beside it. */
const recordSplitCommit = (id: string, _phase: string, actualDuration: number): void => {
  perf.commit(id, actualDuration);
};

function TerminalCellInner({ sessionId, gridId, paneIndex, isActive, tile = false, onActivate, onClose }: TerminalCellProps) {
  // Bound to this pane's index once, so the handlers below are stable and the
  // parent can hand every pane the same two callbacks.
  const activate = useCallback(() => onActivate(paneIndex), [onActivate, paneIndex]);
  const close = useCallback(() => onClose(paneIndex), [onClose, paneIndex]);
  // Every pane in the shown pen stays mounted, so this count is how many of
  // them React re-rendered. A number far above the pane count per second is a
  // render loop, which is invisible in a frame graph and obvious here.
  perf.count('render:TerminalCell');
  // `gridId` holds the synthetic workspace id — zoom is keyed by workspace so
  // every pane sharing a workspace scales together.
  const zoom = useStore(s => s.fontSize);
  const fontFamily = useStore(s => s.terminalFontFamily);
  const theme = useStore(s => s.theme);
  const termRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rendererReadyRef = useRef(false);
  /** The WebGL renderer, when there is one. Held here and not just in the
   *  mount effect because a font-family change has to reach into it — see the
   *  font effect below. */
  const webglRef = useRef<WebglLike | null>(null);

  // Per-pane view (terminal / git / files) + a ref the Files view fills in so
  // the git view can open a file in this same pane.
  // New panes default to the split view (terminal + file browser); panes with a
  // saved preference reopen on whatever view they were left on.
  // **A phone opens on the terminal, alone, and remembers nothing.**
  //
  // `sheepit:pane-views` lives in the shared profile, so the phone was opening
  // whatever split the desktop last had out — and a split halves a screen that
  // is 390px wide to begin with, which is most of the reason the app felt
  // cramped. It was also most of the reason it felt slow: measured in the APK,
  // `commit:split:split-agent` alone was 9.1 of `commit:pane`'s 10.3 ms/sec,
  // for a tool nobody on that device had asked for.
  //
  // So a narrow screen neither reads the saved view nor writes one, exactly as
  // a tile does not (see above). The rail is still there and a tool opened on
  // the phone stays open while you are in it; what does not happen is one
  // device choosing the other's layout. A second storage key would buy a
  // remembered tool across app launches, which is not what a phone is for.
  const narrow = tile || isNarrowScreen();
  const [view, setView] = useState<PaneView>(() => (narrow ? 'terminal' : readPaneView(sessionId) ?? 'split'));

  /** Claude Code drawn as a conversation rather than as a terminal.
   *
   *  **One setting for the whole app, not one per pane.** "Do I read panes as
   *  a terminal or as a conversation" is a way of looking, like a zoom level —
   *  so having chosen it, every pane you move to should keep it, and a toggle
   *  that had to be flipped again on arrival would be a toggle nobody uses.
   *
   *  **Device-local, so it is not in the profile.** That profile is shared by
   *  every browser looking at this machine, and the answer here genuinely
   *  differs between a phone (where a TUI in 390px is a hard read) and a
   *  laptop. See DEVICE_LOCAL in preferences.ts.
   *
   *  A tile is a scratch shell and is never offered this, so it is never on
   *  for one however the preference is set.
   *
   *  The terminal stays mounted underneath (see the style below): switching
   *  back is instant, the scrollback is intact, and the PTY never knew. */
  const [paneMode, setPaneMode] = useState(readPaneMode);
  const toggleNative = useCallback(() => {
    setPaneMode(m => { const next = m === 'native' ? 'terminal' : 'native'; writePaneMode(next); return next; });
  }, []);
  // Another pane in this window just flipped it — follow, so the app is in one
  // mode rather than in as many modes as it has mounted panes.
  useEffect(() => subscribePaneMode(setPaneMode), []);
  /** Only a Claude Code pane is offered the native view; see the pane bar. */
  const isClaudeCode = useStore(s => !!s.sessionMap[sessionId]?.isClaudeCode);
  /** **Whether this pane CAN show the conversation, not just whether the
   *  device prefers it.** The preference is global — it is the one setting
   *  that makes switching panes keep the view — but the view itself only works
   *  where there is a Claude Code transcript to read. Deriving it rather than
   *  storing it is what keeps the two from disagreeing: stored, a shell pane
   *  showed the chat *and* was not offered the button that turns it off, which
   *  is a pane with no terminal and no way back to one.
   *
   *  Derived also means it follows the pane: an agent started in a shell a
   *  minute from now flips this on by itself, and a `/exit` flips it back. */
  const nativeOn = !tile && isClaudeCode && paneMode === 'native';
  /** Set when the browser is opened on a file from the tree; null when it is
   *  opened from the switch, where the address bar starts empty. */
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  /** Counts openings, not URLs — see handleWebLink. */
  const [previewNav, setPreviewNav] = useState(0);
  /** The PR or issue the GitHub view is reading, or null for its list. Lives
   *  here rather than in GithubPane because two things outside that pane put a
   *  reference into it: a github.com link clicked in the terminal, and the PR
   *  chip in the pane bar. */
  const [githubRef, setGithubRef] = useState<GhRef | null>(null);
  /** The terminal is sharing the pane with something — files or the browser. */
  /** Everything except the bare terminal shares the pane with something: files,
   *  the browser, or one of the three git views. */
  const isSplit = view !== 'terminal';
  const openFileRef = useRef<((path: string, opts?: { pin?: boolean }) => void) | null>(null);
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
  /**
   * Which way a split runs. Side by side while there is room for two columns;
   * stacked below that.
   *
   * Half a screen leaves a pane about 460px, and a 60/40 split of that is a
   * 270px terminal beside a 180px file tree — two things too narrow to read
   * instead of one you could. Stacked, both halves keep the full width and
   * give up height, which a terminal minds far less than columns: 80 columns
   * is a hard floor for wrapped output, while ten rows is merely short.
   *
   * Keyed off the PANE, not the window: a narrow window is as narrow
   * as a single pane on a phone, which is the same rule the pane bar's
   * container queries follow.
   */
  const [paneW, setPaneW] = useState(0);
  useEffect(() => {
    const el = paneBodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPaneW(el.getBoundingClientRect().width));
    ro.observe(el);
    setPaneW(el.getBoundingClientRect().width);
    return () => ro.disconnect();
  }, []);
  /** Below this a split stops being two columns. 560px is where a 60/40 split
   *  still leaves the narrow half ~220px — about the least a file tree or an
   *  address bar can use — and the terminal its 80 columns at a small font. */
  const stacked = paneW > 0 && paneW < 560;
  // `narrow`, not `tile`: a phone must not write its view into the shared
  // profile either, or opening Files once on the phone reopens it on every
  // desktop. See the comment on `narrow` above.
  useEffect(() => { if (!narrow) savePaneView(sessionId, view); }, [view, sessionId, narrow]);
  /** The tool to bring back when the tools are shown again. */
  const lastToolRef = useRef<PaneView>(view === 'terminal' ? 'split' : view);
  if (view !== 'terminal') lastToolRef.current = view;
  const toggleTools = useCallback(() => {
    setView(v => v === 'terminal' ? lastToolRef.current : 'terminal');
  }, []);
  // Mirrored into a ref so the create-once terminal effect can read the live
  // theme when answering OSC colour queries.
  const themeRef = useRef(theme);
  useEffect(() => {
    const term = termRef.current;
    themeRef.current = theme;
    if (!term) return;
    term.options.theme = TERMINAL_THEMES[theme];
    term.refresh(0, term.rows - 1);
  }, [theme]);

  // While this pane is active, the global Cmd+Arrow shortcut cycles ITS view.
  // Never a tile: it has no views to cycle, and claiming the slot would point
  // the shortcut at a scratch shell instead of the pane you are working in.
  useEffect(() => {
    if (!isActive || tile) return;
    activePaneCycleView.current = (dir: 'left' | 'right') => {
      setView(prev => {
        // Hidden, then rail order — so cycling walks the rail top to bottom.
        const order: PaneView[] = ['terminal', 'split-github', 'working', 'log', 'split', 'split-preview', 'split-terminals', 'split-agent', 'split-sheepit'];
        const i = order.indexOf(prev);
        return order[(i + (dir === 'right' ? 1 : -1) + order.length) % order.length]!;
      });
    };
  }, [isActive, tile]);

  // Resolve a path clicked in the terminal against this pane's cwd, then open
  // it in the app-wide Files panel.
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
    // The app-wide Files panel, not the pane's own split: a path printed in a
    // terminal is usually somewhere else entirely — a scratchpad under /private
    // /tmp, a file in another checkout — and the pane's Files view is about the
    // repository the pane is standing in. The panel floats over the whole app,
    // so it also costs the terminal none of its width.
    //
    // A window event rather than a prop threaded up to the workspace bar, which
    // is where the panel's state lives — the same channel StatChips already
    // uses to push a PR into a pane, in the other direction.
    window.dispatchEvent(new CustomEvent('sheepit:open-file', { detail: { path: absPath, line } }));
  }, [sessionId]);
  const handleFileLinkRef = useRef(handleFileLink);
  handleFileLinkRef.current = handleFileLink;

  /** A URL printed in this pane opens in the pane's own browser, beside the
   *  terminal that printed it — the agent starts a dev server, or prints the
   *  PR it just opened, and looking at it should not mean leaving the app for
   *  a window that knows nothing about which pane sent you there.
   *
   *  Three things still go to the real browser, because the embedded one is
   *  deliberately not a browser (no tabs, no history, no cookies, no login):
   *  a modifier click, anything that is not http(s), and sheepit's own origin,
   *  which would nest the app inside itself. The preview bar's own "open
   *  externally" button is the fourth way out, after you have looked. */
  const handleWebLink = useCallback((event: MouseEvent | undefined, rawUrl: string) => {
    // The user's own browser, not another window of this app — see openExternal.
    const external = () => openExternal(rawUrl);
    if (event?.metaKey || event?.ctrlKey || event?.shiftKey) { external(); return; }
    let parsed: URL;
    try { parsed = new URL(rawUrl); } catch { external(); return; }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') { external(); return; }
    if (parsed.host === window.location.host) { external(); return; }
    // A pull request or an issue opens in the pane's own GitHub view instead
    // of its browser: reviewing one is reading a title, a description and a
    // diff, which is a thing this pane renders better than a streamed page.
    //
    // Any repository, not only this pane's — `gh` is signed in to all of them,
    // and an agent that printed a link to somebody else's PR meant that PR.
    const gh = parsed.host === 'github.com' && parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(pull|issues)\/(\d+)/);
    if (gh) {
      setGithubRef({ kind: gh[3] === 'issues' ? 'issue' : 'pr', num: Number(gh[4]), repo: `${gh[1]}/${gh[2]}` });
      setView('split-github');
      return;
    }
    setPreviewUrl(rawUrl);
    // Bumped even when the URL is unchanged: after you have clicked through to
    // somewhere else inside the pane browser, clicking the same link again
    // means "take me back there", and a prop that did not change says nothing.
    setPreviewNav(n => n + 1);
    setView('split-preview');
  }, []);
  const handleWebLinkRef = useRef(handleWebLink);
  handleWebLinkRef.current = handleWebLink;

  /** The pane bar's PR chip opens a reference in THIS pane's GitHub view. A
   *  window event rather than props: the chip lives three components away
   *  inside PaneHeader → StatChips, and this is the channel the tab-active
   *  refit already uses. Each pane answers only for its own id. */
  useEffect(() => {
    const onOpenRef = (e: Event) => {
      const d = (e as CustomEvent).detail as ({ sessionId: string } & GhRef) | undefined;
      if (!d || d.sessionId !== sessionId) return;
      setGithubRef({ kind: d.kind, num: d.num, repo: d.repo });
      setView('split-github');
    };
    window.addEventListener('sheepit:open-gh-ref', onOpenRef);
    return () => window.removeEventListener('sheepit:open-gh-ref', onOpenRef);
  }, [sessionId]);

  /** The size the PTY was last told about, so an unchanged one is not resent.
   *  Cleared on a reconnect, where the server has to be told again. */
  const sentSizeRef = useRef<{ cols: number; rows: number } | null>(null);

  /** Tell the PTY this pane's size — but only when it actually moved.
   *
   *  Every resize is a SIGWINCH, and a full-screen app answers one by
   *  repainting its whole frame. Several fits converge on one visible pane
   *  (the become-shown effect, the ResizeObserver's 50ms and 200ms passes, the
   *  tab-active handler), and they mostly agree on the answer, so sending each
   *  one made switching sheep cost three or four repaints of an agent's
   *  UI — which is most of what reads as the pane being rebuilt. */
  const sendResize = () => {
    const t = termRef.current;
    if (!t) return;
    const last = sentSizeRef.current;
    if (last && last.cols === t.cols && last.rows === t.rows) return;
    sentSizeRef.current = { cols: t.cols, rows: t.rows };
    sendRef.current({ type: 'resize', cols: t.cols, rows: t.rows });
  };

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
  /** Brief "Attaching image…" badge shown while a pasted screenshot uploads —
   *  paste has no drag affordance, so this is the only signal it worked. */
  const [imgPasteBusy, setImgPasteBusy] = useState(false);

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
      fontFamily: useStore.getState().terminalFontFamily,
      fontSize: initialFontSize,
      lineHeight: TERMINAL_LINE_HEIGHT,
      scrollback: isMobile ? 1000 : 5000,
      theme: TERMINAL_THEMES[theme],
      // OSC 8 hyperlinks (Claude Code emits file references as these). A local
      // `file://` link opens in this pane's Files view; anything else opens
      // externally. `allowNonHttpProtocols` is required for `file:` to reach us.
      linkHandler: {
        allowNonHttpProtocols: true,
        activate(event: MouseEvent, uri: string) {
          const filePath = fileUriToPath(uri);
          if (filePath) { handleFileLinkRef.current(filePath); return; }
          // Real URL scheme (http:, https:, mailto:, …) → the web-link path,
          // which keeps http(s) in this pane and sends the rest outside.
          if (/^[a-z][a-z0-9+.-]*:\/\//i.test(uri)) { handleWebLinkRef.current(event, uri); return; }
          // Otherwise it's a bare/relative path → resolve against the app's cwd.
          handleFileLinkRef.current(uri);
        },
      },
    });
    const fit = new FitAddon();
    const links = new WebLinksAddon((event: MouseEvent, url: string) => handleWebLinkRef.current(event, url));
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
    let webglAddon: WebglLike | null = null;

    const tryOpen = () => {
      if (disposed || opened) return;
      const el = containerRef.current;
      if (!el || el.clientWidth < 1 || el.clientHeight < 1) return;
      opened = true;
      openObserver?.disconnect();
      openObserver = null;

      term.open(el);
      // themeRef, not the captured `theme`: this effect runs once, and a
      // session that outlives a theme switch must still answer with the
      // palette that is actually on screen.
      registerColorQueryHandlers(term, () => themeRef.current, (data) => sendRef.current({ type: 'input', data }));
      enableWebglRenderer(term, (addon) => {
        // The import is async, so the cell may already have unmounted by the
        // time it resolves — in which case dispose it immediately rather than
        // leaving a live WebGL context attached to a dead terminal.
        if (disposed) { try { addon.dispose(); } catch { /* already gone */ } return; }
        webglAddon = addon;
        webglRef.current = addon;
      });

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
            sendResize();
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
      // Typing marks the pane read — not selecting it. Escape sequences
      // (focus/mouse reports, CPR, arrows) are not typing; a bare Esc is.
      if (!data.startsWith('\x1b') || data === '\x1b') useStore.getState().clearUnseen(sessionId);
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
      import('../utils').then(({ notify }) => notify('sheepit \u{1F411}', `${name} needs attention`));
    });

    return () => {
      mobileCleanup?.();
      scrollDispose.dispose();
      dataDispose.dispose();
      bellDispose.dispose();
      disposed = true;
      openObserver?.disconnect();
      renderDispose?.dispose();
      // Dispose the WebGL addon BEFORE the terminal. xterm's AddonManager
      // disposes addons as part of term.dispose(), by which point the
      // RenderService is gone and WebglAddon.dispose() throws
      // "Cannot read properties of undefined (reading 'onRequestRedraw')",
      // which React then surfaces as an unmount error. Disposing it here
      // unregisters it from the AddonManager, so term.dispose() skips it.
      try { webglAddon?.dispose(); } catch { /* already gone */ }
      webglAddon = null;
      webglRef.current = null;
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      rendererReadyRef.current = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // File link provider — clicking a path opens it in this pane's Files view.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    /** How many wrapped rows of one logical line to stitch — a path is at most
     *  a few hundred characters, and an unbounded walk would scan the screen. */
    const MAX_WRAP_ROWS = 8;
    const provider = term.registerLinkProvider({
      provideLinks(y: number, callback: (links: any[]) => void): void {
        const buf = term.buffer.active;
        // A path longer than the pane is wrapped across rows, so a single row
        // holds only part of it — collect the whole logical line and let
        // findFileLinks map matches back to buffer positions.
        let top = y - 1;
        while (top > 0 && buf.getLine(top)?.isWrapped) top--;
        const rows: string[] = [];
        for (let i = top; rows.length < MAX_WRAP_ROWS; i++) {
          const l = buf.getLine(i);
          if (!l || (i > top && !l.isWrapped)) break;
          rows.push(l.translateToString());
        }
        callback(findFileLinks(rows, term.cols, top).map(m => ({
          range: { start: m.start, end: m.end },
          text: m.text,
          decorations: { underline: true, pointerCursor: true },
          // A plain click is enough, as it is for a URL and for an OSC 8
          // hyperlink: a path drawn as a link that ignores a click on it
          // reads as the app being broken.
          activate(_event: MouseEvent, linkText: string) { handleFileLinkRef.current(linkText); },
        })));
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
    // The terminal's own cost, timed: parsing and rasterising the bytes the
    // agent produced. The biggest single thing on the main thread while an agent
    // is running, and the first place to look when typing feels behind.
    const endWrite = perf.span('xterm:write');
    perf.count('xterm:bytes', batch.length);
    try {
      t.write(theme === 'light' ? makeLightTruecolorReadable(batch) : batch, () => {
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
      endWrite();
      return;
    } finally {
      endWrite();
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
        // A reconnected server has to be told the size again, whatever we
        // last sent the old connection.
        sentSizeRef.current = null;
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
  }, [sessionId, theme]);

  // Resize handling
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const handleResize = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        safeFit();
        sendResize();
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
      sendResize();
    }, 20);
    return () => clearTimeout(id);
  }, [zoom]);

  // Apply font-family changes.
  //
  // **The glyph cache has to be thrown away by hand.** Setting the option does
  // give the WebGL renderer a new texture atlas (the atlas config includes
  // fontFamily), but nothing clears the render model that points into the old
  // one: `_handleOptionsChanged` refreshes the atlas and leaves the model
  // alone, and `_updateModel` skips every cell whose character and colours are
  // unchanged — which, on a screen you have not touched, is all of them. So
  // the pane goes on painting the previous font's glyphs from vertex data
  // computed against the previous atlas.
  //
  // `term.refresh()` cannot fix that, which is why it used to be here and did
  // not work: refresh only marks rows dirty, and dirty rows still hit that
  // unchanged-cell `continue`. `clearTextureAtlas()` is the addon's public
  // answer — it clears the atlas *and* the model, so every cell is rasterised
  // again in the new face.
  //
  // A font *size* change needs none of this: it moves the cell metrics, so the
  // renderer resizes and clears the model on its own. That asymmetry is the
  // whole reason a family swap looked like the setting doing nothing.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    if (term.options.fontFamily === fontFamily) return;
    term.options.fontFamily = fontFamily;
    // Refit first — where the metrics *do* move, the row count changes, and
    // repainting before that would paint rows the grid is about to discard.
    const id = setTimeout(() => {
      safeFit();
      const t = termRef.current;
      if (!t) return;
      // No addon means the DOM renderer, which reads the family off the
      // element and needs nothing but a repaint.
      if (webglRef.current?.clearTextureAtlas) {
        try { webglRef.current.clearTextureAtlas(); } catch { /* context lost; the DOM renderer takes over */ }
      } else {
        t.refresh(0, t.rows - 1);
      }
      sendResize();
    }, 20);
    return () => clearTimeout(id);
  }, [fontFamily]);

  // ResizeObserver on container for panel resize (debounced)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let followup: ReturnType<typeof setTimeout> | null = null;
    const doFit = () => {
      safeFit();
      sendResize();
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

  // Focus + scroll to bottom when active + register as target for mobile key
  // bar. A tile does neither: it would steal focus from the pane it is sitting
  // inside the moment it mounted, and four of them would fight over the one
  // `activeTerminalSend` slot the key bar types into. Clicking a tile still
  // focuses it — xterm does that itself.
  useEffect(() => {
    if (isActive && !tile) {
      const t = termRef.current;
      t?.focus();
      t?.scrollToBottom();
      activeTerminalSend.current = (msg) => sendRef.current(msg);
      activeTerminalRefresh.current = () => sendRef.current({ type: 'connect', session_id: sessionId });
    }
  }, [isActive, tile]);

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
      sendResize();
    };
    window.addEventListener('sheepit:terminal-tab-active', handler);
    return () => window.removeEventListener('sheepit:terminal-tab-active', handler);
  }, [isActive]);

  // Changing this pane's view resizes the terminal — entering a split hands
  // half its width to the other half, and leaving one hands it back — so refit
  // + refocus, making cols/rows match the box and telling the PTY about it.
  // (It used to guard on the terminal being hidden at all. Nothing hides it any
  // more; every view is a split, and a split is still a resize.)
  //
  // `stacked` is in the deps for the same reason: flipping a split from columns
  // to rows changes the terminal's box without changing the view, and an
  // unfitted xterm draws more columns than it has room for, so the right of
  // every line is simply not there.
  useEffect(() => {
    const id = setTimeout(() => {
      safeFit();
      if (isActive) termRef.current?.focus();
      sendResize();
    }, 60);
    return () => clearTimeout(id);
  }, [view, isActive, stacked]); // eslint-disable-line react-hooks/exhaustive-deps

  // Blink only where a cursor means something — the pane on screen.
  //
  // A blinking cursor is a timer plus a repaint twice a second, per terminal,
  // and every sheep in a pen stays mounted under `display: none`. So a pen
  // holding twenty ran twenty blink loops, nineteen of them drawing a caret
  // nobody could see. xterm keeps blinking a hidden terminal quite happily —
  // it has no idea its element is not displayed.
  //
  // It is an option rather than a constructor argument because `isActive`
  // changes over the terminal's life and the constructor runs once.
  useEffect(() => {
    const t = termRef.current;
    if (t) t.options.cursorBlink = isActive && !window.matchMedia('(max-width: 767px)').matches;
  }, [isActive]);

  // Drag the divider between the terminal and the other half of a split.
  const startSplitDrag = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation();
    const body = paneBodyRef.current;
    if (!body) return;
    // One stored percentage for both orientations: it answers one question —
    // how much of the pane is the terminal — and a stacked split that forgot
    // the width you set would re-ask it every time the window changed.
    const vertical = body.getBoundingClientRect().width < 560;
    const onMove = (ev: MouseEvent) => {
      const rect = body.getBoundingClientRect();
      const pct = vertical
        ? ((ev.clientY - rect.top) / rect.height) * 100
        : ((ev.clientX - rect.left) / rect.width) * 100;
      setTermPct(Math.min(80, Math.max(20, pct)));
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      safeFit();
      sendResize();
      // Persist once on release (not during the drag) to avoid localStorage churn.
      setTermPct(pct => { saveSplitPct(sessionId, pct); return pct; });
    };
    document.body.style.cursor = vertical ? 'row-resize' : 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sessionId]);

  // Refit when this pane becomes the one its pen is showing — it goes from
  // `display: none` to the full pen, so cols/rows change and the PTY has to
  // be told.
  //
  // Do NOT re-subscribe / replay the ring-buffer snapshot here. Resizing the
  // PTY makes the running app redraw its live frame at the new width, so the
  // ring buffer ends up holding BOTH the old narrow-width rendering and the
  // new wide-width redraw. Replaying that into a reset terminal renders the
  // block twice (narrow copy + wide copy) because the old frame's cursor-up/
  // erase sequences were computed for narrow wrapping and no longer line up.
  // Instead, let xterm reflow its existing buffer on resize and let the app's
  // natural SIGWINCH repaint stream in — cursor math lines up at the new width.
  //
  // The two frames are held in a ref, not on `window`. Switching sheep runs
  // this effect on two panes at once — the one handing over and the one taking
  // over. Global ids meant the second overwrote the first's, and the first's
  // cleanup then cancelled the second's fit, so the pane you had just opened
  // was left at whatever size it happened to have until the ResizeObserver's
  // later passes caught it.
  const showFitRafRef = useRef<{ a: number; b: number }>({ a: 0, b: 0 });
  useEffect(() => {
    // Two frames: one for layout, one for fit after xterm's renderer catches up
    const frames = showFitRafRef.current;
    frames.a = requestAnimationFrame(() => {
      frames.b = requestAnimationFrame(() => {
        // Timed because this was the one hot path in the app with no span on
        // it, so it could only ever appear as a long-frame blame — seen as a
        // 551ms frame carrying 326ms of script attributed to this file, with
        // xterm's own renderer repainting in the frame after it. What costs is
        // `safeFit`: a pane coming out of `display: none` has no size, so its
        // cols and rows can differ from what its terminal holds, and changing
        // them reflows every line of the scrollback. FitAddon no-ops when the
        // dimensions match, so a switch that does not change the size is
        // already cheap and this will show that as a near-zero span.
        const endFit = perf.span('pane:refit');
        try {
          safeFit();
          sendResize();
          termRef.current?.focus();
        } finally {
          endFit();
        }
      });
    });
    return () => {
      cancelAnimationFrame(frames.a);
      cancelAnimationFrame(frames.b);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

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
      const lineH = (term.options?.fontSize ?? 14) * (term.options?.lineHeight ?? TERMINAL_LINE_HEIGHT);
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
      const lineH = (term.options?.fontSize ?? 14) * (term.options?.lineHeight ?? TERMINAL_LINE_HEIGHT);
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
      const lineH = (term.options?.fontSize ?? 14) * (term.options?.lineHeight ?? TERMINAL_LINE_HEIGHT);
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

  // Resolve this session's cwd so uploads land next to the running process
  // (Claude Code and friends can only attach files they can read on disk).
  async function resolveSessionCwd(): Promise<string> {
    try {
      const res = await fetch(`/api/fs/${encodeURIComponent(sessionId)}/browse`);
      const data = await res.json();
      if (data.cwd) return data.cwd as string;
    } catch { /* fallback below */ }
    return '/tmp';
  }

  // Upload blobs into the session cwd and type their paths into the terminal
  // (space-separated, shell-escaped). Shared by native file drops and image
  // paste — in both cases the goal is to hand a real on-disk path to whatever
  // is running in the pane (e.g. Claude Code, which attaches image paths).
  async function uploadBlobsAndType(items: Array<{ blob: Blob; name: string }>): Promise<void> {
    if (items.length === 0) return;
    const cwd = await resolveSessionCwd();
    const paths: string[] = [];
    for (const { blob, name } of items) {
      try {
        const res = await fetch(`/api/fs/upload?dir=${encodeURIComponent(cwd)}&name=${encodeURIComponent(name)}`, {
          method: 'POST',
          body: blob,
        });
        const { ok, path } = await res.json();
        if (ok && path) paths.push(path);
      } catch { /* skip failed uploads */ }
    }
    if (paths.length > 0) {
      const escaped = paths.map(p => p.includes(' ') ? `"${p}"` : p).join(' ');
      sendRef.current({ type: 'input', data: escaped });
    }
  }

  async function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setFileDragOver(false);
    fileDragCountRef.current = 0;

    // Only files are handled here — pane drops come through dnd-kit and
    // resolve in App.tsx's onDragEnd.
    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    await uploadBlobsAndType(files.map(f => ({ blob: f, name: f.name })));
  }

  // Image paste — screenshots copied to the clipboard (e.g. macOS
  // Cmd+Ctrl+Shift+4) arrive as image blobs, not text, so xterm's default
  // paste silently drops them. Intercept the paste in the capture phase
  // (before it reaches xterm's hidden textarea), upload the image to the
  // session cwd, and type the resulting path into the terminal so the running
  // program — Claude Code in particular — can attach it. Plain-text pastes are
  // left untouched and flow through to xterm normally.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      const images = Array.from(items).filter(it => it.kind === 'file' && it.type.startsWith('image/'));
      if (images.length === 0) return; // text paste → let xterm handle it
      // Stop xterm (and the browser) from also processing this paste.
      e.preventDefault();
      e.stopPropagation();
      const stamp = Date.now();
      const blobs = images
        .map((it, i) => {
          const blob = it.getAsFile();
          if (!blob) return null;
          const ext = (it.type.split('/')[1] || 'png').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
          // Screenshots come in with no/generic names; synthesize a stable,
          // unique one so repeated pastes don't overwrite each other.
          const name = blob.name && !/^image\.\w+$/i.test(blob.name)
            ? blob.name
            : `pasted-${stamp}${images.length > 1 ? `-${i + 1}` : ''}.${ext}`;
          return { blob, name };
        })
        .filter((b): b is { blob: File; name: string } => b !== null);
      if (blobs.length === 0) return;
      setImgPasteBusy(true);
      void uploadBlobsAndType(blobs).finally(() => setImgPasteBusy(false));
    };
    el.addEventListener('paste', onPaste, { capture: true });
    return () => el.removeEventListener('paste', onPaste, { capture: true } as EventListenerOptions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * The tool split, as one element that is reused until something it shows
   * actually changes.
   *
   * Every sheep in a pen stays mounted under `display: none`, and they re-render
   * with everything else: measured at **11 split commits per sweep when at most
   * one split is ever on screen**, and `commit:split` is ~90% of `commit:pane`.
   * That is what a click cost — 180-230ms, scaling with how much you have open.
   *
   * A `useMemo` fixes it rather than a `memo()` wrapper or a visibility flag,
   * for two reasons. `GitDiffPane`, `FilesPane`, `GithubPane` and `AgentPane`
   * subscribe to the store **not at all**, so they re-render only because this
   * component does — hold the element still and the whole subtree stops. And
   * nothing unmounts, which matters: `PreviewPane` owns a live browser view,
   * and `FilesPane` and `GitDiffPane` hold scroll and expansion state that an
   * unmount would throw away on every pen switch.
   *
   * Every dependency here is stable by construction — the three are `useState`
   * setters, `openFileRef` is a ref and `startSplitDrag` is a `useCallback`. **An
   * inline lambda added to this block turns the whole thing off**, silently.
   */
  // Named per view, because "the split is slow" is not actionable: the six
  // tools are a diff, a file tree, a code viewer, a browser, a pull request and
  // a shell, and they have nothing in common but a box.
  const splitEl = useMemo(() => isSplit ? (
        <Profiler id={`split:${view}`} onRender={recordSplitCommit}>
          <div
            onMouseDown={startSplitDrag}
            className={`terminal-resize-handle terminal-resize-handle-${stacked ? 'vertical' : 'horizontal'}`}
            style={stacked
              ? { height: 6, flexShrink: 0, cursor: 'row-resize', background: 'var(--border)' }
              : { width: 6, flexShrink: 0, cursor: 'col-resize', background: 'var(--border)' }}
          />
          <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column', background: 'var(--card)' }}>
            {/* Every tool shares the rail, so moving between a pull request,
                what you have changed, what you have committed, the files and
                the browser is one click and never changes the pane's shape. */}
            <div style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0 }}>
              <ToolRail view={view} onPick={setView} />
              {/* minWidth 0, or a tool as wide as its content (a diff with a
                  long line) pushes the pane past the screen edge. */}
              <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {view === 'split-preview' ? (
                <PreviewPane sessionId={sessionId} initialUrl={previewUrl} navSeq={previewNav} />
              ) : view === 'split-github' ? (
                <GithubPane sessionId={sessionId} selected={githubRef} onSelect={setGithubRef} />
              ) : view === 'split-terminals' ? (
                <SideTerminals sessionId={sessionId} />
              ) : view === 'split-agent' ? (
                <AgentPane sessionId={sessionId} />
              ) : view === 'split-sheepit' ? (
                <SheepitPane sessionId={sessionId} />
              ) : view === 'split' ? (
                <FilesPane
                  sessionId={sessionId}
                  openFileRef={openFileRef}
                  onPreviewFile={(path: string) => {
                    setPreviewUrl(`/api/fs/raw?as=html&path=${encodeURIComponent(path)}`);
                    setView('split-preview');
                  }}
                />
              ) : (
                <GitDiffPane
                  sessionId={sessionId}
                  mode={view === 'log' ? 'log' : 'head'}
                  onOpenFile={(path: string) => { setView('split'); setTimeout(() => openFileRef.current?.(path), 60); }}
                />
              )}
              </div>
            </div>
          </div>
        </Profiler>
  ) : null, [isSplit, view, sessionId, previewUrl, previewNav, githubRef, stacked,
             // Stable by construction, and listed rather than silenced with an
             // eslint-disable: the next person to edit this block needs the
             // linter to tell them when they have added a dependency, because
             // a missing one here does not crash — it quietly freezes the split.
             startSplitDrag, setView, setGithubRef, setPreviewUrl, openFileRef]);

  // One pane's own commit, so an expensive `commit:pane` can be divided by the
  // panes that caused it. The outer Profiler in App wraps the whole main area,
  // which was enough while the problem was breadth — too many panes rendering —
  // and is not enough now that it is depth: a click re-renders only 2.8 cells
  // (`perclick:TerminalCell`) and still costs 137ms, so what is wanted is the
  // cost of *one*. Durations nest: `commit:cell` is inside `commit:pane` and
  // contains `commit:split:<view>`.
  return (
    <Profiler id="cell" onRender={recordSplitCommit}>
      <>
      <div
        ref={setPaneDropRef}
        // Counted as `holding.cells`. `holding.terminals` counts `.xterm`
        // elements, which is not the same number — a cell whose terminal has not
        // initialised has none, and `TerminalTiles` mounts cells for side and
        // scratch shells too. Without this, "14 cell renders with 9 terminals"
        // cannot be told apart from "every mounted cell rendered once", and
        // those point at different bugs.
        data-pane=""
        className="flex-1 min-h-0 min-w-0"
        style={{
          position: 'relative',
          display: 'flex', flexDirection: 'column',
          background: 'var(--background)',
          overflow: 'hidden',
          // The only outline left is the one that says what is under the
          // cursor. Selection needs none: a pen shows one sheep, so the pane
          // on screen is the selected pane by construction, and a brand ring
          // around the text you read all day was the loudest thing in it.
          outline: (fileDragOver || isPaneDragOver) ? '2px solid var(--primary)' : 'none',
          transition: 'outline 0.15s ease',
        }}
        onClick={activate}
        // mousedown with capture — runs before xterm's own handler so we
        // always register the focus change even when xterm stops propagation.
        onMouseDownCapture={activate}
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
      <div style={{
        position: 'relative',
        flex: 1, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        background: 'var(--card)',
        overflow: 'hidden',
      }}>
      {/* Per-pane header — identity, the tools toggle, close. */}
      <PaneHeader
        sessionId={sessionId}
        workspaceId={gridId}
        isActive={isActive}
        onClose={close}
        toolsOpen={isSplit}
        // No tools in a tile — so no button offering them either.
        onToggleTools={tile ? undefined : toggleTools}
        nativeOn={nativeOn}
        // Only where it can work. The native view drives `claude`, so a pane
        // holding Codex, Pi or a plain shell is not offered a button that
        // would open somebody else's agent. A tile is a scratch shell and has
        // no tools at all, by the same rule the rail follows.
        onToggleNative={!tile && isClaudeCode ? toggleNative : undefined}
      />
      {/* Terminal surface — own relative container so absolute-positioned
          .terminal-pane fills only this area (below the header), and the
          active-pane / drag overlays sit on top of the terminal only. */}
      <div ref={paneBodyRef} style={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
      {/* Terminal view — always on screen. In every view but 'terminal' it
          shares the row with the other half (files, the browser, or a git
          view), separated by a resizable handle. */}
      <div style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: stacked ? 'column' : 'row' }}>
      {/* Terminal column — full width normally, fixed % in split. */}
      <div style={{
        position: 'relative', minWidth: 0, minHeight: 0, overflow: 'hidden',
        ...(isSplit
          ? (stacked
            ? { height: `${termPct}%`, flexShrink: 0 }
            : { width: `${termPct}%`, flexShrink: 0 })
          : { flex: 1 }),
      }}>
      {/* The terminal stays MOUNTED under the native view, hidden rather than
          unmounted — the same trade every pane in a pen already makes. Tearing
          down the xterm would discard the scrollback and make switching back a
          rebuild from the daemon's ring; this way the two views are one click
          apart in both directions and the PTY never knew. */}
      <div
        ref={containerRef}
        className="terminal-pane"
        style={nativeOn ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
      />
      {nativeOn && (
        <div style={{ position: 'absolute', inset: 0, zIndex: 12, display: 'flex' }}>
          <NativePane
            sessionId={sessionId}
            // The same link policy the terminal uses — see handleWebLink.
            onOpenLink={handleWebLink}
            // Only the pane on screen takes the keyboard; the rest stay mounted.
            isActive={isActive}
            // A path clicked here opens the same Files panel the terminal
            // opens — see handleFileLink.
            onOpenFile={handleFileLink}
            // The card's "answer this in the terminal" button. It flips the
            // whole device back, which is right: if a dialog needs the TUI,
            // the next pane you open probably does too.
            onOpenTerminal={() => { writePaneMode('terminal'); setPaneMode('terminal'); }}
          />
        </div>
      )}
      {imgPasteBusy && (
        <div style={{
          position: 'absolute', bottom: 16, right: 16, zIndex: 21,
          display: 'flex', alignItems: 'center', gap: 7,
          padding: '6px 12px', borderRadius: 20,
          border: '1px solid var(--border)',
          background: 'rgba(17, 20, 17, 0.92)',
          backdropFilter: 'blur(8px)',
          color: 'var(--foreground)', fontSize: 11, fontWeight: 600,
          boxShadow: '0 2px 10px rgba(0,0,0,0.4)',
          pointerEvents: 'none',
          animation: 'fade-in 0.15s ease',
        }}>
          <Upload size={12} />
          Attaching image…
        </div>
      )}
      {(isPaneDragOver || fileDragOver) && (
        <div style={{
          position: 'absolute', inset: 0, zIndex: 20,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          // Scrim over the terminal while dragging. color-mix keeps it a
          // translucent veil of the current surface instead of a fixed near-
          // black, which washed out to an opaque dark block in light mode.
          background: 'color-mix(in srgb, var(--card) 85%, transparent)',
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
            // Token, not a hardcoded dark: this was rgba(17, 20, 17,.92), which
            // in light mode put --foreground's dark text on a near-black pill.
            background: 'var(--popover)',
            backdropFilter: 'blur(8px)',
            color: 'var(--popover-foreground)',
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

      {/* The other half of a split: the file browser, the embedded browser, or
          the git group. One divider and one stored width for all of them,
          because it is the same question — how much of the pane is not the
          terminal. */}
      {splitEl}
      </div>{/* /terminal+split row */}

      </div>{/* /pane body */}
      {/* The pane's footer bar is gone: its identity — git chip, process /
          link handle, voice button, cwd — moved into PaneHeader. Two chrome
          bars cost ~70px of vertical space per pane to carry one line each,
          and vertical rows are what terminal content is short of. */}
      </div>{/* /inner wrapper */}
      </div>{/* /outer wrapper */}
      </>
    </Profiler>
  );
}

/**
 * Memoised, and that is load-bearing.
 *
 * Every sheep in a pen stays mounted (all but one under `display: none`), so a
 * render of the grid used to re-render every pane in it — the terminal, its
 * chrome bar, and whichever tool split it has open. `commit:pane` was 25ms of
 * every second with the app idle.
 *
 * It only works while the props stay stable: `onActivate`/`onClose` take the
 * pane index so the parent can pass one `useCallback` to all of them, and the
 * rest are strings, numbers and booleans. A handler built inline at the call
 * site turns this off again.
 */
export default memo(TerminalCellInner);
