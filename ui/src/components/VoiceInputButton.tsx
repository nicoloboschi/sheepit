import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { sendToTerminal } from '../store';
import { startDictation, type DictationHandle } from '../voice/dictation';

type Phase = 'idle' | 'listening' | 'transcribing';

export default function VoiceInputButton({ sessionId }: { sessionId: string }) {
  const handleRef = useRef<DictationHandle | null>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [download, setDownload] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

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
    setDownload(null);
    setPhase('listening');
    try {
      handleRef.current = await startDictation({
        onTranscribing: () => setPhase('transcribing'),
        onProgress: fraction => setDownload(fraction),
      });
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
      setDownload(null);
    }
  }

  function cancel() {
    handleRef.current?.cancel();
    handleRef.current = null;
    setPhase('idle');
    setDownload(null);
  }

  // Escape drops the recording rather than typing it.
  useEffect(() => {
    if (phase !== 'listening') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [phase]);

  const listening = phase === 'listening';
  const message = error
    ?? (phase === 'transcribing'
      ? (download !== null && download < 1 ? `Downloading the speech model… ${Math.round(download * 100)}%` : 'Transcribing…')
      : 'Listening…');

  return (
    <>
      {(phase !== 'idle' || error) && (
        <div className="voice-popup" role="status" aria-live="polite">
          {!error && <span className={`voice-popup-dot${listening ? '' : ' voice-popup-dot-working'}`} />}
          <span className={`voice-popup-text${error ? '' : ' voice-popup-text-empty'}`}>{message}</span>
          {listening && <span className="voice-popup-hint">Stop to type it · Esc to discard</span>}
        </div>
      )}
      <button
        onClick={listening ? stop : phase === 'idle' ? start : undefined}
        disabled={phase === 'transcribing'}
        title={listening ? 'Stop and type what you said' : 'Dictate into this sheep'}
        aria-label={listening ? 'Stop and type what you said' : 'Dictate into this sheep'}
        className={`pane-bar-btn${listening ? ' pane-bar-btn-on' : ''}`}
        style={{ flexShrink: 0 }}
      >
        {listening ? <Square size={13} fill="currentColor" /> : <Mic size={17} />}
      </button>
    </>
  );
}
