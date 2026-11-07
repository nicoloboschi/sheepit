/**
 * What the machine is running — a small Activity Monitor for the System panel.
 *
 * One `ps` per poll, plus `vm_stat` on macOS for memory. The panel polls only
 * while it is on screen, so this costs nothing the rest of the time.
 */
import { Router } from 'express';
import { execFile, spawn, type ChildProcess } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { readlink, readdir, readFile, rm, stat, lstat, statfs, writeFile } from 'fs/promises';
import { createInterface } from 'readline';
import { readFileSync } from 'fs';
import { configDir } from './paths.js';
import nodePath from 'path';

const execFileAsync = promisify(execFile);

export interface Proc {
  pid: number; ppid: number; cpu: number; memMb: number; user: string; name: string; path: string;
  /** The full command line, arguments and all. */
  args?: string;
  /** The pane whose shell this process descends from, if any. */
  sessionId?: string;
  /** The outermost `.app` bundle the executable lives in, for its icon. A
   *  helper deep inside Brave's frameworks gets Brave's. */
  app?: string;
}

/** `ps -axo pid=,ppid=,pcpu=,rss=,user=,comm=` → rows. `comm` is last because
 *  it can hold spaces (`/Applications/Google Chrome.app/…`). */
export function parsePs(out: string): Proc[] {
  const rows: Proc[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+?)\s*$/);
    if (!m) continue;
    const path = m[6]!;
    const app = path.match(/^(\/.+?\.app)(?:\/|$)/)?.[1];
    rows.push({
      pid: +m[1]!, ppid: +m[2]!, cpu: +m[3]!, memMb: Math.round(+m[4]! / 1024),
      user: m[5]!, path, name: path.split('/').pop() || path,
      ...(app ? { app } : {}),
    });
  }
  return rows;
}

/** `ps -axo pid=,args=` → pid → full command line. */
export function parseArgs(out: string): Map<number, string> {
  const m = new Map<number, string>();
  for (const line of out.split('\n')) {
    const r = line.match(/^\s*(\d+)\s+(.*?)\s*$/);
    if (r) m.set(+r[1]!, r[2]!);
  }
  return m;
}

/** Tag each process with the pane it runs under: walk up the parent chain
 *  until a pane's shell pid turns up. Memoised, so it is one pass. */
export function tagSessions(procs: Proc[], panes: Map<number, string>): void {
  const parent = new Map(procs.map(p => [p.pid, p.ppid]));
  const memo = new Map<number, string | null>();
  const find = (pid: number, depth = 0): string | null => {
    if (panes.has(pid)) return panes.get(pid)!;
    if (memo.has(pid)) return memo.get(pid)!;
    const pp = parent.get(pid);
    const r = pp && pp > 1 && depth < 64 ? find(pp, depth + 1) : null;
    memo.set(pid, r);
    return r;
  };
  for (const p of procs) { const s = find(p.pid); if (s) p.sessionId = s; }
}

/** An app's icon as a 64px PNG: the bundle's `.icns` (named in Info.plist,
 *  else the first one in Resources), converted by `sips`. Apps that ship
 *  only an asset catalogue have none we can read; they get the fallback. */
const icons = new Map<string, Promise<Buffer | null>>();
async function appIcon(app: string): Promise<Buffer | null> {
  const res = nodePath.join(app, 'Contents/Resources');
  let name = '';
  try {
    const { stdout } = await execFileAsync('plutil', ['-extract', 'CFBundleIconFile', 'raw', nodePath.join(app, 'Contents/Info.plist')], { timeout: 2000 });
    name = stdout.trim();
  } catch { /* no key: look in Resources */ }
  let icns = name ? nodePath.join(res, name.endsWith('.icns') ? name : `${name}.icns`) : '';
  if (!icns || !(await stat(icns).catch(() => null))) {
    const first = (await readdir(res).catch(() => [] as string[])).find(f => f.endsWith('.icns'));
    if (!first) return null;
    icns = nodePath.join(res, first);
  }
  const out = nodePath.join(os.tmpdir(), `sheepit-icon-${process.pid}-${icons.size}.png`);
  try {
    await execFileAsync('sips', ['-s', 'format', 'png', '-Z', '64', icns, '--out', out], { timeout: 5000 });
    return await readFile(out);
  } catch { return null; } finally { void rm(out, { force: true }); }
}

/** Memory in use the way Activity Monitor counts it: active + wired +
 *  compressed. `os.freemem()` on macOS leaves the file cache out of "free",
 *  so total − free reads as nearly full on any machine that has been up a while. */
export function parseVmStat(out: string): number | null {
  const page = +(out.match(/page size of (\d+) bytes/)?.[1] ?? 0);
  if (!page) return null;
  const pages = (label: string) => +(out.match(new RegExp(`${label}:\\s+(\\d+)`))?.[1] ?? 0);
  return (pages('Pages active') + pages('Pages wired down') + pages('Pages occupied by compressor')) * page;
}

/** CPU busy share since the previous call, from the kernel's own counters. */
let lastCpu: { idle: number; total: number } | null = null;
function cpuPercent(): number {
  let idle = 0, total = 0;
  for (const c of os.cpus()) {
    idle += c.times.idle;
    total += c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle;
  }
  const prev = lastCpu;
  lastCpu = { idle, total };
  if (!prev || total === prev.total) return 0;
  return Math.round(100 * (1 - (idle - prev.idle) / (total - prev.total)));
}


// ── Disk ─────────────────────────────────────────────────────────────────────
// What fills the disk, like disktree / Finder's storage view. One `du` walks
// the tree (one process, the kernel's own walk, hard links counted once) and
// streams `kb<TAB>path`, children before their parent. Only folders of 1 MB
// or more are kept, so a million-folder home costs a few MB here; what is
// left over shows as "smaller items". Files of the folder you look at are
// read live (readdir + lstat), so the scan never has to hold them.
//
// It runs in the background, as cheaply as the OS allows: `taskpolicy -b` on
// macOS (background QoS: efficiency cores, throttled disk reads, the tier
// Spotlight and Time Machine use), `nice` + `ionice` idle class on Linux. A
// finished scan is saved and refreshed once a day; the old one stays on
// screen until the new one is complete.

const MIN_KB = 1024;
const REFRESH_MS = 24 * 3600_000;
const SCAN_FILE = () => nodePath.join(configDir(), 'disk-scan.json');

interface DiskScan {
  root: string; started: number; finished?: number; count: number; at: string;
  sizes: Map<string, number>;          // folder → bytes
  kids: Map<string, string[]>;         // folder → kept child folders
  proc?: ChildProcess;
}
/** The last complete scan, and the one in progress (if any). */
let done: DiskScan | null = null;
let running: DiskScan | null = null;
let loaded = false;

/** `kb\tpath` lines from `du -k` into a scan. Exported for the test. */
export function addDuLine(s: Pick<DiskScan, 'sizes' | 'kids' | 'root'>, line: string): string | null {
  const tab = line.indexOf('\t');
  if (tab < 0) return null;
  const kb = +line.slice(0, tab);
  const path = line.slice(tab + 1);
  if (!(kb >= MIN_KB) && path !== s.root) return path;
  s.sizes.set(path, kb * 1024);
  if (path !== s.root) {
    const parent = nodePath.dirname(path);
    const list = s.kids.get(parent);
    if (list) list.push(path); else s.kids.set(parent, [path]);
  }
  return path;
}

function loadScan(): void {
  if (loaded) return;
  loaded = true;
  try {
    const j = JSON.parse(readFileSync(SCAN_FILE(), 'utf8')) as { root: string; started: number; finished: number; sizes: [string, number][] };
    const s: DiskScan = { root: j.root, started: j.started, finished: j.finished, count: j.sizes.length, at: j.root, sizes: new Map(), kids: new Map() };
    // Re-add in file order (children first), which rebuilds `kids` as du would.
    for (const [p, b] of j.sizes) addDuLine(s, `${Math.round(b / 1024)}\t${p}`);
    done = s;
  } catch { /* no saved scan yet */ }
}

function saveScan(s: DiskScan): void {
  const body = JSON.stringify({ root: s.root, started: s.started, finished: s.finished, sizes: [...s.sizes] });
  void writeFile(SCAN_FILE(), body).catch(() => {});
}

function startScan(root: string): DiskScan {
  running?.proc?.kill();
  const s: DiskScan = { root, started: Date.now(), count: 0, at: root, sizes: new Map(), kids: new Map() };
  // -x: stay on this volume (no network mounts, no other disks).
  const [cmd, args] = process.platform === 'darwin'
    ? ['taskpolicy', ['-b', 'du', '-k', '-x', root]]
    : ['nice', ['-n', '19', ...(process.platform === 'linux' ? ['ionice', '-c', '3'] : []), 'du', '-k', '-x', root]];
  const proc = spawn(cmd, args as string[], { stdio: ['ignore', 'pipe', 'ignore'] });
  s.proc = proc;
  createInterface({ input: proc.stdout! }).on('line', line => {
    const p = addDuLine(s, line);
    if (p) { s.count++; s.at = p; }
  });
  proc.on('error', () => { if (running === s) running = null; });
  proc.on('close', code => {
    s.proc = undefined;
    if (running !== s) return;          // replaced by a newer scan
    running = null;
    // du exits 1 when some folders were unreadable; the rest is still good.
    // Killed (code null) means abandoned: keep the previous result.
    if (code === null || !s.sizes.has(root)) return;
    s.finished = Date.now();
    done = s;
    saveScan(s);
  });
  running = s;
  return s;
}

// A scan never outlives the server (a restart would orphan `du`).
process.once('exit', () => running?.proc?.kill());

/** Once an hour: rescan the root you last picked if its scan is a day old. */
setInterval(() => {
  loadScan();
  if (done && !running && Date.now() - (done.finished ?? 0) > REFRESH_MS) startScan(done.root);
}, 3600_000).unref();

const expand = (p: string) => (p === '~' ? os.homedir() : p.startsWith('~/') ? nodePath.join(os.homedir(), p.slice(2)) : p);

export function createSystemRouter(panePids: () => Map<number, string> = () => new Map()): Router {
  const router = Router();

  router.get('/system/activity', async (_req, res) => {
    try {
      // Two `ps` runs: `comm` and `args` both hold spaces, so neither can sit
      // before the other on one line and still be split reliably.
      const [{ stdout }, { stdout: argsOut }, vm] = await Promise.all([
        execFileAsync('ps', ['-axo', 'pid=,ppid=,pcpu=,rss=,user=,comm='], { maxBuffer: 16 * 1024 * 1024, timeout: 5000 }),
        execFileAsync('ps', ['-axo', 'pid=,args='], { maxBuffer: 32 * 1024 * 1024, timeout: 5000 }),
        process.platform === 'darwin'
          ? execFileAsync('vm_stat', [], { timeout: 2000 }).then(r => parseVmStat(r.stdout)).catch(() => null)
          : Promise.resolve(null),
      ]);
      const total = os.totalmem();
      const processes = parsePs(stdout);
      const args = parseArgs(argsOut);
      for (const p of processes) p.args = args.get(p.pid);
      tagSessions(processes, panePids());
      res.json({
        processes,
        cpu: cpuPercent(),
        cores: os.cpus().length,
        load: os.loadavg(),
        memUsed: vm ?? total - os.freemem(),
        memTotal: total,
        uptime: os.uptime(),
        self: process.pid,
      });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  /** Where one process is standing. Asked for one pid at a time, when you
   *  pick it: `lsof` over the whole machine takes seconds. */
  router.get('/system/proc/:pid', async (req, res) => {
    const pid = Number(req.params.pid);
    if (!Number.isInteger(pid) || pid <= 0) return res.status(400).json({ error: 'Bad pid' });
    let cwd: string | null = null;
    try {
      if (process.platform === 'linux') cwd = await readlink(`/proc/${pid}/cwd`);
      else {
        const { stdout } = await execFileAsync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { timeout: 3000 });
        cwd = stdout.split('\n').find(l => l.startsWith('n'))?.slice(1) ?? null;
      }
    } catch { /* gone, or another user's: no folder to show */ }
    res.json({ cwd });
  });

  router.get('/system/icon', async (req, res) => {
    const app = String(req.query.app ?? '');
    if (process.platform !== 'darwin' || !/^\/.+\.app$/.test(app) || app.includes('/../')) return res.status(404).end();
    if (!icons.has(app)) icons.set(app, appIcon(app).catch(() => null));
    const png = await icons.get(app)!;
    if (!png) return res.status(404).end();
    res.set('Cache-Control', 'max-age=86400').type('png').send(png);
  });

  /** Quit (SIGTERM) or force quit (SIGKILL) a process. Anyone who reaches
   *  sheepit already has a shell as this user, so this adds no reach; it only
   *  refuses to take down init or sheepit itself. */
  router.post('/system/kill', (req, res) => {
    const pid = Number(req.body?.pid);
    if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return res.status(400).json({ error: 'Not that one' });
    try {
      process.kill(pid, req.body?.force ? 'SIGKILL' : 'SIGTERM');
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: (e as NodeJS.ErrnoException).code === 'EPERM' ? 'Not allowed (another user’s process)' : String(e) });
    }
  });

  /** The folder at `path` as seen by the current scan, plus the volume's
   *  size and free space. Scanning starts on POST /system/disk/scan. */
  router.get('/system/disk', async (req, res) => {
    loadScan();
    const path = nodePath.resolve(expand(String(req.query.path || done?.root || running?.root || '~')));
    const fsInfo = await statfs(path).catch(() => null);
    const volume = fsInfo ? { total: fsInfo.blocks * fsInfo.bsize, free: fsInfo.bavail * fsInfo.bsize } : null;
    const covers = (x: DiskScan | null) => !!x && (path === x.root || path.startsWith(x.root.endsWith('/') ? x.root : x.root + '/'));
    // A finished scan wins; a running one fills in only where none exists.
    const s = covers(done) ? done : covers(running) ? running : null;
    const entries: { name: string; path: string; bytes: number; dir: boolean }[] = [];
    for (const p of s?.kids.get(path) ?? []) entries.push({ name: nodePath.basename(p), path: p, bytes: s!.sizes.get(p)!, dir: true });
    // The folder's own files, live. Capped: a folder of 100k files is rare
    // and its biggest few are what you came for anyway.
    const names = await readdir(path, { withFileTypes: true }).catch(() => []);
    await Promise.all(names.filter(d => !d.isDirectory()).slice(0, 5000).map(async d => {
      const st = await lstat(nodePath.join(path, d.name)).catch(() => null);
      if (st && st.blocks * 512 >= 1024 * 1024) entries.push({ name: d.name, path: nodePath.join(path, d.name), bytes: st.blocks * 512, dir: false });
    }));
    entries.sort((a, b) => b.bytes - a.bytes);
    res.json({
      path, volume,
      size: s?.sizes.get(path) ?? null,
      entries,
      // `root`/`finished`: what is drawn. `running`: a scan under way, if any.
      scan: (done || running) && { root: (done ?? running)!.root, finished: done?.finished ?? null },
      running: running && { root: running.root, count: running.count, at: running.at, started: running.started },
    });
  });

  router.post('/system/disk/scan', (req, res) => {
    let root = nodePath.resolve(expand(String(req.body?.path || '~')));
    // On macOS `/` is the sealed system volume; your files are on the Data
    // volume beside it, and `du -x /` would never cross into it.
    if (root === '/' && process.platform === 'darwin') root = '/System/Volumes/Data';
    if (!nodePath.isAbsolute(root)) return res.status(400).json({ error: 'Bad path' });
    loadScan();
    if (running?.root !== root) startScan(root);
    res.json({ ok: true, root });
  });

  /** Move to the Trash (Finder's, so it can be put back), and take its size
   *  off every folder above it in the scan. */
  router.post('/system/disk/trash', async (req, res) => {
    const p = nodePath.resolve(expand(String(req.body?.path || '')));
    const parts = p.split('/').filter(Boolean);
    if (process.platform !== 'darwin') return res.status(501).json({ error: 'Only on macOS' });
    if (parts.length < 2 || p === os.homedir()) return res.status(400).json({ error: 'Not that one' });
    try {
      await execFileAsync('osascript', ['-e', 'on run argv', '-e', 'tell application "Finder" to delete (POSIX file (item 1 of argv))', '-e', 'end run', p], { timeout: 30000 });
    } catch (e) { return res.status(500).json({ error: String(e).split('\n')[0] }); }
    for (const sc of [done, running]) {
      if (!sc) continue;
      const gone = sc.sizes.get(p) ?? 0;
      for (let d = nodePath.dirname(p); gone; d = nodePath.dirname(d)) {
        const v = sc.sizes.get(d); if (v != null) sc.sizes.set(d, v - gone);
        if (d === sc.root || d === '/') break;
      }
      sc.sizes.delete(p);
      const sib = sc.kids.get(nodePath.dirname(p));
      if (sib) sc.kids.set(nodePath.dirname(p), sib.filter(x => x !== p));
    }
    res.json({ ok: true });
  });

  return router;
}
