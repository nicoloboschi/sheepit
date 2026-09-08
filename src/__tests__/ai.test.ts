import { describe, expect, it } from 'vitest';
import { isRenameable, stripNameDecoration, looksLikeAssignedName, normalizeAssignedName, readAgentTitle, CLEARED_SESSION_NAME } from '../ai.js';
import { mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

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

// A cleared pane has no subject yet, and the pane bar already carries its
// directory under the title — so it says the honest thing instead of saying
// the directory twice.
describe('the name a clear leaves behind', () => {
  it('is a dash', () => {
    expect(CLEARED_SESSION_NAME).toBe('-')
  })

  // The trap this pair exists for: a dash cannot pass the charset — it has no
  // letter to lead with — so without an explicit claim every cleared pane
  // would be disowned at the next restart and frozen on the dash for good.
  it('is claimed by the reader, or every cleared pane freezes', () => {
    expect(looksLikeAssignedName(CLEARED_SESSION_NAME)).toBe(true)
    expect(isRenameable(CLEARED_SESSION_NAME, '/Users/x/dev/memlake', CLEARED_SESSION_NAME)).toBe(true)
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

  // `#` is in the charset on both sides now. It always was on the reader's,
  // which is what kept the names written before the identifier rule from
  // freezing; the writer produces them again.
  it('claims a name carrying an identifier, and writes one', () => {
    expect(looksLikeAssignedName('merge pr #1837')).toBe(true)
    expect(looksLikeAssignedName('check PR 1251 CI')).toBe(true)
    expect(normalizeAssignedName('merge pr #1837')).toBe('merge pr #1837')
  })

  it('still refuses what it could never have written', () => {
    expect(looksLikeAssignedName('a name with far too many words in it to be ours')).toBe(false)
    expect(looksLikeAssignedName('x'.repeat(61))).toBe(false)
    expect(looksLikeAssignedName('#3672')).toBe(false)
    expect(looksLikeAssignedName('')).toBe(false)
  })

  // An agent title keeps its case; everything else is still lowercased, so the
  // names our own namer writes stay one house style.
  it('keeps the case of a title when asked', () => {
    expect(normalizeAssignedName('Litellm-sdk bedrock support', { keepCase: true }))
      .toBe('Litellm-sdk bedrock support')
    expect(normalizeAssignedName('Check PR #1251 CI', { keepCase: true })).toBe('Check PR #1251 CI')
    expect(normalizeAssignedName('Merge And Deploy')).toBe('merge and deploy')
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

  // The identifier rule is gone: nothing calls a model any more, so there is
  // no model's output to police — the title is the agent's own, and on a day
  // of PR review the number is what the pane is about. It used to reduce
  // these three to "hindsight", the name of the directory all three are in.
  it('keeps the identifier the agent put in its title', () => {
    expect(normalizeAssignedName('hindsight#4066', { keepCase: true })).toBe('hindsight#4066')
    expect(normalizeAssignedName('hindsight pull request 4015', { keepCase: true }))
      .toBe('hindsight pull request 4015')
    expect(normalizeAssignedName('Hindsight pull request 3977 review', { keepCase: true }))
      .toBe('Hindsight pull request 3977 review')
    expect(normalizeAssignedName('review pr #3672')).toBe('review pr #3672')
    expect(normalizeAssignedName('Recall metrics for org 81db9954-2fb1-4012-bab9-977e631c8126', { keepCase: true }))
      .toBe('Recall metrics for org 81db9954-2fb1-4012-bab9-977e631c8126')
    // A name still has to start with a letter, so one that is only an id has
    // nothing to lead with — better the old name than "3672".
    expect(normalizeAssignedName('#123')).toBeNull()
  })

  // The reader has always been the permissive half; the writer no longer
  // produces anything it has to stretch for.
  it('claims back every name it has ever written', () => {
    expect(looksLikeAssignedName('mirror pr 2207')).toBe(true)
    expect(looksLikeAssignedName('compare 0.9.1 pr regression')).toBe(true)
    expect(looksLikeAssignedName('hindsight#4066')).toBe(true)
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
