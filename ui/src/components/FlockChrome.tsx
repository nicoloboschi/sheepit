/**
 * The two pieces of chrome that frame a list of pens: a band on top saying how
 * big the flock is, and the pasture underneath it.
 *
 * Both are shared by the desktop sidebar and the mobile Pens sheet, so the
 * flock looks and reports the same wherever you open it.
 */
import { useCallback } from 'react';
import { useFlockCounts, plural, sheepCount } from '../flock';
import useStore from '../store';
import FlockGrass from './FlockGrass';
import FlockSheep from './FlockSheep';

/** What clicking a sheep does: go to its pen, then focus the pane inside it.
 *  Both halves are needed — switching pens alone lands you on whichever pane
 *  that pen last had focused, which is not the one that called you. */
export interface FlockNav {
  /** The caller's own "go to this pen", so the strip does not have to know
   *  about hash syncing, last-session preferences or closing a mobile sheet. */
  onConnect?: (workspaceId: string) => void;
}

function useSheepSelect(onConnect?: (workspaceId: string) => void) {
  return useCallback((workspaceId: string, paneIndex: number) => {
    if (!onConnect) return;
    onConnect(workspaceId);
    useStore.getState().setActivePane(workspaceId, paneIndex);
  }, [onConnect]);
}

/** The band above the pen list: what the column is, and how big the flock is
 *  right now. */
export function FlockBand(): React.ReactElement {
  const { sheep, pens } = useFlockCounts();
  return (
    <div className="flock-band">
      <span className="flock-band-title">The&nbsp;flock</span>
      <span className="flock-band-count">
        {sheepCount(sheep)}<span className="flock-sep">&middot;</span>{plural(pens, 'pen')}
      </span>
    </div>
  );
}

/** Just the pasture: grass, with one sheep in it for every pane that wants
 *  you. Used on its own as the bottom edge of the mobile header, and inside
 *  FlockFooter. Empty grass means nothing is bleating. */
export function FlockStrip({ slim = false, onConnect }: { slim?: boolean } & FlockNav): React.ReactElement {
  const select = useSheepSelect(onConnect);
  return (
    <div className={`flock-pasture${slim ? ' flock-pasture-slim' : ''}`}>
      <FlockGrass />
      <FlockSheep onSelect={onConnect ? select : undefined} />
    </div>
  );
}

/** The strip the flock stands on: who wants you, who is busy, and the grass
 *  they graze in, so the list has a floor rather than an edge. The line
 *  counts the whole flock; the animals below it are only the ones bleating. */
export function FlockFooter({ onConnect }: FlockNav = {}): React.ReactElement {
  const { bleating, grazing } = useFlockCounts();
  const quiet = bleating === 0 && grazing === 0;
  return (
    <div className="sidebar-footer flock-footer">
      <div className="flock-footer-status">
        <span
          className="flock-footer-dot"
          style={{ background: bleating > 0 ? 'var(--bleating)' : grazing > 0 ? 'var(--grazing)' : 'var(--border)' }}
        />
        {quiet
          ? <span>all quiet</span>
          : <>
              {bleating > 0 && <span style={{ color: 'var(--bleating)' }}>{bleating} bleating</span>}
              {bleating > 0 && grazing > 0 && <span className="flock-footer-sep">&middot;</span>}
              {grazing > 0 && <span>{grazing} grazing</span>}
            </>}
      </div>
      <FlockStrip onConnect={onConnect} />
    </div>
  );
}
