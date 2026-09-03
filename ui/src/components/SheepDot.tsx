/**
 * One sheep, one dot — what a pen shows when it is folded shut.
 *
 * A collapsed pen gives up its pane grid, and with it the four-state animal
 * `SheepStatus` draws. It must not give up the *state*: the reason to look at
 * this sidebar at all is to see that something is waiting on you, and a pen
 * that hides a bleating sheep to save four rows has taken the wrong four rows.
 *
 * So the states are the same four the glossary fixes, in the same colours,
 * shrunk to something readable at 7px:
 *
 *   teal, pulsing   bleating — wants your input
 *   meadow, solid   grazing  — a command is running
 *   amber, filled   idle, with output you have not read
 *   hollow ring     idle, and you have seen it
 *
 * `SheepStatus` is deliberately not reused here. It is a 44×38 animal whose
 * whole design — posture, glyph, silhouette — exists to be read inside a pane
 * card; at this size none of that survives, and a dot is the honest form.
 */
import { useShallow } from 'zustand/react/shallow';
import useStore from '../store';
import { sheepStateOf, type SheepState } from '../flock';

const LABEL: Record<SheepState, string> = {
  bleating: 'bleating — waiting for your input',
  grazing: 'grazing — a command is running',
  unread: 'finished, and you have not read it yet',
  idle: 'idle',
};

/** The state of every sheep in one pen, in pane order.
 *
 *  Selected as one string rather than an array of objects: `useShallow`
 *  compares one level deep, so a fresh array of anything else would never be
 *  equal to the last and the component would re-render forever. The same
 *  trick, and the same reason, as `useFlockSheep` in flock.ts. */
function usePenStates(cellIds: string[]): SheepState[] {
  const encoded = useStore(useShallow(s => cellIds.map(id => sheepStateOf(s, id)).join(' ')));
  return encoded ? encoded.split(' ') as SheepState[] : [];
}

export default function SheepDots({ cellIds }: { cellIds: string[] }): React.ReactElement {
  const states = usePenStates(cellIds);
  return (
    <span className="sheep-dots">
      {states.map((state, i) => (
        <span
          key={cellIds[i] ?? i}
          className={`sheep-dot sheep-dot-${state}`}
          title={LABEL[state]}
        />
      ))}
    </span>
  );
}
