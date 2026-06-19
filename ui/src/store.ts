import { create } from 'zustand';
import { notify } from './utils';

// ── Core types ──────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  name: string;
  path?: string;
  username?: string;
  last_activity?: number;
  isClaudeCode?: boolean;
  isCodex?: boolean;
  cpuPercent?: number;
  memMb?: number;
  gitRoot?: string;
  gitBranch?: string;
  gitDirty?: boolean;
  prNum?: number;
  prState?: string;
  prUrl?: string;
}

export interface ConfirmState {
  message: string;
  resolve: (result: boolean) => void;
}

export type WsStatus = 'connecting' | 'connected' | 'disconnected';
/** Workspace layouts.
 *
 *  Most layouts are symmetric (all panes equal): `single`, `horizontal`,
 *  `vertical`, `quad`. Three-pane layouts are asymmetric — one pane is the
 *  "big" one and the other two are stacked opposite it. The orientation of
 *  the big pane is part of the layout itself:
 *
 *    three        — tall pane on the LEFT, 2 stacked on the right  (legacy default)
 *    three-right  — tall pane on the RIGHT, 2 stacked on the left
 *    three-top    — wide pane on the TOP, 2 side-by-side on the bottom
 *    three-bottom — wide pane on the BOTTOM, 2 side-by-side on the top
 *
 *  The convention is: cells[0] is always the big pane, cells[1] and cells[2]
 *  are the two smaller ones. This keeps the swap mechanics unchanged and
 *  lets the renderer branch only on the layout string. */
export type GridLayout =
  | 'single'
  | 'horizontal'
  | 'vertical'
  | 'three' | 'three-right' | 'three-top' | 'three-bottom'
  | 'quad';

/** True if `l` is any of the four three-pane variants. */
export function isThreeLayout(l: GridLayout): boolean {
  return l === 'three' || l === 'three-right' || l === 'three-top' || l === 'three-bottom';
}

/** A Workspace is a sidebar row. It groups 1–4 panes (sessions rendered as
 *  terminal cells) under a single layout. Identified by a synthetic id that
 *  is NEVER equal to any session id — that decoupling is what lets us move
 *  any pane (including cell 0) between workspaces without re-keying anything.
 *
 *  Invariants:
 *   - `cells.length >= 1` always (empty workspaces are deleted immediately)
 *   - `cells.length <= MAX_WORKSPACE_PANES`
 *   - `0 <= activeCell < cells.length`
 *   - each `cells[i]` is a session id that exists in `sessionMap`
 */
export interface Workspace {
  id: string;
  layout: GridLayout;
  cells: string[];
  activeCell: number;
  /** User-assigned title for the workspace, shown in the sidebar. */
  title?: string;
}

// ── Layout helpers (grid up/downgrade) ──────────────────────────────────────

export const MAX_WORKSPACE_PANES = 4;

export function upgradeWorkspaceLayout(current: GridLayout, newCount: number): GridLayout {
  switch (newCount) {
    case 1: return 'single';
    case 2: return current === 'vertical' ? 'vertical' : 'horizontal';
    // Preserve a three-variant if we're already in one — user's orientation
    // choice survives an appendPaneToWorkspace/removePaneFromWorkspace round trip.
    case 3: return isThreeLayout(current) ? current : 'three';
    default: return 'quad';
  }
}

export function downgradeWorkspaceLayout(current: GridLayout, remaining: number): GridLayout {
  if (remaining <= 1) return 'single';
  if (remaining === 2) return current === 'vertical' ? 'vertical' : 'horizontal';
  if (remaining === 3) return isThreeLayout(current) ? current : 'three';
  return current;
}

/** How many panes a given layout can hold. */
export function layoutCapacity(layout: GridLayout): number {
  switch (layout) {
    case 'single': return 1;
    case 'horizontal': return 2;
    case 'vertical': return 2;
    case 'three':
    case 'three-right':
    case 'three-top':
    case 'three-bottom':
      return 3;
    case 'quad': return 4;
  }
}

// ── Store interface ─────────────────────────────────────────────────────────

export interface StoreState {
  sessions: Session[];
  /** The **active workspace id** (synthetic, not a session id). Legacy field
   *  name — kept for call-site compatibility. See CLAUDE.md glossary. */
  currentSessionId: string | null;
  sessionPreviews: Record<string, string>;
  sessionBusy: Record<string, boolean>;
  /** Sessions with unseen output (cleared when you switch to their workspace) */
  sessionHasUnseen: Record<string, boolean>;
  sessionLastEvent: Record<string, number>;
  sessionOrder: string[];
  sessionMap: Record<string, Session>;
  sessionUrls: Record<string, string[]>;
  sessionCurrentInput: Record<string, string>;
  openPaneMap: Record<string, number[]>;
  /** Per-workspace state. Keyed by **synthetic workspace id**. */
  workspaces: Record<string, Workspace>;
  /** Stable iteration order for the sidebar list. */
  workspaceOrder: string[];
  /** Session id of the pane currently in zen (fullscreen) mode, or null. */
  zenSessionId: string | null;
  /** Global terminal font size — applies to every pane in every workspace. */
  fontSize: number;
  /** @deprecated per-workspace zoom, superseded by the global `fontSize`. Still
   *  written by drag/move bookkeeping but no longer read for terminal sizing. */
  workspaceZooms: Record<string, number>;
  wsStatus: WsStatus;
  sheetOpen: boolean;
  /** Knowledge (notes) dialog — opens as an overlay over the active workspace
   *  rather than replacing it. */
  knowledgeOpen: boolean;
  /** Sidebar workspace list filter (Slack-style). */
  workspaceFilter: 'all' | 'active' | 'favourites';
  confirm: ConfirmState | null;

  setWsStatus: (status: WsStatus) => void;
  setWorkspaceFilter: (filter: 'all' | 'active' | 'favourites') => void;
  setSheetOpen: (open: boolean) => void;
  setKnowledgeOpen: (open: boolean) => void;
  renderSessions: (sessions: Session[]) => void;
  setCurrentSessionId: (id: string | null) => void;
  setOpenPaneMap: (panes: (string | null)[]) => void;
  updatePreview: (sessionId: string, preview: string, busy?: boolean) => void;
  showConfirm: (message: string) => Promise<boolean>;
  dismissConfirm: (result: boolean) => void;
  addSessionUrl: (sessionId: string, url: string) => void;
  clearSessionUrls: (sessionId: string) => void;
  setCurrentInput: (sessionId: string, input: string) => void;
  markUnseen: (sessionId: string) => void;
  clearUnseen: (sessionId: string) => void;

  // ── Workspace actions ─────────────────────────────────────────────────────
  /** Create a new workspace around the given session ids. Returns the new
   *  workspace id. Picks a sensible layout from the count unless overridden. */
  createWorkspace: (sessionIds: string[], layout?: GridLayout) => string;
  /** Delete a workspace. Does NOT kill backend sessions; caller is responsible
   *  for any `close_session` broadcasts. */
  deleteWorkspace: (workspaceId: string) => void;
  /** Append a pane (session id) to an existing workspace. No-op if the
   *  workspace doesn't exist, is full, or already contains the session. */
  appendPaneToWorkspace: (workspaceId: string, sessionId: string) => void;
  /** Remove the pane at `paneIndex` from a workspace. If this was the last
   *  pane, the workspace is deleted. Returns the workspace id if the workspace
   *  survived, or null if it was deleted. */
  removePaneFromWorkspace: (workspaceId: string, paneIndex: number) => string | null;
  /** Legacy alias used by TerminalGrid — writes layout/cells/activeCell into
   *  an existing workspace (or creates one at the given id if it's missing).
   *  New code should prefer the focused helpers above. */
  setGridState: (workspaceId: string, layout: GridLayout, cells: string[], activeCell: number) => void;
  /** Legacy alias for `deleteWorkspace`. */
  clearGridState: (workspaceId: string) => void;
  /** Focus a specific pane within a workspace. */
  setActivePane: (workspaceId: string, paneIndex: number) => void;
  /** Move a pane from one workspace to another. Any pane can move now — no
   *  more "root cell anchored" restriction. If the source workspace ends up
   *  empty, it's deleted and the selection jumps to the target. */
  movePaneBetweenWorkspaces: (args: {
    sourceId: string; sourceIdx: number; targetId: string;
  }) => boolean;
  /** Swap two panes within the same workspace. The session at `idxA` and the
   *  one at `idxB` exchange positions in the `cells` array. `activeCell`
   *  follows the session it was pointing at, so the user's focus stays on
   *  the same pane content even though its grid position changed. */
  swapPanesInWorkspace: (workspaceId: string, idxA: number, idxB: number) => boolean;
  /** Reorder a pane within its workspace using arrayMove semantics — the
   *  pane at `fromIdx` is removed and reinserted at `toIdx`, sliding the
   *  panes in between by one position. This is the natural complement to
   *  dnd-kit's `useSortable`, which animates intermediate panes shifting
   *  out of the way as the user drags. `activeCell` follows the focused
   *  session id so focus stays with the moving pane. */
  reorderPaneInWorkspace: (workspaceId: string, fromIdx: number, toIdx: number) => boolean;
  /** Extract a pane from its current workspace into a brand new workspace
   *  inserted at `insertAt` in `workspaceOrder` (default: end). If the source
   *  workspace becomes empty it is deleted. Returns the new workspace id. */
  extractPaneToNewWorkspace: (args: {
    sourceId: string; sourceIdx: number; insertAt?: number;
  }) => string | null;
  /** Reorder a workspace within `workspaceOrder`. `toIndex` is the position
   *  the workspace should occupy after the move (0-based). */
  reorderWorkspaces: (workspaceId: string, toIndex: number) => boolean;
  /** Set or clear the user-assigned title for a workspace. Pass empty string
   *  or undefined to clear the title. */
  renameWorkspace: (workspaceId: string, title: string | undefined) => void;

  toggleZen: (sessionId: string) => void;
  exitZen: () => void;
  navigateSession: (direction: 'up' | 'down') => { workspaceId: string; paneIndex?: number } | null;

  // ── Global terminal font size (applies to every pane) ────────────────────
  setFontSize: (size: number) => void;
  adjustFontSize: (delta: number) => void;
  resetFontSize: () => void;
}

export const DEFAULT_FONT_SIZE = (): number => 12;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

// ── Storage keys ────────────────────────────────────────────────────────────
// New (post-refactor) keys:
const WORKSPACES_KEY      = 'vipershell:workspaces';
const WORKSPACE_ZOOM_KEY  = 'vipershell:workspace-zoom';
const LAST_WORKSPACE_KEY  = 'vipershell-last-workspace';
// Old (legacy) keys — read-only, used for one-shot migration:
const LEGACY_GRID_KEY     = 'vipershell:term-grid';
const LEGACY_ZOOM_KEY     = 'vipershell:session-zoom';
const LEGACY_LAST_KEY     = 'vipershell-last-session';

// ── Workspace id generation ─────────────────────────────────────────────────
function generateWorkspaceId(): string {
  // Good enough uniqueness: random base36 + timestamp. Doesn't need to be
  // cryptographic — these ids just need to be unique within one browser tab.
  return 'ws-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ── Migration from the legacy session-id-keyed shape ────────────────────────
/** Runs once on first load after the refactor. Reads `vipershell:term-grid`
 *  (which was keyed by the root session id) and converts each entry into a
 *  workspace with a synthetic id. Also migrates the last-session selection
 *  and the per-grid zoom map. Leaves the legacy keys in place so a user can
 *  roll back if something goes wrong. */
function migrateLegacyWorkspaces(): {
  workspaces: Record<string, Workspace>;
  order: string[];
  zooms: Record<string, number>;
  lastWorkspaceId: string | null;
} | null {
  let oldGrid: Record<string, { layout?: GridLayout; cells?: string[]; activeCell?: number }> = {};
  try {
    const raw = localStorage.getItem(LEGACY_GRID_KEY);
    if (!raw) return null;
    oldGrid = JSON.parse(raw) ?? {};
  } catch { return null; }

  // Map old root-session-id → new synthetic workspace id, for later migration
  // of the last-session and zoom keys.
  const sidToWsId = new Map<string, string>();
  const workspaces: Record<string, Workspace> = {};
  const order: string[] = [];

  for (const [rootSid, state] of Object.entries(oldGrid)) {
    const cells = Array.isArray(state?.cells) ? state!.cells.filter(Boolean) : [];
    if (cells.length === 0) continue;
    const wsId = generateWorkspaceId();
    workspaces[wsId] = {
      id: wsId,
      layout: state?.layout ?? 'single',
      cells,
      activeCell: Math.min(Math.max(0, state?.activeCell ?? 0), cells.length - 1),
    };
    order.push(wsId);
    sidToWsId.set(rootSid, wsId);
  }

  // Zoom: old key was `{ [rootSessionId]: fontSize }`
  const zooms: Record<string, number> = {};
  try {
    const rawZoom = localStorage.getItem(LEGACY_ZOOM_KEY);
    if (rawZoom) {
      const oldZooms = JSON.parse(rawZoom) as Record<string, number>;
      for (const [sid, fontSize] of Object.entries(oldZooms)) {
        const wsId = sidToWsId.get(sid);
        if (wsId) zooms[wsId] = fontSize;
      }
    }
  } catch { /* ignore */ }

  // Last session → last workspace
  let lastWorkspaceId: string | null = null;
  try {
    const last = localStorage.getItem(LEGACY_LAST_KEY);
    if (last) lastWorkspaceId = sidToWsId.get(last) ?? null;
  } catch { /* ignore */ }

  // Favourites were keyed by the root session id. Re-key them to the new
  // synthetic workspace ids so the user's starred list survives the migration.
  try {
    const FAV_KEY = 'vipershell:favourite-sessions';
    const rawFavs = localStorage.getItem(FAV_KEY);
    if (rawFavs) {
      const oldFavs = JSON.parse(rawFavs) as string[];
      if (Array.isArray(oldFavs)) {
        const newFavs = oldFavs
          .map(sid => sidToWsId.get(sid))
          .filter((x): x is string => !!x);
        localStorage.setItem(FAV_KEY, JSON.stringify(newFavs));
      }
    }
  } catch { /* ignore */ }

  return { workspaces, order, zooms, lastWorkspaceId };
}

// ── Persistence (new shape) ─────────────────────────────────────────────────

interface PersistedWorkspaces {
  workspaces: Record<string, Workspace>;
  order: string[];
}

function loadWorkspacesFromStorage(): PersistedWorkspaces {
  // Prefer the new key. If absent, run the one-shot legacy migration.
  try {
    const raw = localStorage.getItem(WORKSPACES_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as PersistedWorkspaces;
      if (parsed?.workspaces && Array.isArray(parsed?.order)) return parsed;
    }
  } catch { /* fall through to migration */ }

  const migrated = migrateLegacyWorkspaces();
  if (migrated) {
    const persisted: PersistedWorkspaces = { workspaces: migrated.workspaces, order: migrated.order };
    try { localStorage.setItem(WORKSPACES_KEY, JSON.stringify(persisted)); } catch { /* quota */ }
    try { localStorage.setItem(WORKSPACE_ZOOM_KEY, JSON.stringify(migrated.zooms)); } catch { /* quota */ }
    if (migrated.lastWorkspaceId) {
      try { localStorage.setItem(LAST_WORKSPACE_KEY, migrated.lastWorkspaceId); } catch { /* quota */ }
    }
    return persisted;
  }
  return { workspaces: {}, order: [] };
}

function saveWorkspaces(workspaces: Record<string, Workspace>, order: string[]): void {
  try {
    localStorage.setItem(WORKSPACES_KEY, JSON.stringify({ workspaces, order }));
  } catch { /* quota */ }
}

function loadWorkspaceZooms(): Record<string, number> {
  try {
    const raw = localStorage.getItem(WORKSPACE_ZOOM_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through */ }
  return {};
}

function saveWorkspaceZooms(zooms: Record<string, number>): void {
  try { localStorage.setItem(WORKSPACE_ZOOM_KEY, JSON.stringify(zooms)); } catch { /* quota */ }
}

// Global terminal font size — one value shared by every workspace/pane.
const FONT_SIZE_KEY = 'vipershell:font-size';
function loadFontSize(): number {
  try {
    const raw = localStorage.getItem(FONT_SIZE_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n)) return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, n));
    }
  } catch { /* fall through */ }
  return DEFAULT_FONT_SIZE();
}
function saveFontSize(size: number): void {
  try { localStorage.setItem(FONT_SIZE_KEY, String(size)); } catch { /* quota */ }
}

function loadWorkspaceFilter(): 'all' | 'active' | 'favourites' {
  try {
    const v = localStorage.getItem('vipershell:ws-filter');
    if (v === 'active' || v === 'favourites') return v;
  } catch { /* fall through */ }
  return 'all';
}

function loadLastWorkspaceId(): string | null {
  try { return localStorage.getItem(LAST_WORKSPACE_KEY); } catch { return null; }
}

// Debounce timers kept outside store state (no re-renders on timer changes)
const _busyTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Active terminal send/refresh/scroll — updated by TerminalCell when it becomes active
export const activeTerminalSend    = { current: (_msg: Record<string, unknown>) => {} };
export const activeTerminalRefresh = { current: () => {} };
// Cycle the active pane's view (terminal → git → files). Registered by the
// active TerminalCell; driven by the keyboard shortcut in App.
export const activePaneCycleView = { current: (_dir: 'left' | 'right') => {} };


// Registry for sending to a specific terminal cell by session ID
const _terminalSendRegistry = new Map<string, (msg: Record<string, unknown>) => void>();
export function registerTerminalSend(id: string, fn: (msg: Record<string, unknown>) => void) {
  _terminalSendRegistry.set(id, fn);
  return () => { _terminalSendRegistry.delete(id); };
}
export function sendToTerminal(id: string, msg: Record<string, unknown>) {
  const fn = _terminalSendRegistry.get(id);
  if (fn) fn(msg);
}

// Registry for refreshing all terminal cells (including non-root panes)
const _terminalRefreshRegistry = new Map<string, () => void>();
export function registerTerminalRefresh(id: string, fn: () => void) {
  _terminalRefreshRegistry.set(id, fn);
  return () => { _terminalRefreshRegistry.delete(id); };
}
export function refreshAllTerminals() {
  for (const fn of _terminalRefreshRegistry.values()) fn();
}

// ── Store ───────────────────────────────────────────────────────────────────

const _initialWorkspaces = loadWorkspacesFromStorage();

const useStore = create<StoreState>((set, get) => ({
  sessions: [],
  currentSessionId: loadLastWorkspaceId(),
  sessionPreviews: {},
  sessionBusy: {},
  sessionHasUnseen: {},
  sessionLastEvent: {},
  sessionOrder: [],
  sessionMap: {},
  sessionUrls: {},
  sessionCurrentInput: {},
  openPaneMap: {},
  workspaces: _initialWorkspaces.workspaces,
  workspaceOrder: _initialWorkspaces.order,
  zenSessionId: null,
  fontSize: loadFontSize(),
  workspaceZooms: loadWorkspaceZooms(),
  wsStatus: 'connecting',
  sheetOpen: false,
  knowledgeOpen: false,
  workspaceFilter: loadWorkspaceFilter(),
  confirm: null,

  setWsStatus(status: WsStatus) {
    set({ wsStatus: status });
  },

  setWorkspaceFilter(filter: 'all' | 'active' | 'favourites') {
    try { localStorage.setItem('vipershell:ws-filter', filter); } catch { /* quota */ }
    set({ workspaceFilter: filter });
  },

  setSheetOpen(open: boolean) {
    set({ sheetOpen: open });
  },

  setKnowledgeOpen(open: boolean) {
    set({ knowledgeOpen: open });
  },

  renderSessions(sessions: Session[]) {
    const { currentSessionId, workspaces, workspaceOrder } = get();

    const sessionMap = Object.fromEntries(sessions.map(s => [s.id, s]));
    const liveSessionIds = new Set(sessions.map(s => s.id));

    const sorted = [...sessions].sort((a, b) =>
      (parseInt(a.id.replace('$', ''), 10) || 0) - (parseInt(b.id.replace('$', ''), 10) || 0)
    );

    const byPath: Record<string, Session[]> = {};
    for (const s of sorted) {
      const key = s.path ?? '';
      if (!byPath[key]) byPath[key] = [];
      byPath[key].push(s);
    }
    const sessionOrder = Object.values(byPath).flat().map(s => s.id);

    // ── Reconcile workspaces with the new session list ──
    // 1) Prune dead sessions from existing workspaces; delete empty workspaces.
    const nextWorkspaces: Record<string, Workspace> = {};
    const nextWorkspaceOrder: string[] = [];
    const claimed = new Set<string>();
    for (const wsId of workspaceOrder) {
      const ws = workspaces[wsId];
      if (!ws) continue;
      const prunedCells = ws.cells.filter(cid => liveSessionIds.has(cid));
      if (prunedCells.length === 0) continue; // empty workspace → drop
      const shrunk = prunedCells.length !== ws.cells.length;
      const nextLayout = shrunk
        ? downgradeWorkspaceLayout(ws.layout, prunedCells.length)
        : ws.layout;
      const nextActive = Math.min(ws.activeCell, prunedCells.length - 1);
      nextWorkspaces[wsId] = {
        ...ws,
        cells: prunedCells,
        layout: nextLayout,
        activeCell: Math.max(0, nextActive),
      };
      nextWorkspaceOrder.push(wsId);
      for (const cid of prunedCells) claimed.add(cid);
    }

    // 2) Any session that isn't claimed by a workspace becomes its own
    //    brand-new single-pane workspace. This is how freshly-created sessions
    //    turn into sidebar rows.
    const freshlyCreated: string[] = [];
    for (const s of sorted) {
      if (claimed.has(s.id)) continue;
      const id = generateWorkspaceId();
      nextWorkspaces[id] = { id, layout: 'single', cells: [s.id], activeCell: 0 };
      freshlyCreated.push(id);
      claimed.add(s.id);
    }
    // Newly-created sessions go to the TOP of the sidebar, not the bottom.
    if (freshlyCreated.length) nextWorkspaceOrder.unshift(...freshlyCreated);

    // 3) Reconcile the "active workspace" pointer. If its workspace vanished,
    //    fall back to the first surviving one (or null if nothing left).
    const VIRTUAL_IDS = new Set(['__notes__']);
    let nextCurrentId = currentSessionId;
    if (nextCurrentId && !VIRTUAL_IDS.has(nextCurrentId) && !nextWorkspaces[nextCurrentId]) {
      nextCurrentId = nextWorkspaceOrder[0] ?? null;
    }

    // 4) sessionLastEvent tracking (unchanged)
    const nextLastEvent = { ...get().sessionLastEvent };
    for (const s of sorted) {
      if (s.last_activity) {
        const ms = Math.round(s.last_activity * 1000);
        if (!nextLastEvent[s.id] || ms > nextLastEvent[s.id]!) {
          nextLastEvent[s.id] = ms;
        }
      }
    }

    saveWorkspaces(nextWorkspaces, nextWorkspaceOrder);
    set({
      sessions: sorted,
      sessionMap,
      sessionOrder,
      currentSessionId: nextCurrentId,
      sessionLastEvent: nextLastEvent,
      workspaces: nextWorkspaces,
      workspaceOrder: nextWorkspaceOrder,
    });
  },

  setCurrentSessionId(id: string | null) {
    if (id) {
      try { localStorage.setItem(LAST_WORKSPACE_KEY, id); } catch { /* quota */ }
      // Clear unseen for every pane in this workspace (plus the id itself as
      // a fallback, for the legacy case where `id` isn't registered as a
      // workspace yet — e.g. right after a new session appears but before
      // renderSessions has reconciled it into a workspace).
      const { sessionHasUnseen, workspaces } = get();
      const toClear: string[] = [id];
      const ws = workspaces[id];
      if (ws) {
        for (const cid of ws.cells) if (cid && cid !== id) toClear.push(cid);
      }
      const hasAny = toClear.some(cid => sessionHasUnseen[cid]);
      if (hasAny) {
        const next = { ...sessionHasUnseen };
        for (const cid of toClear) delete next[cid];
        set({ sessionHasUnseen: next });
      }
    }
    set({ currentSessionId: id });
  },

  setOpenPaneMap(panes: (string | null)[]) {
    const map: Record<string, number[]> = {};
    panes.forEach((sid, idx) => {
      if (!sid) return;
      if (!map[sid]) map[sid] = [];
      map[sid].push(idx);
    });
    set({ openPaneMap: map });
  },

  updatePreview(sessionId: string, preview: string, busy?: boolean) {
    const { sessionPreviews, currentSessionId, workspaces } = get();
    const prevPreview = sessionPreviews[sessionId];
    set(s => ({ sessionPreviews: { ...s.sessionPreviews, [sessionId]: preview } }));

    // A session is "visible" if it belongs to the currently-active workspace.
    const isVisible = (() => {
      if (!currentSessionId) return false;
      const ws = workspaces[currentSessionId];
      if (!ws) return currentSessionId === sessionId;
      return ws.cells.includes(sessionId);
    })();

    if (busy === true) {
      if (_busyTimers.has(sessionId)) return;
      _busyTimers.set(sessionId, setTimeout(() => {
        _busyTimers.delete(sessionId);
        set(s => ({ sessionBusy: { ...s.sessionBusy, [sessionId]: true } }));
      }, 2200));
    } else if (busy === false) {
      const pending = _busyTimers.get(sessionId);
      if (pending) {
        clearTimeout(pending);
        _busyTimers.delete(sessionId);
        return;
      }
      const { sessionBusy, sessionMap } = get();
      const wasBusy = sessionBusy[sessionId] ?? false;
      if (wasBusy && !isVisible) {
        const name = sessionMap[sessionId]?.name ?? 'terminal';
        notify('vipershell \u{1F40D}', `${name} finished`);
        set(s => ({ sessionHasUnseen: { ...s.sessionHasUnseen, [sessionId]: true } }));
      }
      set(s => ({ sessionBusy: { ...s.sessionBusy, [sessionId]: false } }));
    } else if (prevPreview !== undefined && preview !== prevPreview && !isVisible) {
      const { sessionBusy } = get();
      if (!sessionBusy[sessionId]) {
        set(s => ({ sessionHasUnseen: { ...s.sessionHasUnseen, [sessionId]: true } }));
      }
    }
  },

  showConfirm(message: string) {
    return new Promise<boolean>(resolve => {
      set({ confirm: { message, resolve } });
    });
  },

  dismissConfirm(result: boolean) {
    const { confirm } = get();
    if (confirm) {
      confirm.resolve(result);
      set({ confirm: null });
    }
  },

  addSessionUrl(sessionId: string, url: string) {
    const prev = get().sessionUrls[sessionId] ?? [];
    if (prev.length >= 50) return;
    const lower = url.toLowerCase();
    if (prev.some(u => u.toLowerCase() === lower)) return;
    set({ sessionUrls: { ...get().sessionUrls, [sessionId]: [...prev, url] } });
  },

  clearSessionUrls(sessionId: string) {
    const urls = { ...get().sessionUrls };
    delete urls[sessionId];
    set({ sessionUrls: urls });
  },

  setCurrentInput(sessionId: string, input: string) {
    set(s => ({ sessionCurrentInput: { ...s.sessionCurrentInput, [sessionId]: input } }));
  },

  markUnseen(sessionId: string) {
    const { currentSessionId, workspaces } = get();
    // Don't mark unseen if the session belongs to the active workspace — the
    // user is presumably looking at it (or at least has it on screen).
    const ws = currentSessionId ? workspaces[currentSessionId] : undefined;
    if (ws?.cells.includes(sessionId)) return;
    if (sessionId === currentSessionId) return; // legacy single-session fallback
    set(s => ({ sessionHasUnseen: { ...s.sessionHasUnseen, [sessionId]: true } }));
  },

  clearUnseen(sessionId: string) {
    set(s => {
      const next = { ...s.sessionHasUnseen };
      delete next[sessionId];
      return { sessionHasUnseen: next };
    });
  },

  // ── Workspace actions ─────────────────────────────────────────────────────

  createWorkspace(sessionIds: string[], layout?: GridLayout): string {
    if (sessionIds.length === 0) return '';
    const id = generateWorkspaceId();
    const cells = sessionIds.slice(0, MAX_WORKSPACE_PANES);
    const ws: Workspace = {
      id,
      layout: layout ?? upgradeWorkspaceLayout('single', cells.length),
      cells,
      activeCell: 0,
    };
    set(s => {
      const nextWorkspaces = { ...s.workspaces, [id]: ws };
      const nextOrder = [...s.workspaceOrder, id];
      saveWorkspaces(nextWorkspaces, nextOrder);
      return { workspaces: nextWorkspaces, workspaceOrder: nextOrder };
    });
    return id;
  },

  deleteWorkspace(workspaceId: string) {
    set(s => {
      if (!s.workspaces[workspaceId]) return {};
      const nextWorkspaces = { ...s.workspaces };
      delete nextWorkspaces[workspaceId];
      const nextOrder = s.workspaceOrder.filter(x => x !== workspaceId);
      const nextZooms = { ...s.workspaceZooms };
      delete nextZooms[workspaceId];
      saveWorkspaces(nextWorkspaces, nextOrder);
      saveWorkspaceZooms(nextZooms);
      return {
        workspaces: nextWorkspaces,
        workspaceOrder: nextOrder,
        workspaceZooms: nextZooms,
      };
    });
  },

  appendPaneToWorkspace(workspaceId: string, sessionId: string) {
    set(s => {
      const ws = s.workspaces[workspaceId];
      if (!ws) return {};
      if (ws.cells.includes(sessionId)) return {};
      if (ws.cells.length >= MAX_WORKSPACE_PANES) return {};
      const nextCells = [...ws.cells, sessionId];
      // Only auto-upgrade the layout when it can't hold the new cell count;
      // if the caller already set an intentionally-larger layout (e.g. switched
      // to 'quad' before splits were populated), leave it alone.
      const nextLayout = nextCells.length > layoutCapacity(ws.layout)
        ? upgradeWorkspaceLayout(ws.layout, nextCells.length)
        : ws.layout;
      const nextWs: Workspace = {
        ...ws,
        cells: nextCells,
        layout: nextLayout,
        activeCell: nextCells.length - 1, // focus the newly-added pane
      };
      const nextWorkspaces = { ...s.workspaces, [workspaceId]: nextWs };
      saveWorkspaces(nextWorkspaces, s.workspaceOrder);
      return { workspaces: nextWorkspaces };
    });
  },

  removePaneFromWorkspace(workspaceId: string, paneIndex: number): string | null {
    const s = get();
    const ws = s.workspaces[workspaceId];
    if (!ws) return null;
    if (paneIndex < 0 || paneIndex >= ws.cells.length) return workspaceId;

    const nextCells = ws.cells.filter((_, i) => i !== paneIndex);
    if (nextCells.length === 0) {
      // Last pane gone → drop the workspace entirely.
      get().deleteWorkspace(workspaceId);
      return null;
    }
    const nextLayout = downgradeWorkspaceLayout(ws.layout, nextCells.length);
    const nextActive =
      ws.activeCell === paneIndex ? Math.max(0, paneIndex - 1)
      : ws.activeCell > paneIndex ? ws.activeCell - 1
      : ws.activeCell;
    const nextWs: Workspace = {
      ...ws,
      cells: nextCells,
      layout: nextLayout,
      activeCell: nextActive,
    };
    set(state => {
      const nextWorkspaces = { ...state.workspaces, [workspaceId]: nextWs };
      saveWorkspaces(nextWorkspaces, state.workspaceOrder);
      return { workspaces: nextWorkspaces };
    });
    return workspaceId;
  },

  setGridState(workspaceId: string, layout: GridLayout, cells: string[], activeCell: number) {
    set(s => {
      const existing = s.workspaces[workspaceId];
      const clampedActive = Math.max(0, Math.min(activeCell, cells.length - 1));
      const nextWs: Workspace = existing
        ? { ...existing, layout, cells, activeCell: clampedActive }
        : { id: workspaceId, layout, cells, activeCell: clampedActive };
      const nextWorkspaces = { ...s.workspaces, [workspaceId]: nextWs };
      const nextOrder = existing ? s.workspaceOrder : [...s.workspaceOrder, workspaceId];
      saveWorkspaces(nextWorkspaces, nextOrder);
      return { workspaces: nextWorkspaces, workspaceOrder: nextOrder };
    });
  },

  clearGridState(workspaceId: string) {
    get().deleteWorkspace(workspaceId);
  },

  setActivePane(workspaceId: string, paneIndex: number) {
    const ws = get().workspaces[workspaceId];
    if (!ws) return;
    if (ws.activeCell === paneIndex) return;
    if (paneIndex < 0 || paneIndex >= ws.cells.length) return;
    set(s => {
      const nextWorkspaces = {
        ...s.workspaces,
        [workspaceId]: { ...ws, activeCell: paneIndex },
      };
      saveWorkspaces(nextWorkspaces, s.workspaceOrder);
      return { workspaces: nextWorkspaces };
    });
  },

  movePaneBetweenWorkspaces({ sourceId, sourceIdx, targetId }) {
    if (sourceId === targetId) return false;
    const s = get();

    const source = s.workspaces[sourceId];
    if (!source) return false;
    if (sourceIdx < 0 || sourceIdx >= source.cells.length) return false;

    const movedSid = source.cells[sourceIdx];
    if (!movedSid) return false;

    const target = s.workspaces[targetId];
    if (!target) return false;
    if (target.cells.length >= MAX_WORKSPACE_PANES) return false;
    if (target.cells.includes(movedSid)) return false;

    // Build the new source. If it's left empty, drop it and jump the active
    // selection to the target workspace (Android folder dissolves behavior).
    const newSourceCells = source.cells.filter((_, i) => i !== sourceIdx);
    let nextWorkspaces: Record<string, Workspace> = { ...s.workspaces };
    let nextOrder = s.workspaceOrder;
    let nextZooms = s.workspaceZooms;
    let sourceDeleted = false;

    if (newSourceCells.length === 0) {
      delete nextWorkspaces[sourceId];
      nextOrder = nextOrder.filter(x => x !== sourceId);
      if (sourceId in nextZooms) {
        nextZooms = { ...nextZooms };
        delete nextZooms[sourceId];
      }
      sourceDeleted = true;
    } else {
      const newSourceLayout = downgradeWorkspaceLayout(source.layout, newSourceCells.length);
      const newSourceActive =
        source.activeCell === sourceIdx ? Math.max(0, sourceIdx - 1)
        : source.activeCell > sourceIdx ? source.activeCell - 1
        : source.activeCell;
      nextWorkspaces[sourceId] = {
        ...source,
        cells: newSourceCells,
        layout: newSourceLayout,
        activeCell: newSourceActive,
      };
    }

    // Build the new target — always a growth.
    const newTargetCells = [...target.cells, movedSid];
    const newTargetLayout = upgradeWorkspaceLayout(target.layout, newTargetCells.length);
    const newTargetActive = newTargetCells.length - 1;
    nextWorkspaces[targetId] = {
      ...target,
      cells: newTargetCells,
      layout: newTargetLayout,
      activeCell: newTargetActive,
    };

    saveWorkspaces(nextWorkspaces, nextOrder);
    if (sourceDeleted) saveWorkspaceZooms(nextZooms);

    // If the user was looking at the now-deleted source workspace, jump them
    // to the target so they see where their pane went.
    const nextCurrentId =
      sourceDeleted && s.currentSessionId === sourceId ? targetId : s.currentSessionId;

    const patch: Partial<StoreState> = {
      workspaces: nextWorkspaces,
      workspaceOrder: nextOrder,
    };
    if (sourceDeleted) patch.workspaceZooms = nextZooms;
    if (nextCurrentId !== s.currentSessionId) patch.currentSessionId = nextCurrentId;
    set(patch as StoreState);
    return true;
  },

  swapPanesInWorkspace(workspaceId: string, idxA: number, idxB: number) {
    if (idxA === idxB) return false;
    const s = get();
    const ws = s.workspaces[workspaceId];
    if (!ws) return false;
    const n = ws.cells.length;
    if (idxA < 0 || idxA >= n || idxB < 0 || idxB >= n) return false;

    // Track which session the user was focused on so activeCell follows the
    // content, not the position. If they were focused on pane A and we swap
    // A↔B, activeCell should end up pointing at B's new index (which is A's
    // old index… no — which is idxB's position, since that's where A moved).
    const focusedSid = ws.cells[ws.activeCell];

    // Temp vars avoid the `noUncheckedIndexedAccess` complaint about
    // destructuring-swap where each index is typed `string | undefined`.
    const a = ws.cells[idxA]!;
    const b = ws.cells[idxB]!;
    const newCells = ws.cells.slice();
    newCells[idxA] = b;
    newCells[idxB] = a;

    const newActive = focusedSid ? newCells.indexOf(focusedSid) : ws.activeCell;

    set(state => {
      const nextWorkspaces = {
        ...state.workspaces,
        [workspaceId]: {
          ...ws,
          cells: newCells,
          activeCell: newActive >= 0 ? newActive : ws.activeCell,
        },
      };
      saveWorkspaces(nextWorkspaces, state.workspaceOrder);
      return { workspaces: nextWorkspaces };
    });
    return true;
  },

  reorderPaneInWorkspace(workspaceId: string, fromIdx: number, toIdx: number) {
    if (fromIdx === toIdx) return false;
    const s = get();
    const ws = s.workspaces[workspaceId];
    if (!ws) return false;
    const n = ws.cells.length;
    if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n) return false;

    // arrayMove semantics: remove from fromIdx, insert at toIdx, sliding
    // intermediate items by one. This matches what dnd-kit's useSortable
    // animates on screen as the user drags, so the final state matches the
    // visual preview.
    const focusedSid = ws.cells[ws.activeCell];
    const newCells = ws.cells.slice();
    const moved = newCells.splice(fromIdx, 1)[0];
    if (moved === undefined) return false;
    newCells.splice(toIdx, 0, moved);
    const newActive = focusedSid ? newCells.indexOf(focusedSid) : ws.activeCell;

    set(state => {
      const nextWorkspaces = {
        ...state.workspaces,
        [workspaceId]: {
          ...ws,
          cells: newCells,
          activeCell: newActive >= 0 ? newActive : ws.activeCell,
        },
      };
      saveWorkspaces(nextWorkspaces, state.workspaceOrder);
      return { workspaces: nextWorkspaces };
    });
    return true;
  },

  extractPaneToNewWorkspace({ sourceId, sourceIdx, insertAt }) {
    const s = get();
    const source = s.workspaces[sourceId];
    if (!source) return null;
    if (sourceIdx < 0 || sourceIdx >= source.cells.length) return null;

    // Refuse to dissolve a 1-pane workspace into an identical new one.
    if (source.cells.length === 1) return null;

    const movedSid = source.cells[sourceIdx];
    if (!movedSid) return null;

    const newId = generateWorkspaceId();
    const newWs: Workspace = {
      id: newId,
      layout: 'single',
      cells: [movedSid],
      activeCell: 0,
    };

    // Shrink the source — same logic as movePaneBetweenWorkspaces.
    const newSourceCells = source.cells.filter((_, i) => i !== sourceIdx);
    const newSourceLayout = downgradeWorkspaceLayout(source.layout, newSourceCells.length);
    const newSourceActive =
      source.activeCell === sourceIdx ? Math.max(0, sourceIdx - 1)
      : source.activeCell > sourceIdx ? source.activeCell - 1
      : source.activeCell;

    const nextWorkspaces: Record<string, Workspace> = {
      ...s.workspaces,
      [sourceId]: {
        ...source,
        cells: newSourceCells,
        layout: newSourceLayout,
        activeCell: newSourceActive,
      },
      [newId]: newWs,
    };

    // Insert the new workspace id at the requested position. If `insertAt`
    // is beyond the current length, clamp to the end.
    const orderWithoutNew = s.workspaceOrder.slice();
    const sourcePos = orderWithoutNew.indexOf(sourceId);
    let pos = insertAt ?? orderWithoutNew.length;
    pos = Math.max(0, Math.min(pos, orderWithoutNew.length));
    // If the user drops right after the source row, put the new ws
    // immediately below it; the natural reading order wins.
    const nextOrder = [
      ...orderWithoutNew.slice(0, pos),
      newId,
      ...orderWithoutNew.slice(pos),
    ];

    saveWorkspaces(nextWorkspaces, nextOrder);
    set({
      workspaces: nextWorkspaces,
      workspaceOrder: nextOrder,
    });
    void sourcePos;
    return newId;
  },

  reorderWorkspaces(workspaceId: string, toIndex: number) {
    const s = get();
    if (!s.workspaces[workspaceId]) return false;
    const order = s.workspaceOrder.slice();
    const from = order.indexOf(workspaceId);
    if (from < 0) return false;
    // Clamp target. Note: `toIndex` is the position in the ORIGINAL order
    // the caller wants the row to end up at — the same semantics as dropping
    // "before row N". We convert to post-removal index here.
    let to = Math.max(0, Math.min(toIndex, order.length));
    order.splice(from, 1);
    if (to > from) to -= 1;
    to = Math.max(0, Math.min(to, order.length));
    if (to === from) return false;
    order.splice(to, 0, workspaceId);
    saveWorkspaces(s.workspaces, order);
    set({ workspaceOrder: order });
    return true;
  },

  renameWorkspace(workspaceId: string, title: string | undefined) {
    const s = get();
    const ws = s.workspaces[workspaceId];
    if (!ws) return;
    const clean = title?.trim() || undefined;
    const nextWorkspaces = { ...s.workspaces, [workspaceId]: { ...ws, title: clean } };
    saveWorkspaces(nextWorkspaces, s.workspaceOrder);
    set({ workspaces: nextWorkspaces });
  },

  toggleZen(sessionId: string) {
    set(s => ({ zenSessionId: s.zenSessionId === sessionId ? null : sessionId }));
  },

  exitZen() {
    set({ zenSessionId: null });
  },

  navigateSession(direction: 'up' | 'down') {
    const { currentSessionId, workspaces, workspaceOrder } = get();
    // Flat list: one entry per pane across all workspaces in sidebar order.
    type Entry = { workspaceId: string; paneIndex?: number };
    const flat: Entry[] = [];
    for (const wsId of workspaceOrder) {
      const ws = workspaces[wsId];
      if (!ws) continue;
      if (ws.cells.length <= 1) {
        flat.push({ workspaceId: wsId });
      } else {
        for (let i = 0; i < ws.cells.length; i++) {
          flat.push({ workspaceId: wsId, paneIndex: i });
        }
      }
    }
    if (flat.length < 2) return null;

    const currentWs = currentSessionId ? workspaces[currentSessionId] : undefined;
    const currentPane = currentWs && currentWs.cells.length > 1 ? currentWs.activeCell : undefined;
    const idx = flat.findIndex(e =>
      e.workspaceId === currentSessionId && e.paneIndex === currentPane
    );
    if (idx === -1) return flat[0] ?? null;

    const nextIdx = (direction === 'up' ? idx - 1 + flat.length : idx + 1) % flat.length;
    return flat[nextIdx] ?? null;
  },

  setFontSize(size: number) {
    const clamped = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.round(size)));
    saveFontSize(clamped);
    set({ fontSize: clamped });
  },

  adjustFontSize(delta: number) {
    get().setFontSize(get().fontSize + delta);
  },

  resetFontSize() {
    saveFontSize(DEFAULT_FONT_SIZE());
    set({ fontSize: DEFAULT_FONT_SIZE() });
  },
}));

export default useStore;
