/**
 * The sheep that want you, standing in the grass at the bottom of the sidebar.
 *
 * **Only bleating sheep appear here.** The strip used to hold one animal per
 * pane in whatever state that pane was in, which made it a second copy of the
 * pen list — the same twenty sheep whether or not anything needed you, so the
 * one that did was lost among them. Now the pasture answers one question,
 * "who wants me?", and answers it by being empty when the answer is nobody.
 * The counts for everything else are in the footer line above.
 *
 * A sheep **calls you by its pane's name**, and clicking it takes you to that
 * pane. That click is the one exception to the strip's `pointer-events: none`
 * — the pasture band as a whole must never swallow a click meant for the last
 * pen card, so only the animals themselves are hit-testable.
 *
 * Everything is CSS animation on a real emoji glyph — no image requests, no
 * canvas, nothing to load. (The grass behind them is canvas; see FlockGrass.)
 */
import { useFlockSheep } from '../flock';

/** More than this and the strip reads as a stampede rather than a flock.
 *  Reached only when a lot of panes want you at once; what gets dropped is
 *  still counted on the footer line above. */
const MAX_SHEEP = 9;

/** How many sheep say a name at once. Every one of them still hops and puffs
 *  a "baa" — this is only about the label. One, because the strip is ~250px
 *  and a name tag is up to 118px of it, so two of them collide as often as
 *  not. The rest carry their names in their tooltip and their aria-label,
 *  which is reachable now that the sheep are buttons. */
const MAX_CALLING = 1;

/** Deterministic 0..1 from an integer — same trick as FlockGrass, so a sheep
 *  keeps its lane and gait across re-renders instead of teleporting whenever
 *  a session goes busy. */
function noise(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** A stable integer per session, so a sheep keeps the same lane and gait for
 *  its whole life rather than inheriting whatever index it landed on. */
function seedOf(sessionId: string): number {
  let h = 0;
  for (let i = 0; i < sessionId.length; i++) h = (h * 31 + sessionId.charCodeAt(i)) | 0;
  return Math.abs(h) % 9973;
}

/** Names get long; a sheep calling across a field is not reading you an
 *  essay. Cut on a word boundary where there is one. */
function shortName(name: string, max = 18): string {
  const clean = name.trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return (space > max * 0.5 ? cut.slice(0, space) : cut).trimEnd() + '…';
}

export default function FlockSheep({ onSelect }: {
  /** Go to this pane. Given by the sidebar and the mobile Pens sheet; without
   *  it the sheep stay decoration, as they were. */
  onSelect?: (workspaceId: string, paneIndex: number) => void;
}): React.ReactElement | null {
  // Only the ones asking for you — see the note at the top of the file.
  const flock = useFlockSheep().filter(sheep => sheep.state === 'bleating');
  if (flock.length === 0) return null;

  const shown = flock.slice(0, MAX_SHEEP);

  return (
    // Interactive sheep must not be hidden from assistive tech; decorative
    // ones must not be announced at all.
    <div className="flock-sheep" aria-hidden={onSelect ? undefined : true}>
      {shown.map((sheep, i) => {
        const seed = seedOf(sheep.sessionId);
        // Spread across the strip by position, jittered by the sheep's own
        // seed so they do not line up and do not shuffle when one changes.
        const left = (i + 0.5) / shown.length * 100
          + (noise(seed, 1) - 0.5) * (60 / shown.length);
        // Walk distance and speed vary per sheep; these ones want you, so
        // they fidget rather than plod.
        const roam = 8 + noise(seed, 2) * 16;
        const walk = 5 + noise(seed, 3) * 7;
        const bob = 0.9 + noise(seed, 4) * 0.5;
        const speaks = i < MAX_CALLING;
        return (
          <span
            key={sheep.sessionId}
            // The edge modifier is on the wrapper, not on the label: the
            // "baa" hangs off the sheep's right too, and both need to fold
            // inward for a sheep standing at the end of the strip.
            className={`flock-sheep-one flock-sheep-bleating${
              left < 26 ? ' flock-sheep-at-start' : left > 74 ? ' flock-sheep-at-end' : ''}`}
            style={{
              left: `${Math.max(2, Math.min(96, left))}%`,
              // Custom properties drive the keyframes, so every sheep shares
              // one animation definition but walks its own beat.
              ['--roam' as string]: `${roam.toFixed(1)}px`,
              ['--walk' as string]: `${walk.toFixed(1)}s`,
              ['--bob' as string]: `${bob.toFixed(2)}s`,
              ['--delay' as string]: `-${(noise(seed, 5) * walk).toFixed(1)}s`,
              ['--size' as string]: `${(11 + noise(seed, 6) * 3).toFixed(1)}px`,
            }}
          >
            {/* The one that wants you says which one it is. */}
            {speaks && (
              <span className="flock-sheep-call">{shortName(sheep.name)}</span>
            )}
            {/* The flip that turns the sheep around at the end of its walk
                lives on this wrapper, not on .flock-sheep-one: as a transform
                on the whole sheep it also mirrored the name tag, which came
                out written backwards. */}
            <span className="flock-sheep-facing">
              {onSelect ? (
                <button
                  type="button"
                  className="flock-sheep-body flock-sheep-hit"
                  title={`${sheep.name} — wants your input`}
                  aria-label={`Go to ${sheep.name}, which wants your input`}
                  onClick={() => onSelect(sheep.workspaceId, sheep.paneIndex)}
                >
                  🐑
                </button>
              ) : (
                <span className="flock-sheep-body">🐑</span>
              )}
            </span>
            <span className="flock-sheep-baa">baa</span>
          </span>
        );
      })}
    </div>
  );
}
