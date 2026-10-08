/**
 * reps (github.com/nicoloboschi/reps) — scheduled agent jobs, each in its own
 * worktree, runs recorded under ~/.reps. sheepit reads it through the CLI's
 * `--json` output rather than the files, so what a run's status *means*
 * (running, killed, crashed…) has one definition, and it is reps'.
 *
 * Everything here is a pass-through: no state, no cache. The panel asks when
 * it is open, and `reps list --json` over a handful of jobs is a few ms.
 */
import { Router } from 'express';
import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import nodePath from 'path';
import os from 'os';

const execFileAsync = promisify(execFile);

/** A job name or run id as reps writes them. Also what keeps a value from
 *  being read as a flag: none may start with `-`. */
const SAFE_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
/** Agent output can run to megabytes; the panel shows the end of it. */
const MAX_OUTPUT = 256 * 1024;

/** The server is often started by launchd or Electron with a bare PATH, which
 *  is exactly where the installer's `~/.local/bin` is missing. */
function repsBin(): string | null {
  if (process.env.REPS_BIN) return process.env.REPS_BIN;
  const dirs = [...(process.env.PATH ?? '').split(nodePath.delimiter), nodePath.join(os.homedir(), '.local/bin')];
  for (const d of dirs) {
    const p = nodePath.join(d, 'reps');
    if (d && existsSync(p)) return p;
  }
  return null;
}

async function repsJson(args: string[]): Promise<unknown> {
  const bin = repsBin();
  if (!bin) throw new Error('reps is not installed');
  try {
    const { stdout } = await execFileAsync(bin, [...args, '--json'], { maxBuffer: 64 * 1024 * 1024, timeout: 15_000 });
    return JSON.parse(stdout);
  } catch (e: any) {
    // reps exits with a one-line reason on stderr ("no job at …")
    throw new Error((e.stderr || e.message || String(e)).trim().split('\n').pop());
  }
}

export function createRepsRouter(): Router {
  const router = Router();

  router.get('/', async (_req, res) => {
    if (!repsBin()) return res.json({ installed: false, jobs: [] });
    try {
      res.json({ installed: true, jobs: await repsJson(['list']) });
    } catch (e: any) {
      res.status(500).json({ installed: true, error: e.message });
    }
  });

  router.get('/:job/runs', async (req, res) => {
    if (!SAFE_ID.test(req.params.job)) return res.status(400).json({ error: 'bad job name' });
    try {
      res.json(await repsJson(['runs', req.params.job]));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get('/:job/runs/:run', async (req, res) => {
    const { job, run } = req.params;
    if (!SAFE_ID.test(job) || !SAFE_ID.test(run)) return res.status(400).json({ error: 'bad id' });
    try {
      const r = await repsJson(['logs', job, '--run', run]) as { output?: string | null };
      if (r.output && r.output.length > MAX_OUTPUT) r.output = '…\n' + r.output.slice(-MAX_OUTPUT);
      res.json(r);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  /** Start a run and answer straight away: a run takes minutes to an hour,
   *  and reps already refuses a second one while the first holds its lock. */
  router.post('/:job/run', (req, res) => {
    const bin = repsBin();
    if (!bin) return res.status(404).json({ error: 'reps is not installed' });
    if (!SAFE_ID.test(req.params.job)) return res.status(400).json({ error: 'bad job name' });
    // detached + its own session, so a sheepit restart does not take the run with it
    const child = spawn(bin, ['run', req.params.job], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
    res.json({ ok: true });
  });

  return router;
}
