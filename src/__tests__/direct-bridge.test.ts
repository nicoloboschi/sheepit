import { describe, it, expect } from 'vitest'
import { mouseModeTail, RingBuffer, detectAgentApp } from '../direct-bridge.js'

const MOUSE_ON = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h'
const SHELL_PROMPT = '\x1b[?2004h'
const CC_MODES = new Set([1049, 1000, 1002, 1003, 1006])
const ALL_OFF = [1000, 1002, 1003, 1004, 1005, 1006, 1015, 1016]
  .map(n => `\x1b[?${n}l`)
  .join('')

const LIVE = true, PROMPT = false

describe('mouseModeTail', () => {
  it('restores the modes of a live full-screen app', () => {
    const tail = mouseModeTail(CC_MODES, `redraw…${MOUSE_ON}more output…`, LIVE)
    expect(tail).toBe('\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h')
  })

  it('restores from the persisted set when the ring has rolled past the setup', () => {
    // The state after a server restart: a long-running app's startup sequences
    // are long gone from the ring, so the tracked-and-persisted set is the only
    // record. Getting this wrong left every live Claude Code pane without
    // scroll until the app itself was restarted by hand.
    const tail = mouseModeTail(CC_MODES, 'just redraws, no mode sequences', LIVE)
    expect(tail).toContain('\x1b[?1006h')
    expect(tail).not.toContain('l')
  })

  it('forces mouse tracking off at a bare shell prompt', () => {
    // The app exited without resetting the terminal; nothing is running, so the
    // tracked modes are stale and would turn every mouse move into `\x1b[<…M`.
    expect(mouseModeTail(CC_MODES, `${MOUSE_ON}app died${SHELL_PROMPT}$ `, PROMPT)).toBe(ALL_OFF)
  })

  it('does not condemn a live app just because it emits bracketed paste', () => {
    // Claude Code emits ?2004h itself, so "prompt marker after the last
    // mouse-enable" is NOT evidence the app is gone.
    const tail = mouseModeTail(CC_MODES, `${MOUSE_ON}redraw${SHELL_PROMPT}input box`, LIVE)
    expect(tail).toContain('\x1b[?1006h')
  })

  it('does not resurrect a mode the app turned off later in the window', () => {
    const tail = mouseModeTail(CC_MODES, `${MOUSE_ON}…\x1b[?1003l…`, LIVE)
    expect(tail).toContain('\x1b[?1006h')
    expect(tail).not.toContain('\x1b[?1003h')
  })

  it('forces off for a live app that never asked for the mouse (less, man)', () => {
    expect(mouseModeTail(new Set([1049]), 'a page of text', LIVE)).toBe(ALL_OFF)
  })
})

describe('RingBuffer.readTail', () => {
  it('returns the tail before the buffer has wrapped', () => {
    const r = new RingBuffer(64)
    r.write('hello world')
    expect(r.readTail(5)).toBe('world')
    expect(r.readTail(100)).toBe('hello world')   // clamps to what exists
  })

  it('returns the tail across the wrap point', () => {
    // 16-byte ring holding 24 bytes of history: the newest 16 survive, and the
    // tail spans the seam where writes wrapped around to index 0.
    const r = new RingBuffer(16)
    r.write('abcdefghijklmnop')   // exactly fills
    r.write('12345678')           // wraps, overwriting 'abcdefgh'
    expect(r.read()).toBe('ijklmnop12345678')
    expect(r.readTail(8)).toBe('12345678')
    expect(r.readTail(12)).toBe('mnop12345678') // spans the seam
    expect(r.readTail(16)).toBe(r.read())
  })

  it('agrees with read() for every tail length', () => {
    const r = new RingBuffer(32)
    r.write('the quick brown fox jumps over the lazy dog')
    const full = r.read()
    for (let n = 0; n <= full.length; n++) {
      expect(r.readTail(n)).toBe(full.slice(full.length - n))
    }
  })

  it('bumps version on write so idle sessions can be skipped', () => {
    const r = new RingBuffer(32)
    const v = r.version
    r.write('x')
    expect(r.version).toBeGreaterThan(v)
  })

  it('is empty when nothing was written', () => {
    expect(new RingBuffer(32).readTail(8)).toBe('')
  })
})

describe('detectAgentApp', () => {
  it('recognises Claude Code, however it was launched', () => {
    expect(detectAgentApp('claude --dangerously-skip-permissions')).toBe('claude')
    expect(detectAgentApp('claude -p --model haiku --output-format json You are naming a session')).toBe('claude')
    expect(detectAgentApp('/Users/n/.local/share/claude/versions/2.1.220 --foo')).toBe('claude')
  })

  it('recognises Codex through its wrapper and its vendored binary', () => {
    // Codex is a Node wrapper that spawns the real worker as a grandchild —
    // both shapes have to resolve to 'codex' for the session to be labelled.
    expect(detectAgentApp('node /Users/n/.local/bin/codex --yolo')).toBe('codex')
    expect(detectAgentApp('/Users/n/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/codex/codex')).toBe('codex')
  })

  it('ignores the agent name appearing in ordinary arguments', () => {
    // Walking the whole process tree means a session's own shell commands show
    // up here; matching anywhere in argv made a session label itself.
    expect(detectAgentApp('node -e "const x = isCodex && isClaudeCode"')).toBeNull()
    expect(detectAgentApp('grep -i codex')).toBeNull()
    expect(detectAgentApp('git commit -m "fix codex thing"')).toBeNull()
    expect(detectAgentApp('vim notes-about-claude.md')).toBeNull()
    expect(detectAgentApp('/bin/zsh -l')).toBeNull()
  })
})
