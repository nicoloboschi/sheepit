// Speech to text for a composer, using whatever the device does best:
//
// - the Android app: the phone's own recognizer (Google's, on most phones),
//   through @capacitor-community/speech-recognition. Live words as you speak,
//   no model download, nothing on our CPU. The WebView has no Web Speech API.
// - a phone browser with Web Speech (Chrome on Android): the same recognizer,
//   reached from the page.
// - everywhere else (desktop): Parakeet on the sheepit server (dictation.ts),
//   the pane bar's mic. Desktop Chrome's Web Speech sends audio to Google; the
//   local model is what the pane bar already uses, so the two mics agree.

import { isNativeApp, isNarrowScreen } from '../platform';
import { startDictation } from './dictation';
import { applyCustomWords } from './customWords';
import useStore from '../store';

export interface SpeechHandle {
  /** Finish: resolves with the final text (may be ''). */
  stop(): Promise<string>;
  /** Drop what was heard. */
  cancel(): void;
}

export interface SpeechOptions {
  /** Live text so far, when the engine gives it (phone engines do). */
  onPartial?: (text: string) => void;
  /** The engine stopped by itself (silence on a phone). `stop()` still works. */
  onEnd?: () => void;
  /** Server engine only: the recording is being transcribed. */
  onTranscribing?: () => void;
  onProgress?: (fraction: number) => void;
  /** Server engine only: mic loudness 0–1, per frame while recording. */
  onLevel?: (level: number) => void;
}

type WebSpeech = {
  new (): {
    lang: string; continuous: boolean; interimResults: boolean;
    onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
    onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
    start(): void; stop(): void; abort(): void;
  };
};
const webSpeech = (): WebSpeech | undefined =>
  (window as unknown as { SpeechRecognition?: WebSpeech; webkitSpeechRecognition?: WebSpeech }).SpeechRecognition
  ?? (window as unknown as { webkitSpeechRecognition?: WebSpeech }).webkitSpeechRecognition;

/** Which engine `startSpeech` will use, for a tooltip. */
export function speechEngine(): 'phone' | 'browser' | 'whisper' {
  if (isNativeApp()) return 'phone';
  if (isNarrowScreen() && webSpeech()) return 'browser';
  return 'whisper';
}

export async function startSpeech(opts: SpeechOptions = {}): Promise<SpeechHandle> {
  const engine = speechEngine();
  if (engine !== 'whisper') {
    // The phone's recognizer gets the same custom words afterwards (the
    // server engine applies them in dictation.ts).
    const h = engine === 'phone' ? await startNative(opts) : startWeb(opts);
    return { stop: async () => applyCustomWords(await h.stop(), useStore.getState().voiceWords), cancel: () => h.cancel() };
  }
  const h = await startDictation({ onTranscribing: opts.onTranscribing, onProgress: opts.onProgress, onLevel: opts.onLevel });
  return { stop: () => h.stop(), cancel: () => h.cancel() };
}

async function startNative(opts: SpeechOptions): Promise<SpeechHandle> {
  const { SpeechRecognition } = await import('@capacitor-community/speech-recognition');
  const perm = await SpeechRecognition.requestPermissions();
  if (perm.speechRecognition !== 'granted') {
    throw Object.assign(new Error('Microphone permission denied'), { name: 'NotAllowedError' });
  }
  if (!(await SpeechRecognition.available()).available) throw new Error('Speech recognition is not available on this phone');
  let text = '';
  let ended = false;
  let endResolve: (() => void) | null = null;
  const partial = await SpeechRecognition.addListener('partialResults', d => {
    text = d.matches?.[0] ?? text;
    opts.onPartial?.(text);
  });
  const state = await SpeechRecognition.addListener('listeningState', d => {
    if (d.status !== 'stopped') return;
    ended = true;
    endResolve?.();
    opts.onEnd?.();
  });
  const cleanup = () => { void partial.remove(); void state.remove(); };
  await SpeechRecognition.start({ language: navigator.language || 'en-US', partialResults: true, popup: false, maxResults: 1 });
  return {
    async stop() {
      if (!ended) {
        // The last partial lands with the stop; wait for it, briefly.
        const done = new Promise<void>(r => { endResolve = r; setTimeout(r, 1200); });
        await SpeechRecognition.stop().catch(() => {});
        await done;
      }
      cleanup();
      return text.trim();
    },
    cancel() { void SpeechRecognition.stop().catch(() => {}); cleanup(); },
  };
}

function startWeb(opts: SpeechOptions): SpeechHandle {
  const Rec = webSpeech()!;
  const rec = new Rec();
  rec.lang = navigator.language || 'en-US';
  rec.continuous = true;
  rec.interimResults = true;
  let final = '';
  let interim = '';
  let endResolve: (() => void) | null = null;
  let ended = false;
  rec.onresult = e => {
    interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (r.isFinal) final += r[0]!.transcript; else interim += r[0]!.transcript;
    }
    opts.onPartial?.((final + interim).trim());
  };
  rec.onend = () => { ended = true; endResolve?.(); opts.onEnd?.(); };
  rec.onerror = () => { /* onend follows */ };
  rec.start();
  return {
    async stop() {
      if (!ended) {
        const done = new Promise<void>(r => { endResolve = r; setTimeout(r, 1500); });
        rec.stop();
        await done;
      }
      return (final + interim).trim();
    },
    cancel() { rec.abort(); },
  };
}
