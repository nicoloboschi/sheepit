import { describe, expect, it } from 'vitest';
import { buildNamerInvocation, isRenameable, stripNameDecoration, CLEARED_SESSION_NAME } from '../ai.js';

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

describe('rename eligibility', () => {
  const path = '/Users/x/dev/memlake';

  it('renames a session still carrying a default name', () => {
    expect(isRenameable('memlake', path, undefined)).toBe(true);
    expect(isRenameable('memlake-3', path, undefined)).toBe(true);
    expect(isRenameable('zsh', path, undefined)).toBe(true);
    expect(isRenameable('7', path, undefined)).toBe(true);
  });

  it('leaves a name a human chose alone', () => {
    expect(isRenameable('do not touch this', path, undefined)).toBe(false);
    // Owned by the namer, but the human has since renamed it: not ours.
    expect(isRenameable('do not touch this', path, 'an older ai name')).toBe(false);
  });

  it('renames over a name it assigned itself', () => {
    expect(isRenameable('merge the as-of snapshot PR', path, 'merge the as-of snapshot PR')).toBe(true);
  });

  it('keeps a cleared session renameable', () => {
    // The trap: CLEARED_SESSION_NAME is not a default name, so a /clear reset
    // that only renamed the session would freeze it there forever. It stays
    // eligible because noteSessionCleared() claims ownership at the same time.
    expect(isRenameable(CLEARED_SESSION_NAME, path, undefined)).toBe(false);
    expect(isRenameable(CLEARED_SESSION_NAME, path, CLEARED_SESSION_NAME)).toBe(true);
  });
});

describe('name decoration', () => {
  it('peels what a model wraps a short answer in', () => {
    expect(stripNameDecoration('`pytest`')).toBe('pytest');
    expect(stripNameDecoration('"merge the PR"')).toBe('merge the PR');
    expect(stripNameDecoration('**release 1.7**')).toBe('release 1.7');
    expect(stripNameDecoration('`"**nested**"`')).toBe('nested');
    expect(stripNameDecoration('  spaced out  ')).toBe('spaced out');
  });

  it('leaves an ordinary name alone', () => {
    expect(stripNameDecoration('streaming chunks')).toBe('streaming chunks');
    // Not decoration: a lone backtick or quote inside the name stays put.
    expect(stripNameDecoration("don't touch")).toBe("don't touch");
  });

  it('unfreezes a session whose stored name carries decoration', () => {
    // `pytest` failed the "looks like ours" shape test because of the
    // backticks, so the namer stopped recognising its own output and refused
    // to rename it ever again. Stripping before the shape test is what lets
    // ownership be reclaimed.
    const path = '/Users/x/dev/hindsight-wt6';
    expect(isRenameable('`pytest`', path, '`pytest`')).toBe(true);
  });
});
