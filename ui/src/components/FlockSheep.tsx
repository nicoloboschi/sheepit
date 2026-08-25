/**
 * The flock, grazing at the bottom of the sidebar.
 *
 * One 🐑 per **real sheep** — one per pane, in the state that pane is actually
 * in. It used to be one per pen with moods handed out from the aggregate
 * counts ("N sheep, draw the first `bleating` of them bleating"), which meant
 * no animal in the strip corresponded to anything you could go and look at.
 * Now each one is a pane, and a bleating sheep **calls you by that pane's
 * name**, so the strip answers "who wants me?" and not just "does anyone?".
 *
 * Everything is CSS animation on a real emoji glyph — no image requests, no
 * canvas, nothing to load. The strip stays `pointer-events: none` so it can
 * never swallow a click meant for the pen list above it, which is also why the
 * name is shown rather than left to a tooltip nobody could hover.
 */
import { useFlockSheep, type SheepState } from '../flock';

/** More than this and the strip reads as a stampede rather than a flock.
 *  The list arrives loudest-first, so what gets dropped is always quiet. */
const MAX_SHEEP = 9;

/** How many sheep say a name at once. Every bleating sheep still hops and
 *  puffs — this is only about the label. One, because the strip is ~250px and
 *  a name tag is up to 118px of it, so two of them collide as often as not.
 *  The footer line right above already says how many are bleating; this
 *  answers the other half, which one. */
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

export default function FlockSheep(): React.ReactElement | null {
  const flock = useFlockSheep();
  if (flock.length === 0) return null;

  const shown = flock.slice(0, MAX_SHEEP);
  let calling = 0;

  return (
    <div className="flock-sheep" aria-hidden>
      {shown.map((sheep, i) => {
        const state: SheepState = sheep.state;
        const seed = seedOf(sheep.sessionId);
        // Spread across the strip by position, jittered by the sheep's own
        // seed so they do not line up and do not shuffle when one changes.
        const left = (i + 0.5) / shown.length * 100
          + (noise(seed, 1) - 0.5) * (60 / shown.length);
        // Walk distance and speed vary per sheep; the ones that want you fidget.
        const roam = 8 + noise(seed, 2) * 16;
        const walk = (state === 'bleating' ? 5 : 9) + noise(seed, 3) * 7;
        const bob = 0.9 + noise(seed, 4) * 0.5;
        const speaks = state === 'bleating' && calling < MAX_CALLING;
        if (speaks) calling++;
        return (
          <span
            key={sheep.sessionId}
            // The edge modifier is on the wrapper, not on the label: the
            // "baa" hangs off the sheep's right too, and both need to fold
            // inward for a sheep standing at the end of the strip.
            className={`flock-sheep-one flock-sheep-${state}${
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
              <span className="flock-sheep-body">🐑</span>
            </span>
            {state === 'bleating' && <span className="flock-sheep-baa">baa</span>}
            {/* Finished, and nobody has read it: no noise, just a mark. */}
            {state === 'unread' && <span className="flock-sheep-unread" />}
          </span>
        );
      })}
    </div>
  );
}
