// Mic capture for dictation; the server transcribes (src/voice.ts, Parakeet).
import { applyCustomWords } from './customWords';
import useStore from '../store';
import { startEdgeWave } from './edgeWave';
import { apiUrl } from '../serverUrl';
//
// Live preview (`onPartial`): Parakeet has no streaming mode, so every
// PARTIAL_MS the whole recording so far is transcribed again, one run at a
// time (a run still going skips the next tick). ~0.2s per 10s of speech on
// the GPU (4 min took ~5s), so a long take only previews less often. The text on
// stop is a fresh run over everything and replaces the preview.

// The rate the model is trained on. Anything else has to be resampled, and doing
// it here means the worker never has to care where the audio came from.
const SAMPLE_RATE = 16_000;

// A minute of speech is already a long shell line; past this the recording is
// stopped for you, so a mic left open cannot grow without bound.
export const MAX_RECORDING_MS = 5 * 60_000;
const PARTIAL_MS = 1500;

/** Load the model on the server (src/voice.ts) without recording anything —
 *  called when the mic opens, so the first load runs while you are talking. */
export async function warmModel(): Promise<void> {
  const res = await fetch(apiUrl('/api/voice/warm'), { method: 'POST' });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
}

async function transcribe(audio: Float32Array): Promise<string> {
  const res = await fetch(apiUrl('/api/voice/transcribe'), {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: audio as BufferSource,
  });
  const reply = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(reply.error ?? `HTTP ${res.status}`);
  return reply.text ?? '';
}

/** Raw model text → what the composer gets: noise tags out, custom words in. */
const finish = (raw: string) => applyCustomWords(clean(raw), useStore.getState().voiceWords);

/** Keep the final text in the server's history (Settings → AI Features), so
 *  a dictation that landed in the wrong place can be copied again. */
export function rememberDictation(text: string): string {
  if (text.trim()) {
    void fetch(apiUrl('/api/voice/history'), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }),
    }).catch(() => {});
  }
  return text;
}

async function toMono16k(blob: Blob): Promise<Float32Array> {
  const bytes = await blob.arrayBuffer();
  const context = new AudioContext();
  try {
    const decoded = await context.decodeAudioData(bytes);
    const frames = Math.ceil(decoded.duration * SAMPLE_RATE);
    const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const resampled = await offline.startRendering();
    return resampled.getChannelData(0);
  } finally {
    void context.close();
  }
}

// A model may narrate what it hears when it hears nothing — `[BLANK_AUDIO]`,
// `(music)`, `[ Silence ]`. Those are annotations about the recording, not
// words anyone said, and typing them into a shell is worse than typing nothing.
function clean(text: string): string {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:blank_audio|silence|music|applause|laughter|laughs|inaudible|noise)\)/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DictationHandle {
  /** Stop recording and resolve with what was said. Empty if nothing was. */
  stop: () => Promise<string>;
  /** Drop the recording; the mic is released and nothing is transcribed. */
  cancel: () => void;
}

export interface DictationCallbacks {
  onTranscribing?: () => void;
  /** Mic loudness while recording, 0–1, once per frame: proof it hears you. */
  onLevel?: (level: number) => void;
  onProgress?: (fraction: number) => void;
  /** The text so far, every PARTIAL_MS while recording (see the top). */
  onPartial?: (text: string) => void;
  /** The time limit stopped the mic. Call `stop()` to get the text. */
  onEnd?: () => void;
}

/** Opens the mic and records until `stop()`. Throws if permission is refused
 *  or the browser has no recorder — both are worth saying out loud. */
export async function startDictation(callbacks: DictationCallbacks = {}): Promise<DictationHandle> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('This browser cannot record audio');
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
  });
  const release = () => { for (const track of stream.getTracks()) track.stop(); };

  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream);
  } catch (err) {
    release();
    throw err;
  }

  const chunks: Blob[] = [];
  recorder.ondataavailable = event => { if (event.data.size > 0) chunks.push(event.data); };
  // The whole window glows at its edges while the mic is open (style.css,
  // `.voice-on`), pulsing with `--voice-level` on <html>. Off on any stop:
  // stop(), cancel() or the time limit.
  const root = document.documentElement;
  const stopped = new Promise<void>(resolve => {
    recorder.onstop = () => { clearInterval(preview); stopMeter(); root.classList.remove('voice-on'); root.style.removeProperty('--voice-level'); resolve(); };
  });
  // Sliced so the preview can read what has been said so far.
  recorder.start(callbacks.onPartial ? 500 : undefined);
  root.classList.add('voice-on');

  // Loudness meter, only while recording (rAF stops with the mic).
  const meter = new AudioContext();
  const analyser = meter.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.55;
  meter.createMediaStreamSource(stream).connect(analyser);
  const wave = startEdgeWave(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let raf = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    // RMS of speech sits around 0.02–0.2; ×5 puts a normal voice near 1.
    const level = Math.min(1, Math.sqrt(sum / samples.length) * 5);
    root.style.setProperty('--voice-level', level.toFixed(2));
    callbacks.onLevel?.(level);
    wave.draw();
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  const stopMeter = () => { cancelAnimationFrame(raf); wave.stop(); void meter.close().catch(() => {}); };

  // The download is started now rather than on stop, so a first use overlaps it
  // with the sentence instead of adding to it. Failures surface at transcribe.
  const warming = warmModel().catch(() => {});

  let cancelled = false;
  let previewing = false;
  const preview = !callbacks.onPartial ? undefined : setInterval(async () => {
    if (previewing || recorder.state !== 'recording' || !chunks.length) return;
    previewing = true;
    try {
      const audio = await toMono16k(new Blob(chunks, { type: recorder.mimeType }));
      if (audio.length < SAMPLE_RATE / 2) return;
      const text = finish(await transcribe(audio));
      if (recorder.state === 'recording' && text) callbacks.onPartial!(text);
    } catch { /* a preview that fails is just skipped; stop() reports */ }
    finally { previewing = false; }
  }, PARTIAL_MS);
  const limit = setTimeout(() => { if (recorder.state === 'recording') { recorder.stop(); callbacks.onEnd?.(); } }, MAX_RECORDING_MS);

  return {
    async stop() {
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      stopMeter();
      release();
      if (cancelled || chunks.length === 0) return '';
      callbacks.onTranscribing?.();
      // The window's edges run a light around while the text is made (style.css).
      root.classList.add('voice-busy');
      try {
        await warming;
        const audio = await toMono16k(new Blob(chunks, { type: recorder.mimeType }));
        // Under ~0.2s of audio is a click on the button, not a sentence.
        if (audio.length < SAMPLE_RATE / 5) return '';
        return rememberDictation(finish(await transcribe(audio)));
      } finally {
        root.classList.remove('voice-busy');
      }
    },
    cancel() {
      cancelled = true;
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      stopMeter();
      release();
    },
  };
}
