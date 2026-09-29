import { useCallback } from 'react';
import { Plus } from 'lucide-react';
import TerminalCell from './TerminalCell';
import * as sharedWs from '../sharedWs';

/**
 * A handful of shells, tiled, with a bar underneath to add another.
 *
 * Two things draw this: the **Terminals panel**, which holds the global
 * scratch shells, and a pane's own **Terminals split**, which holds the shells
 * belonging to that pane. They are the same picture of the same kind of thing,
 * so they are one component — a second copy would have drifted the moment one
 * of them grew a button.
 *
 * ### Why a grid here, when pens lost theirs
 *
 * The 1–4 pane grid was deleted from pens the same day this was written, and
 * the two agree rather than contradict. A pen is where you *read*: one
 * terminal at full width with the browser or a diff beside it, so four panes
 * there were four things none of which you could work in. These are the
 * opposite — shells you *watch* while working somewhere else, in half a pane
 * or a floating box, where seeing all of them at once is the entire point.
 *
 * No draggable separators. `react-resizable-panels` went out with the pen grid
 * and is not worth bringing back so somebody can nudge a scratch shell 40px
 * wider; the container resizes and the tiles follow.
 */
export default function TerminalTiles({ ids, max, onAdd, emptyLabel, addLabel }: {
  /** Session ids to tile, in order. */
  ids: string[];
  /** How many this container may hold — see MAX_HEADLESS / MAX_SIDE_TERMINALS. */
  max: number;
  /** Ask for another. The caller owns what "another" means: a global scratch
   *  shell, or one beside a particular pane. */
  onAdd: () => void;
  emptyLabel: string;
  addLabel: string;
}) {
  const close = useCallback((id: string) => {
    sharedWs.send({ type: 'close_session', session_id: id });
  }, []);

  return (
    <>
      <div className={`headless-grid headless-grid-${Math.min(ids.length, max) || 1}`}>
        {ids.map(id => (
          <div key={id} className="headless-cell">
            <TerminalCell
              sessionId={id}
              // Its own pen id, matching no workspace on purpose: nothing in
              // the store should mistake one of these for a sheep standing in
              // a real pen. Anything that reads a pane's pen from `gridId` has
              // to cope with the miss.
              gridId={`__headless__:${id}`}
              paneIndex={0}
              isActive
              // Bare terminal, no persisted view, no nested Terminals tab.
              tile
              onActivate={() => {}}
              onClose={() => close(id)}
            />
          </div>
        ))}
        {ids.length === 0 && (
          <button className="headless-empty" onClick={onAdd}>
            <Plus size={14} />
            <span>{emptyLabel}</span>
          </button>
        )}
      </div>
      <div className="headless-bar">
        <span className="headless-count">{ids.length} of {max}</span>
        <button
          className="headless-add"
          onClick={onAdd}
          disabled={ids.length >= max}
          title={ids.length >= max ? `${max} is the limit — close one first` : addLabel}
        >
          <Plus size={12} /> Terminal
        </button>
      </div>
    </>
  );
}
