import { describe, it, expect } from 'vitest'
import { extractPrRefs, mergePrRefs, MAX_REFS } from '../pr-refs.js'

describe('extractPrRefs', () => {
  it('reads a PR url out of a tool result', () => {
    const out = extractPrRefs('created https://github.com/vectorize-io/memlake/pull/322 ok')
    expect(out).toEqual([{ kind: 'pr', num: 322, url: 'https://github.com/vectorize-io/memlake/pull/322', repo: 'vectorize-io/memlake' }])
  })

  it('tells an issue from a pull request', () => {
    const out = extractPrRefs('https://github.com/o/r/issues/7')
    expect(out[0]).toMatchObject({ kind: 'issue', num: 7 })
  })

  it('reads the number off a gh command line', () => {
    expect(extractPrRefs('gh pr checkout 3672').at(0)).toMatchObject({ kind: 'pr', num: 3672 })
    expect(extractPrRefs('gh issue comment #88 --body x').at(0)).toMatchObject({ kind: 'issue', num: 88 })
    expect(extractPrRefs('gh pr view --json url,number 42').at(0)).toMatchObject({ kind: 'pr', num: 42 })
  })

  // The whole reason the bare form is opt-in: tool results are full of things
  // shaped like `#12` that are not pull requests.
  it('ignores a bare #number unless asked for it', () => {
    expect(extractPrRefs('see #317 please')).toEqual([])
    expect(extractPrRefs('see #317 please', { bare: true }).at(0)).toMatchObject({ kind: 'pr', num: 317 })
  })

  it('does not take a colour, a fragment or a suffix for an issue', () => {
    expect(extractPrRefs('color: #0d1117; border: #1f6feb', { bare: true })).toEqual([])
    expect(extractPrRefs('id#3a and foo#4', { bare: true })).toEqual([])
    expect(extractPrRefs('#1234567', { bare: true })).toEqual([])
  })

  it('puts the last thing mentioned first — a turn that ends on a PR is about it', () => {
    const out = extractPrRefs('read #10, then opened https://github.com/o/r/pull/11', { bare: true })
    expect(out.map(r => r.num)).toEqual([11, 10])
  })

  it('keeps the url when the same number arrives again bare', () => {
    const out = extractPrRefs('https://github.com/o/r/pull/9 ... and #9 again', { bare: true })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ num: 9, url: 'https://github.com/o/r/pull/9', repo: 'o/r' })
  })
})

describe('mergePrRefs', () => {
  it('says nothing changed, so a per-tool-call report costs nothing', () => {
    const prev = [{ kind: 'pr' as const, num: 1 }]
    expect(mergePrRefs(prev, [])).toBeNull()
    expect(mergePrRefs(prev, [{ kind: 'pr', num: 1 }])).toBeNull()
  })

  it('moves a re-mentioned reference back to the front', () => {
    const prev = [{ kind: 'pr' as const, num: 2 }, { kind: 'pr' as const, num: 1 }]
    expect(mergePrRefs(prev, [{ kind: 'pr', num: 1 }])?.map(r => r.num)).toEqual([1, 2])
  })

  it('never grows past the cap', () => {
    let refs: ReturnType<typeof extractPrRefs> = []
    for (let n = 1; n <= MAX_REFS + 3; n++) refs = mergePrRefs(refs, [{ kind: 'pr', num: n }]) ?? refs
    expect(refs).toHaveLength(MAX_REFS)
    expect(refs[0]).toMatchObject({ num: MAX_REFS + 3 })
  })

  it('does not lose a url to a later bare mention of the same number', () => {
    const prev = [{ kind: 'pr' as const, num: 5, url: 'https://github.com/o/r/pull/5' }]
    expect(mergePrRefs(prev, [{ kind: 'pr', num: 5, repo: 'o/r' }])?.[0]).toMatchObject({
      num: 5, url: 'https://github.com/o/r/pull/5', repo: 'o/r',
    })
  })
})

describe('gh --repo', () => {
  it('takes the repository off the command rather than assuming the pane is in it', () => {
    expect(extractPrRefs('gh pr view 3730 --repo vectorize-io/hindsight --json number').at(0))
      .toMatchObject({ kind: 'pr', num: 3730, repo: 'vectorize-io/hindsight' })
    expect(extractPrRefs('gh pr view --repo=o/r 12').at(0)).toMatchObject({ num: 12, repo: 'o/r' })
  })

  it('leaves the repository unset when the command does not name one', () => {
    expect(extractPrRefs('gh pr checkout 42').at(0)?.repo).toBeUndefined()
  })
})
