import { useRef, useState } from 'react';
import { Check, Mic, Square, X } from 'lucide-react';
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
  const [listening, setListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  function start() {
    const recognition = getRecognition();
    if (!recognition) { setError('Voice input is not supported by this browser'); return; }
    recognition.lang = navigator.language || 'en-US';
    recognition.interimResults = true;
    recognition.maxAlternatives = 1;
    setTranscript('');
    setError(null);
    recognition.onresult = event => {
      let text = '';
      for (let i = 0; i < event.results.length; i++) text += event.results[i]![0]!.transcript;
      setTranscript(text.trim());
    };
    recognition.onerror = event => { setListening(false); setError(event.error === 'not-allowed' ? 'Microphone permission denied' : 'Voice input failed'); };
    recognition.onend = () => setListening(false);
    recognitionRef.current = recognition;
    setListening(true);
    recognition.start();
  }

  function stop() { recognitionRef.current?.stop(); setListening(false); }
  function insert() {
    if (!transcript.trim()) return;
    sendToTerminal(sessionId, { type: 'input', data: transcript.trim() });
    setTranscript('');
    setError(null);
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexShrink: 0 }}>
      {transcript && !listening && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 3, maxWidth: 260 }}>
          <input
            value={transcript}
            onChange={e => setTranscript(e.target.value)}
            aria-label="Voice transcript"
            style={{ width: 180, height: 22, padding: '2px 6px', borderRadius: 4, border: '1px solid var(--ring)', background: 'var(--background)', color: 'var(--foreground)', font: '11px inherit' }}
          />
          <button onClick={insert} title="Insert transcript into this sheep" style={{ color: 'var(--success)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}><Check size={13} /></button>
          <button onClick={() => setTranscript('')} title="Discard transcript" style={{ color: 'var(--muted-foreground)', background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}><X size={13} /></button>
        </div>
      )}
      {error && <span title={error} style={{ color: 'var(--destructive)', fontSize: 9 }}>mic</span>}
      <button
        onClick={listening ? stop : start}
        title={listening ? 'Stop listening' : 'Dictate into this sheep'}
        aria-label={listening ? 'Stop listening' : 'Dictate into this sheep'}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 7, border: '1px solid rgba(140, 148, 132,0.18)', cursor: 'pointer', color: listening ? 'var(--destructive)' : '#c3c9bc', background: listening ? 'rgba(224, 144, 123,0.16)' : 'rgba(140, 148, 132,0.08)', boxShadow: 'inset 0 1px rgba(255,255,255,0.06)' }}
      >
        {listening ? <Square size={13} fill="currentColor" /> : <Mic size={17} />}
      </button>
    </div>
  );
}
