// Click sounds (copied from ciak): tiny tones made in the page, no sound
// files. A press is a short tap; a switch rises when it turns on and falls
// when it turns off.
import { preferences } from './preferences';

let context: AudioContext | undefined;

export const CLICK_SOUND_KEY = 'sheepit:click-sound';
export const readClickSound = (): boolean => preferences.getItem(CLICK_SOUND_KEY) !== 'off';
export function setClickSound(on: boolean): void { preferences.setItem(CLICK_SOUND_KEY, on ? 'on' : 'off'); }

/** Pointer looks, picked in Appearance. The CSS for each is keyed on
 *  `data-cursor` on the root, in style.css. */
export const CURSORS = [
  { id: 'arrow', label: 'Rounded arrow', note: 'From ciak' },
  { id: 'system', label: 'System', note: "Your computer's own" },
] as const;
export type CursorId = typeof CURSORS[number]['id'];
export const CURSOR_KEY = 'sheepit:cursor';
export const readCursor = (): CursorId => (preferences.getItem(CURSOR_KEY) === 'system' ? 'system' : 'arrow');
export function applyCursor(id: CursorId = readCursor()): void { document.documentElement.dataset.cursor = id; }
export function setCursor(id: CursorId): void { preferences.setItem(CURSOR_KEY, id); applyCursor(id); }

function layer(when: number, type: OscillatorType, from: number, to: number, length: number, volume: number) {
  const c = context!;
  const oscillator = c.createOscillator(), gain = c.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, when);
  oscillator.frequency.exponentialRampToValueAtTime(to, when + length);
  gain.gain.setValueAtTime(volume, when);
  gain.gain.exponentialRampToValueAtTime(0.0001, when + length);
  oscillator.connect(gain).connect(c.destination);
  oscillator.start(when);
  oscillator.stop(when + length + 0.02);
}

const kinds = {
  press: (now: number) => { layer(now, 'triangle', 520, 420, 0.04, 0.16); layer(now, 'sine', 1250, 900, 0.02, 0.05); },
  on: (now: number) => { layer(now, 'sine', 520, 520, 0.06, 0.08); layer(now + 0.035, 'sine', 780, 780, 0.07, 0.08); },
  off: (now: number) => { layer(now, 'sine', 780, 780, 0.06, 0.08); layer(now + 0.035, 'sine', 520, 520, 0.07, 0.08); },
};

function sound(kind: keyof typeof kinds) {
  try {
    context ||= new AudioContext();
    if (context.state === 'suspended') void context.resume();
    kinds[kind](context.currentTime + 0.005);
  } catch { /* no audio on this device */ }
}

export function startClickSounds(): void {
  addEventListener('pointerdown', event => {
    const target = (event.target as Element | null)?.closest?.('button, a, select, summary, [role="button"], [role="tab"], [role="menuitem"], input[type=checkbox]') as HTMLInputElement | null;
    if (!target || target.disabled || !readClickSound()) return;
    sound(target.type === 'checkbox' ? (target.checked ? 'off' : 'on') : 'press');
  }, true);
}
