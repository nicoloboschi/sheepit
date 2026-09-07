/// <reference lib="webworker" />
//
// Whisper, in the page. The browser's own speech engine is the browser's to
// withhold — Brave ships no Google speech key and fetches no on-device pack,
// and the Electron wrapper has neither — so dictation that depends on it works
// in some builds and silently not in others. This owns the model instead: one
// download, cached by the browser, then identical everywhere and offline.
//
// It runs in a worker because the first inference compiles shaders and pins a
// core; on the main thread that is a visibly frozen terminal.
import { pipeline, type AutomaticSpeechRecognitionPipeline } from '@huggingface/transformers';

// small over base: what gets dictated here is shell-shaped, and base heard
// "git rebase onto main" as "git rebase on domain" — a name that is merely
// wrong is worse in a command line than one that is obviously garbage. ~250 MB
// at q8, downloaded once and then cached by the browser; measured at ~0.9s to
// transcribe five seconds of speech.
const MODEL = 'onnx-community/whisper-small';

type Request =
  | { id: number; type: 'load' }
  | { id: number; type: 'transcribe'; audio: Float32Array; language: string | null };

let pipelinePromise: Promise<AutomaticSpeechRecognitionPipeline> | null = null;

function post(message: Record<string, unknown>) { (self as unknown as Worker).postMessage(message); }

function load(id: number): Promise<AutomaticSpeechRecognitionPipeline> {
  if (!pipelinePromise) {
    pipelinePromise = (async () => {
      const progress = (event: { status?: string; progress?: number }) => {
        if (event.status === 'progress' && typeof event.progress === 'number') {
          post({ id, type: 'progress', progress: event.progress });
        }
      };
      try {
        // WebGPU is several times faster, but it is not everywhere (and Brave
        // can have it off), so a failure here is a fallback, not an error.
        return await pipeline('automatic-speech-recognition', MODEL, { device: 'webgpu', dtype: 'q8', progress_callback: progress });
      } catch {
        return await pipeline('automatic-speech-recognition', MODEL, { device: 'wasm', dtype: 'q8', progress_callback: progress });
      }
    })().catch(err => { pipelinePromise = null; throw err; });
  }
  return pipelinePromise;
}

self.onmessage = async (event: MessageEvent<Request>) => {
  const request = event.data;
  try {
    if (request.type === 'load') {
      await load(request.id);
      post({ id: request.id, type: 'ready' });
      return;
    }
    const transcriber = await load(request.id);
    // The language is passed when we know it; whisper otherwise detects one,
    // and a detector given two seconds of "ls" can pick anything.
    const options = request.language ? { language: request.language, task: 'transcribe' as const } : {};
    const output = await transcriber(request.audio, options);
    const text = Array.isArray(output) ? (output[0]?.text ?? '') : (output.text ?? '');
    post({ id: request.id, type: 'text', text });
  } catch (err) {
    post({ id: request.id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
