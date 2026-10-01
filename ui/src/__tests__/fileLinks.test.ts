import { describe, it, expect } from 'vitest'
import { findFileLinks } from '../utils'

/** Pad rows the way xterm's untrimmed translateToString does. */
const wrap = (text: string, cols: number) => {
  const rows: string[] = []
  for (let i = 0; i < text.length; i += cols) rows.push(text.slice(i, i + cols).padEnd(cols, ' '))
  return rows
}

describe('findFileLinks', () => {
  it('finds an absolute path on one row', () => {
    const [m] = findFileLinks(wrap('see /tmp/a/b.md now', 80), 80, 4)
    expect(m!.text).toBe('/tmp/a/b.md')
    expect(m!.start).toEqual({ x: 5, y: 5 })
    expect(m!.end).toEqual({ x: 15, y: 5 })
  })

  it('finds a path wrapped across rows, whole and with the right range', () => {
    const path = '/private/tmp/claude-501/-Users-x-dev-hindsight-deployment1/31823bfc-bdea-4370-ba41-bd009ed6e1c3/scratchpad/proposal.md'
    const cols = 40
    const rows = wrap(`at ${path} ok`, cols)
    expect(rows.length).toBeGreaterThan(1)
    const [m] = findFileLinks(rows, cols, 0)
    expect(m!.text).toBe(path)
    expect(m!.start).toEqual({ x: 4, y: 1 })
    const last = 3 + path.length - 1
    expect(m!.end).toEqual({ x: (last % cols) + 1, y: Math.floor(last / cols) + 1 })
  })

  it('matches bare relative paths and skips URLs and prose', () => {
    expect(findFileLinks(['open src/a.ts and out/clip.mp4'], 80, 0).map(m => m.text))
      .toEqual(['src/a.ts', 'out/clip.mp4'])
    expect(findFileLinks(['this and/or TCP/IP https://x.dev/a'], 80, 0)).toEqual([])
  })
})
