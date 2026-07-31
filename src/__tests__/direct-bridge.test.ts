import { describe, it, expect } from 'vitest'
import { mouseModeTail, RingBuffer, detectAgentApp, parseOscNotifications, parseOscProgress, parseKittyNotificationQuery, kittyNotificationAck, drainOsc99Frames, drainOscNotificationFrames } from '../direct-bridge.js'

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

  it('recognises OpenCode only when it is the invoked app', () => {
    expect(detectAgentApp('opencode --continue')).toBe('opencode')
    expect(detectAgentApp('node /Users/n/.local/bin/opencode')).toBe('opencode')
    expect(detectAgentApp('git commit -m "support opencode"')).toBeNull()
  })

  it('recognises Antigravity and GitHub Copilot CLIs', () => {
    expect(detectAgentApp('agy --resume')).toBe('antigravity')
    expect(detectAgentApp('/Users/n/.local/bin/agy')).toBe('antigravity')
    expect(detectAgentApp('copilot --resume')).toBe('copilot')
    expect(detectAgentApp('git commit -m "support copilot"')).toBeNull()
  })

  it('recognises Grok Build through its documented launcher', () => {
    expect(detectAgentApp('grok --resume')).toBe('grok')
    expect(detectAgentApp('/Users/n/.local/bin/grok-build')).toBe('grok')
    expect(detectAgentApp('git commit -m "support grok"')).toBeNull()
  })

  it('recognises Cursor Agent without matching agent as an argument', () => {
    expect(detectAgentApp('agent --continue')).toBe('cursor')
    expect(detectAgentApp('/Users/n/.local/bin/cursor-agent --resume last')).toBe('cursor')
    expect(detectAgentApp('git commit -m "agent support"')).toBeNull()
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

describe('parseOscNotifications', () => {
  it('extracts the completion message Codex emits', () => {
    // Codex sends its closing message as the payload.
    expect(parseOscNotifications('\x1b]9;Fixed. Build passes.\x07').map(n => n.text))
      .toEqual(['Fixed. Build passes.'])
  })

  it('extracts the completion message Claude Code emits', () => {
    expect(parseOscNotifications('\x1b]9;Claude is waiting for your input\x07').map(n => n.text))
      .toEqual(['Claude is waiting for your input'])
  })

  it('accepts ST as well as BEL as the terminator', () => {
    expect(parseOscNotifications('\x1b]9;done\x1b\\').map(n => n.text)).toEqual(['done'])
  })

  it('ignores OSC 9;4 progress, which shares the prefix', () => {
    // ConEmu progress protocol — not a notification, and leaking it would fire
    // a "finished" popup reading "4;3;" every time an agent started working.
    expect(parseOscNotifications('\x1b]9;4;3;\x07')).toEqual([])
    expect(parseOscNotifications('\x1b]9;4;0;\x07')).toEqual([])
  })

  it('ignores unrelated OSC sequences and plain output', () => {
    expect(parseOscNotifications('\x1b]0;some window title\x07')).toEqual([])
    expect(parseOscNotifications('just regular output\n')).toEqual([])
  })

  it('picks up several notifications in one chunk', () => {
    expect(parseOscNotifications('a\x1b]9;one\x07b\x1b]9;two\x07c').map(n => n.text)).toEqual(['one', 'two'])
  })
})

describe('drainOscNotificationFrames', () => {
  it('reassembles a Codex OSC 9 completion split across PTY reads', () => {
    const first = drainOscNotificationFrames('\x1b]9;Fixed the')
    expect(first.frames).toEqual([])
    expect(first.pending).toBe('\x1b]9;Fixed the')

    const second = drainOscNotificationFrames(' build.\x07', first.pending)
    expect(second.pending).toBe('')
    expect(parseOscNotifications(second.frames[0]!)).toMatchObject([{ text: 'Fixed the build.' }])
  })

  it('retains a split OSC introducer', () => {
    const first = drainOscNotificationFrames('output\x1b')
    expect(first.pending).toBe('\x1b')
    const second = drainOscNotificationFrames(']9;Done\x07', first.pending)
    expect(parseOscNotifications(second.frames[0]!)).toMatchObject([{ text: 'Done' }])
  })
})

describe('parseOscProgress', () => {
  it('reads busy and cleared states', () => {
    expect(parseOscProgress('\x1b]9;4;3;\x07')).toBe(true)   // indeterminate = working
    expect(parseOscProgress('\x1b]9;4;0;\x07')).toBe(false)  // cleared = done
    expect(parseOscProgress('\x1b]9;4;1;40\x07')).toBe(true) // percentage = working
  })

  it('returns null when the chunk carries no progress', () => {
    expect(parseOscProgress('\x1b]9;a message\x07')).toBeNull()
    expect(parseOscProgress('plain output')).toBeNull()
  })

  it('takes the last state in the chunk', () => {
    expect(parseOscProgress('\x1b]9;4;3;\x07 work \x1b]9;4;0;\x07')).toBe(false)
  })
})

describe('notifications from the other protocols', () => {
  it('reads urxvt OSC 777, preferring the body over the title', () => {
    expect(parseOscNotifications('\x1b]777;notify;opencode;Finished the refactor\x07').map(n => n.text))
      .toEqual(['Finished the refactor'])
  })

  it('reads a kitty OSC 99 notification', () => {
    expect(parseOscNotifications('\x1b]99;i=1:d=1;All tests pass\x1b\\').map(n => n.text))
      .toEqual(['All tests pass'])
  })

  it('decodes a base64 OSC 99 payload', () => {
    const b64 = Buffer.from('Done ✅', 'utf-8').toString('base64')
    expect(parseOscNotifications(`\x1b]99;i=7:e=1:d=1;${b64}\x1b\\`).map(n => n.text))
      .toEqual(['Done ✅'])
  })

  it('marks a chunked OSC 99 notification as unfinished until the last chunk', () => {
    // opencode splits long messages: d=0 means "more coming".
    const [first] = parseOscNotifications('\x1b]99;i=9:d=0;part one \x1b\\')
    expect(first!.done).toBe(false)
    expect(first!.id).toBe('9')
    const [second] = parseOscNotifications('\x1b]99;i=9:d=1;part two\x1b\\')
    expect(second!.done).toBe(true)
  })

  it('does not treat a capability query as a notification', () => {
    expect(parseOscNotifications('\x1b]99;i=opentui-notifications:p=?;\x1b\\')).toEqual([])
  })
})

describe('kitty notification capability handshake', () => {
  it('recognises opencode’s startup query', () => {
    expect(parseKittyNotificationQuery('\x1b]99;i=opentui-notifications:p=?;\x1b\\'))
      .toBe('opentui-notifications')
  })

  it('ignores actual notifications and unrelated output', () => {
    expect(parseKittyNotificationQuery('\x1b]99;i=1:d=1;hello\x1b\\')).toBeNull()
    expect(parseKittyNotificationQuery('\x1b]9;hello\x07')).toBeNull()
    expect(parseKittyNotificationQuery('plain output')).toBeNull()
  })

  it('answers in the shape the querying app matches on', () => {
    const ack = kittyNotificationAck('opentui-notifications')
    // opencode accepts any OSC 99 echoing back its id and p=?.
    expect(/\x1b\]99;[^\x07\x1b]*i=opentui-notifications[^\x07\x1b]*p=\?[\s\S]*?(?:\x07|\x1b\\)/.test(ack)).toBe(true)
  })
})

describe('drainOsc99Frames', () => {
  it('keeps a fragmented OpenCode capability probe until its terminator arrives', () => {
    const first = drainOsc99Frames('\x1b]99;i=opentui-notifications:p=?;\x1b')
    expect(first.frames).toEqual([])
    const second = drainOsc99Frames('\\', first.pending)
    expect(second.pending).toBe('')
    expect(parseKittyNotificationQuery(second.frames[0]!)).toBe('opentui-notifications')
  })

  it('keeps a fragmented notification payload until it is complete', () => {
    const first = drainOsc99Frames('output\x1b]99;i=3:d=1;All ')
    expect(first.frames).toEqual([])
    const second = drainOsc99Frames('tests pass\x1b\\', first.pending)
    expect(parseOscNotifications(second.frames[0]!).map(note => note.text)).toEqual(['All tests pass'])
  })
})
