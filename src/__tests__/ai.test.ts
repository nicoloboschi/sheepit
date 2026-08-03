import { describe, expect, it } from 'vitest';
import { buildNamerInvocation } from '../ai.js';

describe('AI naming CLI isolation', () => {
  it('runs Claude Code in safe mode without slash commands', () => {
    const invocation = buildNamerInvocation('claude-code', 'name this session');
    expect(invocation.command).toBe('claude');
    expect(invocation.args).toEqual([
      '-p', '--safe-mode', '--disable-slash-commands', '--model', 'haiku',
      '--verbose', '--output-format', 'json', 'name this session',
    ]);
  });

  it('runs Codex ephemerally without user config or rules', () => {
    const invocation = buildNamerInvocation('codex', 'name this session');
    expect(invocation.command).toBe('codex');
    expect(invocation.args).toEqual([
      'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules',
      '--skip-git-repo-check', 'name this session',
    ]);
  });
});
