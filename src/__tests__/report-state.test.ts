import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'http'
import { execFile } from 'child_process'
import { join } from 'path'

/**
 * The hooks reporter, driven the way Claude Code drives it.
 *
 * One thing is checked here and it is the one that went wrong: Claude Code's
 * `Notification` fires both for a permission prompt AND ~60s after a turn ENDS
 * when nobody has come back. Reporting the second as `waiting` turned every
 * finished pane red, which is how the one colour meaning "come here now" stops
 * meaning anything. A hook that reports the wrong state looks exactly like a
 * hook that is working, so nothing but a check catches this.
 */

let server: Server
let posts: { url: string; body: any }[] = []
let base = ''

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
  base = `http://127.0.0.1:${(server.address() as any).port}`
})
afterAll(() => new Promise<void>(r => server.close(() => r())))

/** Run the reporter as a hook does: state in argv, payload on stdin. */
function report(state: string, payload: unknown): Promise<any> {
  posts = []
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [join(process.cwd(), 'plugin', 'bin', 'report-state.mjs'), state],
      { env: { ...process.env, SHEEPIT_URL: base, SHEEPIT_SESSION_ID: 'pane-1' } },
      (err, stdout, stderr) => {
        if (err) return reject(err)
        // Rule 1 of the reporter: never print anything into the agent's session.
        expect(stdout).toBe('')
        expect(stderr).toBe('')
        resolve(posts.find(p => p.url.includes('/agent-state'))?.body)
      },
    )
    child.stdin!.end(JSON.stringify(payload))
  })
}

describe('Notification is two different events wearing one name', () => {
  it('reports a permission prompt as waiting — this one really is blocked', async () => {
    const body = await report('waiting', {
      hook_event_name: 'Notification',
      message: 'Claude needs your permission to use Bash',
    })
    expect(body.state).toBe('waiting')
  })

  it('downgrades the idle nudge to idle — a finished pane is unread, not bleating', async () => {
    const body = await report('waiting', {
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input',
    })
    expect(body.state).toBe('idle')
  })

  it('still reports it, so the hook trace can tell fired from never-wired', async () => {
    const body = await report('waiting', {
      hook_event_name: 'Notification',
      message: 'Claude is waiting for your input',
    })
    expect(body.event).toBe('Notification')
  })

  it('leaves every other state alone', async () => {
    expect((await report('busy', { hook_event_name: 'UserPromptSubmit' })).state).toBe('busy')
    expect((await report('idle', { hook_event_name: 'Stop' })).state).toBe('idle')
  })
})
