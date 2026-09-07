// Mic capture for dictation, and the RPC to the Whisper worker.
//
// The recording is held whole and transcribed once, on stop. Streaming would
// buy a live transcript, but it costs a re-run of the model every second or so
// against a growing buffer, on the machine the user is also compiling on — and
// what the pane needs is the finished line, not a preview of it.

// The rate Whisper is trained on. Anything else has to be resampled, and doing
// it here means the worker never has to care where the audio came from.
const SAMPLE_RATE = 16_000;

// A minute of speech is already a long shell line; past this the recording is
// stopped for you, so a mic left open cannot grow without bound.
export const MAX_RECORDING_MS = 60_000;

type WorkerReply =
  | { id: number; type: 'ready' }
  | { id: number; type: 'progress'; progress: number }
  | { id: number; type: 'text'; text: string }
  | { id: number; type: 'error'; message: string };

let worker: Worker | null = null;
let nextId = 1;

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./whisper-worker.ts', import.meta.url), { type: 'module' });
  }
  return worker;
}

/** One request, one reply. `onProgress` reports the model download, 0–1. */
function call(message: Record<string, unknown>, transfer: Transferable[], onProgress?: (fraction: number) => void): Promise<string> {
  const id = nextId++;
  const w = getWorker();
  return new Promise((resolve, reject) => {
    const listener = (event: MessageEvent<WorkerReply>) => {
      const reply = event.data;
      if (reply.id !== id) return;
      if (reply.type === 'progress') { onProgress?.(reply.progress / 100); return; }
      w.removeEventListener('message', listener);
      if (reply.type === 'error') reject(new Error(reply.message));
      else if (reply.type === 'text') resolve(reply.text);
      else resolve('');
    };
    w.addEventListener('message', listener);
    w.postMessage({ ...message, id }, transfer);
  });
}

/** Start fetching the model without recording anything — called when the mic
 *  opens, so the download runs while you are still talking. */
export function warmModel(onProgress?: (fraction: number) => void): Promise<string> {
  return call({ type: 'load' }, [], onProgress);
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

// Whisper narrates what it hears when it hears nothing — `[BLANK_AUDIO]`,
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

  // The download is started now rather than on stop, so a first use overlaps it
  // with the sentence instead of adding to it. Failures surface at transcribe.
  const warming = warmModel(callbacks.onProgress).catch(() => '');

  let cancelled = false;
  const limit = setTimeout(() => { if (recorder.state === 'recording') recorder.stop(); }, MAX_RECORDING_MS);

  return {
    async stop() {
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      release();
      if (cancelled || chunks.length === 0) return '';
      callbacks.onTranscribing?.();
      await warming;
      const audio = await toMono16k(new Blob(chunks, { type: recorder.mimeType }));
      // Under ~0.2s of audio is a click on the button, not a sentence.
      if (audio.length < SAMPLE_RATE / 5) return '';
      const language = (navigator.language || 'en').split('-')[0] || null;
      const text = await call({ type: 'transcribe', audio, language }, [audio.buffer as ArrayBuffer]);
      return clean(text);
    },
    cancel() {
      cancelled = true;
      clearTimeout(limit);
      if (recorder.state !== 'inactive') recorder.stop();
      release();
    },
  };
}
