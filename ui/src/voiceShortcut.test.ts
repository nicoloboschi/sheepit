import { describe, it, expect } from 'vitest';
import { comboOf, comboLabel } from './voiceShortcut';

const k = (code: string, m: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
  ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...m });

describe('voice shortcut', () => {
  it('builds combos in a fixed order, ignores bare keys and lone modifiers', () => {
    expect(comboOf(k('Space', { metaKey: true, shiftKey: true }))).toBe('Shift+Meta+Space');
    expect(comboOf(k('KeyV', { altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+KeyV');
    expect(comboOf(k('KeyV'))).toBeNull();
    expect(comboOf(k('F5'))).toBe('F5');
    expect(comboOf(k('ShiftLeft', { shiftKey: true }))).toBeNull();
    expect(comboLabel('Shift+Meta+KeyV')).toEqual(['⇧', '⌘', 'V']);
  });
});
