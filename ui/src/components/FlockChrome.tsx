/**
 * The two pieces of chrome that frame a list of pens: a band on top saying how
 * big the flock is, and the pasture underneath it.
 *
 * Both are shared by the desktop sidebar and the mobile Pens sheet, so the
 * flock looks and reports the same wherever you open it.
 */
import { useFlockCounts, plural } from '../flock';
import FlockGrass from './FlockGrass';
import FlockSheep from './FlockSheep';

/** The band above the pen list: what the column is, and how big the flock is
 *  right now. */
export function FlockBand(): React.ReactElement {
  const { panes, pens } = useFlockCounts();
  return (
    <div className="flock-band">
      <span className="flock-band-title">The&nbsp;flock</span>
      <span className="flock-band-count">
        {plural(panes, 'pane')}<span className="flock-sep">&middot;</span>{plural(pens, 'pen')}
      </span>
    </div>
  );
}

/** Just the pasture: grass with one sheep per pen standing in it. Used on its
 *  own as the bottom edge of the mobile header, and inside FlockFooter. */
export function FlockStrip({ slim = false }: { slim?: boolean }): React.ReactElement {
  return (
    <div className={`flock-pasture${slim ? ' flock-pasture-slim' : ''}`}>
      <FlockGrass />
      <FlockSheep />
    </div>
  );
}

/** The strip the flock stands on: who wants you, who is busy, and the grass
 *  they graze in, so the list has a floor rather than an edge. */
export function FlockFooter(): React.ReactElement {
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
      <FlockStrip />
    </div>
  );
}
