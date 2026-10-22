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

describe('RowReader: a message sent while the agent works', () => {
  it('is drawn from its queued_command attachment; task notifications are not', () => {
    const r = new RowReader()
    const typed = r.read({ type: 'attachment', uuid: 'q', timestamp: '2026-10-20T10:00:00Z', attachment: { type: 'queued_command', prompt: 'also check the docs' } })
    expect(typed.added).toMatchObject([{ id: 'u-q', kind: 'user', text: 'also check the docs' }])
    const note = r.read({ type: 'attachment', uuid: 'n', attachment: { type: 'queued_command', prompt: '<task-notification>done</task-notification>' } })
    expect(note.added).toHaveLength(0)
  })
})
