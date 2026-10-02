/**
 * The line of grass along the bottom of the sidebar — the floor the flock
 * stands on.
 *
 * Drawn on a canvas by the same code the pens use (`./grass`), so the ground
 * under the sheep is the ground inside a pen. It was SVG before, with its own
 * blade shape, its own heights and its own alpha, and the two fields six
 * pixels apart did not look like the same field.
 *
 * Blades come from a fixed integer hash rather than Math.random, so the strip
 * is stable across re-renders — a field that reshuffled itself every time a
 * session went busy would be a distraction, not decoration. Nothing here
 * animates; the movement in the pasture is the sheep.
 */
import { useEffect, useRef } from 'react';
import { perf } from '../perf';
import useStore from '../store';
import { scatterGrass, frontGrass } from './grass';

/** The strip's own seed. Any constant will do — it only has to be the same one
 *  every time so the blades keep their places. */
const SEED = 4111;

export default function FlockGrass(): React.ReactElement {
  const ref = useRef<HTMLCanvasElement | null>(null);
  // --grazing is redefined by the light theme, and a canvas cannot react to a
  // CSS colour change on its own, so the strip is repainted when it flips.
  const theme = useStore(s => s.theme);

  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;

    const draw = () => {
      // Timed: a canvas redraw that also reads layout and computed style.
      // One per pen, and pens redraw on resize and theme change — so if this
      // shows up per frame, something is calling it that should not.
      const endDraw = perf.span('flockGrass:draw');
      try { drawNow(); } finally { endDraw(); }
    };

    const drawNow = () => {
      const box = cv.getBoundingClientRect();
      if (!box.width || !box.height) return;
      const dpr = window.devicePixelRatio || 1;
      cv.width  = Math.round(box.width  * dpr);
      cv.height = Math.round(box.height * dpr);
      const g = cv.getContext('2d');
      if (!g) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, box.width, box.height);

      const W = box.width, H = box.height;
      g.lineCap = 'round';
      g.strokeStyle = getComputedStyle(cv).getPropertyValue('--grazing').trim() || '#9CBC7F';
      g.lineWidth = 1;

      // Nothing is ever drawn on top of this strip, so unlike a pen floor the
      // scatter above the front ranks is the part you actually see — it is
      // what keeps the edge from reading as a single ruled band.
      let k = SEED;
      k = scatterGrass(g, { left: 2, right: W - 2, top: 4, bottom: H - 5 }, k, 1.6);
      frontGrass(g, { left: 1, right: W - 1, baseline: H - 1 }, k);

      g.globalAlpha = 1;
    };

    draw();
    // The sidebar is draggable and the mobile header is not the same width as
    // the sidebar, so follow the element rather than the window.
    // Coalesced into one frame: a drag resizes continuously and a
    // ResizeObserver can call back more than once before anything is painted,
    // and each call is a full redraw that reads layout and computed style.
    let pending = 0;
    const redraw = () => {
      if (pending) return;
      pending = requestAnimationFrame(() => { pending = 0; draw(); });
    };
    const ro = new ResizeObserver(redraw);
    ro.observe(cv);
    return () => { ro.disconnect(); if (pending) cancelAnimationFrame(pending); };
  }, [theme]);

  return <canvas ref={ref} className="flock-grass" aria-hidden />;
}
