import { describe, it, expect, vi, afterEach } from 'vitest'
import { recordHook, hookTrace, HOOK_TRACE_RETENTION_MS } from '../hook-trace.js'

/** A hook with everything filled in, so each test only says what it varies. */
function hook(over: Partial<Parameters<typeof recordHook>[0]> = {}) {
  return {
    endpoint: 'agent-state',
    sessionId: 'direct-1',
    source: 'claude',
    event: 'PreToolUse',
    state: 'busy',
    turn: null,
    refs: null,
    outcome: 'ok' as const,
    ...over,
  }
}

// The buffer is module-level (one server, one trace), so tests must not leak
// into each other. Wind the clock past the window and read once to flush it.
//
// Twice the window, not once: a test that used fake timers may have stamped
// its entries slightly in the future, and those are not expired by a clock
// moved exactly one window past *now*.
function clearTrace() {
  vi.useFakeTimers()
  vi.setSystemTime(Date.now() + HOOK_TRACE_RETENTION_MS * 2)
  hookTrace()
  vi.useRealTimers()
}

afterEach(() => { vi.useRealTimers(); clearTrace() })

describe('hook trace', () => {
  it('records what arrived and what became of it', () => {
    clearTrace()
    recordHook(hook({ event: 'Stop', state: 'idle', turn: 'response' }))

    const [entry] = hookTrace()
    expect(entry).toMatchObject({
      endpoint: 'agent-state', sessionId: 'direct-1', source: 'claude',
      event: 'Stop', state: 'idle', turn: 'response', outcome: 'ok', count: 1,
    })
  })

  it('keeps a rejected hook, which is the whole point', () => {
    clearTrace()
    recordHook(hook({ outcome: 'unknown-session' }))
    recordHook(hook({ endpoint: 'resolve', sessionId: null, outcome: 'unresolved', detail: 'pids 1,2' }))

    expect(hookTrace().map(e => e.outcome)).toEqual(['unknown-session', 'unresolved'])
  })

  it('collapses identical hooks in a row rather than flooding the window', () => {
    clearTrace()
    for (let i = 0; i < 50; i++) recordHook(hook())

    const entries = hookTrace()
    expect(entries).toHaveLength(1)
    expect(entries[0]!.count).toBe(50)
  })

  it('does not collapse hooks that differ', () => {
    clearTrace()
    recordHook(hook({ event: 'PreToolUse' }))
    recordHook(hook({ event: 'PostToolUse' }))
    recordHook(hook({ event: 'PreToolUse' }))

    expect(hookTrace().map(e => e.event)).toEqual(['PreToolUse', 'PostToolUse', 'PreToolUse'])
  })

  it('keeps the first timestamp of a collapsed run', () => {
    clearTrace()
    vi.useFakeTimers()
    const start = Date.now()
    recordHook(hook())
    vi.setSystemTime(start + 5000)
    recordHook(hook())

    const [entry] = hookTrace()
    expect(entry!.firstAt).toBe(start)
    expect(entry!.at).toBe(start + 5000)
  })

  it('drops entries once they fall out of the window', () => {
    clearTrace()
    recordHook(hook({ event: 'Stop' }))
    expect(hookTrace()).toHaveLength(1)

    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + HOOK_TRACE_RETENTION_MS + 1)
    expect(hookTrace()).toHaveLength(0)
  })
})
