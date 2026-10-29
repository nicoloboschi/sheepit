import { useSyncExternalStore } from 'react';
import { keybarTarget, subscribeKeybar } from '../store';

interface KeyDef {
  label: string;
  data: string;
}

const KEYS: KeyDef[] = [
  { label: 'Esc',        data: '\x1b' },
  { label: 'Tab',        data: '\t' },
  { label: 'Shift+Tab',  data: '\x1b[Z' },
  { label: 'Shift+\u21B5',   data: '\x1b\r' },
  { label: '\u2191',      data: '\x1b[A' },
  { label: '\u2193',      data: '\x1b[B' },
  { label: '\u2190',      data: '\x1b[D' },
  { label: '\u2192',      data: '\x1b[C' },
  { label: 'Ctrl+C', data: '\x03' },
  { label: 'Ctrl+Z', data: '\x1a' },
  { label: 'Ctrl+D', data: '\x04' },
  { label: 'Ctrl+L', data: '\x0c' },
];

const BTN_STYLE: React.CSSProperties = {
  flexShrink: 0,
  padding: '3px 10px',
  borderRadius: 5,
  border: '1px solid var(--border)',
  background: 'var(--secondary)',
  color: 'var(--foreground)',
  fontSize: 11,
  fontFamily: 'var(--font-mono)',
  cursor: 'pointer',
  userSelect: 'none',
  WebkitUserSelect: 'none',
};

/** Esc, Tab, arrows and Ctrl chords for a phone keyboard that has none. Types
 *  into whichever terminal claimed it last (see `claimKeybar`): the shown pane
 *  while it shows its terminal, or the scratch / side shell you last touched.
 *  Nothing claimed (a chat view on screen) = no bar. */
export default function MobileKeybar() {
  const target = useSyncExternalStore(subscribeKeybar, keybarTarget);
  if (!target) return null;

  const press = (data: string) => keybarTarget()?.send({ type: 'input', data });
  const scrollPage = (pages: number) => keybarTarget()?.scrollPages(pages);

  return (
    <div
      className="md:hidden flex items-center gap-1 px-2 shrink-0 overflow-x-auto border-t"
      style={{ background: 'var(--card)', borderColor: 'var(--border)', height: 40, scrollbarWidth: 'none' }}
    >
      {KEYS.map(k => (
        <button
          key={k.label}
          onPointerDown={e => { e.preventDefault(); press(k.data); }}
          style={BTN_STYLE}
        >
          {k.label}
        </button>
      ))}
      <button onPointerDown={e => { e.preventDefault(); scrollPage(-1); }} style={BTN_STYLE}>PgUp</button>
      <button onPointerDown={e => { e.preventDefault(); scrollPage(+1); }} style={BTN_STYLE}>PgDn</button>
    </div>
  );
}
