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

/**
 * A field of blades, collected by alpha and stroked in one go per level.
 *
 * Every blade used to be its own `beginPath` / `globalAlpha` / `stroke`. The
 * workspace pen covers the whole main area, so that was around 7,000 separate
 * stroke calls per redraw — which sounds ruinous and measured, on a real page,
 * at 2.2ms against 1.7ms for this version. **Canvas strokes are cheap.** Keep
 * the honest number in mind before reaching for this pattern again: it is a
 * 1.3x win on something that only happens on resize, kept because it also turns
 * 7,000 draw calls into about ten, which is worth more on a weaker GPU and at a
 * higher device pixel ratio than the machine it was measured on.
 *
 * It is *not* what makes a slow redraw slow. That is the forced layout and
 * style recalculation in `PenFence` itself — see the note on its
 * ResizeObserver.
 *
 * Nothing about the picture changes. The blades are the same curves from the
 * same deterministic hash; they are only grouped, because canvas state changes
 * and draw calls are what cost, not the geometry. Alpha is quantised to
 * `ALPHA_STEP` so blades of near-identical faintness share a path — the error
 * is at most half a step, which is below what anyone can see in texture this
 * faint.
 */
const ALPHA_STEP = 0.02;

class Field {
  private readonly byAlpha = new Map<number, Path2D>();

  /** One blade, rooted at (x, y) and leaning as it rises. */
  add(x: number, y: number, salt: number, alpha: number): void {
    const height = 3 + noise(salt, 4) * 5;
    const lean   = (noise(salt, 5) - 0.5) * 6;
    const key = Math.round(alpha / ALPHA_STEP);
    let path = this.byAlpha.get(key);
    if (!path) { path = new Path2D(); this.byAlpha.set(key, path); }
    path.moveTo(x, y);
    path.quadraticCurveTo(x + lean * 0.35, y - height * 0.65, x + lean, y - height);
  }

  /** The caller has already set strokeStyle and lineWidth for the whole field. */
  paint(g: CanvasRenderingContext2D): void {
    for (const [key, path] of this.byAlpha) {
      g.globalAlpha = key * ALPHA_STEP;
      g.stroke(path);
    }
  }
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
  const field = new Field();
  for (let y = box.top; y < box.bottom; y += ROW) {
    for (let x = box.left; x < box.right; x += COL) {
      k++;
      if (noise(k, 7) > 0.66) continue;
      field.add(x + (noise(k, 8) - 0.5) * 11, y + (noise(k, 9) - 0.5) * 9, k,
        (0.14 + noise(k, 6) * 0.18) * alphaScale);
    }
  }
  field.paint(g);
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
  const field = new Field();
  for (let x = edge.left + 2; x < edge.right; x += 3.5) {
    k++;
    field.add(x, edge.baseline - 3, k, (0.3 + noise(k, 6) * 0.22) * alphaScale);
  }
  for (let x = edge.left; x < edge.right; x += 3) {
    k++;
    field.add(x, edge.baseline, k, (0.68 + noise(k, 6) * 0.3) * alphaScale);
  }
  field.paint(g);
  return k;
}
