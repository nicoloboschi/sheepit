/**
 * The flock, grazing at the bottom of the sidebar.
 *
 * One 🐑 per pen, wandering the grass strip. What each sheep is doing mirrors
 * what its pen is doing: a bleating pen's sheep hops and puffs a "baa", a
 * grazing pen's sheep keeps its head down and shuffles, and an idle pen's
 * sheep just plods back and forth.
 *
 * Everything is CSS animation on a real emoji glyph — no image requests, no
 * canvas, nothing to load. The strip is `pointer-events: none` so it can never
 * swallow a click meant for the pen list above it.
 */
import { useFlockCounts } from '../flock';

/** More than this and the strip reads as a stampede rather than a flock. */
const MAX_SHEEP = 9;

/** Deterministic 0..1 from an integer — same trick as FlockGrass, so a sheep
 *  keeps its lane and gait across re-renders instead of teleporting whenever
 *  a session goes busy. */
function noise(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

type Mood = 'bleating' | 'grazing' | 'idle';

export default function FlockSheep(): React.ReactElement | null {
  const { pens, bleating, grazing } = useFlockCounts();
  if (pens === 0) return null;

  const count = Math.min(pens, MAX_SHEEP);
  // Hand out moods in the order they matter: the sheep that want you first,
  // so a bleating pen is never the one that got truncated off the strip.
  const moods: Mood[] = Array.from({ length: count }, (_, i) =>
    i < bleating ? 'bleating' : i < bleating + grazing ? 'grazing' : 'idle');

  return (
    <div className="flock-sheep" aria-hidden>
      {moods.map((mood, i) => {
        // Spread the sheep across the strip, then jitter so they don't line up.
        const left = (i + 0.5) / count * 100 + (noise(i, 1) - 0.5) * (60 / count);
        // Walk distance and speed vary per sheep; bleating ones fidget faster.
        const roam = 8 + noise(i, 2) * 16;
        const walk = (mood === 'bleating' ? 5 : 9) + noise(i, 3) * 7;
        const bob = 0.9 + noise(i, 4) * 0.5;
        return (
          <span
            key={i}
            className={`flock-sheep-one flock-sheep-${mood}`}
            style={{
              left: `${Math.max(2, Math.min(96, left))}%`,
              // Custom properties drive the keyframes, so every sheep shares
              // one animation definition but walks its own beat.
              ['--roam' as string]: `${roam.toFixed(1)}px`,
              ['--walk' as string]: `${walk.toFixed(1)}s`,
              ['--bob' as string]: `${bob.toFixed(2)}s`,
              ['--delay' as string]: `-${(noise(i, 5) * walk).toFixed(1)}s`,
              ['--size' as string]: `${(11 + noise(i, 6) * 3).toFixed(1)}px`,
            }}
          >
            <span className="flock-sheep-body">🐑</span>
            {mood === 'bleating' && <span className="flock-sheep-baa">baa</span>}
          </span>
        );
      })}
    </div>
  );
}
