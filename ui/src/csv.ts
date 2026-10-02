// CSV/TSV parsing for the Files viewer's table mode. Hand-rolled rather than a
// dependency: this is RFC 4180 (quotes, escaped quotes, embedded newlines) in
// twenty lines, and the file never leaves the viewer.

/** Splits a delimited file into rows of cells. Handles "" escapes and newlines
 *  inside quoted fields; CRLF is normalised. */
export function parseCsv(text: string, delim = ','): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"' && cell === '') { quoted = true; continue; }
    if (c === delim) { row.push(cell); cell = ''; continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
      continue;
    }
    cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/** Comma unless the first line has more tabs — covers .tsv and tab-delimited
 *  .csv exports alike, which is cheaper than trusting the extension. */
export function guessDelimiter(text: string): string {
  const head = text.slice(0, text.indexOf('\n') + 1 || undefined);
  return (head.split('\t').length > head.split(',').length) ? '\t' : ',';
}

/** Numbers sort as numbers, everything else as text; blanks sink to the end
 *  either way, so sorting a sparse column still shows its values first. */
export function compareCells(a: string, b: string): number {
  if (a === b) return 0;
  if (a === '') return 1;
  if (b === '') return -1;
  const na = Number(a), nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
  return a.localeCompare(b, undefined, { numeric: true });
}
