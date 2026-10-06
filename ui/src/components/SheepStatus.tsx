/** A sheep's state. Defined in flock.ts, which is where the flock's
 *  vocabulary lives; re-exported here because most callers of this component
 *  want the type too. */
import type { SheepState } from '../flock';
export type { SheepState };

const STATE_LABEL: Record<SheepState, string> = {
  grazing:  'Grazing — a command is running',
  bleating: 'Bleating — waiting for your input',
  unread:   'Finished, and you have not read it yet',
  idle:     'Idle',
};

/** **A sheep is only drawn for the two states that are not doing anything.**
 *
 *  The animal is a picture of a pane at rest — standing in a field, or asleep
 *  in it — and it was being asked to carry two states it is bad at. "A command
 *  is running" is a *progress* fact, and the universal drawing of progress is
 *  a spinner: it says "still going" by moving continuously, where a grazing
 *  sheep said it by bobbing its head 3px. "This pane is blocked on you" is a
 *  *request*, and the universal drawing of a request is a raised hand.
 *
 *  So the four states are drawn by three different things:
 *
 *  | state    | drawn as            | colour |
 *  |----------|---------------------|--------|
 *  | bleating | a raised hand, waving | red  — the one state that is stuck |
 *  | grazing  | a spinner            | amber — plus the card's moving shimmer |
 *  | unread   | a sheep, hopping     | green — there is something to collect |
 *  | idle     | a sheep, lying down  | wool  — nothing to say |
 *
 *  Which is also why the colours moved. Red and a hand are what every other
 *  piece of software on the machine uses for "stopped, waiting on you", and a
 *  flock that invents its own vocabulary for that one state is a flock whose
 *  most important signal has to be learned. The sheep keep the rest.
 *
 *  Two channels still carry the sheep's own two states — posture (hopping on
 *  its hind feet, or lying with its legs tucked away) and the colour of the
 *  fleece — because a wall of white animals is a wall of identical shapes
 *  until you stop on one, and a card is scanned rather than read.
 *
 *  The baa puff and the idle `zzz` are the full-size animal's alone: in a pen
 *  card they are 1px dots and 3px strokes above a 28px sheep, which read as
 *  dirt on the card rather than as glyphs. The pane bar still draws the zzz.
 *
 *  The geometry lives in a 44×38 viewBox: the animal occupies the lower 30
 *  units and the top 8 are headroom for the glyph. All motion is CSS in
 *  style.css and stops under prefers-reduced-motion. */
export default function SheepStatus({ state }: { state: SheepState }): React.ReactElement {
  if (state === 'bleating') return <BleatingHand />;
  if (state === 'grazing')  return <GrazingSpinner />;
  return (
    <svg
      className={`sheep sheep-${state}`}
      viewBox="0 0 44 38"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={STATE_LABEL[state]}
    >
      <title>{STATE_LABEL[state]}</title>
      <g transform="translate(2 8)">
        <ellipse className="sheep-halo" cx="21" cy="16" rx="14" ry="10" />
        <ellipse className="sheep-ground" cx="21" cy="27.5" rx="12" ry="1.6" />
        <g className="sheep-body">
          {/* tail: a tuft on a short stalk at the rump */}
          <g className="sheep-tail">
            <path
              d="M32 15 C 34.6 15.2 35.8 16.2 36.3 17.4"
              stroke="var(--wool-shade)" strokeWidth="1.4" strokeLinecap="round" fill="none"
            />
            <circle cx="36.6" cy="18.4" r="1.8" />
          </g>
          {/* legs first, so the fleece overlaps the hips */}
          <g className="sheep-legs">
            <line x1="14" y1="19" x2="13.4" y2="26.5" />
            <line x1="18.5" y1="20" x2="18.5" y2="27" />
            <line x1="25" y1="20" x2="25.6" y2="27" />
            <line x1="29.5" y1="19" x2="30.4" y2="26.5" />
          </g>
          {/* fleece: overlapping tufts give a bumpy silhouette with no filter */}
          <g className="sheep-fleece">
            <circle cx="19" cy="13.5" r="7.2" />
            <circle cx="26" cy="12.6" r="6.4" />
            <circle cx="30.5" cy="15.5" r="5.4" />
            <circle cx="15.5" cy="17" r="6.2" />
            <circle cx="22.5" cy="18.5" r="6.6" />
            <circle cx="28.5" cy="18.6" r="5.2" />
          </g>
          <g transform="translate(11 14)">
            <g className="sheep-head">
              {/* the far ear, shown only when the animal is alert */}
              <ellipse
                className="sheep-ear sheep-ear-far"
                cx="-.2" cy="-4.2" rx="1.5" ry="2.6"
                transform="rotate(-8 -.2 -4.2)"
              />
              <ellipse
                className="sheep-ear"
                cx="2.1" cy="-3.4" rx="1.9" ry="2.9"
                transform="rotate(-34 2.1 -3.4)"
              />
              <ellipse className="sheep-skull" cx="-1.4" cy="1.4" rx="4.3" ry="4.9" />
              <ellipse className="sheep-muzzle" cx="-3.4" cy="3.6" rx="1.9" ry="1.4" />
              <circle className="sheep-eye" cx="-.4" cy=".2" r=".95" />
            </g>
          </g>
        </g>
      </g>
      {/* IDLE: z z z drifting off a sleeping head */}
      <g className="sheep-zzz">
        <path d="M11 10 h3.4 l-3.4 3.4 h3.4" />
        <path d="M7.2 5.6 h2.8 l-2.8 2.8 h2.8" />
        <path d="M4.2 1.8 h2.2 l-2.2 2.2 h2.2" />
      </g>
    </svg>
  );
}

/** Blocked on you. A raised hand, waving — drawn rather than an emoji so it
 *  can take the state's red; an emoji is whatever colour the font says, and
 *  the whole point of this one is that it is the loudest thing in the pen.
 *  Four fingers and a thumb at 16px is as much hand as survives the size. */
function BleatingHand(): React.ReactElement {
  return (
    <svg
      className="pane-state pane-state-bleating"
      viewBox="0 0 20 20"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={STATE_LABEL.bleating}
    >
      <title>{STATE_LABEL.bleating}</title>
      <g className="pane-hand">
        {/* palm */}
        <path d="M4.4 9.2 h9.5 a2.6 2.6 0 0 1 2.6 2.6 v2.1 a4.6 4.6 0 0 1 -4.6 4.6 h-3.4 a4.1 4.1 0 0 1 -4.1 -4.1 z" />
        {/* fingers */}
        <rect x="5.0" y="3.0" width="2.3" height="7.2" rx="1.15" />
        <rect x="8.0" y="1.6" width="2.3" height="8.6" rx="1.15" />
        <rect x="11.0" y="2.4" width="2.3" height="7.8" rx="1.15" />
        <rect x="13.9" y="4.6" width="2.2" height="5.8" rx="1.1" />
        {/* thumb */}
        <path d="M4.6 9.6 L2.2 12.1 a1.15 1.15 0 0 0 1.6 1.6 l2.3 -2.3 z" />
      </g>
    </svg>
  );
}

/** A command is running. The one state that is genuinely *progress*, drawn the
 *  way progress is drawn everywhere: a ring with a gap, turning. The card
 *  behind it carries a slow amber shimmer for the same fact at card scale —
 *  a 14px ring is not something you see without looking at it. */
function GrazingSpinner(): React.ReactElement {
  return (
    <span
      className="pane-state pane-state-grazing"
      role="img"
      aria-label={STATE_LABEL.grazing}
      title={STATE_LABEL.grazing}
    />
  );
}
