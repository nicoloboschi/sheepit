// While the mic is open, the voice's spectrum runs around the window's edges:
// thin bars pointing inward, each side mirrored so the low notes (where
// speech is loud) sit mid-side and fade to the corners. One canvas over
// everything, drawn from dictation.ts's meter frame; gone when the mic stops.

const GAP = 6;        // px between bars
const MAX_LEN = 34;   // px a bar reaches inward at full volume
const LOW_BIN = 2;    // ~190 Hz at 48 kHz / 512
const HIGH_BIN = 46;  // ~4.3 kHz: above that speech is mostly hiss

export function startEdgeWave(analyser: AnalyserNode): { draw(): void; stop(): void } {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return { draw() {}, stop() {} };
  const canvas = document.createElement('canvas');
  canvas.className = 'voice-edge-wave';
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  const bins = new Uint8Array(analyser.frequencyBinCount);
  let w = 0, h = 0;

  const fit = () => {
    const dpr = devicePixelRatio || 1;
    w = innerWidth; h = innerHeight;
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineCap = 'round';
    ctx.lineWidth = 2;
  };
  fit();
  addEventListener('resize', fit);

  // Bar length for a spot `s` (0..1) along a side.
  const len = (s: number) => {
    const u = 1 - Math.abs(2 * s - 1); // 0 at the corners, 1 mid-side
    const v = bins[Math.round(HIGH_BIN - u * (HIGH_BIN - LOW_BIN))]! / 255;
    return v * v * MAX_LEN * (0.35 + 0.65 * u);
  };

  return {
    draw() {
      analyser.getByteFrequencyData(bins);
      ctx.clearRect(0, 0, w, h);
      ctx.beginPath();
      for (let x = GAP / 2; x < w; x += GAP) {
        const l = len(x / w);
        if (l < 0.5) continue;
        ctx.moveTo(x, 0); ctx.lineTo(x, l);
        ctx.moveTo(x, h); ctx.lineTo(x, h - l);
      }
      for (let y = GAP / 2; y < h; y += GAP) {
        const l = len(y / h);
        if (l < 0.5) continue;
        ctx.moveTo(0, y); ctx.lineTo(l, y);
        ctx.moveTo(w, y); ctx.lineTo(w - l, y);
      }
      ctx.strokeStyle = 'rgba(190, 222, 160, 0.85)';
      ctx.shadowColor = 'rgba(156, 188, 127, 0.9)';
      ctx.shadowBlur = 8;
      ctx.stroke();
    },
    stop() {
      removeEventListener('resize', fit);
      canvas.remove();
    },
  };
}
