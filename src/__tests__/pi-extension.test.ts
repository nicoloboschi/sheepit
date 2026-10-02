import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { join } from 'path'

/**
 * The Pi extension, driven the way Pi drives it.
 *
 * Pi has no hooks, so this file is the only thing standing between a Pi pane
 * and the heuristics — and it runs *inside* the agent, where a throw is the
 * agent's problem. So the check is the whole contract: the handlers it
 * registers, the states it reports, and that nothing it does can affect Pi.
 */

let server: Server
let posts: { url: string; body: any }[] = []
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      posts.push({ url: req.url!, body: raw ? JSON.parse(raw) : null })
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  port = (server.address() as any).port
  process.env.SHEEPIT_URL = `http://127.0.0.1:${port}`
  process.env.SHEEPIT_SESSION_ID = 'direct-7'
})

afterAll(() => { server.close() })

/** Pi calls the factory with its ExtensionAPI; everything this file does is a
 *  handler registered on it, so collecting them IS the extension's surface. */
async function load() {
  const mod = await import(join(process.cwd(), 'plugin', 'pi', 'sheepit.js'))
  const handlers = new Map<string, (e: any, c: any) => unknown>()
  mod.default({ on: (event: string, fn: any) => { handlers.set(event, fn); return () => {} } })
  return handlers
}

const ctx = {
  isIdle: () => false,
  sessionManager: {
    getSessionFile: () => '/Users/me/.pi/agent/sessions/--w--/s.jsonl',
    getSessionId: () => 'pi-abc',
  },
}

/** The reports leave without being awaited, which is the point — so a test has
 *  to wait for the socket rather than for the handler. */
async function settle(n: number) {
  for (let i = 0; i < 200 && posts.length < n; i++) await new Promise(r => setTimeout(r, 10))
}

describe('pi extension', () => {
  it('registers a handler for every moment sheepit has a state for', async () => {
    const handlers = await load()
    expect([...handlers.keys()].sort()).toEqual([
      'agent_settled', 'message_end', 'session_shutdown', 'session_start',
      'tool_execution_end', 'tool_execution_start', 'turn_start',
      'ui_prompt_end', 'ui_prompt_start',
    ])
  })

  it('reports the turn, carrying the prompt, the reply and the transcript', async () => {
    const handlers = await load()
    posts = []
    handlers.get('turn_start')!({ type: 'turn_start' }, ctx)
    handlers.get('message_end')!({ message: { role: 'user', content: [{ type: 'text', text: 'add a csv table' }] } }, ctx)
    handlers.get('message_end')!({ message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, ctx)
    handlers.get('agent_settled')!({ type: 'agent_settled' }, ctx)
    // Three reports: an assistant message is remembered, not reported.
    await settle(3)

    expect(posts.every(p => p.url === '/api/sessions/direct-7/agent-state')).toBe(true)
    expect(posts.map(p => p.body.state)).toEqual(['busy', 'busy', 'idle'])
    expect(posts.every(p => p.body.source === 'pi')).toBe(true)
    expect(posts[1]!.body.prompt).toBe('add a csv table')
    // The reply has to be carried: Pi's settle event has no message on it.
    expect(posts[2]!.body.response).toBe('done')
    expect(posts[0]!.body.transcriptPath).toBe('/Users/me/.pi/agent/sessions/--w--/s.jsonl')
    expect(posts[0]!.body.agentSessionId).toBe('pi-abc')

    // One report per event, and nothing arriving late. A handler that fired
    // twice would show here as a pane reporting everything twice — which the
    // server debounces for `state` but not for a prompt or a reply.
    await new Promise(r => setTimeout(r, 150))
    expect(posts).toHaveLength(3)
  })

  // The state Codex still cannot report, and the reason this extension is
  // worth having rather than leaving Pi on the heuristics.
  it('turns a prompt Pi puts up into waiting, and back again', async () => {
    const handlers = await load()
    posts = []
    handlers.get('ui_prompt_start')!({ kind: 'confirm', title: 'Run this?' }, ctx)
    handlers.get('ui_prompt_end')!({ kind: 'confirm' }, ctx)
    handlers.get('ui_prompt_end')!({ kind: 'confirm' }, { ...ctx, isIdle: () => true })
    await settle(3)
    expect(posts.map(p => p.body.state)).toEqual(['waiting', 'busy', 'idle'])
    expect(posts[0]!.body.event).toBe('ui_prompt_start:confirm')
  })

  it('takes PR references only from a tool call that was about one', async () => {
    const handlers = await load()
    posts = []
    handlers.get('tool_execution_start')!({ toolName: 'bash', args: { command: 'gh pr view 3993' } }, ctx)
    // A file that merely contains a PR link must not relabel the pane.
    handlers.get('tool_execution_start')!({ toolName: 'read', args: { path: 'CHANGELOG.md' } }, ctx)
    handlers.get('tool_execution_end')!({ result: 'see https://github.com/o/r/pull/12' }, ctx)
    await settle(3)
    expect(posts.map(p => p.body.refs)).toEqual([['gh pr view 3993'], undefined, undefined])
  })

  it('tells sheepit a new session cleared the pane, and a quit left it', async () => {
    const handlers = await load()
    posts = []
    handlers.get('session_start')!({ reason: 'new' }, ctx)
    await settle(2)
    expect(posts.map(p => p.url)).toContain('/api/sessions/direct-7/cleared')
    posts = []
    handlers.get('session_start')!({ reason: 'resume' }, ctx)
    await settle(2)
    expect(posts.map(p => p.url)).toContain('/api/sessions/direct-7/fresh')
    posts = []
    // Not idle: there is no agent in the pane any more to be idle.
    handlers.get('session_shutdown')!({ reason: 'quit' }, ctx)
    await settle(1)
    expect(posts[0]!.body.state).toBe('unknown')
  })

  // A handler that throws, or returns a value, changes what Pi does. Neither
  // is allowed, and both are one bad line away.
  it('never throws and never answers, whatever Pi hands it', async () => {
    const handlers = await load()
    for (const [, fn] of handlers) {
      expect(fn({}, undefined)).toBeUndefined()
      expect(fn(undefined as any, { sessionManager: { getSessionFile: () => { throw new Error('no file') } } })).toBeUndefined()
    }
  })
})
