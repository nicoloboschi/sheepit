import { describe, it, expect, vi } from 'vitest'
import { LiveBrowser, VIEW_TTL_MS } from '../live-browser.js'

interface Target { targetId: string; type: string; url: string }

/** A LiveBrowser wired to a fake CDP connection that remembers what it was
 *  asked to close. `getTargets` answers from `targets` minus whatever has been
 *  closed, the way the real browser would. `onGetTargets` runs inside that
 *  call, so a test can change the browser's state mid-sweep. */
function fakeBrowser(targets: Target[], onGetTargets?: (browser: LiveBrowser) => void) {
  const closed: string[] = []
  const browser = new LiveBrowser()
  const cdp = {
    isOpen: true,
    send: vi.fn(async (method: string, params: { targetId?: string } = {}) => {
      if (method === 'Target.getTargets') {
        onGetTargets?.(browser)
        return { targetInfos: targets.filter(t => !closed.includes(t.targetId)) }
      }
      if (method === 'Target.closeTarget') { closed.push(params.targetId!); return { success: true } }
      return {}
    }),
  }
  // The sweep only ever reaches the browser through `cdp`, and only reads
  // these fields of a view — so this is the whole of what it needs.
  ;(browser as any).cdp = cdp
  return { browser, closed }
}

function addView(browser: LiveBrowser, id: string, targetId: string, lastSeen: number) {
  const onExpired = vi.fn()
  ;(browser as any).views.set(id, { id, targetId, sessionId: `s-${id}`, lastSeen, onExpired, lastUrl: '' })
  return onExpired
}

const sweep = (browser: LiveBrowser): Promise<void> => (browser as any).sweep()
const page = (targetId: string): Target => ({ targetId, type: 'page', url: `https://example.com/${targetId}` })

describe('live browser sweep', () => {
  it('closes a page out of sight past the TTL and tells its pane', async () => {
    const { browser, closed } = fakeBrowser([page('stale'), page('fresh')])
    const staleExpired = addView(browser, 'view-1', 'stale', Date.now() - VIEW_TTL_MS - 1000)
    const freshExpired = addView(browser, 'view-2', 'fresh', Date.now() - VIEW_TTL_MS / 2)

    await sweep(browser)

    expect(closed).toEqual(['stale'])
    expect(staleExpired).toHaveBeenCalledOnce()
    expect(freshExpired).not.toHaveBeenCalled()
    expect((browser as any).views.has('view-1')).toBe(false)
    expect((browser as any).views.has('view-2')).toBe(true)
  })

  it('a touch keeps a page open', async () => {
    const { browser, closed } = fakeBrowser([page('a')])
    const expired = addView(browser, 'view-1', 'a', Date.now() - VIEW_TTL_MS - 1000)

    browser.touch('view-1')
    await sweep(browser)

    expect(closed).toEqual([])
    expect(expired).not.toHaveBeenCalled()
  })

  it('closes pages no view owns, and only pages', async () => {
    // What a server restart leaves: pages the old server opened, still
    // running, owned by nobody in this process.
    const { browser, closed } = fakeBrowser([
      page('owned'),
      page('left-behind-1'),
      page('left-behind-2'),
      { targetId: 'worker', type: 'service_worker', url: 'https://github.com/sw.js' },
      { targetId: 'omnibox', type: 'browser_ui', url: 'chrome://omnibox-popup.top-chrome/' },
    ])
    addView(browser, 'view-1', 'owned', Date.now())

    await sweep(browser)

    expect(closed.sort()).toEqual(['left-behind-1', 'left-behind-2'])
  })

  it('leaves orphans alone while a view is being opened', async () => {
    // createTarget answers before the view is registered, so a page being
    // opened right now looks exactly like one a dead server left behind.
    const { browser, closed } = fakeBrowser([page('opening')])
    ;(browser as any).opening = 1

    await sweep(browser)

    expect(closed).toEqual([])
  })

  it('leaves orphans alone when a view starts opening mid-sweep', async () => {
    const { browser, closed } = fakeBrowser([page('opening')], b => { (b as any).opening = 1 })

    await sweep(browser)

    expect(closed).toEqual([])
  })

  it('does nothing without a connection', async () => {
    const browser = new LiveBrowser()
    await expect(sweep(browser)).resolves.toBeUndefined()
  })
})
