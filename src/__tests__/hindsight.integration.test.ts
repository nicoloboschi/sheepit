import { describe, it, expect, beforeAll } from 'vitest'

const DAEMON_URL = 'http://127.0.0.1:9027'
const BANK_ID = 'vipershell'

async function isDaemonRunning(): Promise<boolean> {
  try {
    const resp = await fetch(`${DAEMON_URL}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return resp.ok
  } catch {
    return false
  }
}

const daemonRunning = await isDaemonRunning()

describe.skipIf(!daemonRunning)('Hindsight integration (daemon at 9027)', () => {
  it('daemon health endpoint returns ok', async () => {
    const resp = await fetch(`${DAEMON_URL}/health`)
    expect(resp.ok).toBe(true)
  })

  it('bank "vipershell" is accessible', async () => {
    const resp = await fetch(`${DAEMON_URL}/v1/banks/${BANK_ID}`)
    // 200 means it exists; 404 means it hasn't been created yet (both are valid network responses)
    expect([200, 404]).toContain(resp.status)
  })

  describe('retain()', () => {
    let store: import('../memory.js').MemoryStore

    beforeAll(async () => {
      // Dynamically import to avoid mocking conflicts with unit tests
      const { MemoryStore } = await import('../memory.js')
      store = new MemoryStore()

      // Override getConfig so hindsightEnabled=true without touching the real config file.
      // Points at the local Hindsight API running at 9027 (external/API mode — the only mode).
      store.getConfig = () => ({
        hindsightEnabled: true,
        hindsightApiUrl: DAEMON_URL,
        hindsightApiToken: '',
        retainChunkChars: 3000,
        observationsEnabled: false,
        uiPort: 18765,
      })

      await store.start()
    })

    it('store becomes active after start()', () => {
      expect(store.active).toBe(true)
    })

    it('retain() resolves without error', async () => {
      await expect(
        store.retain(
          'Integration test content from vipershell',
          'integration-test-doc-1',
          ['source:test', 'type:integration'],
          'vitest integration test'
        )
      ).resolves.toBeUndefined()
    })
  })
})

describe.skipIf(daemonRunning)('Hindsight integration (daemon not running — skipped)', () => {
  it('skipped because daemon is not running at http://127.0.0.1:9027', () => {
    // This test block is intentionally skipped
  })
})
