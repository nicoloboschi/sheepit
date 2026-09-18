import { describe, it, expect } from 'vitest';
import { changedSpan } from '../diff';

/** The span is what gets painted, so each case checks the substring it picks
 *  out rather than the offsets. */
const cut = (s: string, r: { start: number; end: number }) => s.slice(r.start, r.end);

describe('changedSpan', () => {
  it('picks out the one word that changed', () => {
    const a = 'const width = 200;';
    const b = 'const width = 240;';
    const span = changedSpan(a, b)!;
    expect(cut(a, { start: span.aStart, end: span.aEnd })).toBe('200');
    expect(cut(b, { start: span.bStart, end: span.bEnd })).toBe('240');
  });

  it('marks an insertion as empty on the old side', () => {
    const a = 'run(x)';
    const b = 'run(x, y)';
    const span = changedSpan(a, b)!;
    expect(span.aStart).toBe(span.aEnd);
    expect(cut(b, { start: span.bStart, end: span.bEnd })).toBe(', y');
  });

  it('says nothing for identical lines, or lines with nothing in common', () => {
    expect(changedSpan('same', 'same')).toBeNull();
    expect(changedSpan('alpha', 'beta')).toBeNull();
  });

  it('never returns a reversed range', () => {
    for (const [a, b] of [['', 'x'], ['x', ''], ['  a', 'a  '], ['a.b.c', 'a.c']] as const) {
      const span = changedSpan(a, b);
      if (!span) continue;
      expect(span.aEnd).toBeGreaterThanOrEqual(span.aStart);
      expect(span.bEnd).toBeGreaterThanOrEqual(span.bStart);
    }
  });
});
