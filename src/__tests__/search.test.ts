import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import {
  parseQuery, matchFacts, snippetAround, transcriptLineText, transcriptScore,
  isSearchableTranscript, transcriptPattern,
} from '../search.js'

const q = (s: string) => parseQuery(s)

describe('parseQuery', () => {
  it('reads the number out of the question people actually ask', () => {
    expect(q('3993').prNumber).toBe(3993)
    expect(q('#3993').prNumber).toBe(3993)
    expect(q('pr 3993').prNumber).toBe(3993)
    expect(q('issue #88').prNumber).toBe(88)
  })

  it('leaves prose alone', () => {
    expect(q('mirror deletion').prNumber).toBeNull()
    expect(q('mirror deletion').terms).toEqual(['mirror', 'deletion'])
    // A number inside a phrase is not the question "which pane is on 3993".
    expect(q('rebase onto 3993').prNumber).toBeNull()
  })
})

describe('matchFacts', () => {
  const facts = {
    id: 'direct-1', name: 'mirror deletion fix', path: '/Users/x/dev/hindsight-wt1',
    gitBranch: 'pr-3672', prRefs: [{ kind: 'pr' as const, num: 3993, repo: 'o/r' }],
  }

  it('answers a PR number from what the hooks reported', () => {
    const m = matchFacts(facts, [], q('3993'))
    expect(m).toMatchObject({ source: 'pr' })
    expect(m!.snippet).toContain('#3993')
  })

  it('ranks an exact PR above a name that merely contains the words', () => {
    const other = { id: 'direct-2', name: 'rebase onto 3993 branch' }
    const a = matchFacts(facts, [], q('3993'))!
    const b = matchFacts(other, [], q('3993'))!
    expect(a.score).toBeGreaterThan(b.score)
  })

  it('matches name, branch and path', () => {
    expect(matchFacts(facts, [], q('deletion'))!.source).toBe('name')
    expect(matchFacts(facts, [], q('pr-3672'))!.source).toBe('branch')
    expect(matchFacts(facts, [], q('hindsight-wt1'))!.source).toBe('path')
  })

  it('requires every term, so two words are not two separate matches', () => {
    expect(matchFacts(facts, [], q('mirror deletion'))).not.toBeNull()
    expect(matchFacts(facts, [], q('mirror telemetry'))).toBeNull()
  })

  // What you asked describes the work; what the agent replied may be quoting
  // the question back, or explaining why it did not do it.
  it('prefers the prompt over the response, and recent turns over old ones', () => {
    const asked = matchFacts(facts, [{ prompt: 'look at the flake' }], q('flake'))!
    const answered = matchFacts(facts, [{ response: 'the flake is fixed' }], q('flake'))!
    expect(asked.score).toBeGreaterThan(answered.score)

    const recent = matchFacts(facts, [{ prompt: 'the flake' }, {}], q('flake'))!
    const older = matchFacts(facts, [{}, { prompt: 'the flake' }], q('flake'))!
    expect(recent.score).toBeGreaterThan(older.score)
  })

  it('returns one row per pane — the best reason, not every reason', () => {
    const m = matchFacts(facts, [{ prompt: 'mirror deletion again' }], q('mirror deletion'))
    expect(m!.source).toBe('name')
  })

  it('says nothing for an empty query', () => {
    expect(matchFacts(facts, [], q('   '))).toBeNull()
  })
})

describe('snippetAround', () => {
  it('shows the match rather than the first 160 characters', () => {
    const text = 'a'.repeat(400) + ' NEEDLE ' + 'b'.repeat(400)
    const s = snippetAround(text, ['needle'])
    expect(s).toContain('NEEDLE')
    expect(s.length).toBeLessThanOrEqual(170)
    expect(s.startsWith('…')).toBe(true)
  })

  it('leaves a short line alone', () => {
    expect(snippetAround('  rebase   onto 3993 ', ['3993'])).toBe('rebase onto 3993')
  })
})

describe('transcriptLineText', () => {
  it('reads a Claude user row (content is a plain string)', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'who is on 3993?' } })
    expect(transcriptLineText(line)).toEqual({ role: 'user', text: 'who is on 3993?' })
  })

  it('reads a Claude assistant row (content is a block list)', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'looking at 3993' }] } })
    expect(transcriptLineText(line)).toEqual({ role: 'assistant', text: 'looking at 3993' })
  })

  it('reads a Codex rollout message', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rebase onto 3993' }] },
    })
    expect(transcriptLineText(line)).toEqual({ role: 'user', text: 'rebase onto 3993' })
  })

  // Without this, a search for "skills" matches every Codex pane on a preamble
  // nobody wrote, and every Claude pane on a tool result nobody read.
  it('drops everything that is not conversation', () => {
    const drops = [
      JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ text: 'skills preamble' }] } }),
      JSON.stringify({ type: 'attachment', content: 'skills' }),
      JSON.stringify({ type: 'system', content: 'skills' }),
      JSON.stringify({ type: 'file-history-snapshot' }),
      JSON.stringify({ type: 'user', isSidechain: true, message: { content: 'a subagent said this' } }),
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', input: {} }] } }),
      'not json at all',
      '',
    ]
    for (const line of drops) expect(transcriptLineText(line), line.slice(0, 40)).toBeNull()
  })
})

describe('transcriptScore', () => {
  it('puts a question above an answer, and caps how far a repeat can carry', () => {
    expect(transcriptScore('user', 1)).toBeGreaterThan(transcriptScore('assistant', 1))
    expect(transcriptScore('user', 40)).toBe(transcriptScore('user', 5))
  })

  it('never outranks the facts', () => {
    const facts = { id: 'x', name: 'a pane', prRefs: [{ kind: 'pr' as const, num: 1 }] }
    expect(transcriptScore('user', 40)).toBeLessThan(matchFacts(facts, [], q('1'))!.score)
  })
})

describe('isSearchableTranscript', () => {
  it('accepts the two places transcripts live', () => {
    expect(isSearchableTranscript(join(homedir(), '.claude/projects/-Users-x-dev/abc.jsonl'))).toBe(true)
    expect(isSearchableTranscript(join(homedir(), '.codex/sessions/2026/09/01/rollout-x.jsonl'))).toBe(true)
  })

  // The path comes from a hook, over an endpoint anything local can post to.
  it('refuses anything else, including a climb out of an allowed root', () => {
    expect(isSearchableTranscript('/etc/passwd')).toBe(false)
    expect(isSearchableTranscript(join(homedir(), '.ssh/id_rsa'))).toBe(false)
    expect(isSearchableTranscript(join(homedir(), '.claude/projects/../../.ssh/id_rsa.jsonl'))).toBe(false)
    expect(isSearchableTranscript(join(homedir(), '.claude/projects-of-mine/a.jsonl'))).toBe(false)
    expect(isSearchableTranscript(join(homedir(), '.claude/projects/a/notes.txt'))).toBe(false)
    expect(isSearchableTranscript('')).toBe(false)
  })
})

describe('transcriptPattern', () => {
  it('searches the number for a numeric query, so "pr 3993" finds "#3993"', () => {
    expect(transcriptPattern(q('pr 3993'))).toBe('3993')
  })

  it('searches the phrase otherwise', () => {
    expect(transcriptPattern(q('mirror deletion'))).toBe('mirror deletion')
  })
})
