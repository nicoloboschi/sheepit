import { useEffect, useRef, useCallback, useState } from 'react';
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
import useStore, { activeTerminalSend, refreshAllTerminals } from './store';
import { requestNotificationPermission } from './utils';
import * as sharedWs from './sharedWs';
import Sidebar from './components/Sidebar';
import PaneTerminal, { NOTES_SESSION_ID } from './components/PaneTerminal';
import MobileKeybar from './components/MobileKeybar';
import ConfirmDialog from './components/ConfirmDialog';
import LogsModal from './components/LogsModal';
import MemoryDialog from './components/MemoryDialog';
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
  Home, Zap, TerminalSquare, BrainCircuit, RefreshCw, ImagePlus,
} from 'lucide-react';
import DirectoryPicker from './components/DirectoryPicker';
import ViperIcon from './components/ViperIcon';
import { tildefy } from './utils';

// ── App ──────────────────────────────────────────────────────────────────────

export default function App() {
  const currentSessionId = useStore(s => s.currentSessionId);
  const tabCycleRef = useRef<((dir: 'left' | 'right') => void) | null>(null);
  // True while a popstate handler is running — prevents connectSession from
  // pushing another history entry for the same navigation.
  const fromPopstateRef = useRef(false);

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

  /** Push current workspace + zen state into the URL hash. */
  const syncHash = useCallback(() => {
    if (fromPopstateRef.current) return;
    const { currentSessionId: wsId, zenSessionId } = useStore.getState();
    if (!wsId) return;
    const next = buildHash(wsId, zenSessionId);
    if (window.location.hash !== next) {
      history.pushState(null, '', next);
    }
  }, [buildHash]);

  const connectSession = useCallback((sessionId: string) => {
    useStore.getState().setCurrentSessionId(sessionId);
    localStorage.setItem('vipershell-last-session', sessionId);
    syncHash();
    // Focus the terminal after session switch
    setTimeout(() => window.dispatchEvent(new CustomEvent('vipershell:terminal-tab-active')), 100);
  }, [syncHash]);

  // Sync hash whenever zen mode changes.
  const zenSessionId = useStore(s => s.zenSessionId);
  useEffect(() => { syncHash(); }, [zenSessionId, syncHash]);

  // Browser back/forward: read workspace + zen state from hash.
  useEffect(() => {
    const onPopState = () => {
      const parsed = parseHash(window.location.hash);
      if (!parsed) return;
      const store = useStore.getState();
      if (store.workspaces[parsed.workspaceId] || parsed.workspaceId === NOTES_SESSION_ID) {
        fromPopstateRef.current = true;
        store.setCurrentSessionId(parsed.workspaceId);
        localStorage.setItem('vipershell-last-session', parsed.workspaceId);
        // Restore or clear zen mode
        if (parsed.zenSessionId && store.zenSessionId !== parsed.zenSessionId) {
          store.toggleZen(parsed.zenSessionId);
        } else if (!parsed.zenSessionId && store.zenSessionId) {
          store.exitZen();
        }
        setTimeout(() => window.dispatchEvent(new CustomEvent('vipershell:terminal-tab-active')), 100);
        fromPopstateRef.current = false;
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [parseHash]);

  const handleMessage = useCallback((msg: Record<string, unknown>) => {
    const store = useStore.getState();
    switch (msg.type) {
      case 'sessions': {
        store.renderSessions(msg.sessions as any); // eslint-disable-line @typescript-eslint/no-explicit-any
        if (!store.currentSessionId && (msg.sessions as any[]).length > 0) {
          const stateAfterRender = useStore.getState();
          // Priority: URL hash > localStorage > first session
          const parsed = parseHash(window.location.hash);
          const hashTarget = parsed && (stateAfterRender.workspaces[parsed.workspaceId] || parsed.workspaceId === NOTES_SESSION_ID) ? parsed : null;
          const lastId = localStorage.getItem('vipershell-last-session');
          const lastTarget = lastId && stateAfterRender.workspaces[lastId] ? lastId : null;
          const sessions = msg.sessions as any[];
          const fallbackTarget = sessions[0]?.id;
          const targetId = hashTarget?.workspaceId ?? lastTarget ?? fallbackTarget;
          if (targetId) {
            connectSession(targetId);
            // Restore zen mode from hash on initial load
            if (hashTarget?.zenSessionId) {
              useStore.getState().toggleZen(hashTarget.zenSessionId);
            }
          }
        }
        break;
      }
      case 'session_created': {
        const newId = msg.session_id as string;
        const path = msg.path as string | null;
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
      case 'preview':
        store.updatePreview(msg.session_id as string, msg.preview as string, msg.busy as boolean | undefined);
        break;
      case 'last_command':
        store.setLastCommand(msg.session_id as string, msg.command as string);
        break;
      case 'current_input':
        store.setCurrentInput(msg.session_id as string, msg.input as string);
        break;
      default: break;
    }
  }, [connectSession]);

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
        tabCycleRef.current?.(e.key === 'ArrowRight' ? 'right' : 'left');
        return;
      }
      // Zoom shortcuts — Cmd +, Cmd -, Cmd 0 (reset). Match both Plus/Equal and numpad.
      if (e.key === '+' || e.key === '=') {
        const id = useStore.getState().currentSessionId;
        if (!id) return;
        e.preventDefault();
        useStore.getState().adjustSessionZoom(id, 1);
        return;
      }
      if (e.key === '-' || e.key === '_') {
        const id = useStore.getState().currentSessionId;
        if (!id) return;
        e.preventDefault();
        useStore.getState().adjustSessionZoom(id, -1);
        return;
      }
      if (e.key === '0') {
        const id = useStore.getState().currentSessionId;
        if (!id) return;
        e.preventDefault();
        useStore.getState().resetSessionZoom(id);
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
          height: 'var(--vvh, 100dvh)', transition: 'height 0.25s ease',
          background: '#0c0c0c', color: '#d4d4d8',
          fontFamily: "'Space Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif", fontSize: 13,
        }}
      >
        <Sidebar onConnect={connectSession} send={send} />

        <div className="flex flex-col flex-1 min-w-0">
          <MobileTopBar onConnect={connectSession} send={send} />

          <PaneTerminal
            sessionId={currentSessionId}
            send={send}
            onTabReady={(fn) => { tabCycleRef.current = fn; }}
          />

          <MobileKeybar sendRef={{ current: sharedWs.send }} termRef={{ current: null }} />
        </div>

        <ConfirmDialog />
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
  const [showMemory,   setShowMemory]   = useState(false);
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
              <span style={{ fontSize: 10, color: 'var(--muted-foreground)', fontWeight: 600, flexShrink: 0 }}>
                #{workspaceIdx + 1}
              </span>
            )}
            <span key={currentSessionId} className="session-name-slide flex-1 min-w-0 truncate" style={{ fontSize: 13 }}>
              {currentSessionId === NOTES_SESSION_ID ? 'Notes'
                : workspace?.title ? workspace.title
                : session ? session.name : 'No session'}
            </span>
            {workspace && workspace.cells.length > 1 && (
              <span style={{ fontSize: 9, color: 'var(--muted-foreground)', fontWeight: 600, flexShrink: 0, background: 'rgba(255,255,255,0.08)', borderRadius: 3, padding: '1px 4px' }}>
                {workspace.cells.length} panes
              </span>
            )}
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
            title="Refresh terminal"
            onClick={() => refreshAllTerminals()}
          >
            <RefreshCw size={14} />
          </Button>

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
                <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><ViperIcon size={13} color="var(--primary)" /> <span className="brand-gradient-text">vipershell</span></span>
                <span className="font-mono text-primary">v{version ?? '\u2026'}</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setShowLogs(true)}>
                <ScrollText size={14} /> Server Logs
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setShowMemory(true)}>
                <BrainCircuit size={14} /> Memory
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        {workspaceOrder.length > 1 && (
          <div className="flex items-center justify-center gap-1.5 pb-1.5">
            {workspaceOrder.length <= 12
              ? workspaceOrder.map((id, i) => (
                  <span key={id} style={{
                    width: i === workspaceIdx ? 16 : 5, height: 5, borderRadius: 3,
                    background: i === workspaceIdx ? 'var(--primary-gradient)' : 'var(--border)',
                    transition: 'width 0.25s ease, background 0.25s ease', flexShrink: 0,
                  }} />
                ))
              : <span style={{ fontSize: 10, color: 'var(--muted-foreground)' }}>{workspaceIdx + 1} / {workspaceOrder.length}</span>
            }
          </div>
        )}
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
          <div className="md:hidden fixed left-0 right-0 z-50 flex flex-col rounded-b-2xl border-b border-x"
            style={{ top: 48, maxHeight: '65vh', background: 'var(--card)', borderColor: 'var(--border)', overflow: 'hidden' }}>
            <div className="px-4 py-3 border-b shrink-0 flex items-center" style={{ borderColor: 'var(--border)' }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--foreground)' }}>Workspaces</span>
            </div>
            <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
              <SessionList
                id="topbar-session-list"
                onConnect={(id) => { onConnect(id); setShowSessions(false); }}
                send={send}
              />
            </div>
          </div>
        </>
      )}

      {showLogs     && <LogsModal     onClose={() => setShowLogs(false)} />}
      {showMemory   && <MemoryDialog  onClose={() => setShowMemory(false)} />}
      {showCommands && <CommandsDialog onClose={() => { setShowCommands(false); setCommands(loadCommands()); }} />}
    </>
  );
}
