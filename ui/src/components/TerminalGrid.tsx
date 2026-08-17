import { useCallback, useEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { Loader2 } from 'lucide-react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import TerminalCell from './TerminalCell';
import useStore, { layoutCapacity } from '../store';
import * as sharedWs from '../sharedWs';

/** Kept in sync with `GridLayout` in store.ts. See the store for docs on
 *  the three-variant conventions (cells[0] is always the "big" pane). */
export type Layout =
  | 'single'
  | 'horizontal'
  | 'vertical'
  | 'three' | 'three-right' | 'three-top' | 'three-bottom'
  | 'quad';

// Sizes per group: { [groupId]: { [panelId]: percentage } }
type GroupSizes = Record<string, Record<string, number>>;

interface TerminalGridProps {
  /** Synthetic workspace id this grid renders. The name stays `sessionId`
   *  for prop-renaming-cascade avoidance; it is NOT a backend session id. */
  sessionId: string;
  /** Create a new backend session and return its id, or null on failure.
   *  Used when the user picks a larger layout than the current cell count. */
  onCreateSplit: () => Promise<string | null>;
  onLayoutReady?: (info: { layout: Layout; changeLayout: (l: Layout) => void }) => void;
}

// ── Sizes persistence (panel percentages, keyed by workspace id) ────────────
// Kept separate from the store — this is purely visual chrome and never needs
// to be observed cross-component.
const SIZES_KEY = 'vipershell:workspace-sizes';

function loadSizes(workspaceId: string): GroupSizes {
  try {
    const map = JSON.parse(localStorage.getItem(SIZES_KEY) || '{}');
    return map[workspaceId] ?? {};
  } catch { return {}; }
}

function saveSizes(workspaceId: string, sizes: GroupSizes): void {
  try {
    const map = JSON.parse(localStorage.getItem(SIZES_KEY) || '{}');
    map[workspaceId] = sizes;
    localStorage.setItem(SIZES_KEY, JSON.stringify(map));
  } catch { /* quota */ }
}

const handleCls = (orientation: 'horizontal' | 'vertical') =>
  `terminal-resize-handle terminal-resize-handle-${orientation}`;

// Panel style: override library defaults so absolute-positioned xterm fills correctly
const PANEL_STYLE: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  overflow: 'hidden',
  minHeight: 0,
  minWidth: 0,
};

export default function TerminalGrid({ sessionId: workspaceId, onCreateSplit, onLayoutReady }: TerminalGridProps) {
  // The store is the source of truth for workspace shape. We subscribe with a
  // shallow selector so changes elsewhere (drag-drop, pane close, etc.) flow
  // back into this grid automatically.
  const ws = useStore(useShallow(s => {
    const w = s.workspaces[workspaceId];
    if (!w) return null;
    return { layout: w.layout, cells: w.cells, activeCell: w.activeCell };
  }));

  const layout: Layout = ws?.layout ?? 'single';
  const cells: string[] = ws?.cells ?? [];
  const activeCell: number = ws?.activeCell ?? 0;

  // Panel-resizer percentages are workspace-local, persisted separately.
  const [sizes, setSizes] = useState<GroupSizes>(() => loadSizes(workspaceId));
  useEffect(() => { setSizes(loadSizes(workspaceId)); }, [workspaceId]);
  useEffect(() => { saveSizes(workspaceId, sizes); }, [workspaceId, sizes]);

  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  // Guards concurrent `ensureCells` invocations so a rapid layout-change
  // sequence doesn't spawn duplicate backend sessions.
  const creatingRef = useRef(false);

  const setActiveCell = useCallback((idx: number) => {
    useStore.getState().setActivePane(workspaceId, idx);
  }, [workspaceId]);

  /** Create backend sessions until the workspace has `needed` panes, then
   *  attach each to the workspace. Sequential to avoid duplicate creation. */
  const ensureCells = useCallback(async (needed: number) => {
    if (creatingRef.current) return;
    const startCount = useStore.getState().workspaces[workspaceId]?.cells.length ?? 0;
    if (startCount >= needed) return;
    creatingRef.current = true;
    try {
      for (let i = startCount; i < needed; i++) {
        const newId = await onCreateSplit();
        if (!newId) break;
        useStore.getState().appendPaneToWorkspace(workspaceId, newId);
      }
    } finally {
      creatingRef.current = false;
    }
  }, [workspaceId, onCreateSplit]);

  const changeLayout = useCallback((newLayout: Layout) => {
    const store = useStore.getState();
    const current = store.workspaces[workspaceId];
    if (!current) return;
    const needed = layoutCapacity(newLayout);
    const clampedActive = Math.min(current.activeCell, Math.min(current.cells.length, needed) - 1);

    // Downgrade (e.g. quad → single): the panes past the new capacity would
    // otherwise stay in `cells` and simply never render — their PTYs alive,
    // hidden from the sidebar (non-root panes are), and impossible to close.
    // Re-home them as their own workspaces instead: a layout change shouldn't
    // silently kill a running agent, and it must not strand a session either.
    // Back-to-front so the indices stay valid as the array shrinks.
    const insertAt = store.workspaceOrder.indexOf(workspaceId) + 1;
    for (let i = current.cells.length - 1; i >= needed; i--) {
      useStore.getState().extractPaneToNewWorkspace({ sourceId: workspaceId, sourceIdx: i, insertAt });
    }

    // Update layout first so missing cells render as loader placeholders in
    // the correct final shape while ensureCells fills them in.
    const remaining = useStore.getState().workspaces[workspaceId];
    if (!remaining) return;
    useStore.getState().setGridState(
      workspaceId,
      newLayout,
      remaining.cells,
      Math.max(0, clampedActive),
    );
    ensureCells(needed);
  }, [workspaceId, ensureCells]);

  /** Remove the pane at `index` from this workspace. Also closes the backend
   *  session (its PTY). If it was the last pane in the workspace, the
   *  workspace dissolves automatically (Android-folder style). */
  const closePane = useCallback((index: number) => {
    const current = useStore.getState().workspaces[workspaceId];
    if (!current) return;
    const sid = current.cells[index];
    if (!sid) return;

    // Kill the PTY on the backend. The eventual `list_sessions` response will
    // prune this session from sessionMap, and `renderSessions` will tidy up
    // any workspaces that reference it.
    sharedWs.send({ type: 'close_session', session_id: sid });

    // Optimistically remove from the workspace so the UI responds immediately.
    useStore.getState().removePaneFromWorkspace(workspaceId, index);
  }, [workspaceId]);

  useEffect(() => {
    onLayoutReady?.({ layout, changeLayout });
  }, [layout, changeLayout, onLayoutReady]);

  const onGroupLayoutChanged = useCallback((groupId: string) => (next: Record<string, number>) => {
    setSizes(prev => ({ ...prev, [groupId]: next }));
  }, []);

  const renderCell = (index: number) => {
    const sid = cells[index];
    if (!sid) {
      // Loading placeholder — layout has allocated a slot for this cell but
      // its backend session hasn't been created yet.
      return (
        <div style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'var(--background)', color: 'var(--muted-foreground)',
        }}>
          <Loader2 size={20} className="animate-spin" />
        </div>
      );
    }
    return (
      <TerminalCell
        sessionId={sid}
        gridId={workspaceId}
        paneIndex={index}
        isActive={activeCell === index}
        onActivate={() => setActiveCell(index)}
        onClose={() => closePane(index)}
      />
    );
  };

  const renderLayout = () => {
    // On mobile, splits are unusable due to limited screen space.
    // Show only the active pane full-screen with a tab bar to switch.
    if (isMobile && layout !== 'single' && cells.length > 1) {
      return (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 4,
            padding: '4px 6px', background: 'var(--card)',
            borderBottom: '1px solid var(--border)', flexShrink: 0,
          }}>
            {cells.map((_, i) => (
              <button
                key={i}
                onClick={() => setActiveCell(i)}
                style={{
                  flex: 1, padding: '4px 8px', fontSize: 11,
                  background: i === activeCell ? 'var(--primary)' : 'transparent',
                  color: i === activeCell ? 'var(--primary-foreground)' : 'var(--muted-foreground)',
                  border: '1px solid var(--border)', borderRadius: 4, cursor: 'pointer',
                  fontFamily: '"JetBrains Mono", monospace',
                }}
              >
                Pane {i + 1}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {renderCell(activeCell)}
          </div>
        </div>
      );
    }

    switch (layout) {
      case 'single':
        return (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {renderCell(0)}
          </div>
        );

      case 'horizontal':
        return (
          <Group
            orientation="horizontal"
            defaultLayout={sizes.main}
            onLayoutChanged={onGroupLayoutChanged('main')}
          >
            <Panel id="p0" style={PANEL_STYLE}>{renderCell(0)}</Panel>
            <Separator className={handleCls('horizontal')} />
            <Panel id="p1" style={PANEL_STYLE}>{renderCell(1)}</Panel>
          </Group>
        );

      case 'vertical':
        return (
          <Group
            orientation="vertical"
            defaultLayout={sizes.main}
            onLayoutChanged={onGroupLayoutChanged('main')}
          >
            <Panel id="p0" style={PANEL_STYLE}>{renderCell(0)}</Panel>
            <Separator className={handleCls('vertical')} />
            <Panel id="p1" style={PANEL_STYLE}>{renderCell(1)}</Panel>
          </Group>
        );

      case 'three':
        // cells[0] is the tall pane on the LEFT, cells[1]/cells[2] stacked right.
        // Group id 'right' is kept for backwards compat with saved panel sizes.
        return (
          <Group
            orientation="horizontal"
            defaultLayout={sizes.main}
            onLayoutChanged={onGroupLayoutChanged('main')}
          >
            <Panel id="p0" style={PANEL_STYLE}>{renderCell(0)}</Panel>
            <Separator className={handleCls('horizontal')} />
            <Panel id="right" style={PANEL_STYLE}>
              <Group
                orientation="vertical"
                defaultLayout={sizes.right}
                onLayoutChanged={onGroupLayoutChanged('right')}
              >
                <Panel id="p1" style={PANEL_STYLE}>{renderCell(1)}</Panel>
                <Separator className={handleCls('vertical')} />
                <Panel id="p2" style={PANEL_STYLE}>{renderCell(2)}</Panel>
              </Group>
            </Panel>
          </Group>
        );

      case 'three-right':
        // cells[0] is the tall pane on the RIGHT, cells[1]/cells[2] stacked left.
        return (
          <Group
            orientation="horizontal"
            defaultLayout={sizes.main}
            onLayoutChanged={onGroupLayoutChanged('main')}
          >
            <Panel id="side" style={PANEL_STYLE}>
              <Group
                orientation="vertical"
                defaultLayout={sizes.side}
                onLayoutChanged={onGroupLayoutChanged('side')}
              >
                <Panel id="p1" style={PANEL_STYLE}>{renderCell(1)}</Panel>
                <Separator className={handleCls('vertical')} />
                <Panel id="p2" style={PANEL_STYLE}>{renderCell(2)}</Panel>
              </Group>
            </Panel>
            <Separator className={handleCls('horizontal')} />
            <Panel id="p0" style={PANEL_STYLE}>{renderCell(0)}</Panel>
          </Group>
        );

      case 'three-top':
        // cells[0] is the wide pane on the TOP, cells[1]/cells[2] side-by-side below.
        return (
          <Group
            orientation="vertical"
            defaultLayout={sizes.main}
            onLayoutChanged={onGroupLayoutChanged('main')}
          >
            <Panel id="p0" style={PANEL_STYLE}>{renderCell(0)}</Panel>
            <Separator className={handleCls('vertical')} />
            <Panel id="side" style={PANEL_STYLE}>
              <Group
                orientation="horizontal"
                defaultLayout={sizes.side}
                onLayoutChanged={onGroupLayoutChanged('side')}
              >
                <Panel id="p1" style={PANEL_STYLE}>{renderCell(1)}</Panel>
                <Separator className={handleCls('horizontal')} />
                <Panel id="p2" style={PANEL_STYLE}>{renderCell(2)}</Panel>
              </Group>
            </Panel>
          </Group>
        );

      case 'three-bottom':
        // cells[0] is the wide pane on the BOTTOM, cells[1]/cells[2] side-by-side above.
        return (
          <Group
            orientation="vertical"
            defaultLayout={sizes.main}
            onLayoutChanged={onGroupLayoutChanged('main')}
          >
            <Panel id="side" style={PANEL_STYLE}>
              <Group
                orientation="horizontal"
                defaultLayout={sizes.side}
                onLayoutChanged={onGroupLayoutChanged('side')}
              >
                <Panel id="p1" style={PANEL_STYLE}>{renderCell(1)}</Panel>
                <Separator className={handleCls('horizontal')} />
                <Panel id="p2" style={PANEL_STYLE}>{renderCell(2)}</Panel>
              </Group>
            </Panel>
            <Separator className={handleCls('vertical')} />
            <Panel id="p0" style={PANEL_STYLE}>{renderCell(0)}</Panel>
          </Group>
        );

      case 'quad':
        return (
          <Group
            orientation="vertical"
            defaultLayout={sizes.outer}
            onLayoutChanged={onGroupLayoutChanged('outer')}
          >
            <Panel id="top" style={PANEL_STYLE}>
              <Group
                orientation="horizontal"
                defaultLayout={sizes.top}
                onLayoutChanged={onGroupLayoutChanged('top')}
              >
                <Panel id="p0" style={PANEL_STYLE}>{renderCell(0)}</Panel>
                <Separator className={handleCls('horizontal')} />
                <Panel id="p1" style={PANEL_STYLE}>{renderCell(1)}</Panel>
              </Group>
            </Panel>
            <Separator className={handleCls('vertical')} />
            <Panel id="bottom" style={PANEL_STYLE}>
              <Group
                orientation="horizontal"
                defaultLayout={sizes.bottom}
                onLayoutChanged={onGroupLayoutChanged('bottom')}
              >
                <Panel id="p2" style={PANEL_STYLE}>{renderCell(2)}</Panel>
                <Separator className={handleCls('horizontal')} />
                <Panel id="p3" style={PANEL_STYLE}>{renderCell(3)}</Panel>
              </Group>
            </Panel>
          </Group>
        );
    }
  };

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        padding: layout === 'single' ? 0 : 8,
        background: 'var(--background)',
      }}
    >
      {renderLayout()}
    </div>
  );
}
