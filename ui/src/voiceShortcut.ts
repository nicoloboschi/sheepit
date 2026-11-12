// The key that toggles the mic (Settings → Shortcuts). Stored as
// "Ctrl+Alt+Shift+Meta+<KeyboardEvent.code>", modifiers in that order. `code`
// is the physical key, so Shift or ⌥ (Italian `@` = ⌥ò) don't change it.

export const DEFAULT_VOICE_SHORTCUT = 'Shift+Meta+Space';

const MODS = [['Ctrl', 'ctrlKey', '⌃'], ['Alt', 'altKey', '⌥'], ['Shift', 'shiftKey', '⇧'], ['Meta', 'metaKey', '⌘']] as const;

type Keys = { code: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean };

/** The combo a keydown makes, or null for a lone modifier or a bare key
 *  (a plain letter would start the mic while you type). */
export function comboOf(e: Keys): string | null {
  if (!e.code || /^(Shift|Control|Alt|Meta|OS)/.test(e.code)) return null;
  const mods = MODS.filter(([, k]) => e[k]).map(([n]) => n);
  if (!mods.length && !/^F\d+$/.test(e.code)) return null;
  return [...mods, e.code].join('+');
}

/** "Shift+Meta+Space" → ["⇧", "⌘", "Space"] */
export function comboLabel(combo: string): string[] {
  return combo.split('+').map(p => MODS.find(([n]) => n === p)?.[2] ?? p.replace(/^Key|^Digit/, ''));
}
