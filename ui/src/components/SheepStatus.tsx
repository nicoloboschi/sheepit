/** A sheep's state. Defined in flock.ts, which is where the flock's
 *  vocabulary lives; re-exported here because most callers of this component
 *  want the type too. */
import type { SheepState } from '../flock';
export type { SheepState };

const STATE_CLASS: Record<SheepState, string> = {
  grazing:  'sheep-grazing',
  bleating: 'sheep-bleating',
  unread:   'sheep-unread',
  idle:     'sheep-idle',
};

const STATE_LABEL: Record<SheepState, string> = {
  grazing:  'Grazing — a command is running',
  bleating: 'Bleating — waiting for your input',
  unread:   'Idle — finished, and you have not read it yet',
  idle:     'Idle',
};

/** The pane's activity, drawn as the animal it is named after.
 *
 *  Three channels carry the state, because one is not enough at 34px in a
 *  sidebar holding twenty pens:
 *
 *    1. colour    — --grazing / --bleating / --warning / muted
 *    2. posture   — where the head is and whether the animal is standing
 *    3. a glyph   — grass, a baa puff, or z z z
 *
 *  The silhouettes are deliberately different shapes, not four tints of one:
 *  grazing leans forward onto its face, bleating and unread rear back onto
 *  their hind feet, and idle lies down with its legs tucked away — the only
 *  one of the four with no legs showing, which is what makes it readable at
 *  a glance in a quad.
 *
 *  Bleating and unread share one animation on purpose; what separates them
 *  is that an unread pane tints its whole card amber (.pane-card-unseen).
 *
 *  The geometry lives in a 44×38 viewBox: the animal occupies the lower 30
 *  units and the top 8 are headroom for whichever glyph the state emits.
 *  All motion is CSS in style.css and stops under prefers-reduced-motion. */
export default function SheepStatus({ state }: { state: SheepState }): React.ReactElement {
  return (
    <svg
      className={`sheep ${STATE_CLASS[state]}`}
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
        {/* GRAZING: blades under the muzzle, springing back as it chews */}
        <g className="sheep-grass">
          <path d="M8.4 27 C 7.9 24.4 8.7 22.8 9.5 21.6" />
          <path d="M11.5 27.4 C 11.3 25.2 12.3 23.6 13.3 22.6" />
          <path d="M5.5 27.2 C 5.3 25.4 5.8 24.2 6.5 23.2" />
        </g>
      </g>
      {/* BLEATING: three puffs leaving the muzzle */}
      <g className="sheep-baa">
        <circle cx="5.6" cy="18.6" r="1.7" />
        <circle cx="3.1" cy="15.4" r="1.15" />
        <circle cx="1.4" cy="12.8" r=".8" />
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
