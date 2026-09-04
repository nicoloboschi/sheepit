import { describe, expect, it } from 'vitest';
import { buildNamerInvocation, isRenameable, stripNameDecoration, looksLikeAssignedName, normalizeAssignedName, readAgentTitle, clearedSessionName, CLEARED_SESSION_NAME } from '../ai.js';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

// Every cleared pane used to get the same name, and a sidebar with nine rows
// reading "freshly shorn" says nothing about any of them.
describe('the name a clear leaves behind', () => {
  it('is the directory the pane is in', () => {
    expect(clearedSessionName('/Users/x/dev/memlake4')).toBe('memlake4')
    expect(clearedSessionName('/Users/x/dev/hindsight-wt9/')).toBe('hindsight-wt9')
  })

  it('is normalised, so it cannot freeze the pane it names', () => {
    const name = clearedSessionName('/Users/x/My Project')
    expect(name).toBe('my project')
    expect(looksLikeAssignedName(name)).toBe(true)
  })

  it('falls back when the directory yields nothing usable', () => {
    expect(clearedSessionName(undefined)).toBe(CLEARED_SESSION_NAME)
    expect(clearedSessionName('/')).toBe(CLEARED_SESSION_NAME)
    expect(clearedSessionName('/Users/x/123')).toBe(CLEARED_SESSION_NAME)
  })

  // Whichever of the two it is, the namer has to be able to rename it later:
  // a default name qualifies on its own, and anything else only because the
  // service claimed it.
  it('leaves the pane renameable', () => {
    const path = '/Users/x/dev/memlake4'
    const name = clearedSessionName(path)
    expect(isRenameable(name, path, undefined)).toBe(true)
    expect(isRenameable(CLEARED_SESSION_NAME, '/', CLEARED_SESSION_NAME)).toBe(true)
  })
})

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

  // Claude Code's own `ai-title` is a naming source now, and it is written
  // Sentence case. A reader that refused capitals would disown every name
  // taken from it — the same freeze, arriving by a new road. It also reclaims
  // the pre-rule names ("check PR 1251 CI") that had been stuck since the
  // identifier rule landed.
  it('claims a Sentence-case title, because it now writes them', () => {
    expect(looksLikeAssignedName('Litellm-sdk bedrock support')).toBe(true)
    expect(looksLikeAssignedName('Fields distinction local storage scope')).toBe(true)
  })

  // The reader alone accepts a `#`: the writer strips `#123`, so it can never
  // produce one. It is the only way back to the names written before the
  // identifier rule, which were frozen for good — disowned at every restart.
  it('claims a pre-rule name carrying an identifier', () => {
    expect(looksLikeAssignedName('merge pr #1837')).toBe(true)
    expect(looksLikeAssignedName('check PR 1251 CI')).toBe(true)
    expect(normalizeAssignedName('merge pr #1837')).toBe('merge')
  })

  it('still refuses what it could never have written', () => {
    expect(looksLikeAssignedName('a name with far too many words in it to be ours')).toBe(false)
    expect(looksLikeAssignedName('x'.repeat(61))).toBe(false)
    expect(looksLikeAssignedName('#3672')).toBe(false)
    expect(looksLikeAssignedName('')).toBe(false)
  })

  // An agent title keeps its case; everything else is still lowercased, so the
  // names our own namer writes stay one house style.
  it('keeps the case of a title when asked, and strips ids either way', () => {
    expect(normalizeAssignedName('Litellm-sdk bedrock support', { keepCase: true }))
      .toBe('Litellm-sdk bedrock support')
    expect(normalizeAssignedName('Merge PR 1249', { keepCase: true })).toBe('Merge')
    expect(normalizeAssignedName('Check PR #1251 CI', { keepCase: true })).toBe('Check CI')
    expect(normalizeAssignedName('Merge And Deploy')).toBe('merge and deploy')
  })

  // The prompt forbids these too, and an agent title volunteers them: this was
  // a live pane called "Recall metrics for org 81db9954-2fb1-4012-…". A uuid
  // is 36 characters you cannot read at a glance, and it slipped through the
  // rules above by being one word with no `#` in it.
  it('takes out uuids and commit hashes', () => {
    expect(normalizeAssignedName('Recall metrics for org 81db9954-2fb1-4012-bab9-977e631c8126', { keepCase: true }))
      .toBe('Recall metrics for org')
    expect(normalizeAssignedName('revert a1b2c3d4e5f in the parser')).toBe('revert in the parser')
    // A word that is only hex letters is a word, not a hash: the rule needs a
    // digit in it, or "deadbeef" and "decade" would go the same way.
    expect(normalizeAssignedName('decade of deadbeef cafes')).toBe('decade of deadbeef cafes')
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

// Claude Code names its own session and writes it into the transcript every
// turn. That title is a better name than anything derived from three exchanges
// and costs no model call, so it is the first thing the namer looks for.
describe('the agent\'s own title', () => {
  const write = (lines: string[]): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'sheepit-title-')), 'transcript.jsonl');
    writeFileSync(path, lines.join('\n') + '\n', 'utf8');
    return path;
  };

  it('reads the last title, not the first', () => {
    const path = write([
      JSON.stringify({ type: 'ai-title', aiTitle: 'Early guess' }),
      JSON.stringify({ type: 'user', message: { content: 'hello' } }),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Litellm-sdk bedrock support' }),
    ]);
    expect(readAgentTitle(path)).toBe('Litellm-sdk bedrock support');
  });

  // Codex writes no title at all: session_meta, turn_context, response_item and
  // nothing else. Half the flock takes this path, so it is a normal answer.
  it('says nothing for a transcript with no title in it', () => {
    const path = write([
      JSON.stringify({ type: 'session_meta', payload: {} }),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning' } }),
    ]);
    expect(readAgentTitle(path)).toBeNull();
  });

  it('is not fooled by a row that only mentions the words', () => {
    const path = write([
      JSON.stringify({ type: 'user', message: { content: 'grep for "ai-title" please' } }),
    ]);
    expect(readAgentTitle(path)).toBeNull();
  });

  it('reads the tail of a transcript far too big to parse whole', () => {
    const filler = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(500) } });
    const path = write([
      JSON.stringify({ type: 'ai-title', aiTitle: 'Buried far too early' }),
      ...Array.from({ length: 3000 }, () => filler),
      JSON.stringify({ type: 'ai-title', aiTitle: 'Fields distinction local storage scope' }),
      filler,
    ]);
    expect(readAgentTitle(path)).toBe('Fields distinction local storage scope');
  });

  it('has no opinion about a file that is not there', () => {
    expect(readAgentTitle(join(tmpdir(), 'sheepit-nope', 'missing.jsonl'))).toBeNull();
  });
});
