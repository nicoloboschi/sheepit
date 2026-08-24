import { useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { SquareTerminal, MoreVertical, Trash2, Star, GripHorizontal, Pencil } from 'lucide-react';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import useStore, { upgradeWorkspaceLayout, type Session, type Workspace, type GridLayout } from '../store';
import { useDndEnabled } from '../dndEnabled';

/** Last path component — the cwd "leaf" we show on each pane card so it's
 *  clear what the pane is working on without spelling out the full path. */
function cwdBasename(path: string | undefined): string | null {
  if (!path) return null;
  const trimmed = path.replace(/\/+$/, '');
  if (!trimmed) return '/';
  const parts = trimmed.split('/');
  return parts[parts.length - 1] || '/';
}

/** Compact relative time for the cramped left column — "5m", "2h", "3d", "now". */
function compactRelativeTime(ts: number | null | undefined): string {
  if (!ts) return '';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 10) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}
import ClaudeIcon from './ClaudeIcon';
import OpenAIIcon from './OpenAIIcon';
import OpenCodeIcon from './OpenCodeIcon';
import AntigravityIcon from './AntigravityIcon';
import GitHubCopilotIcon from './GitHubCopilotIcon';
import GrokIcon from './GrokIcon';
import CursorIcon from './CursorIcon';
import { preferences } from '../preferences';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
} from './ui/dropdown-menu';

/** Truncate branch names smartly, preserving prefix and last hyphenated segment(s).
 *  "fix/retain-deadlock-prevention" → "fix/…deadlock-prevention"
 *  "feature/long-name-here"        → "feature/…name-here"
 */
function truncateBranch(branch: string, maxLen = 22): string {
  if (branch.length <= maxLen) return branch;
  const slashIdx = branch.indexOf('/');
  if (slashIdx > 0 && slashIdx < branch.length - 1) {
    const prefix = branch.slice(0, slashIdx + 1); // e.g. "fix/"
    const suffix = branch.slice(slashIdx + 1);     // e.g. "retain-deadlock-prevention"
    const budget = maxLen - prefix.length - 1;      // chars available after "fix/…"
    if (budget > 6) {
      // Walk hyphen-separated segments from the end until we fill the budget
      const parts = suffix.split('-');
      let tail = '';
      for (let i = parts.length - 1; i >= 0; i--) {
        const candidate = i < parts.length - 1 ? parts[i] + '-' + tail : parts[i]!;
        if (candidate.length <= budget) {
          tail = candidate;
        } else {
          break;
        }
      }
      if (tail && tail !== suffix) {
        return prefix + '\u2026' + tail;
      }
    }
  }
  // Fallback: keep the end
  return '\u2026' + branch.slice(-(maxLen - 1));
}

const PR_STATE_COLORS: Record<string, string> = {
  OPEN: 'var(--primary)', MERGED: '#B79CCA', CLOSED: 'var(--destructive)',
};

// ── Favourites persistence ───────────────────────────────────────────────────
const FAV_KEY = 'sheepit:favourite-sessions';

export function loadFavourites(): Set<string> {
  try { return new Set(JSON.parse(preferences.getItem(FAV_KEY) || '[]')); }
  catch { return new Set(); }
}

export function saveFavourites(favs: Set<string>) {
  try { preferences.setItem(FAV_KEY, JSON.stringify([...favs])); } catch { /* quota */ }
}

export function toggleFavourite(sessionId: string): Set<string> {
  const favs = loadFavourites();
  if (favs.has(sessionId)) favs.delete(sessionId); else favs.add(sessionId);
  saveFavourites(favs);
  return favs;
}

interface SessionItemProps {
  /** The workspace this sidebar row represents. */
  workspace: Workspace;
  isActive: boolean;
  /** Called with the workspace id when the user clicks to select it. */
  onConnect: (workspaceId: string) => void;
  send: (msg: Record<string, unknown>) => void;
  isFavourite?: boolean;
  onToggleFavourite?: () => void;
}

// ── Pane layout icons ───────────────────────────────────────────────────────
// One visual that encodes both (a) the split layout of a session's panes and
// (b) the type of session running in each pane (Claude/Codex/terminal).
// Replaces the old "session icon + mini-grid" duo — each pane can now show
// its own icon because a split grid can mix AI and plain shells.

type PaneKind = 'claude' | 'codex' | 'opencode' | 'antigravity' | 'copilot' | 'grok' | 'cursor' | 'terminal';

function getPaneKind(s: Session | undefined): PaneKind {
  if (!s) return 'terminal';
  if (s.isClaudeCode) return 'claude';
  if (s.isCodex) return 'codex';
  if (s.isOpencode) return 'opencode';
  if (s.isAntigravity) return 'antigravity';
  if (s.isCopilot) return 'copilot';
  if (s.isGrok) return 'grok';
  if (s.isCursor) return 'cursor';
  return 'terminal';
}

function PaneIcon({ kind, size }: { kind: PaneKind; size: number }): React.ReactElement {
  switch (kind) {
    case 'claude':   return <ClaudeIcon size={size} />;
    case 'codex':    return <OpenAIIcon size={size} />;
    case 'opencode': return <OpenCodeIcon size={size} />;
    case 'antigravity': return <AntigravityIcon size={size} />;
    case 'copilot':    return <GitHubCopilotIcon size={size} />;
    case 'grok':       return <GrokIcon size={size} />;
    case 'cursor':   return <CursorIcon size={size} />;
    default:         return <SquareTerminal size={size} />;
  }
}

/** Per-pane card rendered inside the PaneGrid.
 *  Every pane is an equal first-class citizen — its own session, name,
 *  timestamp, icon kind, git state. No special role for cells[0]. */
/** Static "drop here" placeholder slot rendered in a workspace's mini-grid
 *  while a foreign pane is hovering and the workspace has room for one more
 *  pane. No hooks, no event handlers — purely visual. Lives outside PaneCard
 *  so we can keep PaneCard's hook order stable. */
function PanePlaceholder({ tight, gridArea }: { tight?: boolean; gridArea?: string }): React.ReactElement {
  return (
    <div
      className={['pane-card', 'pane-card-placeholder', tight && 'pane-card-tight'].filter(Boolean).join(' ')}
      style={{ gridArea }}
    >
      <span className="pane-card-placeholder-label">Drop here</span>
    </div>
  );
}

function PaneCard({
  sessionId, gridId, cellIdx, active, unseen, tight, onActivate, gridArea,
}: {
  sessionId: string;
  /** Workspace this card belongs to — needed for drag payload. */
  gridId: string;
  /** Position within the workspace's cells array. */
  cellIdx: number;
  active: boolean;
  unseen: boolean;
  /** Tight mode: narrow cells in horizontal/three/quad layouts — uses shorter
   *  branch truncation and smaller icons, but still shows git info. */
  tight?: boolean;
  /** Clicking this card should focus its pane inside the workspace. The
   *  caller is responsible for switching the active workspace too. */
  onActivate: (cellIdx: number) => void;
  /** Optional CSS grid-area name. Used by the flattened three-* layouts so
   *  cards can be direct siblings of a single grid container while still
   *  showing the visual "tall pane + 2 stacked" arrangement. */
  gridArea?: string;
}): React.ReactElement {
  const session   = useStore(s => s.sessionMap[sessionId]);
  const lastEvent = useStore(s => s.sessionLastEvent[sessionId] ?? null);
  const busy = useStore(s => !!s.sessionBusy[sessionId]);
  const needsAttention = useStore(s => !!s.sessionNeedsAttention[sessionId]);
  const kind = getPaneKind(session);
  const name = session?.name ?? '\u2026';
  const time = compactRelativeTime(lastEvent);
  const cwd = cwdBasename(session?.path);
  // Always show the cwd on its own row — it's the ground-truth "what is this
  // pane working on" signal, and the name can drift when the user renames or
  // cd's around. Even if they briefly match, keeping them both is consistent.
  const hasCwd = !!cwd;
  const hasGit = !!session?.gitBranch;
  const hasPr  = !!session?.prNum;
  const branchColor = session?.gitDirty ? 'var(--warning)' : 'var(--muted-foreground)';
  const prColor = session?.prNum ? (PR_STATE_COLORS[session.prState ?? ''] ?? 'var(--muted-foreground)') : '';
  const branchMax = tight ? 14 : 22;

  // ── dnd-kit useSortable ────────────────────────────────────────────────
  // PaneCards are sortable items inside a SortableContext rendered by their
  // workspace (see PaneGrid below). useSortable combines drag source +
  // drop target with the layout-shift animation: as the user drags a pane
  // over another, the others slide to make room. The data shape is shared
  // by both drag-source and drop-target instances — when this PaneCard is
  // the active drag, `workspaceId`/`paneIdx` describe the source pane;
  // when it's the over target, they describe the target pane. The
  // dispatcher in App.tsx onDragEnd uses the active vs over instance to
  // tell them apart.
  //
  // For transient empty placeholders (a layout slot whose backend session
  // hasn't been created yet) we still call useSortable — hooks must be
  // called unconditionally — but we pass `disabled: true` so dnd-kit
  // doesn't register it as a sortable item with an empty id.
  const dndEnabled = useDndEnabled();
  const {
    attributes, listeners, setNodeRef,
    transform, transition, isDragging, isOver,
  } = useSortable({
    id: sessionId || `__empty:${gridId}:${cellIdx}`,
    disabled: !sessionId || !dndEnabled,
    data: { kind: 'pane', sessionId, workspaceId: gridId, paneIdx: cellIdx },
  });

  return (
    <div
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      onClick={(e) => {
        // Focus this specific pane inside its workspace. Stop propagation so
        // the enclosing session-item row's handler doesn't also run — our
        // onActivate already handles the workspace switch.
        e.stopPropagation();
        onActivate(cellIdx);
      }}
      className={[
        'pane-card',
        active && 'pane-card-active',
        unseen && 'pane-card-unseen',
        busy ? 'pane-card-busy' : 'pane-card-idle',
        needsAttention && 'pane-card-needs-attention',
        tight && 'pane-card-tight',
        'pane-card-draggable',
        isDragging && 'pane-card-dragging',
        isOver && 'pane-card-drop-target',
      ].filter(Boolean).join(' ')}
      style={{
        gridArea,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0 : 1,
      }}
      title={
        [name, session?.path, session?.gitBranch]
          .filter(Boolean)
          .join(' · ')
      }
    >
      {/* Session-kind "chip" tucked into the top-left corner. Replaces the
          inline row-1 icon and lets every row start at the same X so the
          card reads as a clean aligned column. */}
      <span className="pane-card-badge" aria-hidden>
        <PaneIcon kind={kind} size={tight ? 11 : 13} />
      </span>
      <div className="pane-card-row">
        <span className="pane-card-name">{name}</span>
        <span
          className="pane-card-activity"
          aria-label={
            needsAttention ? 'Sheep is bleating — it wants your input'
              : busy ? 'Sheep is grazing — a command is running'
              : unseen ? 'Pane is idle, with output you have not read'
              : 'Pane is idle'
          }
          title={
            needsAttention ? 'Bleating — waiting for your input'
              : busy ? 'Grazing — a command is running'
              : unseen ? 'Idle — finished, and you have not read it yet'
              : 'Idle'
          }
        />
      </div>
      {(hasCwd || time) && (
        <div className="pane-card-cwd-row" title={session?.path}>
          <span className="pane-card-cwd-text">{hasCwd ? cwd : ''}</span>
          {time && <span className="pane-card-time">{time}</span>}
        </div>
      )}
      {(hasGit || hasPr) && (
        <div className="pane-card-git">
          {hasGit && (
            <span style={{ minWidth: 0, color: branchColor, display: 'flex', alignItems: 'center', gap: 4 }}>
              <span>{truncateBranch(session!.gitBranch!, branchMax)}</span>
              {session!.gitDirty && <span className="pane-card-dirty-dot" />}
            </span>
          )}
          {hasPr && (
            <span
              style={{ color: prColor, flexShrink: 0, fontWeight: 600 }}
              title={`PR #${session!.prNum} ${session!.prState?.toLowerCase() ?? ''}`}
            >
              #{session!.prNum}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Lays out PaneCards in the shape of the session's split layout.
 *
 *  All PaneCards inside this grid are wrapped in a SortableContext so that
 *  dnd-kit can animate the layout shift as the user drags a pane over its
 *  siblings. `rectSortingStrategy` works for any 2D arrangement (horizontal,
 *  vertical, three-variants, quad), so we use it uniformly. */
function PaneGrid({
  gridId, layout, cellIds, activeCell, isRowActive, unseenCells, onActivate, previewExtraSlot,
}: {
  gridId: string;
  layout: GridLayout;
  cellIds: string[];
  activeCell: number;
  isRowActive: boolean;
  unseenCells: number[];
  /** Called when a specific pane card is clicked. Caller decides what happens
   *  (typically: switch active workspace + focus that pane). */
  onActivate: (cellIdx: number) => void;
  /** When true and the workspace has < 4 panes, render the next-larger
   *  layout with one extra empty placeholder slot at the end so the user
   *  sees where a foreign pane drag will land if they drop here. */
  previewExtraSlot?: boolean;
}): React.ReactElement {
  const unseenSet = new Set(unseenCells);

  // If a foreign pane is hovering this row, virtually add a placeholder
  // cell and bump the layout up to the next size. The placeholder is the
  // last cell in the temporarily-upgraded layout.
  const showPreview = !!previewExtraSlot && cellIds.length < 4;
  const effectiveCellCount = showPreview ? cellIds.length + 1 : cellIds.length;
  const effectiveLayout: GridLayout = showPreview
    ? upgradeWorkspaceLayout(layout, effectiveCellCount)
    : layout;
  const placeholderIdx = showPreview ? cellIds.length : -1;

  const cell = (idx: number, tight = false, gridArea?: string) => {
    if (idx === placeholderIdx) {
      return (
        <PanePlaceholder
          key={`__preview__${idx}`}
          tight={tight}
          gridArea={gridArea}
        />
      );
    }
    return (
      <PaneCard
        key={cellIds[idx] ?? `empty-${idx}`}
        sessionId={cellIds[idx] ?? ''}
        gridId={gridId}
        cellIdx={idx}
        active={isRowActive && activeCell === idx}
        unseen={unseenSet.has(idx)}
        tight={tight}
        onActivate={onActivate}
        gridArea={gridArea}
      />
    );
  };

  // Filter out empties so the sortable id list never contains '' (which would
  // collide across workspaces and break dnd-kit's id uniqueness assumption).
  const sortableIds = cellIds.filter(Boolean);

  // Use the upgraded layout when previewing the extra slot.
  const layoutForRender: GridLayout = effectiveLayout;

  // All layouts render their PaneCards as DIRECT siblings of a single grid
  // container (no nested wrappers) so dnd-kit's rectSortingStrategy can
  // smoothly slide cards across the layout without being trapped in a
  // parent. The three-* variants use grid-template-areas to position the
  // "big" pane (cells[0]) and the two stacked smaller ones (cells[1], [2]).
  let body: React.ReactElement;
  if (layoutForRender === 'single') {
    body = <div className="pane-grid pane-grid-single">{cell(0)}</div>;
  } else if (layoutForRender === 'horizontal') {
    body = <div className="pane-grid pane-grid-horizontal">{cell(0, true)}{cell(1, true)}</div>;
  } else if (layoutForRender === 'vertical') {
    body = <div className="pane-grid pane-grid-vertical">{cell(0)}{cell(1)}</div>;
  } else if (layoutForRender === 'three') {
    // Big-left + 2 stacked right: areas "big b / big c"
    body = (
      <div className="pane-grid pane-grid-three-flat pane-grid-three-flat-left">
        {cell(0, true, 'big')}
        {cell(1, true, 'b')}
        {cell(2, true, 'c')}
      </div>
    );
  } else if (layoutForRender === 'three-right') {
    // Big-right + 2 stacked left: areas "b big / c big"
    body = (
      <div className="pane-grid pane-grid-three-flat pane-grid-three-flat-right">
        {cell(0, true, 'big')}
        {cell(1, true, 'b')}
        {cell(2, true, 'c')}
      </div>
    );
  } else if (layoutForRender === 'three-top') {
    // Wide-top + 2 side-by-side bottom: areas "big big / b c"
    body = (
      <div className="pane-grid pane-grid-three-flat pane-grid-three-flat-top">
        {cell(0, true, 'big')}
        {cell(1, true, 'b')}
        {cell(2, true, 'c')}
      </div>
    );
  } else if (layoutForRender === 'three-bottom') {
    // 2 side-by-side top + wide-bottom: areas "b c / big big"
    body = (
      <div className="pane-grid pane-grid-three-flat pane-grid-three-flat-bottom">
        {cell(0, true, 'big')}
        {cell(1, true, 'b')}
        {cell(2, true, 'c')}
      </div>
    );
  } else {
    body = (
      <div className="pane-grid pane-grid-quad">
        {cell(0, true)}{cell(1, true)}{cell(2, true)}{cell(3, true)}
      </div>
    );
  }

  return (
    <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
      {body}
    </SortableContext>
  );
}

/** Static visual preview of a workspace row, used by dnd-kit's DragOverlay
 *  to render a floating card under the cursor while the user drags. Has no
 *  drag/drop hooks, no dropdown menu, no click handlers — it's purely a
 *  picture of what the dragged card looks like. The real row in the list
 *  hides itself (opacity 0) while a drag is in progress so we don't get a
 *  doubled "ghost + overlay" effect. */
export function WorkspaceCardPreview({ workspace }: { workspace: Workspace }): React.ReactElement {
  const cellIds = workspace.cells;
  return (
    <div className="session-item session-item-overlay" data-session-id={workspace.id}>
      <div className="workspace-grip workspace-grip-top workspace-grip-overlay">
        <GripHorizontal size={12} />
      </div>
      <PaneGrid
        gridId={workspace.id}
        layout={workspace.layout}
        cellIds={cellIds}
        activeCell={workspace.activeCell}
        isRowActive={false}
        unseenCells={[]}
        onActivate={() => {}}
      />
    </div>
  );
}

/** Static visual preview of a single pane (session), shown by dnd-kit's
 *  DragOverlay while the user drags a pane from anywhere in the app. Mirrors
 *  the look of a sidebar PaneCard in tight mode but stands alone. */
export function PaneCardPreview({ session }: { session: Session }): React.ReactElement {
  const kind = getPaneKind(session);
  const cwd = cwdBasename(session?.path);
  return (
    <div className="pane-card pane-card-overlay" title={session.name}>
      <span className="pane-card-badge" aria-hidden>
        <PaneIcon kind={kind} size={13} />
      </span>
      <div className="pane-card-row">
        <span className="pane-card-name">{session.name}</span>
      </div>
      {cwd && (
        <div className="pane-card-cwd-row">
          <span className="pane-card-cwd-text">{cwd}</span>
        </div>
      )}
      {session.gitBranch && (
        <div className="pane-card-git">
          <span style={{ minWidth: 0, color: session.gitDirty ? 'var(--warning)' : 'var(--muted-foreground)' }}>
            {truncateBranch(session.gitBranch, 22)}
            {session.gitDirty && <span className="pane-card-dirty-dot" />}
          </span>
        </div>
      )}
    </div>
  );
}


export default function SessionItem({ workspace, isActive, onConnect, send, isFavourite, onToggleFavourite }: SessionItemProps) {
  const showConfirm = useStore(s => s.showConfirm);
  const renameWorkspace = useStore(s => s.renameWorkspace);
  const dndEnabled = useDndEnabled();
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  // dnd-kit sortable: makes the row movable in the SortableContext rendered
  // by SessionList. `listeners`/`attributes` get attached ONLY to the top
  // grip strip — that way clicks on the row body still select the workspace,
  // and pane cards inside still work as their own dnd-kit drag sources.
  // `data.kind` marks this as a workspace drag so the central onDragEnd
  // in App.tsx can dispatch correctly. Disabled entirely on mobile.
  const {
    attributes, listeners, setNodeRef: setSortableRef, transform, transition, isDragging,
  } = useSortable({ id: workspace.id, data: { kind: 'workspace' }, disabled: !dndEnabled });

  // Row also acts as a dnd-kit droppable for pane drops (merge into this
  // workspace). Disabled on mobile — no pane drags happen there.
  const { setNodeRef: setDropRef, isOver: rowIsOver, active: dropActive } = useDroppable({
    id: `workspace-row:${workspace.id}`,
    data: { kind: 'workspace-row', workspaceId: workspace.id },
    disabled: !dndEnabled,
  });
  // Don't highlight the row when its OWN pane is being dragged over it —
  // that's the same-workspace case and the pane card or terminal-cell
  // droppable should win the visual instead.
  const overlayActiveData = dropActive?.data?.current as { kind?: string; sourceWorkspaceId?: string } | undefined;
  const dragOver = rowIsOver
    && overlayActiveData?.kind === 'pane'
    && overlayActiveData.sourceWorkspaceId !== workspace.id;

  const sortableStyle: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    // Hide the original row while dragging — the DragOverlay in App.tsx
    // shows a floating preview at the cursor instead. This avoids the
    // "ghost double" effect.
    opacity: isDragging ? 0 : 1,
  };

  // Unseen per cell — each pane can independently have new output. Shallow
  // compare so this row only re-renders when its own panes' flags flip.
  const unseenCells = useStore(useShallow(s => {
    const out: number[] = [];
    workspace.cells.forEach((cid, idx) => {
      if (cid && s.sessionHasUnseen[cid]) out.push(idx);
    });
    return out;
  }));
  const unseen = unseenCells.length > 0;
  const elRef = useRef<HTMLDivElement | null>(null);
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => tick(n => n + 1), 5_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    if (isActive && elRef.current) {
      elRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }, [isActive]);

  const handleDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const confirmed = await showConfirm(
      workspace.cells.length === 1
        ? 'Close this pen?'
        : `Close this pen and all ${workspace.cells.length} panes?`
    );
    if (!confirmed) return;
    // Jump to the previous workspace before the current one vanishes from
    // the sidebar — otherwise `currentSessionId` would land on whatever the
    // reconciler picks, which is usually surprising.
    const prev = useStore.getState().navigateSession('up');
    if (prev && prev.workspaceId !== workspace.id && onConnect) onConnect(prev.workspaceId);
    // Close every backend session in the workspace; `renderSessions` will
    // reconcile the now-empty workspace and delete it on the next list_sessions.
    for (const sid of workspace.cells) {
      if (sid) send({ type: 'close_session', session_id: sid });
    }
  };

  const startRename = (e: React.MouseEvent) => {
    e.stopPropagation();
    setRenameValue(workspace.title ?? '');
    setRenaming(true);
    // Focus will be set by the useEffect below once the input renders.
  };

  const commitRename = () => {
    renameWorkspace(workspace.id, renameValue);
    setRenaming(false);
  };

  const cancelRename = () => {
    setRenaming(false);
  };

  useEffect(() => {
    if (renaming && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renaming]);

  const cellIds = workspace.cells;
  const cellCount = cellIds.length;
  const isFull = cellCount >= 4;

  // Always-visible workspace name: the user-set title, else the last path
  // segment of the first pane's cwd, else its session name.
  const firstSession = useStore(s => s.sessionMap[workspace.cells[0] ?? '']);
  const displayName =
    workspace.title
    || (firstSession?.path ? firstSession.path.replace(/\/+$/, '').split('/').pop() : undefined)
    || firstSession?.name
    || 'Pen';

  // Compose three refs onto the same DOM node: sortable (for workspace
  // reorder), droppable (for pane merge), and elRef (local).
  const setRefs = (node: HTMLDivElement | null) => {
    setSortableRef(node);
    setDropRef(node);
    elRef.current = node;
  };

  return (
    <div
      ref={setRefs}
      style={sortableStyle}
      className={[
        'session-item',
        isActive ? 'active' : '',
        unseen ? 'unseen' : '',
        dragOver ? 'pane-drop-target' : '',
        dragOver && isFull ? 'pane-drop-target-full' : '',
        !dndEnabled ? 'session-item-no-grip' : '',
      ].filter(Boolean).join(' ')}
      data-session-id={workspace.id}
      onClick={() => onConnect(workspace.id)}
    >
      {/* Workspace grip strip on the TOP edge of the card — the ONLY drag
          source for workspace reorder. Fades in on row hover and uses
          dnd-kit's listeners/attributes so reorders animate smoothly via
          the SortableContext rendered by SessionList. Hidden on mobile. */}
      {dndEnabled && (
        <div
          className="workspace-grip workspace-grip-top"
          title="Drag to reorder this pen"
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripHorizontal size={12} />
        </div>
      )}
      <div style={{ flex: '1 1 0', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        {renaming ? (
          <input
            ref={renameInputRef}
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') cancelRename();
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder="Pen name"
            className="workspace-title-input"
          />
        ) : (
          <div className="workspace-title-row">
            <span className="workspace-title" title={displayName}>{displayName}</span>
            {onToggleFavourite && (
              <button
                onClick={(e) => { e.stopPropagation(); onToggleFavourite(); }}
                className={`session-fav-btn${isFavourite ? ' is-fav' : ''}`}
                title={isFavourite ? 'Remove from favourites' : 'Add to favourites'}
              >
                <Star size={12} style={isFavourite ? { fill: 'var(--warning)' } : undefined} />
              </button>
            )}
          </div>
        )}
        <PaneGrid
          gridId={workspace.id}
          layout={workspace.layout}
          cellIds={cellIds}
          activeCell={workspace.activeCell}
          isRowActive={isActive}
          unseenCells={unseenCells}
          previewExtraSlot={dragOver && !isFull}
          onActivate={(cellIdx) => {
            onConnect(workspace.id);
            useStore.getState().setActivePane(workspace.id, cellIdx);
          }}
        />
      </div>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            onClick={(e) => e.stopPropagation()}
            className="session-action-btn"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 20, height: 20, borderRadius: 4,
              background: 'none', border: 'none', cursor: 'pointer',
              color: 'var(--muted-foreground)', flexShrink: 0,
              alignSelf: 'flex-start',
              opacity: 0,
              transition: 'opacity 0.15s',
            }}
          >
            <MoreVertical size={12} />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="right" align="start">
          <DropdownMenuItem
            onClick={startRename}
            style={{ fontSize: 12, cursor: 'pointer' }}
          >
            <Pencil size={13} />
            Rename
          </DropdownMenuItem>
          {onToggleFavourite && (
            <DropdownMenuItem
              onClick={(e) => { e.stopPropagation(); onToggleFavourite(); }}
              style={{ fontSize: 12, cursor: 'pointer' }}
            >
              <Star size={13} style={isFavourite ? { fill: 'var(--warning)', color: 'var(--warning)' } : {}} />
              {isFavourite ? 'Unfavourite' : 'Favourite'}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem
            onClick={handleDelete}
            className="text-destructive focus:text-destructive"
            style={{ fontSize: 12, cursor: 'pointer' }}
          >
            <Trash2 size={13} />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
