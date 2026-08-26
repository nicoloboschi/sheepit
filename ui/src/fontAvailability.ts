/**
 * Which of a font stack's families this browser can actually render.
 *
 * A CSS font stack fails silently: ask for a font the device doesn't have and
 * you get the next one down, with nothing to tell you it happened. For a
 * terminal font picker that is the whole failure mode — you choose "Hack Nerd
 * Font", get generic monospace, and conclude the setting is broken.
 *
 * Detection is by measurement, anchored on **serif**. The obvious anchor is
 * `monospace`, but on macOS the generic monospace *is* Menlo, so a genuinely
 * installed Menlo measures identically to the fallback and reads as missing.
 * Every monospace face differs from serif, so serif has no such blind spot.
 *
 * `document.fonts.check()` is not used: it returns true for uninstalled local
 * families in Chrome, which would make the badge confidently wrong.
 */

/** CSS generic families and system keywords — always renderable by definition. */
const GENERIC = new Set([
  'monospace', 'serif', 'sans-serif', 'cursive', 'fantasy', 'system-ui',
  'ui-monospace', 'ui-serif', 'ui-sans-serif', 'ui-rounded', 'emoji', 'math', 'fangsong',
]);

const SAMPLE = 'mmmmmmmmmmlliMWZ0O123';

let ctx: CanvasRenderingContext2D | null | undefined;
function measureCtx(): CanvasRenderingContext2D | null {
  if (ctx === undefined) ctx = document.createElement('canvas').getContext('2d');
  return ctx;
}

/** Split a CSS font-family value into its family names, quotes stripped. */
export function parseFontStack(stack: string): string[] {
  return stack
    .split(',')
    .map(f => f.trim().replace(/^['"]|['"]$/g, '').trim())
    .filter(Boolean);
}

export function isFontAvailable(family: string): boolean {
  if (GENERIC.has(family.toLowerCase())) return true;
  const c = measureCtx();
  if (!c) return true; // No canvas to measure with — don't cry wolf.
  c.font = '72px serif';
  const anchor = c.measureText(SAMPLE).width;
  c.font = `72px "${family.replace(/"/g, '')}", serif`;
  return Math.abs(c.measureText(SAMPLE).width - anchor) > 0.01;
}

export interface StackResolution {
  /** Every family named in the stack, in order. */
  families: string[];
  /** The first one this browser can render — what you will actually see. */
  effective: string | null;
  /** Families ahead of `effective` that the device doesn't have. */
  missing: string[];
}

export function resolveFontStack(stack: string): StackResolution {
  const families = parseFontStack(stack);
  const missing: string[] = [];
  for (const family of families) {
    if (isFontAvailable(family)) return { families, effective: family, missing };
    missing.push(family);
  }
  return { families, effective: null, missing };
}
