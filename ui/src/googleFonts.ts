/**
 * Monospace families fetched from Google Fonts on demand.
 *
 * The bundled JetBrains Mono is deliberately self-hosted — it has to paint the
 * first frame, including on a dataplane sitting on a LAN with no route to the
 * internet. These are the opposite case: nobody sees them unless they go
 * looking, so paying a network round-trip at the moment of choosing is fine,
 * and it keeps ~1.7 MB of woff2 out of the npm package.
 *
 * The offline case is handled rather than ignored. Every file that arrives is
 * put in the Cache API, so a font you have used once keeps working with no
 * network afterwards; and a fetch that fails says so in the picker instead of
 * quietly leaving you on the fallback, which is the exact confusion this whole
 * feature already cost once.
 */

/** Families worth typing code in. Google serves plenty more monospace faces,
 *  but the display ones (Major Mono Display, Syne Mono, Doto…) are unreadable
 *  at 12px in a terminal, so they are left out on purpose. */
export const GOOGLE_MONO_FONTS: readonly string[] = [
  'Anonymous Pro', 'Azeret Mono', 'Chivo Mono', 'Courier Prime', 'Cousine',
  'DM Mono', 'Fira Code', 'Fira Mono', 'Geist Mono', 'IBM Plex Mono',
  'Inconsolata', 'Kode Mono', 'Martian Mono', 'Noto Sans Mono', 'Overpass Mono',
  'PT Mono', 'Red Hat Mono', 'Reddit Mono', 'Roboto Mono', 'Sometype Mono',
  'Source Code Pro', 'Space Mono', 'Spline Sans Mono', 'Ubuntu Mono',
  'Ubuntu Sans Mono', 'Victor Mono',
];

const CACHE_NAME = 'sheepit-google-fonts-v1';

/** Latin only. The other subsets Google offers would multiply the transfer for
 *  glyphs a terminal font picker does not need. */
const WANTED_SUBSETS = new Set(['latin', 'latin-ext']);

export type FontLoadState = 'idle' | 'loading' | 'loaded' | 'error';

/** Families already added to document.fonts this session. */
const loaded = new Set<string>();
/** In-flight loads, so two clicks don't fetch the same family twice. */
const inFlight = new Map<string, Promise<void>>();

export function isGoogleFont(family: string): boolean {
  return GOOGLE_MONO_FONTS.includes(family);
}

export function isLoaded(family: string): boolean {
  return loaded.has(family);
}

function cssUrl(family: string, weights: boolean): string {
  const q = family.replace(/ /g, '+');
  return weights
    ? `https://fonts.googleapis.com/css2?family=${q}:wght@400;700&display=swap`
    : `https://fonts.googleapis.com/css2?family=${q}&display=swap`;
}

/** Cache API is only defined in a secure context. Over plain http on a LAN
 *  address — a normal way to reach sheepit — it is simply absent, so every
 *  use of it is optional. */
async function cacheOpen(): Promise<Cache | null> {
  try { return typeof caches !== 'undefined' ? await caches.open(CACHE_NAME) : null; }
  catch { return null; }
}

async function fetchThroughCache(url: string): Promise<Response> {
  const cache = await cacheOpen();
  const hit = await cache?.match(url);
  if (hit) return hit;
  const res = await fetch(url, { mode: 'cors' });
  if (!res.ok) throw new Error(`${res.status} for ${url}`);
  // Response bodies are single-use — bank a clone before anyone reads it.
  try { await cache?.put(url, res.clone()); } catch { /* eviction, quota */ }
  return res;
}

interface FaceSpec { url: string; weight: string; style: string }

/** Pull the latin @font-face blocks out of Google's stylesheet.
 *  Each block is preceded by a `/* latin *\/` comment naming its subset. */
function parseFaces(css: string): FaceSpec[] {
  const faces: FaceSpec[] = [];
  const parts = css.split(/\/\*\s*([\w-]+)\s*\*\//);
  for (let i = 1; i < parts.length; i += 2) {
    const subset = parts[i]!;
    const block = parts[i + 1] ?? '';
    if (!WANTED_SUBSETS.has(subset)) continue;
    const url = /url\((https:\/\/[^)]+\.woff2)\)/.exec(block)?.[1];
    if (!url) continue;
    faces.push({
      url,
      weight: /font-weight:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? '400',
      style: /font-style:\s*([^;]+);/.exec(block)?.[1]?.trim() ?? 'normal',
    });
  }
  return faces;
}

async function load(family: string): Promise<void> {
  // Not every family ships a 700; asking for one it doesn't have 404s the
  // whole stylesheet, so fall back to whatever weights it does offer.
  let css: string;
  try {
    css = await (await fetchThroughCache(cssUrl(family, true))).text();
  } catch {
    css = await (await fetchThroughCache(cssUrl(family, false))).text();
  }

  const faces = parseFaces(css);
  if (!faces.length) throw new Error(`no latin woff2 for ${family}`);

  await Promise.all(faces.map(async ({ url, weight, style }) => {
    const buf = await (await fetchThroughCache(url)).arrayBuffer();
    const face = new FontFace(family, buf, { weight, style });
    await face.load();
    document.fonts.add(face);
  }));

  loaded.add(family);
}

/** Fetch and register a Google font. Safe to call repeatedly. */
export function loadGoogleFont(family: string): Promise<void> {
  if (loaded.has(family)) return Promise.resolve();
  const existing = inFlight.get(family);
  if (existing) return existing;
  const p = load(family).finally(() => inFlight.delete(family));
  inFlight.set(family, p);
  return p;
}

/**
 * Make sure a persisted font stack is actually usable at startup.
 *
 * A family chosen last week is only a string in preferences; nothing has
 * fetched it in this page yet. Called on mount so terminals come up in the
 * font you picked rather than silently on the fallback.
 */
export async function ensureStackLoaded(stack: string): Promise<void> {
  const families = stack.split(',')
    .map(f => f.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  for (const family of families) {
    if (!isGoogleFont(family)) continue;
    try { await loadGoogleFont(family); } catch { /* offline: the stack falls back */ }
  }
}
