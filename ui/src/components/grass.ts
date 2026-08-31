/**
 * The grass, drawn on a canvas.
 *
 * One field, two places: inside every pen (`PenFence`, where it is texture
 * behind the pane cards) and along the bottom of the sidebar (`FlockGrass`,
 * where the flock stands in it). They used to be two implementations — the
 * pens on canvas, the pasture in SVG — with different blade shapes, different
 * heights and different alpha, so the strip the sheep walked on did not look
 * like the ground inside the pens six pixels above it.
 *
 * Nothing here animates and nothing here is random: blades come from a fixed
 * integer hash, so a field never reshuffles itself because a session went
 * busy. Every function takes the running hash counter `k` and returns it, so
 * a caller drawing several passes keeps one continuous sequence.
 */

/** Deterministic 0..1 from an integer. Cheap, and good enough to look organic. */
export function noise(i: number, salt: number): number {
  const x = Math.sin(i * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/** One blade, rooted at (x, y) and leaning as it rises. The caller sets
 *  strokeStyle and lineWidth once for the whole field. */
export function blade(
  g: CanvasRenderingContext2D, x: number, y: number, salt: number, alpha: number,
): void {
  const height = 3 + noise(salt, 4) * 5;
  const lean   = (noise(salt, 5) - 0.5) * 6;
  g.globalAlpha = alpha;
  g.beginPath();
  g.moveTo(x, y);
  g.quadraticCurveTo(x + lean * 0.35, y - height * 0.65, x + lean, y - height);
  g.stroke();
}

/** Blades scattered over a whole floor.
 *
 *  A third of the candidate spots are skipped and the jitter is wider than
 *  the spacing, so it clumps like a field instead of ruling itself into a
 *  lawn. Kept faint: inside a pen this is texture behind content. */
export function scatterGrass(
  g: CanvasRenderingContext2D,
  box: { left: number; right: number; top: number; bottom: number },
  k: number,
  alphaScale = 1,
): number {
  const COL = 8, ROW = 10;
  for (let y = box.top; y < box.bottom; y += ROW) {
    for (let x = box.left; x < box.right; x += COL) {
      k++;
      if (noise(k, 7) > 0.66) continue;
      blade(g, x + (noise(k, 8) - 0.5) * 11, y + (noise(k, 9) - 0.5) * 9, k,
        (0.14 + noise(k, 6) * 0.18) * alphaScale);
    }
  }
  return k;
}

/** The dense front edge: two staggered ranks along `baseline`, a shorter and
 *  dimmer one behind the tall saturated one.
 *
 *  Two passes because a single rank reads as a comb; staggering them reads as
 *  depth. The alpha is high on purpose — `--grazing` and `--fence` are both
 *  olive tones, and a washed-out blade beside a fence rail reads as more
 *  fence. The green has to be saturated to say "ground". */
export function frontGrass(
  g: CanvasRenderingContext2D,
  edge: { left: number; right: number; baseline: number },
  k: number,
  alphaScale = 1,
): number {
  for (let x = edge.left + 2; x < edge.right; x += 3.5) {
    k++;
    blade(g, x, edge.baseline - 3, k, (0.3 + noise(k, 6) * 0.22) * alphaScale);
  }
  for (let x = edge.left; x < edge.right; x += 3) {
    k++;
    blade(g, x, edge.baseline, k, (0.68 + noise(k, 6) * 0.3) * alphaScale);
  }
  return k;
}
