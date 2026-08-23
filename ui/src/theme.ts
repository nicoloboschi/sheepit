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
    background: '#111411', foreground: '#c3c9bc', cursor: '#9cbc7f', cursorAccent: '#111411',
    selectionBackground: 'rgba(156, 188, 127, 0.24)',
    black: '#2a3026', brightBlack: '#6f756a', red: '#e0907b', brightRed: '#efaf9d',
    green: '#9cbc7f', brightGreen: '#b7d29a', yellow: '#d9b84a', brightYellow: '#e9ce73',
    blue: '#80a9bd', brightBlue: '#9ec3d5', magenta: '#b79cca', brightMagenta: '#ceb8dd',
    cyan: '#8ebfa2', brightCyan: '#aad4bc', white: '#c3c9bc', brightWhite: '#eef1e9',
  },
  light: {
    background: '#fbfcf8', foreground: '#22291f', cursor: '#4e7a3b', cursorAccent: '#ffffff',
    selectionBackground: 'rgba(78, 122, 59, 0.20)',
    black: '#37402f', brightBlack: '#6b7263', red: '#a8412a', brightRed: '#c9563a',
    green: '#41702c', brightGreen: '#4f8735', yellow: '#8a6410', brightYellow: '#a3781a',
    blue: '#2b5f7a', brightBlue: '#37768f', magenta: '#7a4a92', brightMagenta: '#9159ac',
    cyan: '#1f6b52', brightCyan: '#2a8265', white: '#d3d7cb', brightWhite: '#12170f',
  },
};
