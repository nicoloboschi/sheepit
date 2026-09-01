import { describe, it, expect } from 'vitest'
import { homedir } from 'os'
import { join } from 'path'
import {
  parseQuery, matchFacts, matchFactsAll, bestPerGroup, groupOf, speakerOf,
  snippetAround, transcriptLineText, transcriptScore,
  isSearchableTranscript, transcriptPattern, containsPattern,
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

  it('carries the turn timestamp, so a result can say when it was said', () => {
    const at = Date.now() - 60_000
    expect(matchFacts(facts, [{ prompt: 'the flake', at }], q('flake'))!.at).toBe(at)
    // A name or a branch is not a message and has no "when".
    expect(matchFacts(facts, [], q('deletion'))!.at).toBeUndefined()
  })

  it('says nothing for an empty query', () => {
    expect(matchFacts(facts, [], q('   '))).toBeNull()
  })
})

// "I asked this pane about 3993" and "this pane told me 3993 is merged" are
// different answers to the same query, and they send you to different things
// to do next — so the results are grouped by who said it.
describe('grouping by speaker', () => {
  const facts = { id: 'direct-1', name: 'mirror deletion fix', gitBranch: 'pr-3672' }

  it('files a match under the speaker, and a fact under neither', () => {
    expect(groupOf({ source: 'name', snippet: '', score: 1 })).toBe('facts')
    expect(groupOf({ source: 'turn', snippet: '', score: 1, role: 'you' })).toBe('you')
    expect(groupOf({ source: 'transcript', snippet: '', score: 1, role: 'agent' })).toBe('agent')
    expect(speakerOf('user')).toBe('you')
    expect(speakerOf('assistant')).toBe('agent')
  })

  it('reports both halves of one exchange, not just the louder one', () => {
    const matches = matchFactsAll(facts, [{ prompt: 'look at the flake', response: 'the flake is fixed' }], q('flake'))
    expect(matches.map(m => m.role)).toEqual(['you', 'agent'])
  })

  it('gives a pane a row in every group it answers in', () => {
    const best = bestPerGroup(matchFactsAll(
      facts, [{ prompt: 'mirror deletion again', response: 'mirror deletion done' }], q('mirror deletion'),
    ))
    expect(Object.keys(best).sort()).toEqual(['agent', 'facts', 'you'])
    expect(best.facts!.source).toBe('name')
    expect(best.you!.snippet).toBe('mirror deletion again')
    expect(best.agent!.snippet).toBe('mirror deletion done')
  })

  it('keeps one row per group — the best reason, not every reason', () => {
    const best = bestPerGroup(matchFactsAll(
      facts, [{ prompt: 'the flake again' }, { prompt: 'the flake' }], q('flake'),
    ))
    expect(Object.keys(best)).toEqual(['you'])
    // The recent turn wins its group.
    expect(best.you!.snippet).toBe('the flake again')
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

  // The complaint that started this: "pane bar" matched a turn where "pane"
  // appeared inside "panel" near the top and "bar" was hundreds of characters
  // later, and the snippet showed neither of them.
  it('anchors on the rare term, not on the first common one', () => {
    const text = 'pane '.repeat(60) + 'the BAR is here ' + 'pane '.repeat(60)
    const s = snippetAround(text, ['pane', 'bar'])
    expect(s).toContain('BAR')
  })

  it('shows both terms in two fragments when they are far apart', () => {
    const text = 'RAREWORD ' + 'x'.repeat(600) + ' OTHERWORD'
    const s = snippetAround(text, ['rareword', 'otherword'])
    expect(s).toContain('RAREWORD')
    expect(s).toContain('OTHERWORD')
    expect(s).toContain('…')
  })

  it('keeps one window when the terms sit close together', () => {
    const text = 'z'.repeat(300) + ' alpha and beta ' + 'z'.repeat(300)
    const s = snippetAround(text, ['alpha', 'beta'])
    expect(s).toContain('alpha and beta')
    expect(s.split(' … ')).toHaveLength(1)
  })

  it('never claims a match it cannot show', () => {
    const s = snippetAround('nothing relevant here '.repeat(20), ['absent'])
    expect(s.endsWith('…')).toBe(true)
  })
})

// ripgrep searches the raw JSONL row, so a hit can land in a uuid or a tool
// result. Showing the message anyway produces a result whose snippet visibly
// does not contain the search term.
describe('containsPattern', () => {
  it('is what keeps a match in machinery out of the results', () => {
    expect(containsPattern('rebase onto 3993 please', '3993')).toBe(true)
    expect(containsPattern('an unrelated reply', '3993')).toBe(false)
    expect(containsPattern('The Pane Bar', 'pane bar')).toBe(true)
  })
})

describe('transcriptLineText', () => {
  it('reads a Claude user row (content is a plain string)', () => {
    const line = JSON.stringify({ type: 'user', message: { content: 'who is on 3993?' } })
    expect(transcriptLineText(line)).toMatchObject({ role: 'user', text: 'who is on 3993?' })
  })

  // "20m ago" beside a result comes from the row, not from the pane: a pane can
  // be busy right now on something it discussed yesterday.
  it('carries the row timestamp when there is one', () => {
    const at = Date.parse('2026-09-01T10:09:53.087Z')
    expect(transcriptLineText(JSON.stringify({
      type: 'user', timestamp: '2026-09-01T10:09:53.087Z', message: { content: 'hi' },
    }))?.at).toBe(at)
    expect(transcriptLineText(JSON.stringify({
      type: 'response_item', timestamp: '2026-09-01T10:09:53.087Z',
      payload: { type: 'message', role: 'user', content: [{ text: 'hi' }] },
    }))?.at).toBe(at)
    // A row without one is still a match, just without a time.
    expect(transcriptLineText(JSON.stringify({ type: 'user', message: { content: 'hi' } }))?.at).toBeUndefined()
  })

  it('reads a Claude assistant row (content is a block list)', () => {
    const line = JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'looking at 3993' }] } })
    expect(transcriptLineText(line)).toMatchObject({ role: 'assistant', text: 'looking at 3993' })
  })

  it('reads a Codex rollout message', () => {
    const line = JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'rebase onto 3993' }] },
    })
    expect(transcriptLineText(line)).toMatchObject({ role: 'user', text: 'rebase onto 3993' })
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
