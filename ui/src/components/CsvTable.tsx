// Table view for .csv / .tsv in the Files viewer. The raw text is still one
// click away (Edit / the Diff), so this only has to be the readable half:
// a header you can sort by, a filter, and a row count.
import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { parseCsv, guessDelimiter, compareCells } from '../csv';

// ponytail: renders at most this many rows — a 200k-row export would freeze the
// pane. Add windowing (react-virtual) if someone actually reads one in here.
const MAX_ROWS = 2000;

export default function CsvTable({ text }: { text: string }) {
  const [sort, setSort] = useState<{ col: number; dir: 1 | -1 } | null>(null);
  const [filter, setFilter] = useState('');
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const tableRef = useRef<HTMLTableElement>(null);
  const [scrollMax, setScrollMax] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  const { head, rows } = useMemo(() => {
    const all = parseCsv(text, guessDelimiter(text));
    return { head: all[0] ?? [], rows: all.slice(1) };
  }, [text]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let out = q ? rows.filter(r => r.some(c => c.toLowerCase().includes(q))) : rows;
    if (sort) out = [...out].sort((a, b) => sort.dir * compareCells(a[sort.col] ?? '', b[sort.col] ?? ''));
    return out;
  }, [rows, filter, sort]);

  useLayoutEffect(() => {
    const table = tableRef.current;
    const body = bodyScrollRef.current;
    if (!table || !body) return;
    const measure = () => {
      const max = Math.max(0, body.scrollWidth - body.clientWidth);
      setScrollMax(max);
      setScrollLeft(Math.min(body.scrollLeft, max));
    };
    measure();
    const frame = requestAnimationFrame(measure);
    const ro = new ResizeObserver(measure);
    ro.observe(table);
    ro.observe(body);
    return () => { cancelAnimationFrame(frame); ro.disconnect(); };
  }, [head, shown]);

  const onBodyScroll = () => {
    const body = bodyScrollRef.current;
    if (body) setScrollLeft(body.scrollLeft);
  };
  const onRange = (value: number) => {
    const body = bodyScrollRef.current;
    if (!body) return;
    body.scrollLeft = value;
    setScrollLeft(value);
  };

  if (!head.length) return (
    <div style={{ padding: 24, color: 'var(--muted-foreground)', fontSize: 12, fontStyle: 'italic' }}>Empty file.</div>
  );

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '6px 10px', borderBottom: '1px solid var(--border)', flexShrink: 0, minWidth: 0 }}>
        <input
          value={filter} onChange={e => setFilter(e.target.value)} placeholder="Filter rows…"
          style={{ flex: 1, minWidth: 0, maxWidth: 260, background: 'var(--background)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--foreground)', fontSize: 12, padding: '3px 7px' }}
        />
        <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }}>
          {shown.length.toLocaleString()}{shown.length !== rows.length ? ` of ${rows.length.toLocaleString()}` : ''} row{shown.length === 1 ? '' : 's'} · {head.length} col{head.length === 1 ? '' : 's'}
        </span>
      </div>
      {scrollMax > 0 && (
        <div className="csv-xbar" title="Scroll columns">
          <input
            type="range"
            min={0}
            max={scrollMax}
            value={Math.min(scrollLeft, scrollMax)}
            onChange={e => onRange(Number(e.currentTarget.value))}
            aria-label="Scroll CSV columns"
          />
        </div>
      )}
      <div ref={bodyScrollRef} className="csv-scroll" onScroll={onBodyScroll}>
        <table ref={tableRef} className="csv-table">
          <thead>
            <tr>
              <th className="csv-gutter" />
              {head.map((h, i) => (
                <th key={i}>
                  <button
                    type="button"
                    onClick={() => setSort(s => s && s.col === i ? (s.dir === 1 ? { col: i, dir: -1 } : null) : { col: i, dir: 1 })}
                    title="Sort by this column"
                  >
                    <span>{h || <em style={{ opacity: 0.5 }}>col {i + 1}</em>}</span>
                    {sort?.col === i && (sort.dir === 1 ? <ArrowUp size={10} /> : <ArrowDown size={10} />)}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.slice(0, MAX_ROWS).map((r, ri) => (
              <tr key={ri}>
                <td className="csv-gutter">{ri + 1}</td>
                {head.map((_, ci) => <td key={ci}>{r[ci] ?? ''}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length > MAX_ROWS && (
          <div style={{ padding: '8px 12px', fontSize: 11, color: 'var(--muted-foreground)' }}>
            Showing the first {MAX_ROWS.toLocaleString()} of {shown.length.toLocaleString()} rows — filter to narrow it down.
          </div>
        )}
      </div>
    </div>
  );
}
