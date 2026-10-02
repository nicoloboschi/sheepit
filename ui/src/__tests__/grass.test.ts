import { describe, it, expect, beforeAll } from 'vitest'
import { scatterGrass, frontGrass, noise } from '../components/grass'

// jsdom has no canvas, so stand in for the two things the field actually uses.
class FakePath {
  segments = 0
  moveTo(): void {}
  quadraticCurveTo(): void { this.segments++ }
}
interface Ctx { strokes: number; alphas: number[]; globalAlpha: number; stroke: (p: FakePath) => void }
function ctx(): Ctx {
  const c = {
    strokes: 0, alphas: [] as number[], globalAlpha: 1,
    stroke(_p: FakePath) { c.strokes++; c.alphas.push(c.globalAlpha) },
  }
  return c
}
beforeAll(() => {
  ;(globalThis as unknown as { Path2D: unknown }).Path2D = FakePath
})

// The grass is drawn on every resize, and the workspace pen covers the whole
// main area — so the thing that matters is how many draw calls a field costs,
// not how many blades are in it. One stroke per blade was 209ms per redraw.
describe('grass batching', () => {
  it('strokes once per alpha level, not once per blade', () => {
    const g = ctx()
    // A floor the size of a full-window workspace pen.
    scatterGrass(g as unknown as CanvasRenderingContext2D,
      { left: 0, right: 1100, top: 0, bottom: 850 }, 0)
    // ~7,800 blades land in this box; the alpha range is 0.14–0.32, which at
    // a 0.02 step is a couple of dozen levels at most.
    expect(g.strokes).toBeGreaterThan(0)
    expect(g.strokes).toBeLessThan(40)
  })

  it('keeps every alpha it paints inside the range the blades asked for', () => {
    const g = ctx()
    scatterGrass(g as unknown as CanvasRenderingContext2D,
      { left: 0, right: 400, top: 0, bottom: 300 }, 0)
    // 0.14 .. 0.32, plus at most half a quantisation step either side.
    for (const a of g.alphas) {
      expect(a).toBeGreaterThanOrEqual(0.13)
      expect(a).toBeLessThanOrEqual(0.33)
    }
  })

  it('keeps the front edge bright — it is the strip nothing covers', () => {
    const g = ctx()
    frontGrass(g as unknown as CanvasRenderingContext2D,
      { left: 0, right: 400, baseline: 100 }, 0)
    expect(Math.max(...g.alphas)).toBeGreaterThan(0.9)
    expect(g.strokes).toBeLessThan(80)
  })

  it('is deterministic, so a field never reshuffles when a sheep goes busy', () => {
    expect(noise(7, 4)).toBe(noise(7, 4))
    const a = ctx(); const b = ctx()
    const box = { left: 0, right: 200, top: 0, bottom: 150 }
    scatterGrass(a as unknown as CanvasRenderingContext2D, box, 0)
    scatterGrass(b as unknown as CanvasRenderingContext2D, box, 0)
    expect(a.alphas).toEqual(b.alphas)
  })

  it('returns the hash counter so successive passes stay one sequence', () => {
    const g = ctx()
    const k = scatterGrass(g as unknown as CanvasRenderingContext2D,
      { left: 0, right: 100, top: 0, bottom: 100 }, 0)
    expect(k).toBeGreaterThan(0)
    expect(frontGrass(g as unknown as CanvasRenderingContext2D,
      { left: 0, right: 100, baseline: 50 }, k)).toBeGreaterThan(k)
  })
})
