import type { Terminal } from 'xterm';
import { TERMINAL_LINE_HEIGHT } from '../theme';
import useStore, { activeTerminalSend } from '../store';

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
  fontFamily: '"JetBrains Mono",monospace',
  cursor: 'pointer',
  userSelect: 'none',
  WebkitUserSelect: 'none',
};

interface MobileKeybarProps {
  sendRef: React.MutableRefObject<(msg: Record<string, unknown>) => void>;
  termRef: React.MutableRefObject<Terminal | null>;
}

export default function MobileKeybar({ termRef }: MobileKeybarProps) {
  const currentSessionId = useStore(s => s.currentSessionId);

  if (!currentSessionId) return null;

  function press(data: string) {
    activeTerminalSend.current({ type: 'input', data });
  }

  function scrollPage(direction: number) {
    const vp = document.querySelector('.terminal-pane .xterm-viewport') as HTMLElement | null;
    if (!vp) return;
    const term = termRef?.current;
    const lineH = (term?.options?.fontSize ?? 14) * (term?.options?.lineHeight ?? TERMINAL_LINE_HEIGHT);
    const lines = term ? Math.max(1, term.rows - 1) : 20;
    vp.scrollTop = Math.max(0, Math.min(
      vp.scrollTop + direction * lines * lineH,
      vp.scrollHeight - vp.clientHeight,
    ));
  }

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
