import { describe, it, expect } from 'vitest'
import { RowReader } from '../claude-native.js'

describe('RowReader: a message with an attached image', () => {
  it('is one user message: marker dropped, image path joined, meta row hidden', () => {
    const r = new RowReader()
    const first = r.read({
      type: 'user', uuid: 'a', timestamp: '2026-10-16T10:00:00Z',
      message: { content: [{ type: 'text', text: '[Image #2]this is a test' }, { type: 'image', source: { type: 'base64' } }] },
    })
    expect(first.added).toHaveLength(1)
    expect(first.added[0]).toMatchObject({ kind: 'user', text: 'this is a test' })

    const meta = r.read({
      type: 'user', uuid: 'b', isMeta: true, timestamp: '2026-10-16T10:00:00Z',
      message: { content: [{ type: 'text', text: '[Image: source: /tmp/shot.png]' }] },
    })
    expect(meta.added).toHaveLength(0)
    expect(meta.changed).toHaveLength(1)
    expect(meta.changed[0]).toMatchObject({ id: 'u-a', text: 'this is a test\n/tmp/shot.png' })
  })

  it('hides other meta rows, like hook feedback', () => {
    const r = new RowReader()
    const out = r.read({ type: 'user', uuid: 'c', isMeta: true, message: { content: 'Stop hook feedback:\n[keep going]' } })
    expect(out.added).toHaveLength(0)
  })
})
