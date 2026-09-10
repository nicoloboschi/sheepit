/**
 * The sheepdog, drawn the way SheepStatus draws a sheep.
 *
 * Same 44×38 viewBox, same tokens, same "the top 8 units are headroom for a
 * glyph" contract — so it drops into every place a sheep goes without any
 * caller learning that this pane is different.
 *
 * **Its states are not a sheep's states, and that is the point.** A sheep
 * reports on itself: grazing, bleating, unread, idle. A dog reports on the
 * *flock* — the only thing worth knowing about a sheepdog is whether anything
 * out there needs you, and whether it is currently doing something about it.
 *
 *   watching  — sitting, ears up. Nothing wants you.
 *   alerting  — up on its feet, barking, because a sheep is bleating.
 *   working   — the dog's own agent is mid-turn: fetching, checking, replying.
 *
 * So a dog that has spotted a bleating sheep is barking even while its own
 * pane is idle. That is the whole feature, said without a word of UI copy.
 *
 * Drawn facing left, like the sheep, so a pen holding both reads as one scene.
 * All motion is CSS in style.css and stops under prefers-reduced-motion.
 */
export type DogState = 'watching' | 'alerting' | 'working';

const STATE_CLASS: Record<DogState, string> = {
  watching: 'dog-watching',
  alerting: 'dog-alerting',
  working:  'dog-working',
};

const STATE_LABEL: Record<DogState, string> = {
  watching: 'The sheepdog is watching the flock',
  alerting: 'The sheepdog is calling you — a sheep is bleating',
  working:  'The sheepdog is working',
};

export default function DogStatus({ state }: { state: DogState }): React.ReactElement {
  return (
    <svg
      className={`sheep dog ${STATE_CLASS[state]}`}
      viewBox="0 0 44 38"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label={STATE_LABEL[state]}
    >
      <title>{STATE_LABEL[state]}</title>
      <g transform="translate(2 8)">
        <ellipse className="sheep-halo" cx="21" cy="16" rx="14" ry="10" />
        <ellipse className="sheep-ground" cx="21" cy="27.5" rx="12" ry="1.6" />
        <g className="dog-body">
          {/* tail: a curved brush over the rump, wagging when there is
              something to be pleased about */}
          <path
            className="dog-tail"
            d="M32.5 16.5 C 36.5 15.6 38 12.6 37.4 9.6"
            fill="none" strokeWidth="2.6" strokeLinecap="round"
          />
          {/* hind legs behind the haunch, front legs planted under the chest */}
          <g className="dog-legs">
            <line x1="27.5" y1="21" x2="28.6" y2="26.8" />
            <line x1="14.2" y1="19.5" x2="13.8" y2="27" />
            <line x1="17.6" y1="20" x2="17.4" y2="27" />
          </g>
          {/* haunch, barrel and chest: three overlapping masses rather than one
              outline, which keeps the silhouette readable at 32px */}
          <g className="dog-coat">
            <ellipse cx="28" cy="18.4" rx="7.2" ry="7.6" />
            <ellipse cx="22" cy="17.4" rx="7.6" ry="6.2" />
            <ellipse cx="15.6" cy="18" rx="5.4" ry="6" />
          </g>
          <g className="dog-head">
            {/* ear: pricked, and the first thing to move when it hears one */}
            <path className="dog-ear" d="M14.6 7.2 L 16.4 1.4 L 18.6 6.6 Z" />
            <ellipse className="dog-skull" cx="12.6" cy="9.4" rx="5.1" ry="4.7" />
            {/* muzzle and nose, out in front so the head reads as pointing */}
            <ellipse className="dog-muzzle" cx="7.6" cy="11.2" rx="3.6" ry="2.3" />
            <circle className="dog-nose" cx="4.6" cy="10.9" r="1.15" />
            <circle className="dog-eye" cx="11.4" cy="8.6" r=".95" />
            {/* the brow patch — a dog's face is unreadable without one */}
            <ellipse className="dog-brow" cx="13.4" cy="6.9" rx="2.4" ry="1.5" />
          </g>
        </g>
        {/* WORKING: a dust puff at the back paw, as if just set off */}
        <g className="dog-dust">
          <circle cx="33.5" cy="26" r="1.6" />
          <circle cx="36.6" cy="24.6" r="1.1" />
        </g>
      </g>
      {/* ALERTING: a bark leaving the muzzle, the same shape the sheep's baa
          uses so the two read as the same kind of event */}
      <g className="dog-bark">
        <circle cx="5.2" cy="18.2" r="1.8" />
        <circle cx="2.5" cy="14.8" r="1.2" />
        <circle cx=".9" cy="12" r=".85" />
      </g>
    </svg>
  );
}
