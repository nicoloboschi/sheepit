import { useEffect, useRef, useState } from 'react';
import { Mic } from 'lucide-react';
import { sendToTerminal } from '../store';
import { startDictation, type DictationHandle } from '../voice/dictation';

// `opening`: asked for the mic, not recording yet — nothing is shown, so
// "Listening…" never appears before it is true.
type Phase = 'idle' | 'opening' | 'listening' | 'transcribing';

/** Toggle the mic of the pane on screen: ⌘⇧Space (App.tsx) or the
 *  controller's ZR (gamepad.ts) dispatch this. */
export const VOICE_TOGGLE_EVENT = 'sheepit:voice-toggle';
/** Controller B / X: clear / send the chat composer (NativePane claims them). */
export const COMPOSER_CLEAR_EVENT = 'sheepit:composer-clear';
export const COMPOSER_SEND_EVENT = 'sheepit:composer-send';

/** Three bars that follow the mic's loudness (`--voice-level` on the button,
 *  0–1, set per frame): dots when quiet, bouncing while you speak. */
export function VoiceBars() {
  return <span className="voice-bars" aria-hidden><i /><i /><i /></span>;
}

export default function VoiceInputButton({ sessionId }: { sessionId: string }) {
  const handleRef = useRef<DictationHandle | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);

  // An error is the only thing the popup outlives the recording for — long
  // enough to read, since a mic that does nothing looks exactly like a mic
  // that was never wired.
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 6000);
    return () => clearTimeout(id);
  }, [error]);

  useEffect(() => () => handleRef.current?.cancel(), []);

  async function start() {
    setError(null);
    setPhase('opening');
    try {
      handleRef.current = await startDictation({
        onTranscribing: () => setPhase('transcribing'),
        // The time limit: type what was heard rather than dropping it.
        onEnd: () => { void stop(); },
        // Straight to the DOM: a state write per frame would re-render the bar.
        onLevel: level => { buttonRef.current?.style.setProperty('--voice-level', level.toFixed(2)); },
      });
      setPhase('listening');
    } catch (err) {
      setPhase('idle');
      handleRef.current = null;
      const name = err instanceof Error ? err.name : '';
      setError(name === 'NotAllowedError' ? 'Microphone permission denied'
        : name === 'NotFoundError' ? 'No microphone found'
        : 'Could not open the microphone');
    }
  }

  // Stopping is the whole confirmation: what was said is typed into the pane
  // as if it had been keyed. Nothing is submitted — the Enter is yours.
  async function stop() {
    const handle = handleRef.current;
    if (!handle) return;
    handleRef.current = null;
    try {
      const text = await handle.stop();
      if (text) {
        sendToTerminal(sessionId, { type: 'input', data: text });
        // The click that opened the mic took focus off the terminal, so without
        // this the dictated line lands in a pane you then have to click before
        // you can type the Enter into it.
        window.dispatchEvent(new Event('sheepit:terminal-tab-active'));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setPhase('idle');
      }
  }

  function cancel() {
    handleRef.current?.cancel();
    handleRef.current = null;
    setPhase('idle');
  }

  // Escape drops the recording rather than typing it.
  useEffect(() => {
    if (phase !== 'listening') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase]);

  // Keyboard / controller toggle. Every mounted pane bar has a button, so only
  // the one actually on screen answers (a hidden one has no offsetParent).
  const toggleRef = useRef(() => {});
  toggleRef.current = () => {
    if (!buttonRef.current?.offsetParent) return;
    if (phase === 'idle') void start();
    else if (phase === 'listening') void stop();
  };
  useEffect(() => {
    // The chat composer (NativePane) claims it with preventDefault when it is
    // on screen. Checked after the dispatch, not during: on `window` listeners
    // run in the order they were added, capture or not (measured, Chrome 156),
    // so the pane bar can run first — and then both mics recorded at once.
    const on = (e: Event) => { queueMicrotask(() => { if (!e.defaultPrevented) toggleRef.current(); }); };
    window.addEventListener(VOICE_TOGGLE_EVENT, on);
    return () => window.removeEventListener(VOICE_TOGGLE_EVENT, on);
  }, []);

  const listening = phase === 'listening';
  const label = listening ? 'Stop and type what you said (⌘⇧Space) · Esc to discard'
    : phase === 'transcribing' ? 'Transcribing…' : 'Dictate into this sheep (⌘⇧Space)';

  // The button is the whole indicator: red and glowing with your voice while
  // it records, a spinner while it transcribes. Only an error gets a popup.
  return (
    <>
      {error && <div className="voice-popup" role="alert">{error}</div>}
      <button
        ref={buttonRef}
        onClick={listening ? stop : phase === 'idle' ? start : undefined}
        disabled={phase === 'transcribing' || phase === 'opening'}
        title={label}
        aria-label={label}
        className={`pane-bar-btn${listening ? ' pane-bar-btn-on voice-btn-on' : ''}`}
        style={{ flexShrink: 0 }}
      >
        {phase === 'transcribing' ? <span className="nat-tool-spin" />
          : listening ? <VoiceBars /> : <Mic size={17} />}
      </button>
    </>
  );
}
