import { create } from 'zustand';
import { notify } from './utils';
import { applyTheme, readTheme, readTerminalFont, DEFAULT_TERMINAL_FONT, TERMINAL_FONT_KEY, type AppTheme } from './theme';
import { preferences, subscribePreferences } from './preferences';

// ── Core types ──────────────────────────────────────────────────────────────

export interface Session {
  id: string;
  name: string;
  path?: string;
  username?: string;
  last_activity?: number;
  isClaudeCode?: boolean;
  isCodex?: boolean;
  isOpencode?: boolean;
  isAntigravity?: boolean;
  isCopilot?: boolean;
  isGrok?: boolean;
  isCursor?: boolean;
  cpuPercent?: number;
  memMb?: number;
  gitRoot?: string;
  gitBranch?: string;
  gitDirty?: boolean;
  prNum?: number;
  prState?: string;
  prUrl?: string;
  /** PR/issue references the agent's own hooks reported for this pane, newest
   *  first. `prNum` above is the PR of the *branch*; this is what the agent
   *  actually touched, which is the only answer for a session working on a
   *  branch with no PR of its own. Nothing here is scraped from output. */
  prRefs?: { kind: 'pr' | 'issue'; num: number; url?: string; repo?: string }[];
  /** Background-only session; kept alive by the backend but not shown as a workspace. */
  isHeadless?: boolean;
  /** No work in it yet: newly started, or just `/clear`ed. */
  fresh?: boolean;
  /** Agent-reported, as of the server's last sweep. Transitions arrive as
   *  `activity` messages; this is only read to seed a tab that has just
   *  loaded and has never seen one (see renderSessions). */
  busy?: boolean;
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
  /** Folded down to one line in the sidebar (name + a dot per sheep). A
   *  display choice about the list, not about the pen: the workspace still
   *  opens in the main area exactly as before. */
  collapsed?: boolean;
  /** The field this pen stands in. Every pen ends up in exactly one; a pen
   *  without one is assigned its repository's field on the next render (see
   *  assignFields). */
  fieldId?: string;
}

/**
 * A field: the ground several pens share.
 *
 * One level above a pen and one below the flock — with two dozen panes across
 * eight repositories, "which project is this?" was a question the sidebar
 * could not answer. Fields are ordered, nameable and foldable; membership
 * lives on the pen (`Workspace.fieldId`) so there is exactly one list of pens
 * in the store and no second ordering to keep in step with it.
 */
export interface Field {
  id: string;
  name: string;
  /** Folded shut: the header alone, with the tally of what is inside. */
  collapsed?: boolean;
}

/** The field every pen starts in. Its id is fixed so it survives a reload and
 *  never multiplies. */
export const DEFAULT_FIELD_ID = 'fld:default';
export const DEFAULT_FIELD_NAME = 'All pens';

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
  sessionBusy: Record<string, boolean>;
  /** Sessions with unseen output (cleared when you switch to their workspace) */
  sessionHasUnseen: Record<string, boolean>;
  /** Sessions whose app explicitly requested attention (for example, an agent
   * finished its turn and is waiting for the user). */
  sessionNeedsAttention: Record<string, boolean>;
  sessionLastEvent: Record<string, number>;
  sessionOrder: string[];
  sessionMap: Record<string, Session>;
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
  /** Global terminal font stack — applies to every pane in every workspace.
   *  A CSS font-family value, not a single family: everything but the bundled
   *  JetBrains Mono depends on the viewing device having the font installed,
   *  so each stack ends in `monospace`. */
  terminalFontFamily: string;
  /** Global UI and terminal palette. Shared profile persistence is handled by
   * the storage compatibility layer installed before React mounts. */
  theme: AppTheme;
  /** @deprecated per-workspace zoom, superseded by the global `fontSize`. Still
   *  written by drag/move bookkeeping but no longer read for terminal sizing. */
  workspaceZooms: Record<string, number>;
  wsStatus: WsStatus;
  sheetOpen: boolean;
  /** Knowledge (notes) dialog — opens as an overlay over the active workspace
   *  rather than replacing it. */
  knowledgeOpen: boolean;
  /** Sidebar workspace list filter (Slack-style). */
  confirm: ConfirmState | null;

  setWsStatus: (status: WsStatus) => void;
  setSheetOpen: (open: boolean) => void;
  setKnowledgeOpen: (open: boolean) => void;
  /** The flock-wide search palette (⌘K). In the store rather than in App so
   *  the toolbar, the mobile sheet and the shortcut all raise the same one. */
  searchOpen: boolean;
  setSearchOpen: (open: boolean) => void;
  renderSessions: (sessions: Session[]) => void;
  setCurrentSessionId: (id: string | null) => void;
  setOpenPaneMap: (panes: (string | null)[]) => void;
  /** A pane's agent started or finished working (server `activity` message). */
  updateActivity: (sessionId: string, busy?: boolean) => void;
  showConfirm: (message: string) => Promise<boolean>;
  dismissConfirm: (result: boolean) => void;
  setCurrentInput: (sessionId: string, input: string) => void;
  /** The app in the session asked for attention (OSC 9) — for coding agents,
   *  the turn finished. */
  sessionAttention: (sessionId: string, message: string) => void;
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
  toggleWorkspaceCollapsed: (workspaceId: string) => void;

  // ── Fields (groups of pens) ──────────────────────────────────────────────
  fields: Record<string, Field>;
  fieldOrder: string[];
  /** The field the sidebar is showing. One at a time: the list stays as short
   *  as it was before fields existed, and the selector says which ground you
   *  are standing on. */
  selectedFieldId: string | null;
  setSelectedField: (fieldId: string | null) => void;
  createField: (name: string) => string;
  renameField: (fieldId: string, name: string) => void;
  /** Delete a field. Its pens fall back to Unsorted — a field is a label on
   *  the ground, and deleting one must never close what stands in it. */
  deleteField: (fieldId: string) => void;
  toggleFieldCollapsed: (fieldId: string) => void;
  reorderFields: (fieldId: string, toIndex: number) => void;
  /** Move a pen into a field, optionally at a position within it. */
  moveWorkspaceToField: (workspaceId: string, fieldId: string, beforeWorkspaceId?: string | null) => void;

  toggleZen: (sessionId: string) => void;
  exitZen: () => void;
  navigateSession: (direction: 'up' | 'down') => { workspaceId: string; paneIndex?: number } | null;

  // ── Global terminal font size (applies to every pane) ────────────────────
  setFontSize: (size: number) => void;
  setTerminalFontFamily: (family: string) => void;
  adjustFontSize: (delta: number) => void;
  resetFontSize: () => void;
  setTheme: (theme: AppTheme) => void;
}

export const DEFAULT_FONT_SIZE = (): number => 12;
export const MIN_FONT_SIZE = 8;
export const MAX_FONT_SIZE = 32;

/** Ids the active-workspace pointer may hold that are not pens. */
const VIRTUAL_IDS = new Set(['__notes__']);

// ── Storage keys ────────────────────────────────────────────────────────────
/**
 * One key per pen, plus one small key for the shape of the flock.
 *
 * The sidebar used to be a single `sheepit:workspaces` blob. Preferences are
 * read once into memory at startup and written back whole, so two browsers
 * each held their own copy of every pen and whichever saved last — and
 * something saves every couple of seconds — replaced the other's work. That
 * is how one pen stood in two different fields in two browsers: field
 * membership lives on the pen, and each browser kept overwriting the pen with
 * its own idea of it.
 *
 * Per-pen keys make the writes disjoint: `saveWorkspaces` sends only the pens
 * that actually changed, so a stale tab can no longer speak for a pen it never
 * touched. `sheepit:flock` still carries the one genuinely shared list (the
 * order, and the fields themselves), which is why the broadcast in
 * `preferences.ts` matters — it keeps that snapshot fresh instead of stale.
 */
const PEN_KEY_PREFIX      = 'sheepit:pen:';
const FLOCK_KEY           = 'sheepit:flock';
// Read-only now: the pre-split blob, kept in place as a rollback path.
const WORKSPACES_KEY      = 'sheepit:workspaces';
const WORKSPACE_ZOOM_KEY  = 'sheepit:workspace-zoom';
const LAST_WORKSPACE_KEY  = 'sheepit-last-workspace';
// Old (legacy) keys — read-only, used for one-shot migration:
const LEGACY_GRID_KEY     = 'sheepit:term-grid';
const LEGACY_ZOOM_KEY     = 'sheepit:session-zoom';
const LEGACY_LAST_KEY     = 'sheepit-last-session';

// ── Fields ──────────────────────────────────────────────────────────────────

/**
 * Give every pen a field.
 *
 * There is one field to begin with and every pen is in it; you make more when
 * you want them and move pens across yourself. An earlier cut derived fields
 * from each pane's `gitRoot`, so worktrees of one repository grouped
 * themselves — clever, and wrong: a grouping you did not ask for is one you
 * then have to undo, and it named a field after whichever checkout happened
 * to hold the git common dir.
 *
 * This runs inside renderSessions — every two seconds, against every pen — so
 * it returns the objects it was given when nothing needs placing, and the
 * caller can compare by identity and skip the write.
 *
 * It is also the migration: a payload written before fields existed simply has
 * no `fieldId` on its pens, which is the same case as a pen created a moment
 * ago, and takes the same path.
 */
export function assignFields(
  workspaces: Record<string, Workspace>,
  order: string[],
  fields: Record<string, Field>,
  fieldOrder: string[],
): { workspaces: Record<string, Workspace>; fields: Record<string, Field>; fieldOrder: string[] } {
  let nextWorkspaces = workspaces;
  let nextFields = fields;
  let nextOrder = fieldOrder;

  const place = (wsId: string, ws: Workspace) => {
    if (nextWorkspaces === workspaces) nextWorkspaces = { ...workspaces };
    nextWorkspaces[wsId] = { ...ws, fieldId: DEFAULT_FIELD_ID };
    if (!nextFields[DEFAULT_FIELD_ID]) {
      if (nextFields === fields) nextFields = { ...fields };
      nextFields[DEFAULT_FIELD_ID] = { id: DEFAULT_FIELD_ID, name: DEFAULT_FIELD_NAME };
    }
    if (!nextOrder.includes(DEFAULT_FIELD_ID)) {
      if (nextOrder === fieldOrder) nextOrder = [...fieldOrder];
      nextOrder.unshift(DEFAULT_FIELD_ID);
    }
  };

  for (const wsId of order) {
    const ws = workspaces[wsId];
    if (!ws) continue;
    // A pen whose field was deleted out from under it is homeless in exactly
    // the same way as one that never had a field.
    if (ws.fieldId && (fields[ws.fieldId] || ws.fieldId === DEFAULT_FIELD_ID)) continue;
    place(wsId, ws);
  }

  return { workspaces: nextWorkspaces, fields: nextFields, fieldOrder: nextOrder };
}

/** The pens standing in a field, in sidebar order.
 *
 *  Derived rather than stored: `workspaceOrder` is the only list of pens, so
 *  there is no second ordering that can drift out of step with it. */
export function pensInField(
  fieldId: string, workspaces: Record<string, Workspace>, order: string[],
): string[] {
  return order.filter(id => (workspaces[id]?.fieldId ?? DEFAULT_FIELD_ID) === fieldId);
}

// ── Workspace id generation ─────────────────────────────────────────────────
function generateWorkspaceId(): string {
  // Good enough uniqueness: random base36 + timestamp. Doesn't need to be
  // cryptographic — these ids just need to be unique within one browser tab.
  return 'ws-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

// ── Migration from the legacy session-id-keyed shape ────────────────────────
/** Runs once on first load after the refactor. Reads `sheepit:term-grid`
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
    const raw = preferences.getItem(LEGACY_GRID_KEY);
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
    const rawZoom = preferences.getItem(LEGACY_ZOOM_KEY);
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
    const last = preferences.getItem(LEGACY_LAST_KEY);
    if (last) lastWorkspaceId = sidToWsId.get(last) ?? null;
  } catch { /* ignore */ }

  return { workspaces, order, zooms, lastWorkspaceId };
}

// ── Persistence (new shape) ─────────────────────────────────────────────────

interface PersistedWorkspaces {
  workspaces: Record<string, Workspace>;
  order: string[];
  /** Absent in payloads written before fields existed — which is exactly the
   *  signal assignFields uses to place those pens. */
  fields?: Record<string, Field>;
  fieldOrder?: string[];
}

/**
 * Drop fields that an earlier build derived from each pane's `gitRoot`.
 *
 * Those were never asked for — the feature that made them has been removed —
 * and leaving them behind means opening the sidebar to a grouping you did not
 * choose and have to undo by hand. Their pens are untouched: cleared of a
 * field, they are placed in the default one by assignFields, which is the
 * state a fresh install has.
 */
function dropDerivedFields(p: PersistedWorkspaces): PersistedWorkspaces {
  const derived = Object.keys(p.fields ?? {}).filter(id => id.startsWith('fld:/') || id === 'fld:unsorted');
  if (derived.length === 0) return p;

  const fields = { ...(p.fields ?? {}) };
  for (const id of derived) delete fields[id];
  const gone = new Set(derived);
  const workspaces = { ...p.workspaces };
  for (const [wsId, ws] of Object.entries(workspaces)) {
    if (ws.fieldId && gone.has(ws.fieldId)) workspaces[wsId] = { ...ws, fieldId: undefined };
  }
  return {
    ...p, workspaces, fields,
    fieldOrder: (p.fieldOrder ?? []).filter(id => !gone.has(id)),
  };
}

/**
 * The pens and the flock shape exactly as the profile holds them.
 *
 * Writes are diffed against this, which is what makes them disjoint: a pen
 * whose JSON has not moved is not sent, so this tab only ever speaks for the
 * pens it actually changed. It is refreshed both when we write and when
 * another client's write arrives, so it is never our idea of the profile —
 * it is the profile.
 */
let persistedPens: Record<string, string> = {};
let persistedFlock = '';

/** Read every `sheepit:pen:*` key plus the flock shape, and re-seed the
 *  snapshot the diff is taken against. Exported for the tests, which drive the
 *  two halves of this contract — what is written and what is read back —
 *  directly, since a split that loses a pen loses a sidebar row. */
export function readPersistedWorkspaces(): PersistedWorkspaces | null {
  const pens: Record<string, string> = {};
  const workspaces: Record<string, Workspace> = {};
  for (const key of preferences.keys(PEN_KEY_PREFIX)) {
    const raw = preferences.getItem(key);
    if (!raw) continue;
    let ws: Workspace | null = null;
    try { ws = JSON.parse(raw) as Workspace; } catch { continue; }
    if (!ws?.id || !Array.isArray(ws.cells) || ws.cells.length === 0) continue;
    pens[ws.id] = raw;
    workspaces[ws.id] = ws;
  }

  const rawFlock = preferences.getItem(FLOCK_KEY);
  // Seed the diff's snapshot before anything can return: it is what the
  // profile holds, and that is true even when the answer is "nothing".
  persistedPens = pens;
  persistedFlock = rawFlock ?? '';
  if (rawFlock === null && Object.keys(workspaces).length === 0) return null;

  let flock: { order?: string[]; fields?: Record<string, Field>; fieldOrder?: string[] } = {};
  try { flock = rawFlock ? JSON.parse(rawFlock) : {}; } catch { /* an unreadable shape is no shape */ }

  // The order is the flock's, filtered to the pens that exist — and then any
  // pen the order has not heard of is appended. That pen is one another client
  // made while this list was being written; dropping it would lose a sidebar
  // row rather than merely misplace it.
  const order = (Array.isArray(flock.order) ? flock.order : []).filter(id => workspaces[id]);
  const known = new Set(order);
  for (const id of Object.keys(workspaces)) if (!known.has(id)) order.push(id);

  const deduped = dedupePens(workspaces, order);
  const result = dropDerivedFields({
    workspaces: deduped.workspaces, order: deduped.order,
    fields: flock.fields ?? {},
    fieldOrder: Array.isArray(flock.fieldOrder) ? flock.fieldOrder : [],
  });
  // Take the duplicates off the profile rather than merely ignoring them: they
  // are otherwise re-read, and re-discarded, by every client for ever.
  if (deduped.changed) {
    writeWorkspaces(result.workspaces, result.order, result.fields ?? {}, result.fieldOrder ?? []);
  }
  return result;
}

/**
 * A session belongs to exactly one pen.
 *
 * Two clients can both notice an unclaimed session in the same breath and both
 * make a pen for it — `renderSessions` claims sessions against the pens *this*
 * tab knows about, and a pen another tab made a moment ago is not yet one of
 * them. The old whole-blob write hid that: whichever tab saved last erased the
 * other's pen along with everything else. Per-pen keys keep both, so the same
 * sheep shows up twice and the flock appears to double.
 *
 * The bigger pen wins. A pen holding two, three or four sheep is one somebody
 * built on purpose; a single-pane pen over the same session is what the sweep
 * makes automatically when it thinks nothing has claimed it. Ties go to
 * whichever comes first in the shared order, so every client discards the same
 * pen without having to agree on anything else.
 */
function dedupePens(
  workspaces: Record<string, Workspace>,
  order: string[],
): { workspaces: Record<string, Workspace>; order: string[]; changed: boolean } {
  const ranked = [...order].sort((a, b) => {
    const size = (workspaces[b]?.cells.length ?? 0) - (workspaces[a]?.cells.length ?? 0);
    return size !== 0 ? size : order.indexOf(a) - order.indexOf(b);
  });

  const claimed = new Set<string>();
  const kept: Record<string, Workspace> = {};
  let changed = false;
  for (const id of ranked) {
    const ws = workspaces[id];
    if (!ws) continue;
    const cells = ws.cells.filter(cell => !claimed.has(cell));
    // Losing every sheep to bigger pens is what makes this a duplicate pen and
    // not merely an overlapping one: there is nothing left to stand in it.
    if (cells.length === 0) { changed = true; continue; }
    if (cells.length !== ws.cells.length) changed = true;
    for (const cell of cells) claimed.add(cell);
    kept[id] = cells.length === ws.cells.length
      ? ws
      // A pen that keeps only some of its sheep keeps its orientation: that is
      // what downgradeWorkspaceLayout is for. activeCell has to come back
      // inside the pen, or it points past the end of it.
      : {
          ...ws, cells,
          layout: downgradeWorkspaceLayout(ws.layout, cells.length),
          activeCell: Math.min(ws.activeCell, cells.length - 1),
        };
  }

  // Trimming a pen counts as much as dropping one: both have to be written
  // back, and identity is what the callers compare to decide there is nothing
  // to do.
  return changed
    ? { workspaces: kept, order: order.filter(id => kept[id]), changed }
    : { workspaces, order, changed };
}

/** Split the pre-split `sheepit:workspaces` blob into one key per pen. Runs
 *  once, the first time this build loads a profile written by the old one. The
 *  blob is left where it is: it costs nothing and it is the way back. */
function splitLegacyBlob(): PersistedWorkspaces | null {
  try {
    const raw = preferences.getItem(WORKSPACES_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkspaces;
    if (!parsed?.workspaces || !Array.isArray(parsed?.order)) return null;
    return dropDerivedFields(parsed);
  } catch { return null; }
}

function loadWorkspacesFromStorage(): PersistedWorkspaces {
  const stored = readPersistedWorkspaces();
  if (stored) return stored;

  const split = splitLegacyBlob();
  if (split) {
    writeWorkspaces(split.workspaces, split.order, split.fields ?? {}, split.fieldOrder ?? []);
    return split;
  }

  const migrated = migrateLegacyWorkspaces();
  if (migrated) {
    const persisted: PersistedWorkspaces = { workspaces: migrated.workspaces, order: migrated.order };
    writeWorkspaces(persisted.workspaces, persisted.order, {}, []);
    try { preferences.setItem(WORKSPACE_ZOOM_KEY, JSON.stringify(migrated.zooms)); } catch { /* quota */ }
    if (migrated.lastWorkspaceId) {
      try { preferences.setItem(LAST_WORKSPACE_KEY, migrated.lastWorkspaceId); } catch { /* quota */ }
    }
    return persisted;
  }
  return { workspaces: {}, order: [] };
}

/**
 * Write only what moved: one key per changed pen, one for the flock's shape.
 *
 * Callers hand over the whole map, as they always have — a pen that is absent
 * from it has been closed and its key is removed. What they do not do any more
 * is restate every other pen, which is the whole point: two browsers editing
 * different pens now write different keys and neither can undo the other.
 */
export function writeWorkspaces(
  workspaces: Record<string, Workspace>,
  order: string[],
  fields: Record<string, Field>,
  fieldOrder: string[],
): void {
  for (const [id, ws] of Object.entries(workspaces)) {
    const json = JSON.stringify(ws);
    if (persistedPens[id] === json) continue;
    persistedPens[id] = json;
    preferences.setItem(PEN_KEY_PREFIX + id, json);
  }
  for (const id of Object.keys(persistedPens)) {
    if (workspaces[id]) continue;
    delete persistedPens[id];
    preferences.removeItem(PEN_KEY_PREFIX + id);
  }

  const flock = JSON.stringify({ order, fields, fieldOrder });
  if (flock === persistedFlock) return;
  persistedFlock = flock;
  preferences.setItem(FLOCK_KEY, flock);
}

/** Write the sidebar's shape: pens, their order, and the fields they stand in.
 *
 *  Fields default to whatever the store currently holds, so the dozens of
 *  existing `saveWorkspaces(ws, order)` call sites keep working unchanged and
 *  cannot accidentally persist a stale field list. */
function saveWorkspaces(
  workspaces: Record<string, Workspace>,
  order: string[],
  fields?: Record<string, Field>,
  fieldOrder?: string[],
): void {
  try {
    const s = useStore.getState();
    writeWorkspaces(workspaces, order, fields ?? s.fields, fieldOrder ?? s.fieldOrder);
  } catch { /* quota */ }
}

function loadWorkspaceZooms(): Record<string, number> {
  try {
    const raw = preferences.getItem(WORKSPACE_ZOOM_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* fall through */ }
  return {};
}

function saveWorkspaceZooms(zooms: Record<string, number>): void {
  try { preferences.setItem(WORKSPACE_ZOOM_KEY, JSON.stringify(zooms)); } catch { /* quota */ }
}

// Global terminal font size — one value shared by every workspace/pane.
const FONT_SIZE_KEY = 'sheepit:font-size';
function loadFontSize(): number {
  try {
    const raw = preferences.getItem(FONT_SIZE_KEY);
    if (raw) {
      const n = parseInt(raw, 10);
      if (!Number.isNaN(n)) return Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, n));
    }
  } catch { /* fall through */ }
  return DEFAULT_FONT_SIZE();
}
function saveFontSize(size: number): void {
  try { preferences.setItem(FONT_SIZE_KEY, String(size)); } catch { /* quota */ }
}

function loadLastWorkspaceId(): string | null {
  try { return preferences.getItem(LAST_WORKSPACE_KEY); } catch { return null; }
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
  sessionBusy: {},
  sessionHasUnseen: {},
  sessionNeedsAttention: {},
  sessionLastEvent: {},
  sessionOrder: [],
  sessionMap: {},
  sessionCurrentInput: {},
  openPaneMap: {},
  workspaces: _initialWorkspaces.workspaces,
  workspaceOrder: _initialWorkspaces.order,
  fields: _initialWorkspaces.fields ?? {},
  fieldOrder: _initialWorkspaces.fieldOrder ?? [],
  selectedFieldId: null,
  zenSessionId: null,
  fontSize: loadFontSize(),
  terminalFontFamily: readTerminalFont(),
  theme: readTheme(),
  workspaceZooms: loadWorkspaceZooms(),
  wsStatus: 'connecting',
  sheetOpen: false,
  knowledgeOpen: false,
  searchOpen: false,
  confirm: null,

  setWsStatus(status: WsStatus) {
    set({ wsStatus: status });
  },

  setSheetOpen(open: boolean) {
    set({ sheetOpen: open });
  },

  setKnowledgeOpen(open: boolean) {
    set({ knowledgeOpen: open });
  },

  setSearchOpen(open: boolean) {
    set({ searchOpen: open });
  },

  renderSessions(sessions: Session[]) {
    const { currentSessionId, workspaces, workspaceOrder } = get();

    const sessionMap = Object.fromEntries(sessions.map(s => [s.id, s]));
    const liveSessionIds = new Set(sessions.map(s => s.id));
    const workspaceSessions = sessions.filter(s => !s.isHeadless);

    const sorted = [...workspaceSessions].sort((a, b) =>
      (parseInt(a.id.replace('$', ''), 10) || 0) - (parseInt(b.id.replace('$', ''), 10) || 0)
    );
    const allSorted = [...sessions].sort((a, b) =>
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
      const nextActive = Math.max(0, Math.min(ws.activeCell, prunedCells.length - 1));
      // Reuse the SAME object when nothing about this workspace changed. This
      // runs every 2 seconds against every workspace; minting fresh objects
      // regardless invalidated every selector downstream, so the whole sidebar
      // re-rendered on a timer even when the session list was identical.
      nextWorkspaces[wsId] = (!shrunk && nextLayout === ws.layout && nextActive === ws.activeCell)
        ? ws
        : { ...ws, cells: prunedCells, layout: nextLayout, activeCell: nextActive };
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

    // Nothing changed? Then don't touch the store at all.
    //
    // This is a 2-second timer, and both of the things below are expensive:
    // `saveWorkspaces` serialises every workspace to localStorage synchronously,
    // and `set` invalidates the sidebar, every chip, and every mounted pane's
    // selectors. Measured in the browser, that combination produced periodic
    // 50–124 ms main-thread stalls with the app sitting completely idle.
    // Every pen gets a field. One to begin with, holding all of them; you
    // make more and move pens across yourself. Also the migration: a payload
    // written before fields existed has no fieldId on its pens, which is the
    // same case as a pen created a second ago and takes the same path.
    const placed = assignFields(nextWorkspaces, nextWorkspaceOrder, get().fields, get().fieldOrder);
    const nextFields = placed.fields;
    const nextFieldOrder = placed.fieldOrder;
    Object.assign(nextWorkspaces, placed.workspaces);

    // The sidebar always stands in a real field. Null on a cold start (the URL
    // has not been read yet) or pointing at one that has since been deleted.
    const selected = get().selectedFieldId;
    const nextSelected = selected && nextFields[selected] ? selected : nextFieldOrder[0] ?? null;

    const prev = get();
    const fieldsUnchanged = nextFields === prev.fields && nextFieldOrder === prev.fieldOrder;
    const workspacesUnchanged =
      nextWorkspaceOrder.length === prev.workspaceOrder.length &&
      nextWorkspaceOrder.every((id, i) => prev.workspaceOrder[i] === id && prev.workspaces[id] === nextWorkspaces[id]);
    const sessionsUnchanged =
      allSorted.length === prev.sessions.length &&
      allSorted.every((s, i) => {
        const p = prev.sessions[i];
        // `busy` is deliberately absent: it rides the preview message into
        // `sessionBusy` and is never read off these objects.
        return !!p && p.id === s.id && p.name === s.name && p.path === s.path
          && p.cpuPercent === s.cpuPercent && p.memMb === s.memMb
          && p.isClaudeCode === s.isClaudeCode && p.isCodex === s.isCodex
          && p.isOpencode === s.isOpencode && p.isAntigravity === s.isAntigravity
          && p.isCopilot === s.isCopilot && p.isGrok === s.isGrok && p.isCursor === s.isCursor
          && p.gitBranch === s.gitBranch && p.gitDirty === s.gitDirty
          && p.prNum === s.prNum && p.prState === s.prState
          && p.prRefs?.length === s.prRefs?.length
          && (p.prRefs ?? []).every((r, n) => r.num === s.prRefs?.[n]?.num && r.kind === s.prRefs[n]?.kind)
          && p.last_activity === s.last_activity && p.isHeadless === s.isHeadless
          && p.fresh === s.fresh;
      });
    // Seed the busy flag for panes this tab has no opinion about yet.
    //
    // `activity` messages own transitions — they are what fires "finished" —
    // but they only arrive when something flips. A tab that loads while an
    // agent is halfway through a turn has missed the flip, and would show that
    // pane as idle until it next changed. The list says so, so use it, and
    // only for ids we have never recorded: adopting it wholesale would let the
    // 2s sweep beat the activity message to a transition and swallow the
    // notification that goes with it.
    let seededBusy: Record<string, boolean> | null = null;
    for (const s of allSorted) {
      if (s.busy === undefined || prev.sessionBusy[s.id] !== undefined) continue;
      (seededBusy ??= { ...prev.sessionBusy })[s.id] = s.busy;
    }

    const selectionUnchanged = nextSelected === prev.selectedFieldId;
    if (workspacesUnchanged && fieldsUnchanged && selectionUnchanged && sessionsUnchanged
        && !seededBusy && nextCurrentId === prev.currentSessionId) return;

    if (!workspacesUnchanged || !fieldsUnchanged) {
      saveWorkspaces(nextWorkspaces, nextWorkspaceOrder, nextFields, nextFieldOrder);
    }
    set({
      ...(seededBusy ? { sessionBusy: seededBusy } : {}),
      ...(fieldsUnchanged ? {} : { fields: nextFields, fieldOrder: nextFieldOrder }),
      ...(selectionUnchanged ? {} : { selectedFieldId: nextSelected }),
      sessions: allSorted,
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
      // The sidebar shows one field; the active pen must be in it. A jump from
      // ⌘K search, from a bleating sheep in the pasture or from ⌘↑/↓ can cross
      // fields, and landing in a pane the list does not show is how you lose
      // track of where you are.
      const field = get().workspaces[id]?.fieldId;
      if (field && field !== get().selectedFieldId) get().setSelectedField(field);
    }
    if (id) {
      try { preferences.setItem(LAST_WORKSPACE_KEY, id); } catch { /* quota */ }
      // Clear unseen for every pane in this workspace (plus the id itself as
      // a fallback, for the legacy case where `id` isn't registered as a
      // workspace yet — e.g. right after a new session appears but before
      // renderSessions has reconciled it into a workspace).
      const { sessionHasUnseen, sessionNeedsAttention, workspaces } = get();
      const toClear: string[] = [id];
      const ws = workspaces[id];
      if (ws) {
        for (const cid of ws.cells) if (cid && cid !== id) toClear.push(cid);
      }
      const hasAny = toClear.some(cid => sessionHasUnseen[cid] || sessionNeedsAttention[cid]);
      if (hasAny) {
        const nextUnseen = { ...sessionHasUnseen };
        const nextAttention = { ...sessionNeedsAttention };
        for (const cid of toClear) {
          delete nextUnseen[cid];
          delete nextAttention[cid];
        }
        set({ sessionHasUnseen: nextUnseen, sessionNeedsAttention: nextAttention });
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

  /**
   * A pane's agent started or finished working.
   *
   * This was `updatePreview`, which also carried two decoded lines of that
   * pane's output. Nothing ever rendered them: the text existed so that a
   * *change* in it could mark a background pane unread. That signal is gone
   * with it, on purpose — a shell repainting a progress bar is not news, and
   * the thing worth telling you about is a turn ending, which the agent
   * reports itself.
   */
  updateActivity(sessionId: string, busy?: boolean) {
    const { currentSessionId, workspaces } = get();

    // A session is "visible" if it belongs to the currently-active workspace.
    const isVisible = (() => {
      if (!currentSessionId) return false;
      const ws = workspaces[currentSessionId];
      if (!ws) return currentSessionId === sessionId;
      return ws.cells.includes(sessionId);
    })();

    if (busy === true) {
      // New work means a previous "waiting for you" request has been acted
      // on (or otherwise resolved), even if the workspace stays in background.
      if (get().sessionNeedsAttention[sessionId]) {
        set(s => {
          const next = { ...s.sessionNeedsAttention };
          delete next[sessionId];
          return { sessionNeedsAttention: next };
        });
      }
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
        notify('sheepit \u{1F411}', `${name} finished`);
        set(s => ({ sessionHasUnseen: { ...s.sessionHasUnseen, [sessionId]: true } }));
      }
      set(s => ({ sessionBusy: { ...s.sessionBusy, [sessionId]: false } }));
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

  setCurrentInput(sessionId: string, input: string) {
    set(s => ({ sessionCurrentInput: { ...s.sessionCurrentInput, [sessionId]: input } }));
  },

  sessionAttention(sessionId: string, message: string) {
    const { currentSessionId, workspaces, sessionMap } = get();
    const ws = currentSessionId ? workspaces[currentSessionId] : undefined;
    const isVisible = ws?.cells.includes(sessionId) || sessionId === currentSessionId;

    // The app has spoken, so this burst is over: clearing busy here also stops
    // the slower activity heuristic from firing a second "finished" for the
    // same turn a few seconds later.
    const pending = _busyTimers.get(sessionId);
    if (pending) { clearTimeout(pending); _busyTimers.delete(sessionId); }
    set(s => ({ sessionBusy: { ...s.sessionBusy, [sessionId]: false } }));

    if (isVisible) return;
    const name = sessionMap[sessionId]?.name ?? 'terminal';
    notify('sheepit \u{1F411}', message.trim() ? `${name}: ${message.slice(0, 120)}` : `${name} finished`);
    set(s => ({
      sessionHasUnseen: { ...s.sessionHasUnseen, [sessionId]: true },
      sessionNeedsAttention: { ...s.sessionNeedsAttention, [sessionId]: true },
    }));
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

  /** Show this field. Deliberately not persisted here: the URL carries it (see
   *  buildHash in App.tsx), so two tabs can stand in two different fields and
   *  a refresh keeps each where it was. A single localStorage key cannot say
   *  that — the second tab would drag the first. */
  setSelectedField(fieldId: string | null) {
    if (get().selectedFieldId === fieldId) return;
    set({ selectedFieldId: fieldId });
  },

  createField(name: string) {
    const id = `fld:new:${Date.now().toString(36)}`;
    const s = get();
    const fields = { ...s.fields, [id]: { id, name: name.trim() || 'Field' } };
    const fieldOrder = [...s.fieldOrder, id];
    saveWorkspaces(s.workspaces, s.workspaceOrder, fields, fieldOrder);
    set({ fields, fieldOrder });
    return id;
  },

  renameField(fieldId: string, name: string) {
    const s = get();
    const field = s.fields[fieldId];
    const clean = name.trim();
    if (!field || !clean || field.name === clean) return;
    const fields = { ...s.fields, [fieldId]: { ...field, name: clean } };
    saveWorkspaces(s.workspaces, s.workspaceOrder, fields, s.fieldOrder);
    set({ fields });
  },

  /** Delete a field; its pens fall back to Unsorted.
   *
   *  A field is a label on the ground, not a container that owns anything —
   *  deleting one must never close a pen, and losing work to a tidy-up would
   *  be the worst possible reading of "delete". */
  deleteField(fieldId: string) {
    const s = get();
    if (!s.fields[fieldId] || fieldId === DEFAULT_FIELD_ID) return;

    const fields = { ...s.fields };
    delete fields[fieldId];
    const fieldOrder = s.fieldOrder.filter(id => id !== fieldId);

    const orphans = pensInField(fieldId, s.workspaces, s.workspaceOrder);
    const workspaces = { ...s.workspaces };
    if (orphans.length > 0) {
      if (!fields[DEFAULT_FIELD_ID]) {
        fields[DEFAULT_FIELD_ID] = { id: DEFAULT_FIELD_ID, name: DEFAULT_FIELD_NAME };
        fieldOrder.unshift(DEFAULT_FIELD_ID);
      }
      for (const wsId of orphans) {
        workspaces[wsId] = { ...workspaces[wsId]!, fieldId: DEFAULT_FIELD_ID };
      }
    }
    saveWorkspaces(workspaces, s.workspaceOrder, fields, fieldOrder);
    set({ workspaces, fields, fieldOrder });
  },

  toggleFieldCollapsed(fieldId: string) {
    const s = get();
    const field = s.fields[fieldId];
    if (!field) return;
    const fields = { ...s.fields, [fieldId]: { ...field, collapsed: !field.collapsed } };
    saveWorkspaces(s.workspaces, s.workspaceOrder, fields, s.fieldOrder);
    set({ fields });
  },

  reorderFields(fieldId: string, toIndex: number) {
    const s = get();
    const from = s.fieldOrder.indexOf(fieldId);
    if (from < 0) return;
    const fieldOrder = [...s.fieldOrder];
    fieldOrder.splice(from, 1);
    fieldOrder.splice(Math.max(0, Math.min(toIndex > from ? toIndex - 1 : toIndex, fieldOrder.length)), 0, fieldId);
    if (fieldOrder.every((id, i) => id === s.fieldOrder[i])) return;
    saveWorkspaces(s.workspaces, s.workspaceOrder, s.fields, fieldOrder);
    set({ fieldOrder });
  },

  /**
   * Move a pen into a field.
   *
   * Membership and position are one move: `workspaceOrder` is the only list of
   * pens, and a pen whose field changed but whose position did not would draw
   * itself among the pens of a field it no longer belongs to. Dropping onto a
   * field header (no `beforeWorkspaceId`) appends to that field.
   */
  moveWorkspaceToField(workspaceId: string, fieldId: string, beforeWorkspaceId?: string | null) {
    const s = get();
    const ws = s.workspaces[workspaceId];
    if (!ws || !s.fields[fieldId]) return;

    const workspaces = { ...s.workspaces, [workspaceId]: { ...ws, fieldId } };
    const order = s.workspaceOrder.filter(id => id !== workspaceId);
    const siblings = pensInField(fieldId, workspaces, order);
    const anchor = beforeWorkspaceId && siblings.includes(beforeWorkspaceId)
      ? beforeWorkspaceId
      : siblings[siblings.length - 1] ?? null;

    let at = order.length;
    if (anchor) {
      const i = order.indexOf(anchor);
      // Dropped on a pen: land in front of it. Dropped on the header, or on a
      // field with nothing in it: land after the last pen already there.
      at = beforeWorkspaceId && siblings.includes(beforeWorkspaceId) ? i : i + 1;
    }
    order.splice(at, 0, workspaceId);

    if (order.every((id, i) => id === s.workspaceOrder[i]) && ws.fieldId === fieldId) return;
    saveWorkspaces(workspaces, order, s.fields, s.fieldOrder);
    set({ workspaces, workspaceOrder: order });
  },

  /** Fold a pen down to one line, or open it again. Persisted with the
   *  workspace, so a sidebar you have tidied stays tidy across a reload. */
  toggleWorkspaceCollapsed(workspaceId: string) {
    const s = get();
    const ws = s.workspaces[workspaceId];
    if (!ws) return;
    const nextWorkspaces = { ...s.workspaces, [workspaceId]: { ...ws, collapsed: !ws.collapsed } };
    saveWorkspaces(nextWorkspaces, s.workspaceOrder);
    set({ workspaces: nextWorkspaces });
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
    const { currentSessionId, workspaces, workspaceOrder, fieldOrder } = get();
    // Flat list: one entry per pane, in the order the sidebar draws them —
    // field by field, pens within each. ⌘↑/↓ is for reaching the next pane you
    // can see, so it has to walk the screen and not the store's own order.
    // Folded pens and folded fields still count: the shortcut reaches a pane,
    // it does not tour the sidebar.
    type Entry = { workspaceId: string; paneIndex?: number };
    const flat: Entry[] = [];
    const visitOrder = fieldOrder.length
      ? fieldOrder.flatMap(fid => pensInField(fid, workspaces, workspaceOrder))
      : workspaceOrder;
    for (const wsId of visitOrder) {
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

  setTerminalFontFamily(family: string) {
    // An empty box means "back to the default", not "no font at all".
    const next = family.trim() || DEFAULT_TERMINAL_FONT;
    try { preferences.setItem(TERMINAL_FONT_KEY, next); } catch { /* quota */ }
    set({ terminalFontFamily: next });
  },

  setTheme(theme: AppTheme) {
    try { preferences.setItem('sheepit:theme', theme); } catch { /* quota */ }
    applyTheme(theme);
    set({ theme });
  },
}));

/**
 * Take in pens another client changed.
 *
 * The store is a copy of the profile, and until the profile could speak, that
 * copy was only ever refreshed by a reload — so a second browser went on
 * showing (and re-saving) the pens as they were when it started. Now every
 * write is broadcast, and the pen and flock keys are re-read the moment one
 * lands.
 *
 * Re-reading is safe against our own edits because `preferences` is a
 * synchronous mirror: a pen this tab just changed is already in it, its own
 * echo is dropped by origin, and a key with a write still pending is never
 * overwritten by an incoming one.
 */
subscribePreferences(keys => {
  if (!keys.some(key => key === FLOCK_KEY || key.startsWith(PEN_KEY_PREFIX))) return;
  const next = readPersistedWorkspaces();
  if (!next) return;

  const s = useStore.getState();
  const fields = next.fields ?? {};
  const fieldOrder = next.fieldOrder ?? [];
  // The sidebar has to keep standing in a field that exists — the one it was
  // showing may have been deleted from the other browser.
  const selectedFieldId = s.selectedFieldId && fields[s.selectedFieldId]
    ? s.selectedFieldId
    : fieldOrder[0] ?? null;
  // The active pen likewise. renderSessions would repair both within two
  // seconds, but two seconds of pointing at a pen that is gone is two seconds
  // of an empty main area.
  const currentSessionId = s.currentSessionId
    && !VIRTUAL_IDS.has(s.currentSessionId)
    && !next.workspaces[s.currentSessionId]
      ? next.order[0] ?? null
      : s.currentSessionId;

  useStore.setState({
    workspaces: next.workspaces,
    workspaceOrder: next.order,
    fields,
    fieldOrder,
    selectedFieldId,
    currentSessionId,
  });
});

export default useStore;
