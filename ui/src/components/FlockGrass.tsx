/**
 * The line of grass along the bottom of the sidebar.
 *
 * Blades are generated from a fixed integer hash rather than Math.random so the
 * strip is stable across re-renders — a field that reshuffled itself every time
 * a session went busy would be a distraction, not decoration. The SVG scales to
 * whatever width the sidebar has been dragged to via preserveAspectRatio.
 */
const WIDTH = 240;
const HEIGHT = 22;
const BLADES = 78;
/** Tallest blade. Deliberately short of the strip's full height: the sheep in
 *  FlockSheep stand in this grass, and blades that reach their backs bury them
 *  instead of framing them. */
const MAX_BLADE = 13;

/** Deterministic 0..1 from an integer. Cheap, and good enough to look organic. */
function noise(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

const blades = Array.from({ length: BLADES }, (_, i) => {
  // Jitter the spacing so the blades don't read as a comb.
  const x = (i + noise(i, 1) * 0.9 - 0.45) * (WIDTH / BLADES);
  // Squared noise biases the field towards short blades with a few tall ones,
  // which reads as grass; a flat distribution reads as a comb.
  const height = 3 + noise(i, 2) ** 1.7 * (MAX_BLADE - 3);
  // Lean left or right, more the taller the blade.
  const lean = (noise(i, 3) - 0.5) * height * 0.55;
  const width = 0.6 + noise(i, 4) * 0.6;
  return { x, height, lean, width, opacity: 0.3 + noise(i, 5) * 0.42 };
});

export default function FlockGrass(): React.ReactElement {
  return (
    <svg
      className="flock-grass"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      aria-hidden
      focusable="false"
    >
      {blades.map(({ x, height, lean, width, opacity }, i) => (
        <path
          key={i}
          d={`M${x.toFixed(2)} ${HEIGHT} Q${(x + lean * 0.4).toFixed(2)} ${(HEIGHT - height * 0.6).toFixed(2)} ${(x + lean).toFixed(2)} ${(HEIGHT - height).toFixed(2)}`}
          stroke="var(--grazing)"
          strokeWidth={width.toFixed(2)}
          strokeLinecap="round"
          fill="none"
          opacity={opacity.toFixed(2)}
        />
      ))}
    </svg>
  );
}
