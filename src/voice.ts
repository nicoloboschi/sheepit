/**
 * Speech to text on the server: Parakeet (NVIDIA, 0.6B) through
 * transcribe.cpp — the same model and engine Handy uses, on the Mac's GPU.
 * ~2s for 45s of speech, against ~1s for 5s with Whisper-small in the page.
 *
 * The model is ~700 MB. Handy's copy (Hugging Face cache) is used when it is
 * there; otherwise it is downloaded once into the config dir. Loaded on first
 * use and kept: the first load compiles Metal shaders (~18s).
 *
 *   POST /api/voice/warm         → { ok } once the model is loaded
 *   POST /api/voice/transcribe   body: 16 kHz mono float32 PCM → { text }
 */
import { Router, raw } from 'express';
import { createWriteStream, existsSync, mkdirSync, readdirSync, renameSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import type { TranscribeModel } from 'transcribe-cpp';
import { configDir } from './paths.js';

const REPO = 'handy-computer/parakeet-unified-en-0.6b-gguf';
const FILE = 'parakeet-unified-en-0.6b-Q8_0.gguf';
// 60s of audio (the UI's cap) is 3.84 MB of float32.
const MAX_BODY = '8mb';

async function modelPath(log: (msg: string) => void): Promise<string> {
  const snapshots = join(homedir(), '.cache', 'huggingface', 'hub', `models--${REPO.replace('/', '--')}`, 'snapshots');
  if (existsSync(snapshots)) {
    for (const snap of readdirSync(snapshots)) {
      const p = join(snapshots, snap, FILE);
      if (existsSync(p)) return p;
    }
  }
  const dir = join(configDir(), 'models');
  const p = join(dir, FILE);
  if (existsSync(p)) return p;
  mkdirSync(dir, { recursive: true });
  log(`[voice] downloading ${FILE} (~700 MB)`);
  const res = await fetch(`https://huggingface.co/${REPO}/resolve/main/${FILE}`);
  if (!res.ok || !res.body) throw new Error(`model download failed: HTTP ${res.status}`);
  // Written beside, then renamed: an interrupted download leaves no half model.
  const tmp = `${p}.${process.pid}.tmp`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
  renameSync(tmp, p);
  return p;
}

let loading: Promise<TranscribeModel> | null = null;
function model(log: (msg: string) => void): Promise<TranscribeModel> {
  loading ??= (async () => {
    const { TranscribeModel } = await import('transcribe-cpp');
    const path = await modelPath(log);
    const started = Date.now();
    const m = await TranscribeModel.load(path);
    log(`[voice] model loaded in ${Date.now() - started}ms`);
    return m;
  })().catch(err => { loading = null; throw err; });
  return loading;
}

export function createVoiceRouter(log: (msg: string) => void): Router {
  const router = Router();
  router.post('/voice/warm', async (_req, res) => {
    try { await model(log); res.json({ ok: true }); }
    catch (err) { res.status(500).json({ error: String(err) }); }
  });
  router.post('/voice/transcribe', raw({ type: 'application/octet-stream', limit: MAX_BODY }), async (req, res) => {
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length % 4 !== 0) return res.status(400).json({ error: 'expected float32 PCM' });
    try {
      // Copied out: a Float32Array needs 4-byte alignment, which a pooled Buffer may not have.
      const pcm = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length));
      const result = await (await model(log)).transcribe(pcm);
      res.json({ text: result.text.trim() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
  return router;
}
