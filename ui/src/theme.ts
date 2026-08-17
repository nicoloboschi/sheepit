import type { ITheme } from 'xterm';

export type AppTheme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'vipershell:theme';

export function readTheme(): AppTheme {
  try { return localStorage.getItem(THEME_STORAGE_KEY) === 'light' ? 'light' : 'dark'; }
  catch { return 'dark'; }
}

export function applyTheme(theme: AppTheme): void {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
}

/** Standard ANSI colours are resolved by xterm at render time. Updating this
 * palette changes the appearance of an already-running Claude/Codex session
 * without sending any bytes to (or restarting) the process. */
export const TERMINAL_THEMES: Record<AppTheme, ITheme> = {
  dark: {
    background: '#111111', foreground: '#d4d4d8', cursor: '#0074d9', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(0,116,217,0.25)',
    black: '#3b3b3b', brightBlack: '#737373', red: '#f87171', brightRed: '#fca5a5',
    green: '#4ade80', brightGreen: '#86efac', yellow: '#facc15', brightYellow: '#fde047',
    blue: '#60a5fa', brightBlue: '#93c5fd', magenta: '#c084fc', brightMagenta: '#d8b4fe',
    cyan: '#22d3ee', brightCyan: '#67e8f9', white: '#d4d4d8', brightWhite: '#f4f4f5',
  },
  light: {
    background: '#ffffff', foreground: '#1f2937', cursor: '#006ac3', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(0,106,195,0.20)',
    black: '#374151', brightBlack: '#6b7280', red: '#b42318', brightRed: '#dc2626',
    green: '#087443', brightGreen: '#15803d', yellow: '#8a5a00', brightYellow: '#a16207',
    blue: '#0759b5', brightBlue: '#2563eb', magenta: '#8b2bb1', brightMagenta: '#a855f7',
    cyan: '#087b8c', brightCyan: '#0891b2', white: '#d1d5db', brightWhite: '#111827',
  },
};
