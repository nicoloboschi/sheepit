import { useEffect, useRef, useCallback, useState, lazy, Suspense } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  pointerWithin,
  rectIntersection,
  closestCenter,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import useStore, { activeTerminalSend, activePaneCycleView } from './store';
import { requestNotificationPermission } from './utils';
import { ensureStackLoaded } from './googleFonts';
import * as sharedWs from './sharedWs';
import Sidebar from './components/Sidebar';
import { FlockBand, FlockFooter, FlockStrip } from './components/FlockChrome';
import PaneTerminal, { NOTES_SESSION_ID } from './components/PaneTerminal';
import TerminalCell from './components/TerminalCell';
// Deferred: the Knowledge dialog carries MDXEditor, which nothing else uses
// and most sessions never open.
const KnowledgeDialog = lazy(() => import('./components/KnowledgeDialog'));
import MobileKeybar from './components/MobileKeybar';
import ConfirmDialog from './components/ConfirmDialog';
import LogsModal from './components/LogsModal';
import CommandsDialog, { loadCommands } from './components/CommandsDialog';
import SessionList from './components/SessionList';
import { WorkspaceCardPreview, PaneCardPreview } from './components/SessionItem';
import { DndEnabledContext } from './dndEnabled';
import { Button } from './components/ui/button';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from './components/ui/dropdown-menu';
import {
  Settings, ScrollText, ChevronDown, SquarePlus,
  Home, Zap, TerminalSquare, ImagePlus, BookOpen,
} from 'lucide-react';
import DirectoryPicker from './components/DirectoryPicker';
import SheepIcon from './components/SheepIcon';
import { tildefy } from './utils';
import { preferences } from './preferences';

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const currentSessionId = useStore(s => s.currentSessionId);
  const attentionCount = useStore(s => Object.values(s.sessionNeedsAttention).filter(Boolean).length);

  // Keep explicit "waiting for you" requests visible even when the app is in
  // another browser tab. Generic background output intentionally stays quiet.
  useEffect(() => {
    document.title = attentionCount > 0 ? `(${attentionCount}) sheepit 🐑` : 'sheepit 🐑';
  }, [attentionCount]);

  // A terminal font fetched from Google is only a string in preferences until
  // something asks for the bytes. Do that before the panes settle, or a font
  // chosen last week comes up as the fallback and looks like it was forgotten.
  useEffect(() => { void ensureStackLoaded(useStore.getState().terminalFontFamily); }, []);

  // True while a popstate handler is running — prevents connectSession from
  // pushing another history entry for the same navigation.
  const fromPopstateRef = useRef(false);
  // Guards the one-shot "open the workspace/pane named in the URL hash" pass.
  const initialHashAppliedRef = useRef(false);
  // The hash the app was opened with, captured during the first render —
  // syncHash would otherwise overwrite it with the persisted workspace before
  // the session list arrives, and the link's target would be lost.
  const initialHashRef = useRef(window.location.hash);

  /** Build the hash fragment from workspace + zen state.
   *  Format: `#workspaceId` or `#workspaceId/zen:sessionId` */
  const buildHash = useCallback((wsId: string, zenId?: string | null) => {
    return zenId ? `#${wsId}/zen:${zenId}` : `#${wsId}`;
  }, []);

  /** Parse hash → { workspaceId, zenSessionId } */
  const parseHash = useCallback((hash: string): { workspaceId: string; zenSessionId: string | null } | null => {
    const raw = hash.replace(/^#/, '');
    if (!raw) return null;
    const [wsId, zenPart] = raw.split('/zen:');
    return { workspaceId: wsId!, zenSessionId: zenPart ?? null };
  }, []);

  /** Resolve a hash into a workspace that actually exists right now, plus the
   *  pane to open in zen. Workspace ids are per-browser (randomly minted), so
   *  a link opened elsewhere may not know our id — in that case fall back to
   *  whichever workspace owns the zen pane. Returns null when neither
   *  resolves, and drops a zen id that isn't a pane of the target workspace
   *  (a stale one would leave zen state on with nothing rendered). */
  const resolveHashTarget = useCallback((hash: string) => {
    const parsed = parseHash(hash);
    if (!parsed) return null;
    const { workspaces, workspaceOrder } = useStore.getState();
    let workspaceId: string | null = workspaces[parsed.workspaceId] ? parsed.workspaceId : null;
    if (!workspaceId && parsed.zenSessionId) {
      workspaceId = workspaceOrder.find(id => workspaces[id]?.cells.includes(parsed.zenSessionId!)) ?? null;
    }
    if (!workspaceId) return null;
    const cells = workspaces[workspaceId]!.cells;
    const zenSessionId = parsed.zenSessionId && cells.includes(parsed.zenSessionId) ? parsed.zenSessionId : null;
    return { workspaceId, zenSessionId };
  }, [parseHash]);

  /** Push current workspace + zen state into the URL hash. */
  const syncHash = useCallback(() => {
    if (fromPopstateRef.current) return;
    // Don't overwrite the opened link before we've had a chance to honour it.
    if (!initialHashAppliedRef.current && initialHashRef.current) return;
    const { currentSessionId: wsId, zenSessionId } = useStore.getState();
    if (!wsId) return;
    const next = buildHash(wsId, zenSessionId);
    if (window.location.hash !== next) {
      history.pushState(null, '', next);
    }
  }, [buildHash]);

  const connectSession = useCallback((sessionId: string) => {
    useStore.getState().setCurrentSessionId(sessionId);
    preferences.setItem('sheepit-last-session', sessionId);
    syncHash();
    // Focus the terminal after session switch
    setTimeout(() => window.dispatchEvent(new CustomEvent('sheepit:terminal-tab-active')), 100);
  }, [syncHash]);

  // Knowledge (notes) is an overlay dialog over the active workspace, not a
  // context switch — toggled from the status bar.
  const knowledgeOpen = useStore(s => s.knowledgeOpen);
  const setKnowledgeOpen = useStore(s => s.setKnowledgeOpen);
  // Sanitize stale state: older builds used '__notes__' as a pseudo-workspace.
  useEffect(() => {
    if (useStore.getState().currentSessionId === NOTES_SESSION_ID) useStore.getState().setCurrentSessionId(null);
  }, []);

  // Sync hash whenever zen mode changes.
  const zenSessionId = useStore(s => s.zenSessionId);
  useEffect(() => { syncHash(); }, [zenSessionId, syncHash]);

  // Browser back/forward: read workspace + zen state from hash.
  useEffect(() => {
    const onPopState = () => {
      const target = resolveHashTarget(window.location.hash);
      if (!target) return;
      const store = useStore.getState();
      fromPopstateRef.current = true;
      store.setCurrentSessionId(target.workspaceId);
      preferences.setItem('sheepit-last-session', target.workspaceId);
      // Restore or clear zen mode
      if (target.zenSessionId && store.zenSessionId !== target.zenSessionId) {
        store.toggleZen(target.zenSessionId);
      } else if (!target.zenSessionId && store.zenSessionId) {
        store.exitZen();
      }
      setTimeout(() => window.dispatchEvent(new CustomEvent('sheepit:terminal-tab-active')), 100);
      fromPopstateRef.current = false;
    };
    // `hashchange` covers pasting a link into the address bar of an already
    // open tab; `popstate` covers back/forward.
    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onPopState);
    };
  }, [resolveHashTarget]);

  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    const store = useStore.getState();
    switch (msg.type) {
      case 'sessions': {
        store.renderSessions(msg.sessions as any); // eslint-disable-line @typescript-eslint/no-explicit-any
        const sessionList = msg.sessions as any[]; // eslint-disable-line @typescript-eslint/no-explicit-any
        const visibleSessionList = sessionList.filter(session => !session.isHeadless);
        if (visibleSessionList.length === 0) break;

        // The URL hash wins over the persisted last workspace, but only on the
        // first `sessions` message — after that the user's own navigation owns
        // the selection and re-applying the hash would fight it.
        if (!initialHashAppliedRef.current) {
          initialHashAppliedRef.current = true;
          const hashTarget = resolveHashTarget(initialHashRef.current);
          if (hashTarget) {
            connectSession(hashTarget.workspaceId);
            if (hashTarget.zenSessionId && useStore.getState().zenSessionId !== hashTarget.zenSessionId) {
              useStore.getState().toggleZen(hashTarget.zenSessionId);
            }
            break;
          }
        }

        if (!store.currentSessionId) {
          const stateAfterRender = useStore.getState();
          // Priority: localStorage > first session
          const lastId = preferences.getItem('sheepit-last-session');
          const lastTarget = lastId && stateAfterRender.workspaces[lastId] ? lastId : null;
          const targetId = lastTarget ?? visibleSessionList[0]?.id;
          if (targetId) connectSession(targetId);
        }
        break;
      }
      case 'session_created': {
        const newId = msg.session_id as string;
        const path = msg.path as string | null;
        // Headless sessions are intentionally not given a workspace or selected.
        // They remain backend-live and can only exist once (enforced server-side).
        if (msg.headless === true) {
          // It has no workspace row by design, so its only presentation is Zen.
          // The following sessions refresh fills sessionMap for TerminalCell.
          if (useStore.getState().zenSessionId !== newId) store.toggleZen(newId);
          break;
        }
        // Optimistically add session to the store so it appears in sidebar immediately
        if (!store.sessionMap[newId]) {
          const optimistic = {
            id: newId,
            name: path ? path.split('/').pop() || 'terminal' : 'terminal',
            path: path || undefined,
            last_activity: Date.now() / 1000,
          };
          store.renderSessions([...Object.values(store.sessionMap), optimistic]);
        }
        // After renderSessions reconciles, look up which workspace contains
        // this new session. If it's already part of an existing workspace
        // (because TerminalGrid.ensureCells appended it synchronously as a
        // split), don't switch to it — the user is mid-split. Otherwise the
        // reconciler just minted a new single-pane workspace for it, so
        // jump there.
        const stateAfter = useStore.getState();
        let owningWorkspaceId: string | null = null;
        for (const wsId of stateAfter.workspaceOrder) {
          const ws = stateAfter.workspaces[wsId];
          if (ws && ws.cells.includes(newId)) { owningWorkspaceId = wsId; break; }
        }
        // Only auto-switch when the owning workspace is a fresh single-pane
        // workspace (i.e. cell 0 is this new session id) — that's the
        // "brand-new sidebar row" case. Split-append cases leave focus alone.
        if (owningWorkspaceId) {
          const ws = stateAfter.workspaces[owningWorkspaceId];
          if (ws && ws.cells.length === 1 && ws.cells[0] === newId) {
            connectSession(owningWorkspaceId);
          }
        }
        break;
      }
      case 'activity':
        store.updateActivity(msg.session_id as string, msg.busy as boolean | undefined);
        break;
      case 'current_input':
        store.setCurrentInput(msg.session_id as string, msg.input as string);
        break;
      case 'attention':
        // The app said it's done (OSC 9). Exact, and immediate — no waiting for
        // the busy heuristics to notice the session went quiet.
        store.sessionAttention(msg.session_id as string, msg.message as string);
        break;
      default: break;
    }
  }, [connectSession, resolveHashTarget]);

  const send = useCallback((msg: Record<string, unknown>) => sharedWs.send(msg), []);

  // Initialize shared WebSocket and subscribe to global messages
  useEffect(() => {
    sharedWs.init();
    const unsub = sharedWs.subscribeGlobal(handleMessage);
    return () => { unsub(); sharedWs.destroy(); };
  }, [handleMessage]);

  useEffect(() => {
    document.addEventListener('click', requestNotificationPermission, { once: true });
    return () => document.removeEventListener('click', requestNotificationPermission);
  }, []);

  // Visual viewport handling (mobile keyboard)
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let lastH = 0;
    const update = () => {
      const h = vv.height + vv.offsetTop;

      // An open keyboard sits on top of the navigation bar, so once the visual
      // viewport has already shrunk by the keyboard height, subtracting the
      // bottom safe-area inset as well would leave a dead gap the height of
      // the nav bar. Collapse it while the keyboard is up. Computed before the
      // early-returns below so it stays correct even when they skip the --vvh
      // write.
      const keyboardOpen = window.innerHeight - vv.height > 120;
      document.documentElement.style.setProperty(
        '--safe-bottom-eff',
        keyboardOpen ? '0px' : 'var(--safe-bottom)',
      );

      if (document.querySelector('[data-radix-popper-content-wrapper],[data-radix-dialog-content]')) return;
      if (Math.abs(h - lastH) < 10 && lastH !== 0) return;
      lastH = h;
      document.documentElement.style.setProperty('--vvh', `${h}px`);
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => { vv.removeEventListener('resize', update); vv.removeEventListener('scroll', update); };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (!e.metaKey) return;
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const next = useStore.getState().navigateSession(e.key === 'ArrowUp' ? 'up' : 'down');
        if (next) {
          connectSession(next.workspaceId);
          if (next.paneIndex != null) {
            useStore.getState().setActivePane(next.workspaceId, next.paneIndex);
          }
        }
        return;
      }
      if (e.key === 'n') {
        e.preventDefault();
        // "New session" — inherits the cwd of the currently-active pane inside
        // the currently-active workspace. Workspaces themselves have no path.
        const { currentSessionId, sessionMap, workspaces } = useStore.getState();
        const ws = currentSessionId ? workspaces[currentSessionId] : undefined;
        const activeSid = ws ? ws.cells[ws.activeCell] ?? ws.cells[0] ?? null : null;
        const path = activeSid ? sessionMap[activeSid]?.path ?? null : null;
        sharedWs.send({ type: 'create_session', path, from_session_id: activeSid });
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        activePaneCycleView.current(e.key === 'ArrowRight' ? 'right' : 'left');
        return;
      }
      // Zoom shortcuts — Cmd +, Cmd -, Cmd 0 (reset). Match both Plus/Equal and numpad.
      // Font size is global, so these apply to every pane in every workspace.
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        useStore.getState().adjustFontSize(1);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        useStore.getState().adjustFontSize(-1);
        return;
      }
      if (e.key === '0') {
        e.preventDefault();
        useStore.getState().resetFontSize();
        return;
      }
    };
    window.addEventListener('keydown', down);
    return () => window.removeEventListener('keydown', down);
  }, [connectSession]); // eslint-disable-line

  // ── Global DnD wiring ──────────────────────────────────────────────────
  // One DndContext spans the whole app so panes can be dragged from
  // anywhere (sidebar mini-cards or pane headers in the terminal area)
  // and dropped anywhere (other panes for swap, other workspaces for
  // merge, sidebar gaps for extract). Workspace reorder lives in the
  // same context — it just uses dnd-kit's SortableContext (in SessionList).
  const [activeDrag, setActiveDrag] = useState<{
    kind: 'workspace'; id: string;
  } | {
    kind: 'pane'; sessionId: string; workspaceId: string; paneIdx: number;
  } | null>(null);

  // Mobile = narrow viewport. All dnd-kit interactivity turns off on mobile
  // via the DndEnabledContext below — on touch + small screens the drag
  // affordances are hard to hit and users just want to tap to switch.
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const dndEnabled = !isMobile;

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  /** Cursor-driven collision detection.
   *
   *  `closestCenter` (the dnd-kit default) measures the distance between the
   *  active drag's bounding-rect center and each droppable's center, then
   *  picks the closest. That's a poor fit for our sidebar:
   *    - Gap drop zones are 56 px tall, sandwiched between full workspace
   *      cards (100+ px tall). When the cursor is over a gap, the gap's
   *      center is often *farther* from the active rect's center than the
   *      neighboring cards' centers, so the gap loses the collision check.
   *    - Mini PaneCards inside a workspace are tiny; the active rect of a
   *      pane drag is much larger, so the same problem hits there too.
   *
   *  `pointerWithin` instead checks which droppable the *cursor* is inside.
   *  That matches user intuition: if my cursor is over the gap, drop on the
   *  gap. We fall back to `rectIntersection` (then `closestCenter`) only
   *  when no droppable contains the pointer — covers keyboard sensor and
   *  edge cases where the user is dragging "near" but not "inside" a target.
   *
   *  Specificity filter: when the pointer is over a pane card inside a
   *  workspace row, BOTH the card and the row are returned by pointerWithin
   *  (the row is the card's parent droppable). dnd-kit picks the first one
   *  as the "over" target — and if that's the row catch-all instead of the
   *  card, the card's `useSortable` shift animation never fires. We filter
   *  out `workspace-row` hits whenever any more-specific droppable is also
   *  hit, so panes/gaps/terminal-cells always win over the row. */
  const collisionDetection: CollisionDetection = useCallback((args) => {
    const getKind = (id: string | number): string | undefined => {
      for (const c of args.droppableContainers) {
        if (c.id === id) {
          return (c.data?.current as { kind?: string } | undefined)?.kind;
        }
      }
      return undefined;
    };

    const filterRowsIfSpecific = (collisions: ReturnType<typeof pointerWithin>) => {
      const specific = collisions.filter(c => getKind(c.id) !== 'workspace-row');
      return specific.length > 0 ? specific : collisions;
    };

    const pointerHits = pointerWithin(args);
    if (pointerHits.length > 0) return filterRowsIfSpecific(pointerHits);
    const rectHits = rectIntersection(args);
    if (rectHits.length > 0) return filterRowsIfSpecific(rectHits);
    return filterRowsIfSpecific(closestCenter(args));
  }, []);

  const handleDragStart = (e: DragStartEvent) => {
    const data = e.active.data.current as
      | { kind: 'workspace' }
      | { kind: 'pane'; sessionId: string; workspaceId: string; paneIdx: number }
      | undefined;
    if (data?.kind === 'workspace') {
      setActiveDrag({ kind: 'workspace', id: String(e.active.id) });
    } else if (data?.kind === 'pane') {
      setActiveDrag({
        kind: 'pane',
        sessionId: data.sessionId,
        workspaceId: data.workspaceId,
        paneIdx: data.paneIdx,
      });
    }
  };

  const handleDragCancel = () => setActiveDrag(null);

  const handleDragEnd = (e: DragEndEvent) => {
    setActiveDrag(null);
    const { active, over } = e;
    if (!over) return;

    const aData = active.data.current as
      | { kind: 'workspace' }
      | { kind: 'pane'; sessionId: string; workspaceId: string; paneIdx: number }
      | undefined;
    const oData = over.data.current as
      | { kind: 'workspace' }
      | { kind: 'pane'; sessionId: string; workspaceId: string; paneIdx: number }
      | { kind: 'terminal-cell'; workspaceId: string; paneIdx: number }
      | { kind: 'workspace-row'; workspaceId: string }
      | { kind: 'gap'; prevId: string | null; nextId: string | null }
      | undefined;
    if (!aData || !oData) return;

    const store = useStore.getState();

    // ── Workspace drag (sortable) ─────────────────────────────────────
    if (aData.kind === 'workspace') {
      if (oData.kind !== 'workspace') return;
      if (active.id === over.id) return;
      const order = store.workspaceOrder;
      const fromIdx = order.indexOf(String(active.id));
      const overIdx = order.indexOf(String(over.id));
      if (fromIdx < 0 || overIdx < 0) return;
      const insertAt = fromIdx < overIdx ? overIdx + 1 : overIdx;
      store.reorderWorkspaces(String(active.id), insertAt);
      return;
    }

    // ── Pane drag ─────────────────────────────────────────────────────
    if (aData.kind !== 'pane') return;
    const sourceWorkspaceId = aData.workspaceId;
    const sourceIdx = aData.paneIdx;

    switch (oData.kind) {
      case 'pane': {
        // The over target is another PaneCard. Its workspaceId/paneIdx
        // describe the target pane (NOT the source — both source and target
        // happen to share the same data shape since useSortable is used
        // for both directions).
        const targetWsId = oData.workspaceId;
        const targetIdx = oData.paneIdx;
        if (targetWsId === sourceWorkspaceId) {
          if (targetIdx !== sourceIdx) {
            // arrayMove semantics — matches the sortable animation that
            // showed cards sliding out of the way as the user dragged.
            store.reorderPaneInWorkspace(targetWsId, sourceIdx, targetIdx);
          }
        } else {
          const ok = store.movePaneBetweenWorkspaces({
            sourceId: sourceWorkspaceId, sourceIdx, targetId: targetWsId,
          });
          if (ok) connectSession(targetWsId);
        }
        return;
      }
      case 'terminal-cell': {
        const { workspaceId: targetWsId, paneIdx: targetIdx } = oData;
        // Terminal-area swap is intentionally same-workspace only — the
        // source workspace would be hidden, so cross-workspace drops there
        // are confusing. Sidebar mini-cards handle cross-workspace drops.
        if (targetWsId === sourceWorkspaceId && targetIdx !== sourceIdx) {
          store.reorderPaneInWorkspace(targetWsId, sourceIdx, targetIdx);
        }
        return;
      }
      case 'workspace-row': {
        const { workspaceId: targetWsId } = oData;
        if (targetWsId === sourceWorkspaceId) return;
        const ok = store.movePaneBetweenWorkspaces({
          sourceId: sourceWorkspaceId, sourceIdx, targetId: targetWsId,
        });
        if (ok) connectSession(targetWsId);
        return;
      }
      case 'gap': {
        const { prevId, nextId } = oData;
        const order = useStore.getState().workspaceOrder;
        let insertAt = order.length;
        if (nextId) {
          const i = order.indexOf(nextId);
          if (i >= 0) insertAt = i;
        } else if (prevId) {
          const i = order.indexOf(prevId);
          if (i >= 0) insertAt = i + 1;
        }
        const newId = store.extractPaneToNewWorkspace({
          sourceId: sourceWorkspaceId, sourceIdx, insertAt,
        });
        if (newId) connectSession(newId);
        return;
      }
    }
  };

  // Resolve the dragged workspace / pane for the DragOverlay preview.
  const draggedWorkspace = activeDrag?.kind === 'workspace'
    ? useStore.getState().workspaces[activeDrag.id]
    : null;
  const draggedPaneSession = activeDrag?.kind === 'pane'
    ? useStore.getState().sessionMap[activeDrag.sessionId]
    : null;

  return (
    <DndEnabledContext.Provider value={dndEnabled}>
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div
        className="flex overflow-hidden"
        style={{
          // --safe-* come from env(safe-area-inset-*) (see style.css): 0 in a
          // desktop browser, the real system-bar sizes in the Android app and
          // on notched phones. Without them the workspace header hides under
          // the status bar and the mobile keybar under the gesture pill.
          // --safe-bottom-eff collapses to 0 while the keyboard is open, since
          // --vvh has already shrunk past the navigation bar by then.
          height: 'calc(var(--vvh, 100dvh) - var(--safe-top) - var(--safe-bottom-eff, var(--safe-bottom)))',
          marginTop: 'var(--safe-top)',
          transition: 'height 0.25s ease',
          background: 'var(--background)', color: 'var(--foreground)',
          fontFamily: "'Space Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 13,
        }}
      >
        <Sidebar onConnect={connectSession} send={send} />

        <div className="flex flex-col flex-1 min-w-0">
          <MobileTopBar onConnect={connectSession} send={send} />

          <PaneTerminal
            sessionId={currentSessionId}
            send={send}
          />
          <HeadlessZenTerminal send={send} />

          <MobileKeybar sendRef={{ current: sharedWs.send }} termRef={{ current: null }} />
        </div>

        <ConfirmDialog />
        {knowledgeOpen && (
          <Suspense fallback={null}>
            <KnowledgeDialog onClose={() => setKnowledgeOpen(false)} />
          </Suspense>
        )}
      </div>

      {/* DragOverlay floats with the cursor for both workspace and pane
          drags. Static, non-interactive previews so dnd-kit doesn't try to
          re-register the same id while a drag is active. */}
      <DragOverlay dropAnimation={{ duration: 180, easing: 'cubic-bezier(0.18, 0.67, 0.6, 1.22)' }}>
        {draggedWorkspace ? <WorkspaceCardPreview workspace={draggedWorkspace} /> : null}
        {draggedPaneSession ? <PaneCardPreview session={draggedPaneSession} /> : null}
      </DragOverlay>
    </DndContext>
    </DndEnabledContext.Provider>
  );
}

/** Headless sessions deliberately have no workspace, but Zen gives their
 * terminal a focused, full-screen surface immediately after creation. */
function HeadlessZenTerminal({ send }: { send: (msg: Record<string, unknown>) => void }) {
  const sessionId = useStore(s => s.zenSessionId);
  const isHeadless = useStore(s => !!(s.zenSessionId && s.sessionMap[s.zenSessionId]?.isHeadless));

  if (!sessionId || !isHeadless) return null;
  return (
    <TerminalCell
      sessionId={sessionId}
      gridId={`__headless__:${sessionId}`}
      paneIndex={0}
      isActive
      onActivate={() => {}}
      onClose={() => {
        useStore.getState().exitZen();
        send({ type: 'close_session', session_id: sessionId });
      }}
    />
  );
}

// ── MobileTopBar ──────────────────────────────────────────────────────────────

interface MobileTopBarProps {
  onConnect: (id: string) => void;
  send: (msg: Record<string, unknown>) => void;
}

function MobileTopBar({ onConnect, send }: MobileTopBarProps) {
  const wsStatus         = useStore(s => s.wsStatus);
  const currentSessionId = useStore(s => s.currentSessionId);
  const sessionMap       = useStore(s => s.sessionMap);
  const sessions         = useStore(s => s.sessions);
  const workspaces       = useStore(s => s.workspaces);
  const workspaceOrder   = useStore(s => s.workspaceOrder);
  const workspaceIdx     = currentSessionId ? workspaceOrder.indexOf(currentSessionId) : -1;
  const swipeTouchRef    = useRef<{ x: number; y: number } | null>(null);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    swipeTouchRef.current = { x: e.touches[0]!.clientX, y: e.touches[0]!.clientY };
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (!swipeTouchRef.current) return;
    const dx = e.changedTouches[0]!.clientX - swipeTouchRef.current.x;
    const dy = e.changedTouches[0]!.clientY - swipeTouchRef.current.y;
    swipeTouchRef.current = null;
    if (Math.abs(dx) < 40 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    const next = useStore.getState().navigateSession(dx < 0 ? 'down' : 'up');
    if (next) {
      onConnect(next.workspaceId);
      if (next.paneIndex != null) {
        useStore.getState().setActivePane(next.workspaceId, next.paneIndex);
      }
    }
  }, [onConnect]);

  const [showSessions, setShowSessions] = useState(false);
  const [showLogs,     setShowLogs]     = useState(false);
  const [showCommands, setShowCommands] = useState(false);
  const [commands,     setCommands]     = useState(loadCommands);
  const [version,      setVersion]      = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/version').then(r => r.json()).then(d => setVersion(d.version)).catch(() => {});
  }, []);

  const workspace = currentSessionId ? workspaces[currentSessionId] : undefined;
  const activeSessionId = workspace ? workspace.cells[workspace.activeCell] : currentSessionId;
  const session  = activeSessionId ? sessionMap[activeSessionId] : undefined;
  const username = sessions.find(s => s.username)?.username;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);

  const handleFileUpload = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    if (files.length === 0 || !currentSessionId) return;
    setUploadStatus(`Uploading ${files.length} file${files.length > 1 ? 's' : ''}...`);
    try {
      // Get session CWD
      let cwd = '/tmp';
      try {
        const res = await fetch(`/api/fs/${encodeURIComponent(currentSessionId)}/browse`);
        const data = await res.json();
        if (data.cwd) cwd = data.cwd;
      } catch { /* fallback to /tmp */ }

      const paths: string[] = [];
      for (const file of files) {
        setUploadStatus(`Uploading ${file.name} (${(file.size / 1024).toFixed(0)}KB)...`);
        const res = await fetch(`/api/fs/upload?dir=${encodeURIComponent(cwd)}&name=${encodeURIComponent(file.name)}`, {
          method: 'POST',
          body: file,
        });
        const data = await res.json();
        if (data.ok && data.path) {
          paths.push(data.path);
        } else {
          setUploadStatus(`Failed: ${data.error || 'unknown error'}`);
          setTimeout(() => setUploadStatus(null), 3000);
          return;
        }
      }

      if (paths.length > 0) {
        const escaped = paths.map(p => p.includes(' ') ? `"${p}"` : p).join(' ');
        activeTerminalSend.current({ type: 'input', data: escaped + ' ' });
        setUploadStatus(`Uploaded ${paths.length} file${paths.length > 1 ? 's' : ''}`);
      }
      setTimeout(() => setUploadStatus(null), 2000);
    } catch (err) {
      setUploadStatus(`Error: ${err}`);
      setTimeout(() => setUploadStatus(null), 3000);
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  }, [currentSessionId]);

  return (
    <>
      <header
        className="md:hidden flex flex-col shrink-0 border-b"
        style={{ background: 'var(--card)', borderColor: 'var(--border)' }}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        <div className="flex items-center gap-1 px-2" style={{ height: 48 }}>
          <span className={`status-dot ${wsStatus} shrink-0`} style={{ marginLeft: 4, marginRight: 2 }} />
          <button
            onClick={() => setShowSessions(true)}
            className="flex items-center gap-1 flex-1 min-w-0 rounded-md px-2 py-1 hover:bg-accent text-left"
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            {workspaceIdx >= 0 && (
              <span style={{ fontSize: 10, color: 'var(--muted-foreground)', fontWeight: 600, flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                #{workspaceIdx + 1}{workspaceOrder.length > 1 && <span style={{ opacity: 0.55 }}>/{workspaceOrder.length}</span>}
              </span>
            )}
            <span key={currentSessionId} className="session-name-slide flex-1 min-w-0 truncate" style={{ fontSize: 13 }}>
              {workspace?.title ? workspace.title
                : session ? session.name : 'No session'}
            </span>
            {/* No pane count here: on a phone the panes are right there on
                screen, so counting them is a label for something you can see. */}
            {session?.path && (
              <span className="session-path shrink-0" style={{ fontSize: 10, maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {tildefy(session.path, username)}
              </span>
            )}
            <ChevronDown size={13} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
          </button>

          <Button
            variant="ghost" size="icon"
            className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground"
            title="Upload file"
            disabled={!!uploadStatus}
            onClick={() => fileInputRef.current?.click()}
          >
            <ImagePlus size={14} />
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*,video/*,.pdf,.txt,.json,.csv,.log"
            multiple
            onChange={handleFileUpload}
            style={{ position: 'absolute', width: 1, height: 1, opacity: 0, overflow: 'hidden', pointerEvents: 'none' }}
          />

          <DropdownMenu onOpenChange={(open) => { if (open) setCommands(loadCommands()); }}>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground">
                <Zap size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" className="w-52">
              {commands.length === 0
                ? <DropdownMenuItem disabled><span className="text-xs text-muted-foreground">No saved commands</span></DropdownMenuItem>
                : commands.map(c => (
                  <DropdownMenuItem key={c.id} onClick={() => {
                    activeTerminalSend.current({ type: 'input', data: c.command + '\r' });
                  }}>
                    <TerminalSquare size={13} /><span className="truncate text-xs">{c.name}</span>
                  </DropdownMenuItem>
                ))
              }
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowCommands(true)}>
                <Settings size={13} /> Manage commands&hellip;
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground">
                <SquarePlus size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" className="w-72 !overflow-hidden p-0">
              <div className="px-1 pt-1">
                <DropdownMenuItem onClick={() => send({ type: 'create_session', path: null })}>
                  <Home size={14} /><span className="text-xs">Home</span>
                </DropdownMenuItem>
              </div>
              {(() => {
                const dirs = [...new Set(sessions.map(s => s.path).filter(Boolean))] as string[];
                return dirs.length > 0 && <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-[10px] text-muted-foreground font-normal uppercase tracking-wider px-3 py-0.5">Recent</DropdownMenuLabel>
                  <div className="overflow-y-auto px-1" style={{ maxHeight: 100 }}>
                    {dirs.map(path => (
                      <DropdownMenuItem key={path} onClick={() => send({ type: 'create_session', path })}>
                        <span className="truncate font-mono text-xs">{tildefy(path, username)}</span>
                      </DropdownMenuItem>
                    ))}
                  </div>
                </>;
              })()}
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-[10px] text-muted-foreground font-normal uppercase tracking-wider px-3 py-0.5">Browse</DropdownMenuLabel>
              <DirectoryPicker
                initialPath="~"
                onSelect={(path) => send({ type: 'create_session', path })}
              />
            </DropdownMenuContent>
          </DropdownMenu>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0 text-muted-foreground hover:text-foreground">
                <Settings size={15} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="bottom" className="w-48">
              <DropdownMenuLabel className="flex justify-between items-center text-xs">
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><SheepIcon size={13} color="var(--primary)" /> <span className="brand-gradient-text">sheepit</span></span>
                <span className="font-mono text-primary">v{version ?? '\u2026'}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => useStore.getState().setKnowledgeOpen(true)}>
                <BookOpen size={14} /> Knowledge
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => send({ type: 'create_session', path: null })}>
                <SquarePlus size={14} /> New session
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={sessions.some(s => s.isHeadless)}
                onClick={() => send({ type: 'create_session', path: null, headless: true })}
              >
                <TerminalSquare size={14} />
                {sessions.some(s => s.isHeadless) ? 'Headless session running' : 'New headless session'}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowCommands(true)}>
                <Zap size={14} /> Saved commands
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowLogs(true)}>
                <ScrollText size={14} /> Server Logs
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {/* No pager dots: the name button above is the workspace selector, and
            it carries the "#3/9" position the dots used to show. The header's
            bottom edge is the pasture instead, the way the sidebar's is on
            desktop — so the flock is visible on a phone without opening the
            Pens sheet. */}
        <FlockStrip slim onConnect={onConnect} />
      </header>

      {uploadStatus && (
        <div className="md:hidden px-3 py-1.5 text-xs text-center border-b"
          style={{ background: 'var(--card)', borderColor: 'var(--border)', color: 'var(--muted-foreground)' }}>
          {uploadStatus}
        </div>
      )}

      {showSessions && (
        <>
          <div className="md:hidden fixed inset-0 z-40" style={{ background: 'rgba(0,0,0,0.5)' }} onClick={() => setShowSessions(false)} />
          {/* Same chrome as the desktop sidebar: the flock band on top, the
              pasture along the bottom — grass, plus a sheep for each pane
              that wants you, each one a shortcut to that pane. */}
          <div className="md:hidden mobile-flock-sheet fixed left-0 right-0 z-50 flex flex-col rounded-b-2xl border-b border-x"
            style={{ top: 48, maxHeight: '72vh', background: 'var(--card)', borderColor: 'var(--border)', overflow: 'hidden' }}>
            <FlockBand />
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <SessionList
                id="topbar-session-list"
                onConnect={(id) => { onConnect(id); setShowSessions(false); }}
                send={send}
              />
            </div>
            <FlockFooter onConnect={(id) => { onConnect(id); setShowSessions(false); }} />
          </div>
        </>
      )}

      {showLogs     && <LogsModal     onClose={() => setShowLogs(false)} />}
      {showCommands && <CommandsDialog onClose={() => { setShowCommands(false); setCommands(loadCommands()); }} />}
    </>
  );
}
