import { describe, it, expect } from 'vitest'
import { RowReader, answerKeys } from '../claude-native.js'

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

describe('answerKeys: the keys that answer AskUserQuestion', () => {
  const opts = (n: number) => Array.from({ length: n }, (_, i) => ({ label: `o${i}` }))
  const D = '\x1b[B'
  it('one single-select question is one digit, no review', () => {
    expect(answerKeys([{ options: opts(2) }], [{ picks: [1] }])).toEqual(['2'])
  })
  it('free text goes on the row after the options', () => {
    expect(answerKeys([{ options: opts(2) }], [{ picks: [], text: 'Mango\nplease' }])).toEqual(['3', 'Mango please', '\r'])
  })
  it('multi select toggles, walks to Submit, then the review', () => {
    expect(answerKeys([{ options: opts(3), multiSelect: true }], [{ picks: [1], text: 'Hamster' }]))
      .toEqual(['2', '4', D, D, D, 'Hamster', D, '\r', '1'])
    expect(answerKeys([{ options: opts(3) }, { options: opts(3), multiSelect: true }], [{ picks: [1] }, { picks: [0, 2, 9] }]))
      .toEqual(['2', '1', '3', D, D, D, D, '\r', '1'])
  })
})
