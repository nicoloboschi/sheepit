// Custom words: after speech becomes text, words that look or sound like one
// of yours are replaced by it ("hind sight" → "Hindsight"). A port of Handy's
// `apply_custom_words` (src-tauri/src/audio_toolkit/text.rs): Parakeet takes no
// word list, so Handy fixes the text afterwards too.
//
// Each run of 1–3 words is squashed to letters and digits and compared to each
// custom word: edit distance over length, cut to 30% when they sound alike
// (Soundex). The closest under THRESHOLD wins.

/** Handy's default `word_correction_threshold`. */
export const THRESHOLD = 0.18;

const key = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const fuzzyOk = (k: string) => /^[a-z0-9]+$/.test(k);

function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const CODES: Record<string, string> = {};
for (const [d, ls] of [['1', 'bfpv'], ['2', 'cgjkqsxz'], ['3', 'dt'], ['4', 'l'], ['5', 'mn'], ['6', 'r']] as const) {
  for (const l of ls) CODES[l] = d;
}
/** American Soundex: first letter + three digits. */
export function soundex(s: string): string {
  let out = s[0]!.toUpperCase();
  let last = CODES[s[0]!] ?? '';
  for (const c of s.slice(1)) {
    const d = CODES[c] ?? '';
    if (d && d !== last) out += d;
    if (c !== 'h' && c !== 'w') last = d; // h/w don't separate equal codes; vowels do
    if (out.length === 4) break;
  }
  return out.padEnd(4, '0');
}

function bestMatch(candidate: string, words: string[], keys: { i: number; k: string }[], threshold: number): [string, number] | null {
  if (!fuzzyOk(candidate) || candidate.length > 50) return null;
  let best: [string, number] | null = null;
  for (const { i, k } of keys) {
    const maxLen = Math.max(candidate.length, k.length);
    if (Math.abs(candidate.length - k.length) > Math.max(maxLen * 0.25, 2)) continue;
    let score = levenshtein(candidate, k) / maxLen;
    if (/^[a-z]+$/.test(candidate) && /^[a-z]+$/.test(k) && soundex(candidate) === soundex(k)) score *= 0.3;
    if (score < threshold && (!best || score < best[1])) best = [words[i]!, score];
  }
  return best;
}

/** Leading and trailing punctuation of a word. */
function punct(w: string): [string, string] {
  const m = w.match(/^([^\p{L}\p{N}]*)[\s\S]*?([^\p{L}\p{N}]*)$/u)!;
  return m[1]!.length === w.length ? [w, ''] : [m[1]!, m[2]!];
}

function keepCase(original: string, replacement: string): string {
  if (/^\p{Lu}+$/u.test(original)) return replacement.toUpperCase();
  if (/^\p{Lu}/u.test(original)) return replacement[0]!.toUpperCase() + replacement.slice(1);
  return replacement;
}

export function applyCustomWords(text: string, words: string[], threshold = THRESHOLD): string {
  if (!words.length) return text;
  const keys = words.flatMap((w, i) => {
    const k = key(w);
    const out = fuzzyOk(k) ? [{ i, k }] : [];
    const and = key(w.replace(/&/g, ' and '));
    if (w.includes('&') && fuzzyOk(and) && and !== k) out.push({ i, k: and });
    return out;
  });
  const ws = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  for (let i = 0; i < ws.length;) {
    let best: [number, string, number] | null = null;
    for (let n = 3; n >= 1; n--) {
      if (i + n > ws.length) continue;
      const run = ws.slice(i, i + n);
      // A run never crosses punctuation: in "Charge B, che" the comma ends it.
      if (run.slice(0, -1).some(w => punct(w)[1])) continue;
      const m = bestMatch(run.map(key).join(''), words, keys, threshold);
      if (m && (!best || m[1] < best[2])) best = [n, m[0], m[1]];
    }
    if (best) {
      const [n, word] = best;
      out.push(punct(ws[i]!)[0] + keepCase(ws[i]!, word) + punct(ws[i + n - 1]!)[1]);
      i += n;
    } else out.push(ws[i++]!);
  }
  return out.join(' ');
}
