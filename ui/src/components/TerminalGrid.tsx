import { useCallback, useEffect, useState, memo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import TerminalCell from './TerminalCell';
import PenFence from './PenFence';
import { perf } from '../perf';
import useStore from '../store';
import * as sharedWs from '../sharedWs';

interface TerminalGridProps {
  /** Synthetic workspace id this pen renders. The name stays `sessionId`
   *  for prop-renaming-cascade avoidance; it is NOT a backend session id. */
  sessionId: string;
}

/**
 * A pen, showing one sheep.
 *
 * This was a resizable grid of up to four panes in eight layout variants. It
 * is one pane filling the whole area: every split worth having — the browser,
 * a pull request, the working tree, the files — is *inside* a pane beside its
 * own terminal, and two terminals side by side is a thing nobody was reading.
 *
 * There is deliberately **nothing above the pane**. A tab strip was tried and
 * removed: it spends a row of terminal, on every pen, on a list the sidebar is
 * already drawing — and drawing better, with each sheep's name, its PR, its
 * context and its own animal, none of which fits in a tab. Vertical rows are
 * what terminal content is short of, which is the same argument that merged
 * the pane's two chrome bars into one. The sidebar is the switcher; ⌘↑/↓ walks
 * the same sheep without leaving the keyboard.
 */
function TerminalGridInner({ sessionId: workspaceId }: TerminalGridProps) {
  // Counted because the memo below is load-bearing and was unverifiable. A
  // pane-card click re-renders 17.4 TerminalCells with only 14 mounted, which
  // is either this grid re-rendering for every mounted pen (so its memo is
  // failing) or the cells re-rendering individually. One number separates
  // those, and guessing between them is how this file's comment came to assert
  // something nothing measured.
  perf.count('render:TerminalGrid');
  const ws = useStore(useShallow(s => {
    const w = s.workspaces[workspaceId];
    if (!w) return null;
    return { cells: w.cells, activeCell: w.activeCell };
  }));

  const cells: string[] = ws?.cells ?? [];
  const activeCell: number = ws?.activeCell ?? 0;
  const shown = cells[activeCell] ?? cells[0];

  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const onChange = () => setIsMobile(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const setActiveCell = useCallback((idx: number) => {
    useStore.getState().setActivePane(workspaceId, idx);
  }, [workspaceId]);

  /** Remove the shown pane from this pen, and kill its PTY. If it was the
   *  last one the pen dissolves with it. */
  const closePane = useCallback((index: number) => {
    const current = useStore.getState().workspaces[workspaceId];
    const sid = current?.cells[index];
    if (!sid) return;
    // The eventual `list_sessions` response prunes it from sessionMap and
    // renderSessions tidies up; removing it here is what makes the UI answer
    // straight away.
    sharedWs.send({ type: 'close_session', session_id: sid });
    useStore.getState().removePaneFromWorkspace(workspaceId, index);
  }, [workspaceId]);

  // Seeded from the workspace id so the fence does not reshuffle its posts
  // every time a pane goes busy or the pen re-renders.
  const fenceSeed = (() => {
    let h = 0;
    for (let i = 0; i < workspaceId.length; i++) h = (h * 31 + workspaceId.charCodeAt(i)) | 0;
    return Math.abs(h) % 997;
  })();

  return (
    <div
      className="workspace-pen"
      style={{
        flex: 1, minHeight: 0, minWidth: 0,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        position: 'relative', background: 'var(--background)',
      }}
    >
      {!isMobile && <PenFence seed={fenceSeed} active className="workspace-fence" rails={false} />}
      {/* Every sheep in this pen stays mounted; all but one are hidden.
          Unmounting the others would tear down their xterm on every tab
          switch and rebuild it from the daemon's ring — a visible stall, and
          the scroll position gone. This is the same trade `PaneTerminal`
          makes between pens, and the cost is bounded the same way: only the
          pen you are standing in mounts its sheep, and PaneTerminal keeps at
          most a dozen pens alive. */}
      {cells.map((sid, i) => (
        <div
          key={sid}
          style={{
            display: sid === shown ? 'flex' : 'none',
            flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden',
          }}
        >
          <TerminalCell
            sessionId={sid}
            gridId={workspaceId}
            paneIndex={i}
            isActive={sid === shown}
            // The `useCallback`s themselves, not arrows closing over `i`:
            // TerminalCell is memoised and takes the index as an argument, so
            // a fresh function here would re-render every mounted pane in the
            // pen on every render of the grid.
            onActivate={setActiveCell}
            onClose={closePane}
          />
        </div>
      ))}
    </div>
  );
}

/**
 * Memoised, because `PaneTerminal` renders one of these per *mounted* pen and
 * keeps up to a dozen alive.
 *
 * Without it, clicking a pen in the sidebar re-rendered every mounted pen's
 * grid, not just the two involved in the switch — and clicking was the worst
 * thing in the app: the browser blamed 148–208ms frames on `DIV#root.onclick`,
 * which is exactly the "clicking feels unreactive" this work started from.
 *
 * The prop is a single string, so there is nothing here to get wrong — but a
 * pen whose own contents changed still re-renders, because the `useStore`
 * selector above fires regardless of the parent. That is the point: memo stops
 * the eleven pens that did not change.
 */
export default memo(TerminalGridInner);
