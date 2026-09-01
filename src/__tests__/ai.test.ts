import { describe, expect, it } from 'vitest';
import { buildNamerInvocation, isRenameable, stripNameDecoration, looksLikeAssignedName, normalizeAssignedName, CLEARED_SESSION_NAME } from '../ai.js';

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

describe('assigned-name shape', () => {
  // The bug this whole pair exists to prevent: the namer wrote a name its own
  // recogniser could not read back, so after a restart it disowned it and
  // isRenameable() froze the pane for good. Both of these were live sessions.
  it('claims names it actually produced', () => {
    expect(looksLikeAssignedName('rrf cross_encoder benchmark')).toBe(true)
    expect(looksLikeAssignedName('compare 0.9.1 pr regression')).toBe(true)
    expect(looksLikeAssignedName('merge and deploy dev')).toBe(true)
  })

  it('still refuses names that are plainly a human\'s', () => {
    expect(looksLikeAssignedName('Do Not Touch This')).toBe(false)
    expect(looksLikeAssignedName('a name with far too many words in it to be ours')).toBe(false)
    expect(looksLikeAssignedName('x'.repeat(61))).toBe(false)
  })

  it('normalises every way a name could fall outside the recogniser', () => {
    expect(normalizeAssignedName('Merge And Deploy')).toBe('merge and deploy')
    expect(normalizeAssignedName('one two three four five six seven')).toBe('one two three four five six')
    expect(normalizeAssignedName('feat/document-transfer')).toBe('feat document-transfer')
    expect(normalizeAssignedName('`fix the parser`')).toBe('fix the parser')
    expect(normalizeAssignedName('rrf cross_encoder benchmark')).toBe('rrf cross_encoder benchmark')
  })

  it('declines rather than storing something unusable', () => {
    expect(normalizeAssignedName('')).toBeNull()
    expect(normalizeAssignedName('12345')).toBeNull()
    expect(normalizeAssignedName('!!!')).toBeNull()
  })

  it('trims to whole words, never mid-word', () => {
    const long = normalizeAssignedName('alpha bravo charlie delta echo foxtrotfoxtrotfoxtrotfoxtrotfoxtrot')!
    expect(long.length).toBeLessThanOrEqual(60)
    expect(long).toBe('alpha bravo charlie delta echo')
  })

  // A name is read a hundred times and written once, and an id in it says
  // nothing about the work: the prompt asks the model not to produce one, and
  // this is the half that does not depend on the model complying.
  it('never stores an identifier in a name', () => {
    expect(normalizeAssignedName('review pr #3672')).toBe('review')
    expect(normalizeAssignedName('mirror pr 2207')).toBe('mirror')
    expect(normalizeAssignedName('fix issue 88 in namer')).toBe('fix in namer')
    expect(normalizeAssignedName('pull request 42 review')).toBe('review')
    // Nothing left to name it after — better the old name than "3672".
    expect(normalizeAssignedName('pr-3672')).toBeNull()
    expect(normalizeAssignedName('#123')).toBeNull()
  })

  // The reader stays permissive on purpose: names written before that rule
  // existed must still be claimable, or every one of them freezes its pane.
  it('still claims back the names it wrote before ids were stripped', () => {
    expect(looksLikeAssignedName('mirror pr 2207')).toBe(true)
    expect(looksLikeAssignedName('compare 0.9.1 pr regression')).toBe(true)
  })

  // The invariant. If this fails, the writer can once again store a name the
  // reader will disown, and a pane freezes.
  it('always produces something it will claim back', () => {
    const raws = [
      'Merge And Deploy', 'rrf cross_encoder benchmark', 'compare 0.9.1 pr regression',
      '`pytest`', '**bold name**', 'feat/document-transfer-knowledge-base',
      'one two three four five six seven eight', 'x'.repeat(200),
      'UPPER CASE NAME', 'trailing   spaces   ', 'émoji café run',
      'review pr #3672', 'mirror pr 2207', 'issue 88 in the namer',
      CLEARED_SESSION_NAME,
    ]
    for (const raw of raws) {
      const out = normalizeAssignedName(raw)
      if (out === null) continue
      expect(looksLikeAssignedName(out), `normalised ${JSON.stringify(raw)} -> ${JSON.stringify(out)}`).toBe(true)
      // And a claimed name is a renameable one, which is the property that
      // actually keeps the pane unfrozen.
      expect(isRenameable(out, '/tmp/some-project', out)).toBe(true)
    }
  })
})
