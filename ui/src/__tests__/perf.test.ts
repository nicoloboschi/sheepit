import { describe, it, expect } from 'vitest'
import { span, count, commit, live, startPerf } from '../perf'

// The checks behind the one place the UI measures itself. The span bookkeeping
// is what every later finding is read off, so a double count or a lost
// restore here sends the next fix at the wrong thing.
describe('perf spans', () => {
  it('records how often, how long in total, and the worst one', () => {
    const a = span('t:one'); a()
    const b = span('t:one'); b()
    const s = live().spans['t:one']!
    expect(s.n).toBe(2)
    expect(s.maxMs).toBeLessThanOrEqual(s.totalMs)
  })

  it('ignores a second call to the same end function', () => {
    const end = span('t:twice')
    end(); end(); end()
    expect(live().spans['t:twice']!.n).toBe(1)
  })

  it('restores the outer span when an inner one ends', () => {
    // The innermost open span is what a janky frame is blamed on, so an inner
    // span that forgot to put the outer one back would misattribute every
    // frame for the rest of the outer call.
    const outer = span('t:outer')
    const inner = span('t:inner')
    inner()
    const mid = span('t:mid')
    mid()
    outer()
    // Both inner spans recorded, and nothing left open.
    expect(live().spans['t:inner']!.n).toBe(1)
    expect(live().spans['t:mid']!.n).toBe(1)
    expect(live().worstFrameBlame).toBe('')
  })

  it('counts things that have no duration', () => {
    count('t:thing')
    count('t:thing', 4)
    expect(live().counts['t:thing']).toBe(5)
  })

  it('files a React commit as a span, so it ranks beside everything else', () => {
    commit('sidebar', 12)
    expect(live().spans['commit:sidebar']).toMatchObject({ n: 1, totalMs: 12, maxMs: 12 })
  })

  it('starts once, however many times a hot update re-runs the module', () => {
    // The guard is on `window`, not module scope: HMR hands back a fresh module
    // instance, and a module-scope flag would start a second frame loop beside
    // the first with nothing to stop it.
    startPerf()
    startPerf()
    expect((window as unknown as Record<string, unknown>).__sheepitPerfStarted).toBe(true)
  })
})
