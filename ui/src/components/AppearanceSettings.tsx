import { useEffect, useState } from 'react';
import { Moon, Sun, RotateCcw, Download, Check, Loader2, CloudOff } from 'lucide-react';
import useStore from '../store';
import {
  TERMINAL_THEMES,
  TERMINAL_FONT_PRESETS,
  DEFAULT_TERMINAL_FONT,
} from '../theme';
import { resolveFontStack, type StackResolution } from '../fontAvailability';
import {
  GOOGLE_MONO_FONTS,
  loadGoogleFont,
  isLoaded as isFontLoaded,
  type FontLoadState,
} from '../googleFonts';

/** Glyph-rich enough to answer the questions you actually open this for: is
 *  zero slashed, do l/1/I differ, does the box drawing join up, and did the
 *  Nerd Font glyph resolve or come out as tofu. */
const SAMPLE = '~/dev/sheepit  main ❯ 0O l1I {}[]() ─┼─ ✚ ✔ ✖';

export function AppearanceContent() {
  const theme = useStore(s => s.theme);
  const setTheme = useStore(s => s.setTheme);
  const fontFamily = useStore(s => s.terminalFontFamily);
  const setFontFamily = useStore(s => s.setTerminalFontFamily);
  const fontSize = useStore(s => s.fontSize);

  // The box is a draft until it is committed, so a half-typed family name does
  // not repaint every terminal on each keystroke — each repaint refits the grid
  // and pushes a resize to the PTY.
  const [draft, setDraft] = useState(fontFamily);
  useEffect(() => { setDraft(fontFamily); }, [fontFamily]);

  // Per-family fetch state for the Google list.
  const [loadState, setLoadState] = useState<Record<string, FontLoadState>>({});

  // Measured after document.fonts settles, or the bundled JetBrains Mono is
  // still loading and reports itself missing.
  const [resolved, setResolved] = useState<Record<string, StackResolution>>({});
  useEffect(() => {
    let live = true;
    const measure = () => {
      if (!live) return;
      const next: Record<string, StackResolution> = {};
      for (const p of TERMINAL_FONT_PRESETS) next[p.stack] = resolveFontStack(p.stack);
      next[fontFamily] = resolveFontStack(fontFamily);
      setResolved(next);
    };
    document.fonts?.ready.then(measure) ?? measure();
    return () => { live = false; };
    // loadState: a download registers new faces, and a preset naming the same
    // family has to stop calling itself missing the moment it arrives.
  }, [fontFamily, loadState]);

  const current = resolved[fontFamily];

  const [filter, setFilter] = useState('');
  const [offline, setOffline] = useState(false);

  const pickGoogleFont = async (family: string) => {
    const stack = `"${family}", monospace`;
    if (isFontLoaded(family)) { setFontFamily(stack); return; }
    setLoadState(s => ({ ...s, [family]: 'loading' }));
    try {
      await loadGoogleFont(family);
      setLoadState(s => ({ ...s, [family]: 'loaded' }));
      setOffline(false);
      setFontFamily(stack);
    } catch {
      // Say so. Falling back silently is what made this feature look broken
      // the first time round.
      setLoadState(s => ({ ...s, [family]: 'error' }));
      setOffline(true);
    }
  };

  const shown = GOOGLE_MONO_FONTS.filter(
    f => f.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const term = TERMINAL_THEMES[theme];

  return (
    <div className="p-5 flex flex-col gap-6">
      <section>
        <h3 className="text-sm font-semibold mb-1">Theme</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Changes the app and standard ANSI terminal colours immediately, including running Claude Code sessions.
        </p>
        <div className="flex gap-3">
          {([
            { id: 'dark' as const, label: 'Dark', icon: Moon, preview: '#111411' },
            { id: 'light' as const, label: 'Light', icon: Sun, preview: '#f7f8fa' },
          ]).map(({ id, label, icon: Icon, preview }) => (
            <button
              key={id}
              onClick={() => setTheme(id)}
              className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
              style={{
                borderColor: theme === id ? 'var(--primary)' : 'var(--border)',
                background: theme === id ? 'var(--accent)' : 'var(--card)',
                color: 'var(--foreground)',
              }}
            >
              <span style={{ width: 18, height: 18, borderRadius: 4, background: preview, border: '1px solid var(--border)' }} />
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>
      </section>

      <section>
        <div className="flex items-center gap-2 mb-1">
          <h3 className="text-sm font-semibold">Terminal font</h3>
          {fontFamily !== DEFAULT_TERMINAL_FONT && (
            <button
              onClick={() => setFontFamily(DEFAULT_TERMINAL_FONT)}
              className="flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5"
              style={{ color: 'var(--muted-foreground)', border: '1px solid var(--border)' }}
              title="Back to JetBrains Mono"
            >
              <RotateCcw size={10} /> Reset
            </button>
          )}
        </div>
        <p className="text-xs text-muted-foreground mb-3">
          Applies to every pane straight away. These are the fonts already on <em>this</em> device — not the machine
          running the shells — and one falls back to plain monospace if it isn't there. To get a font you don't
          have, use <strong>Download a font</strong> below.
        </p>

        <div className="grid grid-cols-2 gap-2 mb-3">
          {TERMINAL_FONT_PRESETS.map(p => {
            const active = fontFamily === p.stack;
            // Anything ahead of the family you actually get is a family this
            // device doesn't have — which makes the button's own label a lie.
            // Undefined until the first measurement lands: treat as fine, so
            // the grid doesn't flash a wall of warnings as the dialog opens.
            const r = resolved[p.stack];
            const missing = !!r && r.missing.length > 0;
            return (
              <button
                key={p.label}
                onClick={() => setFontFamily(p.stack)}
                className="rounded-md border px-3 py-2 text-left"
                style={{
                  borderColor: active ? 'var(--primary)' : 'var(--border)',
                  background: active ? 'var(--accent)' : 'var(--card)',
                  color: 'var(--foreground)',
                }}
              >
                <div className="text-xs" style={{ fontFamily: p.stack, opacity: missing ? 0.55 : 1 }}>{p.label}</div>
                <div className="text-[10px] mt-0.5" style={{ color: missing ? 'var(--warning)' : 'var(--muted-foreground)' }}>
                  {missing ? `not installed — you'd get ${r!.effective ?? 'the default'}` : p.note}
                </div>
              </button>
            );
          })}
        </div>

        <label className="block text-[11px] mb-1" style={{ color: 'var(--muted-foreground)' }}>
          Or a CSS font stack of your own — the family your terminal emulator uses, if you want the two to match
        </label>
        <input
          value={draft}
          onChange={e => setDraft(e.target.value)}
          onBlur={() => setFontFamily(draft)}
          onKeyDown={e => {
            if (e.key === 'Enter') { setFontFamily(draft); (e.target as HTMLInputElement).blur(); }
            if (e.key === 'Escape') { setDraft(fontFamily); (e.target as HTMLInputElement).blur(); }
          }}
          spellCheck={false}
          placeholder={DEFAULT_TERMINAL_FONT}
          className="w-full rounded-md border px-2.5 py-1.5 text-xs"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--background)',
            color: 'var(--foreground)',
            fontFamily: '"JetBrains Mono", monospace',
            outline: 'none',
          }}
        />

        {current && current.missing.length > 0 && (
          <div className="mt-1.5 text-[11px]" style={{ color: 'var(--warning)' }}>
            {current.missing.join(', ')} {current.missing.length > 1 ? 'are' : 'is'} not installed on this device —
            {' '}rendering in {current.effective ?? 'the default monospace'} instead.
          </div>
        )}

        <div
          className="mt-3 rounded-md border px-3 py-2.5 overflow-x-auto"
          style={{ borderColor: 'var(--border)', background: term.background }}
        >
          <div className="text-[10px] mb-1.5" style={{ color: 'var(--muted-foreground)' }}>Preview</div>
          <div style={{ fontFamily, fontSize, lineHeight: 1.2, color: term.foreground, whiteSpace: 'pre' }}>
            {SAMPLE}
          </div>
        </div>
      </section>

      <section>
        <h3 className="text-sm font-semibold mb-1">Download a font</h3>
        <p className="text-xs text-muted-foreground mb-3">
          Fetched from Google Fonts the moment you pick one, then kept on this device — so a font you have used
          once still works with no network later. Nothing is downloaded until you choose it.
        </p>

        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="Filter…"
          spellCheck={false}
          className="w-full rounded-md border px-2.5 py-1.5 text-xs mb-2"
          style={{
            borderColor: 'var(--border)', background: 'var(--background)',
            color: 'var(--foreground)', outline: 'none',
          }}
        />

        {offline && (
          <div className="flex items-center gap-1.5 mb-2 text-[11px]" style={{ color: 'var(--warning)' }}>
            <CloudOff size={12} />
            Couldn't reach fonts.googleapis.com — this device may have no route to the internet. Fonts you have
            already downloaded still work.
          </div>
        )}

        <div className="grid grid-cols-3 gap-2 max-h-64 overflow-y-auto pr-1">
          {shown.map(family => {
            const stack = `"${family}", monospace`;
            const active = fontFamily === stack;
            const state: FontLoadState = loadState[family] ?? (isFontLoaded(family) ? 'loaded' : 'idle');
            return (
              <button
                key={family}
                onClick={() => void pickGoogleFont(family)}
                disabled={state === 'loading'}
                className="rounded-md border px-2.5 py-2 text-left flex items-center gap-1.5"
                style={{
                  borderColor: active ? 'var(--primary)' : 'var(--border)',
                  background: active ? 'var(--accent)' : 'var(--card)',
                  color: 'var(--foreground)',
                }}
              >
                <span
                  className="text-[11px] flex-1 min-w-0 truncate"
                  style={{ fontFamily: state === 'loaded' ? stack : undefined }}
                >
                  {family}
                </span>
                {state === 'loading' && <Loader2 size={11} className="animate-spin shrink-0" style={{ color: 'var(--muted-foreground)' }} />}
                {state === 'loaded' && <Check size={11} className="shrink-0" style={{ color: 'var(--success)' }} />}
                {state === 'error' && <CloudOff size={11} className="shrink-0" style={{ color: 'var(--warning)' }} />}
                {state === 'idle' && <Download size={11} className="shrink-0" style={{ color: 'var(--muted-foreground)' }} />}
              </button>
            );
          })}
        </div>
        {!shown.length && (
          <div className="text-[11px]" style={{ color: 'var(--muted-foreground)' }}>No family matches "{filter}".</div>
        )}
      </section>
    </div>
  );
}

export default AppearanceContent;
