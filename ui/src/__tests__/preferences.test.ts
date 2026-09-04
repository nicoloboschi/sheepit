import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { preferences, applyRemotePreferences, subscribePreferences } from '../preferences'

// The profile is shared by every browser looking at this machine, and each one
// holds a copy of it. These are the rules that keep the copies from diverging.
describe('preferences', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // Writes go out over the network; nothing here is testing that they arrive.
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) })))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('takes in a value another client wrote', () => {
    applyRemotePreferences({ 'sheepit:pen:a': '{"id":"a"}' }, 'another-tab')
    expect(preferences.getItem('sheepit:pen:a')).toBe('{"id":"a"}')
  })

  it('reads a deletion as an empty string, the way a write spells one', () => {
    applyRemotePreferences({ 'sheepit:pen:gone': 'x' }, 'another-tab')
    applyRemotePreferences({ 'sheepit:pen:gone': '' }, 'another-tab')
    expect(preferences.getItem('sheepit:pen:gone')).toBeNull()
  })

  // Ours is the newer intention: it is already in the snapshot and the flush is
  // about to make it the server's answer too. Letting the broadcast win here is
  // how an edit gets silently undone a moment after it is made.
  it('does not overwrite a key this tab has a write pending for', () => {
    preferences.setItem('sheepit:pen:mine', 'local')
    applyRemotePreferences({ 'sheepit:pen:mine': 'remote' }, 'another-tab')
    expect(preferences.getItem('sheepit:pen:mine')).toBe('local')
  })

  // ...and it stays ours between the send and the response, which is a window
  // `pending` alone does not cover.
  it('does not overwrite a key whose write is in flight', async () => {
    preferences.setItem('sheepit:pen:flight', 'local')
    await vi.advanceTimersByTimeAsync(200)   // the debounce fires; the PATCH is out
    applyRemotePreferences({ 'sheepit:pen:flight': 'remote' }, 'another-tab')
    expect(preferences.getItem('sheepit:pen:flight')).toBe('local')
  })

  it('tells its listeners which keys moved, and only those', () => {
    const seen: string[][] = []
    const stop = subscribePreferences(keys => { seen.push(keys) })
    applyRemotePreferences({ 'sheepit:a': '1', 'sheepit:b': '2' }, 'another-tab')
    // Same values again: nothing moved, so nobody is woken.
    applyRemotePreferences({ 'sheepit:a': '1' }, 'another-tab')
    stop()
    expect(seen).toEqual([['sheepit:a', 'sheepit:b']])
  })
})
