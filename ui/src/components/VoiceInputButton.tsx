import { useEffect, useRef, useState } from 'react';
import { Mic, Square } from 'lucide-react';
import { sendToTerminal } from '../store';

interface RecognitionResult {
  isFinal: boolean;
  [index: number]: { transcript: string };
}
interface RecognitionEvent { results: ArrayLike<RecognitionResult>; }
interface Recognition {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionConstructor = new () => Recognition;

function getRecognition(): Recognition | null {
  const w = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  const Constructor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Constructor ? new Constructor() : null;
}

function errorMessage(code: string | undefined): string {
  if (code === 'not-allowed' || code === 'service-not-allowed') return 'Microphone permission denied';
  if (code === 'no-speech') return 'Nothing heard';
  if (code === 'audio-capture') return 'No microphone found';
  if (code === 'network') return 'Speech service unreachable';
  return `Voice input failed (${code || 'unknown'})`;
}

export default function VoiceInputButton({ sessionId }: { sessionId: string }) {
  const recognitionRef = useRef<Recognition | null>(null);
  // What has been heard so far. Kept in a ref, not state: the text is typed on
  // `onend`, which fires after the last `onresult`, and a state read there
  // would be a render behind.
  const transcriptRef = useRef('');
  const cancelledRef = useRef(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState('');
  const [error, setError] = useState<string | null>(null);

  // An error is the only thing the popup outlives listening for — long enough
  // to read, since a mic that does nothing is otherwise indistinguishable from
  // a mic that was never wired.
  useEffect(() => {
    if (!error) return;
    const id = setTimeout(() => setError(null), 5000);
    return () => clearTimeout(id);
  }, [error]);

  useEffect(() => () => { recognitionRef.current?.abort(); }, []);

  function start() {
    const recognition = getRecognition();
    if (!recognition) { setError('Voice input is not supported by this browser'); return; }
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    // Without this the recogniser ends itself at the first pause, and a pause
    // in the middle of a sentence is a pause in the middle of a sentence.
    recognition.continuous = true;
    recognition.maxAlternatives = 1;
    transcriptRef.current = '';
    cancelledRef.current = false;
    setHeard('');
    setError(null);
    recognition.onresult = event => {
      let text = '';
      for (let i = 0; i < event.results.length; i++) text += event.results[i]![0]!.transcript;
      transcriptRef.current = text.trim();
      setHeard(transcriptRef.current);
    };
    recognition.onerror = event => {
      // `no-speech` still ends normally; let onend do the closing so there is
      // one path out.
      cancelledRef.current = true;
      setError(errorMessage(event.error));
    };
    // Stopping is the whole confirmation: what was heard is typed into the
    // pane as if it had been keyed. Nothing is submitted — the Enter is yours.
    recognition.onend = () => {
      setListening(false);
      setHeard('');
      const text = transcriptRef.current.trim();
      transcriptRef.current = '';
      recognitionRef.current = null;
      if (cancelledRef.current || !text) return;
      sendToTerminal(sessionId, { type: 'input', data: text });
      // The click that opened the mic took focus off the terminal, so without
      // this the dictated line lands in a pane you then have to click to type
      // the Enter into.
      window.dispatchEvent(new Event('sheepit:terminal-tab-active'));
    };
    recognitionRef.current = recognition;
    setListening(true);
    try {
      recognition.start();
    } catch {
      setListening(false);
      recognitionRef.current = null;
      setError('Voice input could not start');
    }
  }

  function stop() { recognitionRef.current?.stop(); }
  function cancel() { cancelledRef.current = true; recognitionRef.current?.abort(); }

  // Escape drops what was heard rather than typing it.
  useEffect(() => {
    if (!listening) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); cancel(); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [listening]);

  return (
    <>
      {(listening || error) && (
        <div className="voice-popup" role="status" aria-live="polite">
          {listening && <span className="voice-popup-dot" />}
          <span className={`voice-popup-text${heard || error ? '' : ' voice-popup-text-empty'}`}>
            {error ?? (heard || 'Listening…')}
          </span>
          {listening && <span className="voice-popup-hint">Stop to type it · Esc to discard</span>}
        </div>
      )}
      <button
        onClick={listening ? stop : start}
        title={listening ? 'Stop listening' : 'Dictate into this sheep'}
        aria-label={listening ? 'Stop listening' : 'Dictate into this sheep'}
        className={`pane-bar-btn${listening ? ' pane-bar-btn-on' : ''}`}
        style={{ flexShrink: 0 }}
      >
        {listening ? <Square size={13} fill="currentColor" /> : <Mic size={17} />}
      </button>
    </>
  );
}
