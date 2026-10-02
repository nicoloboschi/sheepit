import { describe, it, expect } from 'vitest';
import { parseCsv, guessDelimiter, compareCells } from '../csv';

describe('parseCsv', () => {
  it('reads plain rows', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps commas and newlines inside quotes, and unescapes ""', () => {
    expect(parseCsv('a,b\n"x,y","say ""hi""\nagain"')).toEqual([
      ['a', 'b'],
      ['x,y', 'say "hi"\nagain'],
    ]);
  });

  it('handles CRLF and a missing trailing newline', () => {
    expect(parseCsv('a,b\r\n1,2')).toEqual([['a', 'b'], ['1', '2']]);
  });
});

describe('guessDelimiter', () => {
  it('picks tab only when the header has more of them', () => {
    expect(guessDelimiter('a\tb\tc\n1\t2\t3')).toBe('\t');
    expect(guessDelimiter('a,b,c\n1,2,3')).toBe(',');
  });
});

describe('compareCells', () => {
  it('sorts numbers numerically', () => {
    expect(['10', '9', '100'].sort(compareCells)).toEqual(['9', '10', '100']);
  });

  it('sinks blanks to the end in both directions', () => {
    expect(compareCells('', 'a')).toBeGreaterThan(0);
    expect(compareCells('a', '')).toBeLessThan(0);
  });
});
