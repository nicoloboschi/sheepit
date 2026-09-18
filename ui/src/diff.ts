/**
 * Unified-diff types and parser.
 *
 * These live apart from FileView on purpose. GitDiffPane needs only the parser
 * and the types, but FileView carries CodeMirror, sixteen language packs and a
 * syntax highlighter with it — importing one named export from that module
 * pulls the whole thing into the bundle that loads before anything is on
 * screen. Splitting the plain data out lets FileView itself load on demand.
 */

export interface DiffLine { type: 'add' | 'del' | 'ctx'; content: string; }
export interface DiffHunk { header: string; context: string; oldStart: number; newStart: number; lines: DiffLine[]; }
export interface DiffFile {
  oldPath: string; newPath: string; hunks: DiffHunk[];
  additions: number; deletions: number;
  isNew: boolean; isDeleted: boolean; isBinary: boolean;
}

/** One line's edit, as character ranges into the old and the new line. */
export interface WordSpan { aStart: number; aEnd: number; bStart: number; bEnd: number }

const TOKENS = /\w+|\s+|[^\w\s]/g;

/**
 * What actually changed between two versions of one line.
 *
 * The tokens shared at the start and at the end are trimmed away and whatever
 * is left is the edit. It is not a real diff — a token that merely moved reads
 * as changed — but the case this is for is a value, a name or an argument
 * being edited in place, and that it gets right in ten lines rather than a
 * hundred, with no dependency.
 *
 * `null` means don't highlight: the lines are identical, or they share nothing
 * at either end, and painting a whole line says no more than the row's own
 * colour already does.
 */
export function changedSpan(a: string, b: string): WordSpan | null {
  if (a === b) return null;
  const ta = a.match(TOKENS) ?? [];
  const tb = b.match(TOKENS) ?? [];
  let p = 0;
  while (p < ta.length && p < tb.length && ta[p] === tb[p]) p++;
  let s = 0;
  while (s < ta.length - p && s < tb.length - p && ta[ta.length - 1 - s] === tb[tb.length - 1 - s]) s++;
  if (p === 0 && s === 0) return null;
  // The first p tokens are equal on both sides, so one length serves for both.
  const head = ta.slice(0, p).join('').length;
  return {
    aStart: head,
    aEnd: a.length - ta.slice(ta.length - s).join('').length,
    bStart: head,
    bEnd: b.length - tb.slice(tb.length - s).join('').length,
  };
}

export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  for (const line of raw.split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      file = { oldPath: m ? m[1]! : '', newPath: m ? m[2]! : '', hunks: [], additions: 0, deletions: 0, isNew: false, isDeleted: false, isBinary: false };
      files.push(file!); hunk = null;
    } else if (!file) {
      continue;
    } else if (line.startsWith('new file'))     { file.isNew = true; }
    else if (line.startsWith('deleted file'))   { file.isDeleted = true; }
    else if (line.startsWith('Binary files'))   { file.isBinary = true; }
    else if (line.startsWith('--- '))           { file.oldPath = line.slice(4).replace(/^a\//, ''); }
    else if (line.startsWith('+++ '))           { file.newPath = line.slice(4).replace(/^b\//, ''); }
    else if (line.startsWith('@@ ')) {
      const m = line.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/);
      if (m) { hunk = { header: line.match(/@@ .* @@/)?.[0] ?? line, context: m[3]!.trim(), oldStart: +m[1]!, newStart: +m[2]!, lines: [] }; file.hunks.push(hunk); }
    } else if (hunk) {
      if (line.startsWith('+'))      { hunk.lines.push({ type: 'add', content: line.slice(1) }); file.additions++; }
      else if (line.startsWith('-')) { hunk.lines.push({ type: 'del', content: line.slice(1) }); file.deletions++; }
      else if (line.startsWith(' ') || line === '') { hunk.lines.push({ type: 'ctx', content: line.slice(1) }); }
    }
  }
  return files;
}
