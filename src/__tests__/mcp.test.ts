import { describe, it, expect } from 'vitest';
import { toStructuredContent } from '../mcp.js';

// `structuredContent` must be a JSON object. A real client (Hermes, via
// pydantic) rejects the whole tool call otherwise — which is exactly what
// happened to list_flock and who_needs_me, whose answers are arrays.
describe('toStructuredContent', () => {
  it('passes a plain object through untouched', () => {
    const out = { session_id: 'direct-1', exchanges: [] };
    expect(toStructuredContent(out)).toBe(out);
  });

  it('wraps an array, because an array is not an object to a client', () => {
    expect(toStructuredContent([{ id: 'direct-1' }])).toEqual({ result: [{ id: 'direct-1' }] });
  });

  it('wraps an empty array too — "nobody needs you" must still be a valid result', () => {
    expect(toStructuredContent([])).toEqual({ result: [] });
  });

  it('wraps primitives and null', () => {
    expect(toStructuredContent('ok')).toEqual({ result: 'ok' });
    expect(toStructuredContent(3)).toEqual({ result: 3 });
    expect(toStructuredContent(null)).toEqual({ result: null });
  });

  it('omits it entirely when there is nothing', () => {
    expect(toStructuredContent(undefined)).toBeUndefined();
  });
});
