import { useEffect, useRef, useState, useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import useStore from '../store';
import SessionStatsBar from './SessionStatsBar';
import TerminalGrid from './TerminalGrid';
import type { Layout } from './TerminalGrid';

// Legacy id for the old Notes-as-a-session. Knowledge is now an overlay dialog
// (see KnowledgeDialog), so this is kept only to sanitize stale persisted state.
export const NOTES_SESSION_ID = '__notes__';

/** How many workspaces stay mounted at once (see `visitedIds` below). Each one
 *  holds every pane it contains, so this is a memory ceiling, not a count of
 *  tabs — 12 covers normal back-and-forth without unbounded growth. */
const MAX_MOUNTED_WORKSPACES = 12;

interface PaneTerminalProps {
  sessionId: string | null;
  send: (msg: Record<string, unknown>) => void;
}

export default function PaneTerminal({ sessionId, send }: PaneTerminalProps): JSX.Element {
  const [gridLayout, setGridLayout] = useState<Layout>('single');
  const changeLayoutRef = useRef<((l: Layout) => void) | null>(null);

  // Keep visited workspaces mounted (hidden) for instant switching. Each id
  // in this list is a workspace id (what `sessionId` holds after the workspace
  // refactor), not a backend session id.
  //
  // Bounded, least-recently-used: every mounted pane is a live xterm holding
  // its full scrollback and streaming output, so an unbounded cache grew into
  // gigabytes for anyone who visited a lot of workspaces in one page session.
  // Evicting is cheap to undo — returning to a workspace replays the daemon's
  // ring buffer, the same path a page reload takes.
  const allWorkspaceIds = useStore(useShallow(s => s.workspaceOrder));
  const [visitedIds, setVisitedIds] = useState<string[]>([]);
  // Visit order, kept out of state: it changes on every switch but only ever
  // decides *which* id to evict, so it must not trigger a render on its own.
  const lastVisitRef = useRef(new Map<string, number>());
  const visitSeqRef = useRef(0);
  useEffect(() => {
    if (!sessionId || sessionId === NOTES_SESSION_ID) return;
    lastVisitRef.current.set(sessionId, ++visitSeqRef.current);
    setVisitedIds(prev => {
      // Already mounted → nothing to add, and nothing to evict either.
      if (prev.includes(sessionId)) return prev;
      const next = [...prev, sessionId];
      while (next.length > MAX_MOUNTED_WORKSPACES) {
        // Drop the least recently visited — never the one being shown.
        let lruIdx = -1, lruSeq = Infinity;
        next.forEach((id, i) => {
          if (id === sessionId) return;
          const seq = lastVisitRef.current.get(id) ?? 0;
          if (seq < lruSeq) { lruSeq = seq; lruIdx = i; }
        });
        if (lruIdx < 0) break;
        lastVisitRef.current.delete(next[lruIdx]!);
        next.splice(lruIdx, 1);
      }
      return next;
    });
  }, [sessionId]);
  // Drop cached entries for workspaces that no longer exist (e.g. dissolved
  // via drag-out-last-pane).
  const activeVisited = visitedIds.filter(id => allWorkspaceIds.includes(id));

  // Create split: create a new session inheriting the ACTIVE pane's cwd and
  // return its id. The caller (TerminalGrid) is responsible for attaching the
  // new session to this workspace via `appendPaneToWorkspace`. Workspaces
  // themselves have no path — we take the cwd from whichever pane is focused
  // right now, which is what the user expects when they split.
  const handleCreateSplit = useCallback(async (): Promise<string | null> => {
    if (!sessionId) return null;
    const state = useStore.getState();
    const ws = state.workspaces[sessionId];
    const activeSid = ws?.cells[ws.activeCell] ?? null;
    const path = activeSid ? state.sessionMap[activeSid]?.path ?? null : null;
    try {
      const res = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await res.json();
      if (data.ok && data.session_id) {
        // Refresh sessions list so the new session appears in sessionMap
        // (the workspace reconciliation in renderSessions will NOT create a
        // second workspace for it because TerminalGrid.ensureCells calls
        // appendPaneToWorkspace synchronously after this returns).
        send({ type: 'list_sessions' });
        return data.session_id;
      }
      return null;
    } catch { return null; }
  }, [sessionId, send]);

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0" style={{ position: 'relative' }}>
      <SessionStatsBar
        sessionId={sessionId}
        layout={gridLayout}
        onLayoutChange={(l) => changeLayoutRef.current?.(l)}
      />
      {/* Each workspace renders its own grid of panes. The terminal/git/files
          switch lives inside each pane (see PaneHeader / TerminalCell). */}
      {activeVisited.map(vid => {
        const isVisible = vid === sessionId;
        return (
          <div
            key={vid}
            style={{
              display: isVisible ? 'flex' : 'none',
              flex: 1, flexDirection: 'column', minHeight: 0, overflow: 'hidden',
            }}
          >
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
              <TerminalGrid
                sessionId={vid}
                onCreateSplit={handleCreateSplit}
                onLayoutReady={vid === sessionId ? ({ layout: l, changeLayout }) => {
                  setGridLayout(l);
                  changeLayoutRef.current = changeLayout;
                } : undefined}
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
