import { useRef, useState } from 'react';
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
  maxAlternatives: number;
  onresult: ((event: RecognitionEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
}
type RecognitionConstructor = new () => Recognition;

function getRecognition(): Recognition | null {
  const w = window as Window & { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  const Constructor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Constructor ? new Constructor() : null;
}

export default function VoiceInputButton({ sessionId }: { sessionId: string }) {
  const recognitionRef = useRef<Recognition | null>(null);
  // What was heard so far. Kept in a ref, not state: the text is typed on `onend`,
  // which fires after the last `onresult`, and a state read there would be stale.
  const transcriptRef = useRef('');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function start() {
    const recognition = getRecognition();
    if (!recognition) { setError('Voice input is not supported by this browser'); return; }
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    transcriptRef.current = '';
    setError(null);
    recognition.onresult = event => {
      let text = '';
      for (let i = 0; i < event.results.length; i++) text += event.results[i]![0]!.transcript;
      transcriptRef.current = text.trim();
    };
    recognition.onerror = event => {
      transcriptRef.current = '';
      setListening(false);
      setError(event.error === 'not-allowed' ? 'Microphone permission denied' : 'Voice input failed');
    };
    // Stopping is the whole confirmation: what was heard is typed into the pane,
    // as if it had been keyed. Nothing is submitted — the Enter is still yours.
    recognition.onend = () => {
      setListening(false);
      const text = transcriptRef.current.trim();
      transcriptRef.current = '';
      if (text) sendToTerminal(sessionId, { type: 'input', data: text });
    };
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  function stop() { recognitionRef.current?.stop(); }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
      {error && <span title={error} style={{ color: 'var(--destructive)', fontSize: 9 }}>mic</span>}
      <button
        onClick={listening ? stop : start}
        title={listening ? 'Stop listening' : 'Dictate into this sheep'}
        aria-label={listening ? 'Stop listening' : 'Dictate into this sheep'}
        className={`pane-bar-btn${listening ? ' pane-bar-btn-on' : ''}`}
      >
        {listening ? <Square size={13} fill="currentColor" /> : <Mic size={17} />}
      </button>
    </div>
  );
}
