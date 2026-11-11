// A game controller switches sessions. macOS reads the pad on the server
// (src/gamepad.ts — Chromium can't see a Switch Pro there) and each press
// arrives as a `sheepit:gamepad` event (sharedWs). Only the focused window
// acts, so a phone left open doesn't follow along.
//   L / D-pad up    → previous sheep (⌘↑)
//   R / D-pad down  → next sheep (⌘↓)
//   A               → dictate into the shown pane; again to stop and type it (⌘⇧Space)
//   B               → clear the chat box (terminal: Ctrl-U, clear the line)
//   X               → send the chat box (terminal: Enter)
// Home is macOS's (Launchpad); turn it off in System Settings → Game Controllers.

import { VOICE_TOGGLE_EVENT, COMPOSER_CLEAR_EVENT, COMPOSER_SEND_EVENT } from './components/VoiceInputButton';
import { activeTerminalSend } from './store';

/** Offer the press to the chat composer; if it isn't on screen, type `fallback`
 *  into the shown terminal instead. */
function composerOr(type: string, fallback: string) {
  const e = new Event(type, { cancelable: true });
  window.dispatchEvent(e);
  if (!e.defaultPrevented) activeTerminalSend.current({ type: 'input', data: fallback });
}

const PREV = new Set(['l', 'up']);
const NEXT = new Set(['r', 'down']);
const VOICE = 'a';

// Some pads (an EchtPower "Pro Controller", measured) fire a macro by
// themselves every ~20s: A,A,B,B, each pair under 300ms apart. A real single
// press never comes twice that fast, so A/B/X wait PAIR_MS and a pair is
// dropped whole. ponytail: costs 300ms on those buttons and eats deliberate
// double taps; key on the exact burst if that ever matters.
const PAIR_MS = 300;

export function startGamepad(goSheep: (dir: 'up' | 'down') => void): () => void {
  const waiting = new Map<string, ReturnType<typeof setTimeout>>();
  const act = (button: string) => {
    if (button === VOICE) window.dispatchEvent(new Event(VOICE_TOGGLE_EVENT, { cancelable: true }));
    else if (button === 'b') composerOr(COMPOSER_CLEAR_EVENT, '\x15');
    else if (button === 'x') composerOr(COMPOSER_SEND_EVENT, '\r');
  };
  const onPress = (e: Event) => {
    if (!document.hasFocus()) return;
    const button = (e as CustomEvent<string>).detail;
    if (PREV.has(button)) { goSheep('up'); return; }
    if (NEXT.has(button)) { goSheep('down'); return; }
    if (button !== VOICE && button !== 'b' && button !== 'x') return;
    const twin = waiting.get(button);
    if (twin) { clearTimeout(twin); waiting.delete(button); return; }
    waiting.set(button, setTimeout(() => { waiting.delete(button); act(button); }, PAIR_MS));
  };
  window.addEventListener('sheepit:gamepad', onPress);
  return () => {
    window.removeEventListener('sheepit:gamepad', onPress);
    for (const t of waiting.values()) clearTimeout(t);
  };
}
