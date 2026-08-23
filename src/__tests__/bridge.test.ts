import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs'
import { join } from 'path'
import os from 'os'
import { TmuxBridge } from '../bridge.js'

// Use a temp directory for scrollback/sessions so tests don't touch real config
// We need to mock the module-level constants. Since they use homedir(),
// we mock homedir to redirect to our temp dir structure.
vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    default: {
      ...actual,
      homedir: () => join(os.tmpdir(), `sheepit-test-${process.pid}`, '_home'),
      hostname: actual.hostname,
      userInfo: actual.userInfo,
      platform: actual.platform,
    },
    homedir: () => join(os.tmpdir(), `sheepit-test-${process.pid}`, '_home'),
  }
})

// Mock server logger
vi.mock('../server.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}))

// Mock node-pty to avoid real PTY creation
vi.mock('node-pty', () => ({
  spawn: vi.fn().mockReturnValue({
    onData: vi.fn(),
    onExit: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    pid: 99999,
  }),
}))

// The mocked homedir points here, so bridge.ts will write sessions.json and scrollback/ under it
const testConfigDir = join(os.tmpdir(), `sheepit-test-${process.pid}`, '_home', '.config', 'sheepit')

describe('TmuxBridge', () => {
  let bridge: TmuxBridge

  beforeEach(() => {
    mkdirSync(join(testConfigDir, 'scrollback'), { recursive: true })
    bridge = new TmuxBridge()
  })

  afterEach(() => {
    try { bridge.stop() } catch { /* ignore */ }
    try { rmSync(join(os.tmpdir(), `sheepit-test-${process.pid}`), { recursive: true, force: true }) } catch { /* ignore */ }
  })

  describe('getScrollbackPath', () => {
    it('returns path under scrollback dir', () => {
      const p = bridge.getScrollbackPath('$5')
      expect(p).toContain('scrollback')
      expect(p).toContain('_5.log')
    })

    it('sanitizes special characters in session ID', () => {
      const p = bridge.getScrollbackPath('$foo/bar..baz')
      expect(p).toMatch(/[a-zA-Z0-9_-]+\.log$/)
      const filename = p.split('/').pop()!
      expect(filename).toBe('_foo_bar__baz.log')
    })

    it('keeps alphanumeric and dash/underscore', () => {
      const p = bridge.getScrollbackPath('my-session_1')
      const filename = p.split('/').pop()!
      expect(filename).toBe('my-session_1.log')
    })
  })

  describe('session persistence', () => {
    function sessionsFile() {
      return join(testConfigDir, 'sessions.json')
    }

    function readSaved(): Record<string, { name: string; path: string }> {
      try {
        return JSON.parse(readFileSync(sessionsFile(), 'utf-8'))
      } catch {
        return {}
      }
    }

    it('_persistSession writes to sessions.json', () => {
      // Access private method via any
      const b = bridge as any
      b._persistSession('$1', 'myshell', '/home/user')

      const saved = readSaved()
      expect(saved['$1']).toEqual({ name: 'myshell', path: '/home/user', sessionType: null })
    })

    it('_persistSession updates existing entry', () => {
      const b = bridge as any
      b._persistSession('$1', 'shell', '/tmp')
      b._persistSession('$1', 'renamed', '/home')

      const saved = readSaved()
      expect(saved['$1']).toEqual({ name: 'renamed', path: '/home', sessionType: null })
    })

    it('_unpersistSession removes entry', () => {
      const b = bridge as any
      b._persistSession('$1', 'shell', '/tmp')
      b._persistSession('$2', 'other', '/home')
      b._unpersistSession('$1')

      const saved = readSaved()
      expect(saved['$1']).toBeUndefined()
      expect(saved['$2']).toEqual({ name: 'other', path: '/home', sessionType: null })
    })

    it('_unpersistSession is no-op for unknown id', () => {
      const b = bridge as any
      b._persistSession('$1', 'shell', '/tmp')
      b._unpersistSession('$999')

      const saved = readSaved()
      expect(saved['$1']).toBeDefined()
    })

    it('_loadSavedSessions returns empty object when file missing', () => {
      const b = bridge as any
      const result = b._loadSavedSessions()
      expect(result).toEqual({})
    })

    it('_loadSavedSessions returns empty object on corrupt JSON', () => {
      writeFileSync(sessionsFile(), 'not valid json{{{')
      const b = bridge as any
      const result = b._loadSavedSessions()
      expect(result).toEqual({})
    })

    it('multiple sessions can be persisted', () => {
      const b = bridge as any
      b._persistSession('$1', 'shell', '/tmp')
      b._persistSession('$2', 'dev', '/home/dev')
      b._persistSession('$3', 'project', '/opt/project')

      const saved = readSaved()
      expect(Object.keys(saved)).toHaveLength(3)
      expect(saved['$2']).toEqual({ name: 'dev', path: '/home/dev', sessionType: null })
    })
  })

  describe('_closeScrollback', () => {
    it('deletes scrollback file when deleteFile=true', () => {
      const scrollbackDir = join(testConfigDir, 'scrollback')
      const logFile = join(scrollbackDir, '$1.log')
      writeFileSync(logFile, 'some scrollback data')
      expect(existsSync(logFile)).toBe(true)

      const b = bridge as any
      b._closeScrollback('$1', true)

      expect(existsSync(logFile)).toBe(false)
    })

    it('keeps scrollback file when deleteFile=false', () => {
      const scrollbackDir = join(testConfigDir, 'scrollback')
      const logFile = join(scrollbackDir, '$1.log')
      writeFileSync(logFile, 'some scrollback data')

      const b = bridge as any
      b._closeScrollback('$1', false)

      expect(existsSync(logFile)).toBe(true)
    })

    it('does not throw when scrollback file does not exist', () => {
      const b = bridge as any
      expect(() => b._closeScrollback('$999', true)).not.toThrow()
    })
  })

  describe('diagnostics', () => {
    it('returns expected shape', () => {
      const diag = bridge.diagnostics()
      expect(diag).toHaveProperty('managedPtys')
      expect(diag).toHaveProperty('scrollbackStreams')
      expect(diag).toHaveProperty('inputBuffers')
      expect(diag).toHaveProperty('knownSessions')
      expect(diag).toHaveProperty('pubsubChannels')
      expect(diag).toHaveProperty('serverMemory')
    })

    it('starts with zero counts', () => {
      const diag = bridge.diagnostics()
      expect(diag.managedPtys).toBe(0)
      expect(diag.scrollbackStreams).toBe(0)
      expect(diag.inputBuffers).toBe(0)
      expect(diag.knownSessions).toBe(0)
    })
  })
})
