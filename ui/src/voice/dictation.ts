// Mic capture for dictation; the server transcribes (src/voice.ts, Parakeet).
import { apiUrl } from '../serverUrl';
//
// The recording is held whole and transcribed once, on stop. Streaming would
// buy a live transcript, but it costs a re-run of the model every second or so
// against a growing buffer, on the machine the user is also compiling on — and
// what the pane needs is the finished line, not a preview of it.

// The rate the model is trained on. Anything else has to be resampled, and doing
// it here means the worker never has to care where the audio came from.
const SAMPLE_RATE = 16_000;

// A minute of speech is already a long shell line; past this the recording is
// stopped for you, so a mic left open cannot grow without bound.
export const MAX_RECORDING_MS = 60_000;

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
  const stopped = new Promise<void>(resolve => { recorder.onstop = () => resolve(); });
  recorder.start();

  // Loudness meter, only while recording (rAF stops with the mic).
  const meter = new AudioContext();
  const analyser = meter.createAnalyser();
  analyser.fftSize = 512;
  meter.createMediaStreamSource(stream).connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let raf = 0;
  const tick = () => {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    // RMS of speech sits around 0.02–0.2; ×5 puts a normal voice near 1.
    callbacks.onLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 5));
    raf = requestAnimationFrame(tick);
  };
  if (callbacks.onLevel) raf = requestAnimationFrame(tick);
  const stopMeter = () => { cancelAnimationFrame(raf); void meter.close().catch(() => {}); };

  // The download is started now rather than on stop, so a first use overlaps it
  // with the sentence instead of adding to it. Failures surface at transcribe.
  const warming = warmModel().catch(() => {});

  let cancelled = false;
  const limit = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, MAX_RECORDING_MS);

  return {
    async stop() {
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      stopMeter();
      release();
      if (cancelled || chunks.length === 0) return '';
      callbacks.onTranscribing?.();
      await warming;
      const audio = await toMono16k(new Blob(chunks, { type: recorder.mimeType }));
      // Under ~0.2s of audio is a click on the button, not a sentence.
      if (audio.length < SAMPLE_RATE / 5) return '';
      return clean(await transcribe(audio));
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
