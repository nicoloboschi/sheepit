import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { TerminalSquare } from 'lucide-react';
import FloatingPanel from './FloatingPanel';
import TerminalTiles from './TerminalTiles';
import useStore from '../store';
import * as sharedWs from '../sharedWs';

/** Mirrors `MAX_HEADLESS` in `src/protocol.ts`, which is where it is actually
 *  enforced — the server is the only side that can count without racing two
 *  clients asking at once. If the two drift the server still wins, handing
 *  back an existing shell rather than making one. */
const MAX_HEADLESS = 4;

/**
 * The global scratch terminals, in a floating panel.
 *
 * A headless session is a shell with no pen: never in the flock, never
 * something you select, because the point of it is to be running while you
 * work somewhere else. There was exactly one, raised in the slot the sheepdog
 * also used — so opening it put the dog away, and that one shell had to be
 * both the build you are running and the log you are tailing.
 *
 * **These are the shells that belong to nobody.** A pane's own Terminals split
 * holds a different set, tagged with `sideOf`, and they are filtered out here:
 * a shell opened beside one pane is that pane's, and listing it in the global
 * panel as well would offer two places to close the same thing.
 */
export default function TerminalsDialog({ onClose }: { onClose: () => void }) {
  // Derived from the session list rather than held in the store: the server
  // owns which shells exist, so a second list here could only disagree.
  const ids = useStore(useShallow(
    s => s.sessions.filter(x => x.isHeadless && !x.sideOf).map(x => x.id),
  ));

  const add = useCallback(() => {
    sharedWs.send({ type: 'create_session', path: null, headless: true });
  }, []);

  return (
    <FloatingPanel
      title="Terminals"
      icon={<TerminalSquare size={13} style={{ color: 'var(--primary)' }} />}
      onClose={onClose}
      width={900}
      height={560}
      minWidth={520}
      minHeight={320}
    >
      <TerminalTiles
        ids={ids}
        max={MAX_HEADLESS}
        onAdd={add}
        emptyLabel="Open a scratch terminal"
        addLabel="Another scratch terminal"
      />
    </FloatingPanel>
  );
}
