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
