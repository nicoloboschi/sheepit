import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import express from 'express'
import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { createApiRouter } from '../api.js'
import type { DirectBridge } from '../direct-bridge.js'
import type { LogBuffer } from '../server.js'
import type { AIService } from '../ai.js'

// ── Mock bridge ──────────────────────────────────────────────────────────────

const mockSessions = [
  { id: '$0', name: 'shell', path: '/tmp', username: 'test', last_activity: 1000, busy: false },
]

const mockBridge: DirectBridge = {
  listSessions: vi.fn().mockResolvedValue(mockSessions),
  getSessionPid: vi.fn().mockResolvedValue(null),
  createSession: vi.fn().mockResolvedValue('$1'),
  renameSession: vi.fn().mockResolvedValue(undefined),
  closeSession: vi.fn().mockResolvedValue(undefined),
  getScrollbackPath: vi.fn().mockReturnValue('/tmp/nonexistent-scrollback.log'),
  diagnostics: vi.fn().mockReturnValue({
    managedPtys: 1,
    scrollbackStreams: 1,
    memBuffers: 0,
    inputBuffers: 1,
    knownSessions: 1,
    pubsubChannels: [],
    serverMemory: { rss: 100000, heapUsed: 50000, heapTotal: 80000, external: 1000, arrayBuffers: 500 },
  }),
} as unknown as DirectBridge

// ── Mock logBuffer ───────────────────────────────────────────────────────────

const mockLogBuffer: LogBuffer = {
  entries: vi.fn().mockReturnValue([]),
  subscribe: vi.fn().mockReturnValue(() => {}),
  log: vi.fn(),
} as unknown as LogBuffer

// ── Mock AI ──────────────────────────────────────────────────────────────────

const mockAI = {
  getConfig: vi.fn().mockReturnValue({
    autoNaming: false,
    autoNamingIntervalSecs: 30,
  }),
  saveConfig: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  restart: vi.fn(),
  setBridge: vi.fn(),
} as unknown as AIService

// ── Server setup ─────────────────────────────────────────────────────────────

let baseUrl: string
let server: ReturnType<typeof createServer>

beforeAll(() => {
  return new Promise<void>((resolve) => {
    const app = express()
    app.use(express.json())
    app.use('/api', createApiRouter(mockBridge, mockLogBuffer, mockAI))

    server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      baseUrl = `http://127.0.0.1:${addr.port}/api`
      resolve()
    })
  })
})

afterAll(() => {
  return new Promise<void>((resolve) => {
    server.close(() => resolve())
  })
})

// ── Tests ────────────────────────────────────────────────────────────────────

describe('GET /api/version', () => {
  it('returns a version string', async () => {
    const res = await fetch(`${baseUrl}/version`)
    expect(res.status).toBe(200)
    const body = await res.json() as { version: string }
    expect(typeof body.version).toBe('string')
    expect(body.version.length).toBeGreaterThan(0)
  })
})

describe('GET /api/sessions', () => {
  it('returns session list from bridge', async () => {
    const res = await fetch(`${baseUrl}/sessions`)
    expect(res.status).toBe(200)
    const body = await res.json() as typeof mockSessions
    expect(Array.isArray(body)).toBe(true)
    expect(body[0]!.id).toBe('$0')
    expect(body[0]!.name).toBe('shell')
  })
})

describe('POST /api/sessions', () => {
  it('creates session and returns session_id', async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/tmp' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean; session_id: string }
    expect(body.ok).toBe(true)
    expect(body.session_id).toBe('$1')
    expect(mockBridge.createSession).toHaveBeenCalledWith('/tmp')
  })

  it('creates session without path', async () => {
    const res = await fetch(`${baseUrl}/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
  })
})

describe('POST /api/sessions/:id/rename', () => {
  it('renames session', async () => {
    const res = await fetch(`${baseUrl}/sessions/$0/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'new-name' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(mockBridge.renameSession).toHaveBeenCalledWith('$0', 'new-name')
  })

  it('returns 400 when name is missing', async () => {
    const res = await fetch(`${baseUrl}/sessions/$0/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('name required')
  })

  it('returns 400 when name is blank', async () => {
    const res = await fetch(`${baseUrl}/sessions/$0/rename`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: '   ' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /api/diagnostics', () => {
  it('returns diagnostics with uptime', async () => {
    const res = await fetch(`${baseUrl}/diagnostics`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toHaveProperty('managedPtys', 1)
    expect(body).toHaveProperty('scrollbackStreams', 1)
    expect(body).toHaveProperty('knownSessions', 1)
    expect(body).toHaveProperty('uptimeSeconds')
    expect(typeof body.uptimeSeconds).toBe('number')
  })
})

describe('GET /api/sessions/:id/scrollback', () => {
  it('returns 404 when scrollback file does not exist', async () => {
    const res = await fetch(`${baseUrl}/sessions/$0/scrollback`)
    expect(res.status).toBe(404)
  })
})

describe('GET /api/ai/config', () => {
  // Provider and CLI command are gone with the namer that used them: a pen is
  // named from the title the agent wrote itself.
  it('returns the naming config', async () => {
    const res = await fetch(`${baseUrl}/ai/config`)
    expect(res.status).toBe(200)
    const body = await res.json() as Record<string, unknown>
    expect(body).toEqual({ autoNaming: false, autoNamingIntervalSecs: 30 })
  })
})

describe('POST /api/ai/config', () => {
  it('saves config and restarts AI', async () => {
    const res = await fetch(`${baseUrl}/ai/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoNaming: true }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { ok: boolean }
    expect(body.ok).toBe(true)
    expect(mockAI.saveConfig).toHaveBeenCalled()
    expect(mockAI.restart).toHaveBeenCalled()
  })
})
