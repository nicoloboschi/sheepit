import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readAgentInfo, claudePrompt, codexPrompt, piPrompt, parseSlashCommand, readClaudeUsage, readCodexUsage, readPiUsage, readOpeningPrompt, agentKindOf, isInteractiveTranscript, type AgentInfo } from '../agent-info.js'

/** Row shapes copied from real transcripts — the filter is only worth what the
 *  samples are, so these are what the files actually hold, not what is tidy. */

const human = (text: string, extra: Record<string, unknown> = {}) => ({
  type: 'user', isSidechain: false, timestamp: '2026-09-24T15:31:06.470Z',
  promptSource: 'typed', origin: { kind: 'human' }, turnOrigin: 'human',
  message: { role: 'user', content: text }, ...extra,
})

describe('claudePrompt', () => {
  it('takes a prompt the human typed', () => {
    const p = claudePrompt(human('fix the reranker floor'))
    expect(p).toEqual({ text: 'fix the reranker floor', at: Date.parse('2026-09-24T15:31:06.470Z'), kind: 'prompt' })
  })

  // The commonest row in the file by a wide margin: 4354 of them against 194
  // real prompts in the sample. Both tells are checked because either can be
  // the only one present.
  it('drops a tool result', () => {
    expect(claudePrompt({
      type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] },
      toolUseResult: { stdout: '' },
    })).toBeNull()
    expect(claudePrompt({
      type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] },
    })).toBeNull()
  })

  // 506 of these in the sample. They carry origin.kind 'task-notification',
  // which is exactly not 'human'.
  it('drops a background task notification', () => {
    expect(claudePrompt({
      type: 'user', origin: { kind: 'task-notification' }, turnOrigin: 'task_notification',
      message: { content: '<task-notification>\n<task-id>abc</task-id>' },
    })).toBeNull()
  })

  it('drops an injected caveat or image note', () => {
    expect(claudePrompt({
      type: 'user', isMeta: true,
      message: { content: '<local-command-caveat>Caveat: …</local-command-caveat>' },
    })).toBeNull()
  })

  it("drops a subagent's exchange", () => {
    expect(claudePrompt(human('inner', { isSidechain: true }))).toBeNull()
  })

  it('drops a message from another session', () => {
    expect(claudePrompt({
      type: 'user', origin: { kind: 'peer' }, message: { content: 'hello from elsewhere' },
    })).toBeNull()
  })

  it('drops an escape key', () => {
    expect(claudePrompt(human('[Request interrupted by user]'))).toBeNull()
  })

  // `origin` is absent on older rows; `turnOrigin` is what covers them. Keying
  // on promptSource instead would hide the oldest half of a conversation.
  it('takes an older row that has turnOrigin but no origin', () => {
    const p = claudePrompt({
      type: 'user', turnOrigin: 'human', message: { content: 'older prompt' },
    })
    expect(p?.text).toBe('older prompt')
  })

  // /clear carries no human marker at all, /ship-it does. Matching the shape
  // before the origin test is what keeps both.
  it('takes a slash command with or without a human marker', () => {
    expect(claudePrompt({
      type: 'user',
      message: { content: '<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args></command-args>' },
    })).toMatchObject({ text: '/clear', kind: 'command' })

    expect(claudePrompt(human('<command-name>/ship-it</command-name>\n<command-args>and make ci stable</command-args>')))
      .toMatchObject({ text: '/ship-it and make ci stable', kind: 'command' })
  })

  it('ignores every row type that is not a user turn', () => {
    for (const type of ['assistant', 'attachment', 'system', 'ai-title', 'cost-state', 'queue-operation'])
      expect(claudePrompt({ type, message: { content: 'x' }, origin: { kind: 'human' } })).toBeNull()
  })
})

describe('codexPrompt', () => {
  // The newer, injection-free row: every UserMessage in the sample was human.
  it('takes a UserMessage item', () => {
    const p = codexPrompt({
      type: 'event_msg', timestamp: '2026-10-01T11-32-58.000Z',
      payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: 'make tea' }] } },
    })
    expect(p).toMatchObject({ text: 'make tea', kind: 'prompt' })
  })

  it('ignores the other item kinds beside it', () => {
    for (const type of ['Reasoning', 'CommandExecution', 'AgentMessage', 'McpToolCall', 'FileChange'])
      expect(codexPrompt({
        type: 'event_msg', payload: { type: 'item_completed', item: { type, content: [{ text: 'x' }] } },
      })).toBeNull()
  })

  it('falls back to the older message row', () => {
    expect(codexPrompt({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix this' }] },
    })).toMatchObject({ text: 'fix this', kind: 'prompt' })
  })

  it('drops an injected envelope on the older row', () => {
    for (const text of ['<environment_context>\n  <cwd>/x</cwd>', '<recommended_plugins>\nhere is a list', '# AGENTS.md instructions for /x'])
      expect(codexPrompt({
        type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
      })).toBeNull()
  })

  // An injected turn is envelope-first with the prompt after it. Joining the
  // blocks would staple the preamble onto the prompt.
  it('takes the real prompt out of an envelope-first turn', () => {
    expect(codexPrompt({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [
        { type: 'input_text', text: '<environment_context>\n  <cwd>/x</cwd>\n</environment_context>' },
        { type: 'input_text', text: 'the actual question' },
      ] },
    })).toMatchObject({ text: 'the actual question' })
  })

  it('drops the developer-role preamble', () => {
    expect(codexPrompt({
      type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'skills preamble' }] },
    })).toBeNull()
  })
})

describe('parseSlashCommand', () => {
  it('renders the command the user typed, not the envelope', () => {
    expect(parseSlashCommand('<command-name>/loop</command-name><command-args>5m /foo</command-args>')).toBe('/loop 5m /foo')
    expect(parseSlashCommand('<command-name>/clear</command-name><command-args></command-args>')).toBe('/clear')
    expect(parseSlashCommand('just prose')).toBeNull()
  })
})

describe('context', () => {
  const claudeReply = (usage: Record<string, unknown>) => JSON.stringify({
    type: 'assistant',
    message: { model: 'claude-opus-5-5', usage },
  })

  // The cached part IS the context on a long session. A real 952k conversation
  // reports input_tokens: 2 — summing only the obvious field would call it empty.
  it('sums the whole Claude prompt, not just fresh input', () => {
    const info: AgentInfo = blank()
    readClaudeUsage(claudeReply({
      input_tokens: 2, cache_read_input_tokens: 950520,
      cache_creation_input_tokens: 1951, output_tokens: 113, service_tier: 'standard',
    }), info)
    expect(info.context?.used).toBe(952473)
    expect(info.model).toBe('claude-opus-5-5')
    expect(info.serving).toBe('standard')
  })

  // The one rule worth a test of its own: guessing a window would report that
  // same session as 476% full.
  it('never invents a limit for Claude', () => {
    const info: AgentInfo = blank()
    readClaudeUsage(claudeReply({ input_tokens: 10 }), info)
    expect(info.context?.limit).toBeUndefined()
  })

  it('takes the last turn for Codex, and its reported window', () => {
    const info: AgentInfo = blank()
    readCodexUsage(JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: {
          // Every turn added up — NOT what is in the context.
          total_token_usage: { input_tokens: 999999 },
          last_token_usage: { input_tokens: 19181, cached_input_tokens: 17536, output_tokens: 8 },
          model_context_window: 258400,
        },
        rate_limits: { primary: { used_percent: 4, window_minutes: 300, resets_at: 1790690645 } },
      },
    }), info)
    expect(info.context).toMatchObject({ used: 19181, limit: 258400, cacheRead: 17536 })
    expect(info.rateLimits?.primary).toMatchObject({ usedPercent: 4, windowMinutes: 300 })
    // Codex reports seconds; everything else here is milliseconds.
    expect(info.rateLimits?.primary?.resetsAt).toBe(1790690645000)
  })
})

describe('links', () => {
  it('keeps what both sides shared and nothing the agent merely read', async () => {
    const { mkdtempSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const file = join(mkdtempSync(join(tmpdir(), 'agent-links-')), 'x.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'user', origin: { kind: 'human' }, timestamp: '2026-10-02T10:00:00Z',
        message: { content: 'look at https://github.com/x/y/pull/42 please' } }),
      JSON.stringify({ type: 'assistant', timestamp: '2026-10-02T10:01:00Z',
        message: { content: [{ type: 'text', text: 'opened https://example.com/a. Wrote `~/Downloads/audit/summary.csv` (106KB) and /tmp/x.json' }], usage: { input_tokens: 1 } } }),
      // A tool result is not something anybody shared.
      JSON.stringify({ type: 'user', toolUseResult: {}, message: { content: [{ type: 'tool_result', text: 'https://leak.example' }] } }),
    ].join('\n') + '\n')

    const info = await readAgentInfo(file)
    expect(info.links.map(l => [l.from, l.kind, l.url])).toEqual([
      ['me', 'url', 'https://github.com/x/y/pull/42'],
      // The url's own path must not come back as a file.
      ['agent', 'url', 'https://example.com/a'],
      ['agent', 'file', '~/Downloads/audit/summary.csv'],
      ['agent', 'file', '/tmp/x.json'],
    ])
  })
})

function blank(): AgentInfo {
  return { agent: 'claude', transcriptPath: '', transcriptBytes: 0, rowsScanned: 0, prompts: [], links: [], truncated: false }
}

describe('pi', () => {
  const piUser = (text: string) => ({
    type: 'message', timestamp: '2026-10-02T12:13:23.222Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })

  it('takes a user message and marks a slash command', () => {
    expect(piPrompt(piUser('make the Files panel resizable'))).toEqual({
      text: 'make the Files panel resizable', at: Date.parse('2026-10-02T12:13:23.222Z'), kind: 'prompt',
    })
    expect(piPrompt(piUser('/clear'))?.kind).toBe('command')
  })

  // Pi files a tool result under a role of its own, which is the whole reason
  // its filter can be one line.
  it('drops a tool result and the preamble', () => {
    expect(piPrompt({ type: 'message', message: { role: 'toolResult', content: [{ type: 'text', text: 'ok' }] } })).toBeNull()
    expect(piPrompt({ type: 'message', message: { role: 'system', content: 'You are an expert…' } })).toBeNull()
  })

  it('sums the whole prompt and keeps the bill', () => {
    const info: AgentInfo = blank()
    readPiUsage(JSON.stringify({
      type: 'message',
      message: {
        role: 'assistant', provider: 'openai', model: 'gpt-5.5', thinkingLevel: 'medium',
        usage: { input: 1561, output: 32, cacheRead: 106368, cacheWrite: 0, cost: { total: 0.061949 } },
      },
    }), info)
    expect(info.context).toMatchObject({ used: 107929, cacheRead: 106368, output: 32 })
    // Pi records no window size either, so nothing may be invented to divide by.
    expect(info.context?.limit).toBeUndefined()
    expect([info.model, info.serving, info.effort]).toEqual(['gpt-5.5', 'openai', 'medium'])
    expect(info.costUsd).toBeCloseTo(0.061949)
  })

  it('reads a whole Pi session end to end', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    // The path decides the agent, so the fixture has to live under a `.pi`.
    const dir = join(mkdtempSync(join(tmpdir(), 'agent-pi-')), '.pi', 'sessions')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 's.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session', id: 'abc-123', timestamp: '2026-10-02T12:13:03.687Z', cwd: '/w' }),
      JSON.stringify({ type: 'model_change', provider: 'openai', modelId: 'gpt-5.5' }),
      JSON.stringify({ type: 'thinking_level_change', thinkingLevel: 'high' }),
      JSON.stringify(piUser('add a csv table')),
      JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', usage: { input: 10 } } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', stopReason: 'stop', model: 'gpt-5.5', usage: { input: 20, cacheRead: 100 } } }),
    ].join('\n') + '\n')

    const info = await readAgentInfo(file)
    expect(info.agent).toBe('pi')
    expect(info.agentSessionId).toBe('abc-123')
    expect(info.cwd).toBe('/w')
    expect(info.effort).toBe('high')
    // Only the reply that finished counts, not the one that stopped to call a tool.
    expect(info.turns).toBe(1)
    expect(info.context?.used).toBe(120)
    expect(info.prompts.map(p => p.text)).toEqual(['add a csv table'])
    // The name a Pi pane gets: it writes no title, so the opening prompt is it.
    expect(readOpeningPrompt(file)).toBe('add a csv table')
    expect(agentKindOf(file)).toBe('pi')
  })
})

describe('codex parity', () => {
  it('counts finished turns, and reads the effort, sandbox and branch', async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('fs')
    const { join } = await import('path')
    const { tmpdir } = await import('os')
    const dir = join(mkdtempSync(join(tmpdir(), 'agent-codex-')), '.codex', 'sessions')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'rollout.jsonl')
    writeFileSync(file, [
      JSON.stringify({ type: 'session_meta', timestamp: '2026-10-01T09:32:59.011Z', payload: {
        session_id: 'cx-1', cwd: '/w', cli_version: '0.153.2', model_provider: 'openai',
        git: { branch: 'agent-hook-state', commit_hash: 'abc' },
      } }),
      JSON.stringify({ type: 'turn_context', payload: {
        model: 'gpt-6-astra', approval_policy: 'never', effort: 'low', sandbox_policy: { type: 'read-only' },
      } }),
      JSON.stringify({ type: 'event_msg', timestamp: '2026-10-01T09:33:00Z', payload: {
        type: 'item_completed', item: { type: 'UserMessage', content: [{ text: 'draw the diagram' }] },
      } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete', last_agent_message: 'done' } }),
    ].join('\n') + '\n')

    const info = await readAgentInfo(file)
    expect(info.agent).toBe('codex')
    // All four were silently empty on a Codex pane before: the sandbox was read
    // under an older key, and nothing counted its turns at all.
    expect(info.turns).toBe(1)
    expect(info.effort).toBe('low')
    expect(info.sandboxPolicy).toBe('read-only')
    expect(info.gitBranch).toBe('agent-hook-state')
    expect(readOpeningPrompt(file)).toBe('draw the diagram')
  })
})

describe('whose transcript is this', () => {
  // SHEEPIT_SESSION_ID is in the pane's environment, so a Claude Code the
  // agent spawns reports through the pane's hooks with its own transcript.
  // Found on a real pane: the model read as haiku while the agent was on
  // Opus, and the conversation shown was a repository survey nobody typed.
  const write = (rows: unknown[]) => {
    const p = join(mkdtempSync(join(tmpdir(), 'sheepit-entry-')), 't.jsonl')
    writeFileSync(p, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
    return p
  }

  it('calls an interactive session the pane\'s own', () => {
    expect(isInteractiveTranscript(write([
      { type: 'queue-operation' },
      { type: 'user', entrypoint: 'cli', message: { role: 'user', content: 'hi' } },
    ]))).toBe(true)
  })

  it('calls a programmatically started one somebody else\'s', () => {
    expect(isInteractiveTranscript(write([
      { type: 'user', entrypoint: 'sdk-cli', message: { role: 'user', content: 'survey this repo' } },
    ]))).toBe(false)
  })

  it('says "do not know" before any conversation row exists', () => {
    // The normal state for a moment after a session starts. It must not read
    // as "not ours", or the pane's own first report is thrown away for good.
    expect(isInteractiveTranscript(write([{ type: 'queue-operation' }]))).toBe(null)
  })

  it('says "do not know" for a file that is not there', () => {
    expect(isInteractiveTranscript('/no/such/transcript.jsonl')).toBe(null)
  })

  it('ignores a half-written trailing line', () => {
    const p = write([{ type: 'queue-operation' }])
    writeFileSync(p, '{"type":"queue-operation"}\n{"type":"user","entrypo')
    expect(isInteractiveTranscript(p)).toBe(null)
  })
})
