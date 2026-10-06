import { useEffect, useRef, useState, useCallback, memo } from 'react';
import { perf } from '../perf';
import { useSharedTick } from '../hooks/useSharedTick';
import { useShallow } from 'zustand/react/shallow';
import { SquareTerminal, MoreVertical, Trash2, GripHorizontal, Pencil, ChevronDown, ChevronRight, FolderTree, Plus, Pi, Feather } from 'lucide-react';
import { SortableContext, useSortable, rectSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useDroppable } from '@dnd-kit/core';
import useStore, { addSheepToPen, type Session, type Workspace } from '../store';
import { useDndEnabled } from '../dndEnabled';


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
import SheepStatus, { type SheepState } from './SheepStatus';
import SheepDots from './SheepDot';
import PenFence from './PenFence';
import ClaudeIcon from './ClaudeIcon';
import OpenAIIcon from './OpenAIIcon';
import OpenCodeIcon from './OpenCodeIcon';
import AntigravityIcon from './AntigravityIcon';
import GitHubCopilotIcon from './GitHubCopilotIcon';
import GrokIcon from './GrokIcon';
import CursorIcon from './CursorIcon';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSub, DropdownMenuSubTrigger, DropdownMenuSubContent,
} from './ui/dropdown-menu';


interface SessionItemProps {
  /** The workspace this sidebar row represents. */
  workspace: Workspace;
  isActive: boolean;
  /** Called with the workspace id when the user clicks to select it. */
  onConnect: (workspaceId: string) => void;
  send: (msg: Record<string, unknown>) => void;
}

// ── Pane layout icons ───────────────────────────────────────────────────────
// One visual that encodes both (a) the split layout of a session's panes and
// (b) the type of session running in each pane (Claude/Codex/terminal).
// Replaces the old "session icon + mini-grid" duo — each pane can now show
// its own icon because a split grid can mix AI and plain shells.

type PaneKind = 'claude' | 'codex' | 'pi' | 'hermes' | 'opencode' | 'antigravity' | 'copilot' | 'grok' | 'cursor' | 'terminal';

/**
 * A pane's age, and the only thing in the sidebar that re-renders on a clock.
 *
 * The tick used to live on `SessionItem`, which meant every five seconds every
 * pen re-rendered its whole subtree — the pane cards, their agent marks, their
 * context counts and a 44x38 SVG sheep each — to refresh a string like "48s".
 * Owning the tick here puts the re-render where the change is. The timer is
 * still shared, so forty of these are one interval and one tick, which is what
 * `useSharedTick` is for.
 */
function PaneAge({ sessionId }: { sessionId: string }): React.ReactElement | null {
  // Subscribed here rather than passed in. `sessionLastEvent` moves on every
  // output message an agent produces — measured at 22 a second — and while the
  // card above held the subscription, each of those re-rendered the whole card:
  // its name, agent mark, context count and sheep. Now the only thing that
  // re-renders is the string that actually changed.
  const at = useStore(s => s.sessionLastEvent[sessionId] ?? null);
  useSharedTick(5_000);
  const time = compactRelativeTime(at);
  return time ? <span className="pane-card-time">{time}</span> : null;
}

function getPaneKind(s: Session | undefined): PaneKind {
  if (!s) return 'terminal';
  if (s.isClaudeCode) return 'claude';
  if (s.isCodex) return 'codex';
  if (s.isPi) return 'pi';
  if (s.isHermes) return 'hermes';
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
    // Pi and Hermes ship no mark of their own, so they borrow a glyph rather
    // than a logo: the letter the agent is named after, and the messenger's
    // feather. Both take currentColor like the vendor icons beside them.
    case 'pi':       return <Pi size={size} />;
    case 'hermes':   return <Feather size={size} />;
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
/** `33%` when the agent reports its window, `451k` when it does not, and a dim
 *  en-dash for an empty context — see the card's info row for why. */
function formatCtx(used: number, limit?: number): string {
  if (used === 0) return '\u2013';
  if (limit && limit > 0) return `${Math.min(100, Math.round((used / limit) * 100))}%`;
  return used >= 1000 ? `${Math.round(used / 1000)}k` : String(used);
}

function ctxTitle(used: number, limit?: number): string {
  if (used === 0) return 'Nothing in this context yet';
  const n = used.toLocaleString();
  return limit && limit > 0
    ? `Context in use: ${n} of ${limit.toLocaleString()} tokens`
    : `Context in use: ${n} tokens`;
}

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

/** Memoised, and that is the whole point of the handlers above being
 *  `useCallback`s: a pen holds 5.7 cards on average, and without this every
 *  one of their bodies — the agent mark, the context count, the age and a 26px
 *  SVG sheep each — re-rendered whenever its pen did. Measured: 16.4 card
 *  renders a second against 2.87 pen renders, which is exactly 5.7 cards per
 *  pen and so accounts for every card render by its parent rather than by its
 *  own subscriptions. The three `useStore` calls inside are all narrow
 *  per-session ones, so a card whose own session changed still re-renders.
 *
 *  **An inline handler at the call site turns this off silently** — the same
 *  trap `TerminalCell`'s memo hit, where `onActivate={() => setActiveCell(i)}`
 *  meant the memo could never hold. */
function PaneCardInner({
  sessionId, gridId, cellIdx, active, unseen, tight, onActivate, gridArea,
}: {
  sessionId: string;
  /** Workspace this card belongs to — needed for drag payload. */
  gridId: string;
  /** Position within the workspace's cells array. */
  cellIdx: number;
  active: boolean;
  unseen: boolean;
  /** Tight mode: a pen holding more than a couple of sheep — uses shorter
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
  // Counted separately from the pen. A pen and the cards inside it re-render
  // for different reasons, and one number for both cannot say which.
  perf.count('render:PaneCard');
  const session   = useStore(s => s.sessionMap[sessionId]);
  const busy = useStore(s => !!s.sessionBusy[sessionId]);
  const needsAttention = useStore(s => !!s.sessionNeedsAttention[sessionId]);
  const kind = getPaneKind(session);
  const name = session?.name ?? '\u2026';
  // The last segment only. A trailing slash would otherwise pop an empty
  // string, and `/` has no segment at all \u2014 both fall out as falsy and draw
  // nothing, which is right: there is no directory name to show.
  const dir = session?.path?.replace(/\/+$/, '').split('/').pop();
  // Precedence, per CLAUDE.md: the two live states win over the two idle
  // ones, and bleating wins over grazing, so a pane is never counted twice.
  const sheepState: SheepState =
    needsAttention ? 'bleating'
      : busy ? 'grazing'
      : unseen ? 'unread'
      : 'idle';

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
        // Nothing has been asked of this agent yet — see .pane-card-fresh.
        session?.fresh && 'pane-card-fresh',
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
      {/* Two rows: the name, then everything else — agent mark, PR, dirty
          dot, context, time, and the sheep.

          The **cwd row is gone**. It was here when a pen was a grid and a card
          was the only place a pane's identity was written down; the pane's own
          bar has carried the path as the title's subtitle since the two chrome
          bars merged, so this said the same thing a second time and cost a row
          per sheep — in a single-column sidebar, a row per sheep is the whole
          budget. The full path is still on the card's `title`.

          The sheep is the last item IN the info row rather than floating over
          the card's corner: floating it meant every row above had to reserve a
          gutter for it, which in a tight card ate the name down to "…ell". */}
      <span className="pane-card-name" title={name}>{name}</span>
      {/* Where this pane is — the last path segment alone, on its own line
          under the name. Not the old cwd row coming back: that was the whole
          path, at the card's own size, and it read as a second name. This is
          one word, drawn small and quiet enough to be a subtitle rather than
          a field, which is what a directory is to the name above it.
          It earns its line because a flock is mostly worktrees of one project,
          where the name says what the pane is doing and only the directory
          says which checkout it is doing it in. Full path stays on the
          card's title. */}
      {dir && <span className="pane-card-dir" title={session?.path}>{dir}</span>}
      <div className="pane-card-info">
        <span className="pane-card-badge" aria-hidden>
          <PaneIcon kind={kind} size={tight ? 12 : 13} />
        </span>
        {/* How full the agent's context is, from its own transcript. A count
            and not a percentage: nothing the agents write down says how big
            the window is, and a limit kept by hand here would go stale the
            next time a model changes.

            **A percentage when the agent says how big its window is, a count
            when it does not.** Codex records `model_context_window`, so its
            panes read `33%` — the thing you actually want to know. Claude Code
            records no window size anywhere its transcript can be read from, so
            those panes keep the count. Guessing a limit for them would report a
            1M session at 536k tokens as 268% full. See readContextTokens.

            **Zero is drawn differently from any other number**, because the
            question you ask a list of twenty panes first is not "how full is
            this one" but "is there anything in it at all". A `0` among `451k`
            and `88k` is a number you have to read before you know it means
            nothing; a dim dash is the absence itself. The exact count is in
            the title either way.

            `!== undefined`, not a truthiness test: zero is a real answer that
            has to draw something. Absent means there is no agent to ask, and
            draws nothing. */}
        {session?.ctxTokens !== undefined ? (
          <span
            className={`pane-card-ctx${session.ctxTokens === 0 ? ' pane-card-ctx-empty' : ''}`}
            title={ctxTitle(session.ctxTokens, session.ctxLimit)}
          >
            {formatCtx(session.ctxTokens, session.ctxLimit)}
          </span>
        ) : null}
        <PaneAge sessionId={sessionId} />
        <SheepStatus state={sheepState} />
      </div>
    </div>
  );
}

/** The sheep standing in a pen, as a list of cards.
 *
 *  This used to draw them in the shape of the pen's split layout — eight
 *  variants, grid-template-areas, a "big" cell. A pen has no shape any more:
 *  it holds as many sheep as you like and shows one of them, so the card for
 *  each is a row, and the one with the ring is the one on screen.
 *
 *  Still a SortableContext, so dnd-kit can slide the cards as a pane is
 *  dragged over its siblings. `rectSortingStrategy` handles a wrapping list
 *  as happily as it handled the grid.
 */
const PaneCard = memo(PaneCardInner);

/** A card's `onActivate` must be referentially stable or its memo is off, so
 *  the drag preview — which cannot be activated — shares one noop rather than
 *  building a new empty function per render. */
const noop = (): void => {};

function PaneGrid({
  gridId, cellIds, activeCell, isRowActive, unseenCells, onActivate, previewExtraSlot, onAddSheep,
}: {
  gridId: string;
  cellIds: string[];
  activeCell: number;
  isRowActive: boolean;
  unseenCells: number[];
  /** Start another sheep in this pen. Absent on the drag preview, which is a
   *  picture of a row rather than a row you can act on. */
  onAddSheep?: () => void;
  /** Called when a specific pane card is clicked. Caller decides what happens
   *  (typically: switch active workspace + focus that pane). */
  onActivate: (cellIdx: number) => void;
  /** A foreign pane is hovering this row: show where it would land. */
  previewExtraSlot?: boolean;
}): React.ReactElement {
  const unseenSet = new Set(unseenCells);
  // The cards run two abreast, so every card in a pen holding more than one
  // sheep is half a sidebar wide and wants tight mode. A lone sheep spans both
  // columns (`:only-child` in the CSS) and stays full size.
  const tight = cellIds.length > 1;

  // Filter out empties so the sortable id list never contains '' (which would
  // collide across workspaces and break dnd-kit's id uniqueness assumption).
  const sortableIds = cellIds.filter(Boolean);

  return (
    <SortableContext items={sortableIds} strategy={rectSortingStrategy}>
      {/* `pane-grid-one` does what `:only-child` used to do on its own. The +
          strip is a second child, so a lone sheep stopped being an only child
          and lost its full-width row the moment the strip appeared. The count
          is known here, so the class says it outright rather than asking the
          CSS to reason about which siblings are cards. */}
      <div className={`pane-grid pane-grid-list${cellIds.length === 1 ? ' pane-grid-one' : ''}`}>
        {cellIds.map((sid, idx) => (
          <PaneCard
            key={sid || `empty-${idx}`}
            sessionId={sid ?? ''}
            gridId={gridId}
            cellIdx={idx}
            active={isRowActive && activeCell === idx}
            unseen={unseenSet.has(idx)}
            tight={tight}
            onActivate={onActivate}
          />
        ))}
        {previewExtraSlot && <PanePlaceholder tight={tight} />}
        {/* Another sheep in THIS pen, without going to it first. The workspace
            bar's + can only add to the pen you are standing in; from the flock
            you can see which pen the work belongs to, and this puts the new
            sheep straight in it.

            A strip rather than a card: it spans both columns and is ~20px, so
            it never disturbs the two-abreast card maths and costs a pen a
            fraction of a card's height. Paid across thirty pens, a full card
            here would have been most of a screen.

            It stops the click reaching the row, which would otherwise select
            the pen as well — adding to a pen is not the same as going to it. */}
        {onAddSheep && (
          <button
            type="button"
            className="pane-card-add"
            title="Another sheep in this pen"
            aria-label="Another sheep in this pen"
            onClick={e => { e.stopPropagation(); onAddSheep(); }}
          >
            <Plus size={11} strokeWidth={2.5} />
          </button>
        )}
      </div>
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
        cellIds={cellIds}
        activeCell={workspace.activeCell}
        isRowActive={false}
        unseenCells={[]}
        onActivate={noop}
      />
    </div>
  );
}

/** Static visual preview of a single pane (session), shown by dnd-kit's
 *  DragOverlay while the user drags a pane from anywhere in the app. Mirrors
 *  the look of a sidebar PaneCard in tight mode but stands alone. */
export function PaneCardPreview({ session }: { session: Session }): React.ReactElement {
  const kind = getPaneKind(session);
  return (
    <div className="pane-card pane-card-overlay" title={session.name}>
      <span className="pane-card-name">{session.name}</span>
      <div className="pane-card-info">
        <span className="pane-card-badge" aria-hidden>
          <PaneIcon kind={kind} size={13} />
        </span>
        <SheepStatus state="idle" />
      </div>
    </div>
  );
}


/**
 * One pen in the sidebar.
 *
 * Memoised, and that is load-bearing rather than decoration. The sidebar
 * re-renders on every session sweep, and without this every pen re-rendered
 * with it — the whole column, several times a second, because one pane
 * somewhere had new output. Each pen holds a list of pane cards, so it is the
 * widest render surface in the app.
 *
 * It works because the props are all stable: `workspace` keeps its object
 * unless that pen actually changed (`nextWorkspaces` in renderSessions),
 * `isActive` is a boolean, and `onConnect`/`send` are `useCallback`s in App
 * whose own dependencies bottom out at `[]`. A pen whose own data changed still
 * re-renders — its `useStore` selectors fire regardless of the parent, which is
 * the point: memo stops the *parent-driven* renders, not the real ones.
 *
 * If you give this component a prop built inline at the call site, you have
 * turned the memo off.
 */
function SessionItemInner({ workspace, isActive, onConnect, send }: SessionItemProps) {
  perf.count('render:SessionItem');
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

  // The fence's jitter is seeded from the workspace id, so a pen keeps the
  // same fence across re-renders, reorders and reloads.
  const fenceSeed = (() => {
    let h = 0;
    for (let i = 0; i < workspace.id.length; i++) h = (h * 31 + workspace.id.charCodeAt(i)) | 0;
    return Math.abs(h) % 997;
  })();

  const cellIds = workspace.cells;
  const collapsed = !!workspace.collapsed;

  // Both of these are what `PaneCard`'s memo rests on. They were inline
  // lambdas, so every pen render handed its cards a new function and the memo
  // could never have held. `onConnect` and `send` are `useCallback`s in App
  // that bottom out at `[]`, and a workspace id does not change, so these are
  // stable for the life of the pen.
  const activatePane = useCallback((cellIdx: number) => {
    onConnect(workspace.id);
    useStore.getState().setActivePane(workspace.id, cellIdx);
  }, [onConnect, workspace.id]);
  const addSheep = useCallback(() => {
    void addSheepToPen(workspace.id, send);
  }, [workspace.id, send]);

  const fields = useStore(s => s.fields);
  const fieldOrder = useStore(s => s.fieldOrder);

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
            <button
              className="pen-fold"
              // The chevron folds the pen; the row behind it still selects it.
              onClick={(e) => { e.stopPropagation(); useStore.getState().toggleWorkspaceCollapsed(workspace.id); }}
              title={collapsed ? 'Open this pen' : 'Fold this pen'}
              aria-label={collapsed ? 'Open this pen' : 'Fold this pen'}
              aria-expanded={!collapsed}
            >
              {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
            </button>
            <span className="workspace-title" title={displayName}>{displayName}</span>
            {/* A folded pen gives up its grid, never its state: the reason to
                look at this list is to see that something wants you. */}
            {collapsed && <SheepDots cellIds={cellIds} />}
          </div>
        )}
        {!collapsed && (
        <div className="pen-body">
          <PenFence seed={fenceSeed} active={isActive} />
          <PaneGrid
          gridId={workspace.id}
            cellIds={cellIds}
          activeCell={workspace.activeCell}
          isRowActive={isActive}
          unseenCells={unseenCells}
          previewExtraSlot={dragOver}
          onAddSheep={addSheep}
          onActivate={activatePane}
          />
        </div>
        )}
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
          {/* Moving a pen between fields lives here because the sidebar shows
              one field at a time — there is no other field on screen to drag
              it onto. */}
          {fieldOrder.length > 1 && (
            <DropdownMenuSub>
              <DropdownMenuSubTrigger style={{ fontSize: 12, cursor: 'pointer' }}>
                <FolderTree size={13} />
                Move to field
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {fieldOrder.filter(fid => fields[fid]).map(fid => (
                  <DropdownMenuItem
                    key={fid}
                    disabled={fid === workspace.fieldId}
                    onClick={() => useStore.getState().moveWorkspaceToField(workspace.id, fid)}
                    style={{ fontSize: 12, cursor: 'pointer' }}
                  >
                    {fields[fid]!.name}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
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

export default memo(SessionItemInner);
