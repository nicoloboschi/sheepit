import { useEffect, useRef } from 'react';
import useStore from '../store';
import { noise, scatterGrass, frontGrass } from './grass';

/** The fence around a pen, drawn on a canvas rather than in CSS gradients.
 *
 *  A stack of `linear-gradient` slices can draw straight rails and evenly
 *  spaced posts, and that is exactly what it looks like — a border with
 *  ticks on it. Canvas buys the three things that make it read as timber:
 *  rails that sag between their posts, a darker grain hairline down each
 *  post, and per-post jitter. The gate is a real break in the top rail with
 *  two taller gateposts either side of it.
 *
 *  Costs one canvas and one ResizeObserver per pen. Everything is redrawn on
 *  size and theme changes only — there is no animation frame here. */
export default function PenFence({
  seed, active, gate = 17, className = 'pen-fence',
}: {
  seed: number;
  active: boolean;
  /** Half-width of the gap in the top rail. The sidebar's pens use the
   *  default; the workspace fence around the terminal grid is far wider, so
   *  a 17px gate on it reads as a nick rather than a way in. */
  gate?: number;
  className?: string;
}): React.ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // The wood colour comes from --fence, which the light theme redefines, so
  // the fence has to be repainted when the theme flips.
  const theme = useStore(s => s.theme);

  useEffect(() => {
    const cv = ref.current;
    const host = cv?.parentElement;
    if (!cv || !host) return;

    const draw = () => {
      const box = host.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width  = Math.round(box.width  * dpr);
      cv.height = Math.round(box.height * dpr);
      const g = cv.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, box.width, box.height);

      const cs = getComputedStyle(host);
      const wood  = cs.getPropertyValue('--fence').trim()   || '#8c9484';
      const grass = cs.getPropertyValue('--grazing').trim() || '#9CBC7F';
      const W = box.width, H = box.height;
      const m = 5.5;        // how far the rails sit inside the box
      const GATE = gate;    // half-width of the gate gap, centred on the top edge

      g.lineCap = 'round';

      // Rails first, posts on top of them, so the posts read as nearer the eye.
      const rail = (x1: number, y1: number, x2: number, y2: number, sag: number, alpha: number) => {
        g.strokeStyle = wood; g.globalAlpha = alpha; g.lineWidth = 1.1;
        g.beginPath();
        g.moveTo(x1, y1);
        g.quadraticCurveTo((x1 + x2) / 2, (y1 + y2) / 2 + sag, x2, y2);
        g.stroke();
      };
      rail(m, m, W / 2 - GATE, m, 1.6, 0.55);          // top, broken for the gate
      rail(W / 2 + GATE, m, W - m, m, 1.6, 0.55);
      rail(m, m + 4, W / 2 - GATE, m + 4, 0.7, 0.32);  // second rail: post-and-rail
      rail(W / 2 + GATE, m + 4, W - m, m + 4, 0.7, 0.32);
      rail(m, H - m, W - m, H - m, -1.8, 0.55);
      rail(m, H - m - 4, W - m, H - m - 4, -0.8, 0.32);
      rail(m, m, m, H - m, 0.6, 0.5);
      rail(W - m, m, W - m, H - m, -0.6, 0.5);

      const post = (x: number, y: number, dx: number, dy: number, len: number, alpha: number) => {
        g.globalAlpha = alpha; g.lineWidth = 1.6; g.strokeStyle = wood;
        g.beginPath(); g.moveTo(x, y); g.lineTo(x + dx * len, y + dy * len); g.stroke();
        g.globalAlpha = alpha * 0.45; g.lineWidth = 0.5;   // grain
        g.beginPath();
        g.moveTo(x + dx * len * 0.18, y + dy * len * 0.18);
        g.lineTo(x + dx * len * 0.82, y + dy * len * 0.82);
        g.stroke();
      };

      const STEP = 30;
      let k = seed * 97;
      for (let x = m; x <= W - m + 0.5; x += STEP) {     // top edge, skipping the gate
        if (Math.abs(x - W / 2) < GATE + 3) continue;
        post(x + (noise(k, 1) - 0.5) * 2, m - 3.5, 0, 1, 11 + noise(k, 2) * 3, 0.62); k++;
      }
      post(W / 2 - GATE, m - 5.5, 0, 1, 15, 0.8);        // gateposts stand taller —
      post(W / 2 + GATE, m - 5.5, 0, 1, 15, 0.8);        // that is the way in
      for (let x = m; x <= W - m + 0.5; x += STEP) {
        post(x + (noise(k, 1) - 0.5) * 2, H - m - 7.5, 0, 1, 11 + noise(k, 2) * 3, 0.62); k++;
      }
      for (let y = m + STEP / 2; y <= H - m - STEP / 2; y += STEP) {
        post(m - 3.5,   y + (noise(k, 1) - 0.5) * 2, 1, 0, 11 + noise(k, 2) * 3, 0.5); k++;
        post(W - m - 7.5, y + (noise(k, 3) - 0.5) * 2, 1, 0, 11 + noise(k, 2) * 3, 0.5); k++;
      }

      // Grass, all over the pen floor. The cards and panes paint on top of
      // this canvas, so most of it is hidden underneath them and what you
      // actually see is the field showing through the gutters, the margins
      // and the gap under the last card — which is what makes the enclosure
      // read as ground rather than as a box with a border.
      //
      // Drawn by the same code as the sidebar's pasture strip (./grass), from
      // the same deterministic hash as the posts above — so a blade never
      // moves when a sheep goes busy, and the ground the flock walks on looks
      // like the ground inside the pens. Static: nothing here animates.
      g.strokeStyle = grass;
      g.lineWidth = 1;
      k = scatterGrass(g, { left: m + 4, right: W - m - 4, top: m + 10, bottom: H - m - 8 }, k);
      // The front edge is the one strip that is never covered by a card, so
      // it carries the metaphor on its own. It grows in the bottom padding,
      // which .pen-body / .workspace-pen keep deeper than the other three
      // sides precisely to leave it room: rooted any higher and the cards sit
      // on top of it. Rooted ABOVE the bottom rail's pickets, not among them:
      // a first cut grew them from the rail itself, where they interleaved
      // with the pickets and read as more fence rather than as ground.
      k = frontGrass(g, { left: m + 4, right: W - m - 4, baseline: H - m - 3 }, k);

      g.globalAlpha = 1;
    };

    draw();
    // The pen's height changes when a pane is added, when a font lands, and
    // when the sidebar is dragged — observe the box rather than the window.
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => ro.disconnect();
    // `active` is in the deps because the canvas cannot react to a CSS colour
    // change on its own — --fence is read at paint time, so the fence has to
    // be repainted when the selected pen changes.
  }, [seed, theme, active, gate]);

  return <canvas ref={ref} className={className} aria-hidden />;
}
