import { useEffect, useRef, useState, useCallback } from 'react';
import { perf } from '../perf';
import { useShallow } from 'zustand/react/shallow';
import useStore, { addSheepToPen } from '../store';
import SessionStatsBar from './SessionStatsBar';
import TerminalGrid from './TerminalGrid';

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
  // The grid's parent. If this re-renders and TerminalGrid's memo holds, the
  // count below stays near 1 per click while render:TerminalGrid stays near 2 —
  // the two pens involved in a switch. Divergence names which of the two is at
  // fault without having to reason about either.
  perf.count('render:PaneTerminal');
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

  /** Put another sheep in this pen: a new session inheriting the shown pane's
   *  cwd, appended to the pen and shown straight away. A pen has no path of
   *  its own, so the cwd comes from whichever sheep you are looking at — which
   *  is what you mean by "another one of these". */
  const handleAddSheep = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    await addSheepToPen(sessionId, send);
  }, [sessionId, send]);

  return (
    <div className="flex flex-col flex-1 min-w-0 min-h-0" style={{ position: 'relative' }}>
      <SessionStatsBar
        sessionId={sessionId}
        onAddSheep={sessionId ? handleAddSheep : undefined}
        onCreateSession={(headless) => send({ type: 'create_session', path: null, ...(headless ? { headless: true } : {}) })}
      />
      {/* Each pen renders the one sheep it is showing. The terminal/git/files
          switch lives inside the pane (see PaneHeader / TerminalCell). */}
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
              <TerminalGrid sessionId={vid} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
