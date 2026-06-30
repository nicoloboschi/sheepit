import { Router } from 'express';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import { rgPath } from '@vscode/ripgrep';
import { existsSync, createReadStream, readdirSync, statSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync, watchFile, unwatchFile } from 'fs';
import nodePath from 'path';
import http from 'http';
import os from 'os';
import si from 'systeminformation';
import type { DirectBridge } from './direct-bridge.js';
import type { LogBuffer } from './server.js';
import type { MemoryStore } from './memory.js';
import { logMemoryActivity, getMemoryActivity, capPayload, type MemoryActivity } from './memory.js';
import type { AIService } from './ai.js';

const execAsync = promisify(exec);

const PKG_VERSION: string = (() => {
  try { return JSON.parse(readFileSync(nodePath.join(__dirname, '..', 'package.json'), 'utf-8')).version; }
  catch { return 'unknown'; }
})();

/** Detect which plugin is making a proxy call based on headers, user-agent, or path */
function _detectPluginSource(req: { headers: Record<string, unknown>; url?: string; originalUrl?: string }): 'claude-code' | 'codex' | 'plugin' {
  const ua = String(req.headers['user-agent'] ?? '').toLowerCase();
  const xSource = String(req.headers['x-hindsight-source'] ?? '').toLowerCase();
  if (ua.includes('claude') || xSource.includes('claude')) return 'claude-code';
  if (ua.includes('codex') || xSource.includes('codex')) return 'codex';
  // Detect by bank ID in path — read configured bank IDs
  const url = req.originalUrl ?? req.url ?? '';
  try {
    const ccCfg = JSON.parse(readFileSync(nodePath.join(os.homedir(), '.hindsight', 'claude-code.json'), 'utf-8'));
    if (ccCfg.bankId && url.includes(`/banks/${ccCfg.bankId}/`)) return 'claude-code';
  } catch { /* ignore */ }
  try {
    const cxCfg = JSON.parse(readFileSync(nodePath.join(os.homedir(), '.config', 'codex', 'config.toml'), 'utf-8'));
    if (cxCfg.bankId && url.includes(`/banks/${cxCfg.bankId}/`)) return 'codex';
  } catch { /* ignore */ }
  return 'plugin';
}

export function createApiRouter(bridge: DirectBridge, logBuffer: LogBuffer, memory: MemoryStore, ai: AIService): Router {
  const router = Router();

  /** Get a session's working directory path (replaces tmux display-message) */
  function getSessionCwd(sessionId: string): string {
    const sessions = bridge.getCachedSessions();
    return sessions.find(s => s.id === sessionId)?.path ?? os.homedir();
  }

  router.get('/version', (_req, res) => {
    res.json({ version: PKG_VERSION });
  });

  router.get('/sessions', async (_req, res) => {
    try {
      const sessions = await bridge.listSessions();
      res.json(sessions);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/sessions/git-roots', async (_req, res) => {
    try {
      const sessions = await bridge.listSessions();
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const entries = await Promise.all(sessions.map(async (s) => {
        try {
          const { stdout: pathOut } = await execAsync(
            `echo ${sh(s.path ?? '')}`
          );
          const cwd = pathOut.trim();
          if (!cwd) return [s.id, null];
          const { stdout } = await execAsync(`git -C ${sh(cwd)} rev-parse --git-common-dir 2>/dev/null`);
          const commonDir = stdout.trim();
          if (!commonDir) return [s.id, null];
          // --git-common-dir can be relative (e.g. ".git") for the main worktree
          const absCommonDir = commonDir.startsWith('/') ? commonDir : nodePath.join(cwd, commonDir);
          return [s.id, absCommonDir];
        } catch {
          return [s.id, null];
        }
      }));
      res.json(Object.fromEntries(entries));
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/stats', async (req, res) => {
    try {
      const sessionId = req.query.session_id as string | undefined;

      const [cpuData, memData] = await Promise.all([
        si.currentLoad(),
        si.mem(),
      ]);

      const cpu_percent = cpuData.currentLoad ?? 0;
      const mem_used_gb = memData.used / (1024 ** 3);
      const mem_percent = (memData.used / memData.total) * 100;

      let processes: { pid: number; name: string; cpu_percent: number; mem_mb: number }[] = [];
      if (sessionId) {
        const panePid = await bridge.getSessionPid(sessionId);
        if (panePid) {
          try {
            const isLinux = os.platform() === 'linux';
            const cmd = isLinux
              ? `ps -o pid=,comm=,pcpu=,rss= --ppid ${panePid} 2>/dev/null`
              : `ps -o pid=,comm=,pcpu=,rss= -p $(pgrep -P ${panePid} 2>/dev/null | tr '\\n' ',') 2>/dev/null`;
            const { stdout } = await execAsync(cmd);
            processes = stdout.trim().split('\n').filter(Boolean).map(line => {
              const parts = line.trim().split(/\s+/);
              return {
                pid: parseInt(parts[0]!, 10),
                name: parts[1] ?? '',
                cpu_percent: parseFloat(parts[2] ?? '0'),
                mem_mb: parseInt(parts[3] ?? '0', 10) / 1024,
              };
            }).filter(p => !isNaN(p.pid));
          } catch { /* ignore */ }
        }
      }

      res.json({ cpu_percent, mem_percent, mem_used_gb, processes });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.delete('/stats/process/:pid', async (req, res) => {
    try {
      const pid = parseInt(req.params.pid, 10);
      if (isNaN(pid) || pid <= 1) return res.status(400).json({ error: 'Invalid PID' });
      process.kill(pid, 'SIGTERM');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/diagnostics', (_req, res) => {
    try {
      const diag = bridge.diagnostics();
      const uptime = process.uptime();
      res.json({ ...diag, uptimeSeconds: uptime });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post('/pick-directory', async (_req, res) => {
    try {
      if (os.platform() !== 'darwin') return res.json({ path: null });
      const { stdout } = await execAsync(
        `osascript -e 'POSIX path of (choose folder with prompt "Choose a directory")' 2>/dev/null`
      );
      const path = stdout.trim().replace(/\/$/, '') || null;
      res.json({ path });
    } catch {
      res.json({ path: null });
    }
  });

  router.get('/browse', (req, res) => {
    try {
      const raw = (req.query.path as string | undefined) ?? '~';
      const dir = expandHome(raw);
      const resolved = nodePath.resolve(dir);

      const entries = readdirSync(resolved, { withFileTypes: true });
      const dirs = entries
        .filter(e => e.isDirectory() && !e.name.startsWith('.'))
        .map(e => ({ name: e.name, path: nodePath.join(resolved, e.name) }))
        .sort((a, b) => a.name.localeCompare(b.name));

      res.json({ path: resolved, parent: nodePath.dirname(resolved), dirs });
    } catch (e) {
      res.status(400).json({ error: String(e) });
    }
  });

  router.post('/sessions', async (req, res) => {
    try {
      const { path } = req.body as { path?: string };
      const sessionId = await bridge.createSession(path ?? undefined);
      res.json({ ok: true, session_id: sessionId });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(e) });
    }
  });

  router.post('/sessions/:id/rename', async (req, res) => {
    try {
      const { name } = req.body as { name?: string };
      if (!name?.trim()) return res.status(400).json({ error: 'name required' });
      await bridge.renameSession(req.params.id, name.trim());
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/git/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json(null);

      const run = (cmd: string) => execAsync(cmd, { cwd }).then(r => r.stdout.trim()).catch(() => '');

      const [branch, status, aheadBehind] = await Promise.all([
        run('git rev-parse --abbrev-ref HEAD'),
        run('git status --short'),
        run('git rev-list --left-right --count @{u}...HEAD 2>/dev/null'),
      ]);

      if (!branch || branch === 'HEAD') {
        // Detached HEAD — try short hash
        const hash = await run('git rev-parse --short HEAD');
        if (!hash) return res.json(null);
        return res.json({ branch: hash, detached: true, dirty: status.length > 0, ahead: 0, behind: 0 });
      }

      const abParts = aheadBehind.split('\t');
      res.json({
        branch,
        detached: false,
        dirty: status.length > 0,
        ahead: parseInt(abParts[1] ?? '0', 10) || 0,
        behind: parseInt(abParts[0] ?? '0', 10) || 0,
      });
    } catch {
      res.json(null);
    }
  });



  router.get('/git/:sessionId/github', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json(null);

      const run = (cmd: string) => execAsync(cmd, { cwd }).then(r => r.stdout.trim()).catch(() => '');

      const remoteUrl = await run('git remote get-url origin 2>/dev/null');
      if (!remoteUrl) return res.json(null);

      const m = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
      if (!m) return res.json(null);
      const owner = m[1]!;
      const repo  = m[2]!.replace(/\.git$/, '');
      const repoUrl = `https://github.com/${owner}/${repo}`;

      const branch = await run('git rev-parse --abbrev-ref HEAD');

      let prUrl: string | null = null;
      let prNum: number | null = null;
      let prState: string | null = null;  // OPEN, MERGED, CLOSED
      let prChecks: string | null = null; // PASS, FAIL, PENDING, null
      let prReviewDecision: string | null = null; // APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, null
      try {
        const { stdout } = await execAsync(
          `gh pr view --json url,number,state,statusCheckRollup,reviewDecision 2>/dev/null`,
          { cwd }
        );
        const pr = JSON.parse(stdout.trim());
        if (pr.url) prUrl = pr.url;
        if (pr.number) prNum = pr.number;
        if (pr.state) prState = pr.state;
        if (pr.reviewDecision) prReviewDecision = pr.reviewDecision;
        // Derive checks status from statusCheckRollup
        if (Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.length > 0) {
          const statuses = pr.statusCheckRollup.map((c: any) => (c.conclusion ?? c.status ?? '').toUpperCase());
          if (statuses.some((s: string) => s === 'FAILURE' || s === 'ERROR' || s === 'CANCELLED'))
            prChecks = 'FAIL';
          else if (statuses.some((s: string) => s === 'PENDING' || s === 'QUEUED' || s === 'IN_PROGRESS' || s === 'WAITING'))
            prChecks = 'PENDING';
          else if (statuses.every((s: string) => s === 'SUCCESS' || s === 'NEUTRAL' || s === 'SKIPPED'))
            prChecks = 'PASS';
        }
      } catch {
        // gh not available — try GitHub API as fallback
        try {
          const { stdout } = await execAsync(
            `curl -sf -H "Accept: application/vnd.github+json" "https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open&per_page=1" 2>/dev/null`,
            { cwd, timeout: 5000 }
          );
          const prs = JSON.parse(stdout.trim());
          if (Array.isArray(prs) && prs.length > 0) {
            prUrl = prs[0].html_url;
            prNum = prs[0].number;
            prState = 'OPEN';
          }
        } catch { /* no gh, no API access */ }
      }

      res.json({ repoUrl, prUrl, prNum, prState, prChecks, prReviewDecision, branch, owner, repo });
    } catch {
      res.json(null);
    }
  });

  router.get('/git/:sessionId/worktrees', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json([]);
      const { stdout: rootOut } = await execAsync(`git -C ${sh(cwd)} rev-parse --show-toplevel 2>/dev/null`);
      const gitRoot = rootOut.trim();
      if (!gitRoot) return res.json([]);
      const { stdout } = await execAsync(`git -C ${sh(gitRoot)} worktree list --porcelain 2>/dev/null`);
      // Parse porcelain output: blocks separated by blank lines
      const worktrees = stdout.trim().split(/\n\n+/).filter(Boolean).map(block => {
        const lines = block.split('\n');
        const path = lines.find(l => l.startsWith('worktree '))?.slice('worktree '.length) ?? '';
        const branch = lines.find(l => l.startsWith('branch '))?.slice('branch refs/heads/'.length) ?? null;
        const bare = lines.some(l => l === 'bare');
        const detached = lines.some(l => l === 'detached');
        return { path, branch, bare, detached };
      });
      res.json(worktrees);
    } catch {
      res.json([]);
    }
  });

  router.post('/git/:sessionId/worktree', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.status(400).json({ error: 'No session path' });
      const { stdout: rootOut } = await execAsync(`git -C ${sh(cwd)} rev-parse --show-toplevel 2>/dev/null`);
      const gitRoot = rootOut.trim();
      if (!gitRoot) return res.status(400).json({ error: 'Not a git repository' });
      const parentDir = nodePath.dirname(gitRoot);
      const repoName = nodePath.basename(gitRoot);

      // Explicit name → worktree dir `<repo>-<name>` on a new branch `<name>`.
      const rawName = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
      const name = rawName.replace(/[^A-Za-z0-9._/-]+/g, '-').replace(/^[-/]+|[-/]+$/g, '');
      if (name) {
        const worktreePath = nodePath.join(parentDir, `${repoName}-${name.replace(/\//g, '-')}`);
        if (existsSync(worktreePath)) {
          return res.status(400).json({ error: `Path already exists: ${nodePath.basename(worktreePath)}` });
        }
        try {
          // New branch named after the worktree…
          await execAsync(`git -C ${sh(gitRoot)} worktree add -b ${sh(name)} ${sh(worktreePath)}`);
        } catch {
          // …or attach an existing branch of that name.
          await execAsync(`git -C ${sh(gitRoot)} worktree add ${sh(worktreePath)} ${sh(name)}`);
        }
        return res.json({ path: worktreePath });
      }

      // No name → auto-numbered fallback.
      let worktreePath = '';
      for (let i = 1; i <= 20; i++) {
        const candidate = nodePath.join(parentDir, `${repoName}-wt${i}`);
        if (!existsSync(candidate)) { worktreePath = candidate; break; }
      }
      if (!worktreePath) return res.status(400).json({ error: 'Could not find available worktree path' });
      await execAsync(`git -C ${sh(gitRoot)} worktree add ${sh(worktreePath)}`);
      res.json({ path: worktreePath });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/git/:sessionId/root', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json({ root: null });
      const { stdout } = await execAsync(`git -C ${sh(cwd)} rev-parse --show-toplevel 2>/dev/null`);
      res.json({ root: stdout.trim() || null });
    } catch {
      res.json({ root: null });
    }
  });

  router.get('/git/:sessionId/diff', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { mode, base, commit } = req.query as Record<string, string>;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.type('text/plain').send('');

      const run = (cmd: string) => execAsync(cmd, { cwd, maxBuffer: 10 * 1024 * 1024 })
        .then(r => r.stdout)
        .catch((e: any) => e.stdout ?? '');

      // Single-file diff (used by the file viewer's content/diff toggle): the
      // working-tree changes for one path, falling back to a vs-empty diff for
      // a new/untracked file so it still shows as all-additions.
      const { path: filePath } = req.query as Record<string, string>;
      if (filePath) {
        let d = await run(`git diff HEAD -- ${sh(filePath)}`);
        if (!d) {
          const mimeEnc = await run(`file --mime-encoding ${sh(filePath)}`);
          if (!mimeEnc.includes('binary')) d = await run(`git diff --no-index /dev/null ${sh(filePath)}`);
        }
        return res.type('text/plain; charset=utf-8').send(d);
      }

      let diff = '';
      if (mode === 'commit' && commit) {
        diff = await run(`git diff ${sh(commit)}^..${sh(commit)}`);
      } else if (mode === 'branch') {
        const baseBranch = base || 'origin/main';
        // Try the requested base; if it doesn't exist, fall back to HEAD
        diff = await run(`git diff ${sh(baseBranch)}`);
        if (!diff) {
          // Check if base ref exists — if not, show working tree diff instead
          const refExists = await run(`git rev-parse --verify ${sh(baseBranch)} 2>/dev/null`);
          if (!refExists) diff = await run('git diff HEAD');
        }
      } else {
        // Working tree: show tracked changes (staged + unstaged)
        diff = await run('git diff HEAD');
      }

      // For non-commit modes, append untracked files as synthetic diffs.
      //
      // Hot path for the working-tree view: this used to spawn TWO processes
      // per untracked file (`file --mime-encoding` + `git diff --no-index`)
      // sequentially, which cost ~1s+ on repos with dozens of untracked files.
      // Now we let `git diff --no-index` flag binaries itself ("Binary files
      // … differ") — so one spawn per file — and run them with bounded
      // concurrency instead of serially.
      if (mode !== 'commit') {
        const untrackedOut = await run("git ls-files --others --exclude-standard");
        const untrackedFiles = untrackedOut.trim().split('\n').filter(Boolean);
        const CONCURRENCY = 16;
        for (let i = 0; i < untrackedFiles.length; i += CONCURRENCY) {
          const batch = untrackedFiles.slice(i, i + CONCURRENCY);
          const parts = await Promise.all(
            batch.map((file: string) => run(`git diff --no-index /dev/null ${sh(file)}`)),
          );
          for (const content of parts) {
            // git prints "Binary files …" instead of a textual diff for binaries.
            if (content && !/^Binary files /m.test(content)) diff += '\n' + content;
          }
        }
      }

      res.type('text/plain; charset=utf-8').send(diff);
    } catch {
      res.type('text/plain; charset=utf-8').send('');
    }
  });

  router.get('/git/:sessionId/log', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const { base, limit = '60' } = req.query as Record<string, string>;
      const sh = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json([]);

      const { full } = req.query as Record<string, string>;
      const baseRef = full ? '' : base ? `^${sh(base)}` : `^${sh('origin/main')}`;
      const { stdout } = await execAsync(
        `git -C ${sh(cwd)} log HEAD ${baseRef} --format="%H\x1f%h\x1f%s\x1f%an\x1f%ar\x1f%ad" --date=short -${limit} 2>/dev/null`
      );
      const commits = stdout.trim().split('\n').filter(Boolean).map(line => {
        const parts = line.split('\x1f');
        return { hash: parts[0]!, short: parts[1]!, subject: parts[2]!, author: parts[3]!, relDate: parts[4]!, date: parts[5]! };
      });
      res.json(commits);
    } catch {
      res.json([]);
    }
  });

  router.get('/sessions/:id/scrollback', (req, res) => {
    const sessionId = req.params.id;
    const scrollbackPath = bridge.getScrollbackPath(sessionId);
    if (!existsSync(scrollbackPath)) {
      return res.status(404).type('text/plain').send('No scrollback log found for this session.');
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `inline; filename="${sessionId}.log"`);
    createReadStream(scrollbackPath).pipe(res);
  });

  router.get('/sessions/:id/history', async (req, res) => {
    const sessionId = req.params.id;
    try {
      const text = await bridge.snapshot(sessionId);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.send(text);
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/git/:sessionId/status', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.json({ files: {} });

      const run = (cmd: string) => execAsync(cmd, { cwd }).then(r => r.stdout.trim()).catch(() => '');
      const root = await run('git rev-parse --show-toplevel 2>/dev/null');
      if (!root) return res.json({ files: {} });

      const statusOut = await run('git status --short --porcelain 2>/dev/null');
      const files: Record<string, string> = {};
      for (const line of statusOut.split('\n')) {
        if (!line) continue;
        // Format: XY filename  or  XY old -> new (for renames)
        const x = line[0]; // index status
        const y = line[1]; // working tree status
        let filePath = line.slice(3);
        // Handle renames: "R  old -> new"
        const arrowIdx = filePath.indexOf(' -> ');
        if (arrowIdx !== -1) filePath = filePath.slice(arrowIdx + 4);
        filePath = filePath.replace(/^"(.*)"$/, '$1'); // remove quotes

        // Determine status: untracked, added, modified, deleted, renamed
        let status = 'modified';
        if (x === '?' && y === '?') status = 'untracked';
        else if (x === 'A') status = 'added';
        else if (x === 'D' || y === 'D') status = 'deleted';
        else if (x === 'R') status = 'renamed';

        // Store as absolute path
        files[root + '/' + filePath] = status;
      }
      res.json({ files, root });
    } catch {
      res.json({ files: {} });
    }
  });

  // ── Notes ───────────────────────────────────────────────────────────────────

  const NOTES_DIR = nodePath.join(os.homedir(), '.vipershell', 'notes');
  // Migrate old single-file notes to sheets dir
  const OLD_NOTES_PATH = nodePath.join(os.homedir(), '.vipershell', 'notes.md');
  try {
    if (existsSync(OLD_NOTES_PATH)) {
      mkdirSync(NOTES_DIR, { recursive: true });
      const oldContent = readFileSync(OLD_NOTES_PATH, 'utf-8');
      if (oldContent.trim()) {
        const dest = nodePath.join(NOTES_DIR, 'notes.md');
        if (!existsSync(dest)) writeFileSync(dest, oldContent, 'utf-8');
      }
      unlinkSync(OLD_NOTES_PATH);
    }
  } catch { /* ignore migration errors */ }

  // Backwards compat: old single-file endpoint redirects to default sheet
  router.get('/notes', (_req, res) => {
    try {
      const p = nodePath.join(NOTES_DIR, 'notes.md');
      if (!existsSync(p)) return res.json({ content: '' });
      res.json({ content: readFileSync(p, 'utf-8') });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.put('/notes', (req, res) => {
    try {
      const { content } = req.body as { content?: string };
      if (content === undefined) return res.status(400).json({ error: 'Missing content' });
      mkdirSync(NOTES_DIR, { recursive: true });
      writeFileSync(nodePath.join(NOTES_DIR, 'notes.md'), content, 'utf-8');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // List all note sheets
  router.get('/notes/sheets', (_req, res) => {
    try {
      mkdirSync(NOTES_DIR, { recursive: true });
      const files = readdirSync(NOTES_DIR).filter(f => f.endsWith('.md')).sort();
      if (files.length === 0) {
        // Create a default sheet
        writeFileSync(nodePath.join(NOTES_DIR, 'notes.md'), '', 'utf-8');
        files.push('notes.md');
      }
      res.json({ sheets: files.map(f => f.replace(/\.md$/, '')), dir: NOTES_DIR.replace(os.homedir(), '~') });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Read a sheet
  router.get('/notes/sheets/:name', (req, res) => {
    try {
      const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
      const p = nodePath.join(NOTES_DIR, `${name}.md`);
      if (!existsSync(p)) return res.json({ content: '' });
      res.json({ content: readFileSync(p, 'utf-8') });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Write a sheet
  router.put('/notes/sheets/:name', (req, res) => {
    try {
      const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
      const { content } = req.body as { content?: string };
      if (content === undefined) return res.status(400).json({ error: 'Missing content' });
      mkdirSync(NOTES_DIR, { recursive: true });
      writeFileSync(nodePath.join(NOTES_DIR, `${name}.md`), content, 'utf-8');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Delete a sheet
  router.delete('/notes/sheets/:name', (req, res) => {
    try {
      const name = req.params.name.replace(/[^a-zA-Z0-9_-]/g, '');
      const p = nodePath.join(NOTES_DIR, `${name}.md`);
      if (existsSync(p)) unlinkSync(p);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // ── Filesystem browse ────────────────────────────────────────────────────────

  const expandHome = (p: string) => p.startsWith('~/') ? nodePath.join(os.homedir(), p.slice(2)) : p === '~' ? os.homedir() : p;

  // Live foreground-process working directory — used to resolve relative paths
  // an app (e.g. Claude Code) prints, against ITS cwd rather than the shell's
  // tracked path. Falls back to the session's tracked cwd.
  router.get('/fs/:sessionId/cwd', async (req, res) => {
    const { sessionId } = req.params;
    const fallback = getSessionCwd(sessionId);
    try {
      const cwd = await bridge.getForegroundCwd(sessionId);
      res.json({ cwd: cwd || fallback });
    } catch {
      res.json({ cwd: fallback });
    }
  });

  router.get('/fs/:sessionId/browse', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const subpath = expandHome((req.query.path as string | undefined) ?? '');
      const cwd = getSessionCwd(sessionId);
      if (!cwd) return res.status(404).json({ error: 'Session not found' });

      const dir = subpath ? nodePath.resolve(cwd, subpath) : cwd;
      const entries = readdirSync(dir, { withFileTypes: true });
      const result = entries
        .map(e => {
          const fullPath = nodePath.join(dir, e.name);
          let size = 0;
          try { if (!e.isDirectory()) size = statSync(fullPath).size; } catch { /* ignore */ }
          return { name: e.name, isDir: e.isDirectory(), path: fullPath, size };
        })
        .sort((a, b) => {
          if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
      res.json({ cwd, dir, entries: result });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/fs/:sessionId/search', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const query = (req.query.q as string | undefined ?? '').trim();
      const glob  = (req.query.glob as string | undefined ?? '').trim();
      const dir   = (req.query.dir as string | undefined ?? '').trim();
      if (!query) return res.json({ results: [] });

      const sessionCwd = getSessionCwd(sessionId);
      if (!sessionCwd) return res.status(404).json({ error: 'Session not found' });

      // Scope the ripgrep run to `dir` when provided so users can search from
      // a subfolder. We resolve and require the dir exists (`statSync.isDirectory`)
      // — but we DON'T require it to live under sessionCwd: the file browser
      // can navigate anywhere the user has read access to, and search should
      // follow. Falling back to sessionCwd otherwise.
      let cwd = sessionCwd;
      if (dir) {
        try {
          const resolved = nodePath.resolve(dir);
          if (statSync(resolved).isDirectory()) cwd = resolved;
        } catch { /* fall through to sessionCwd */ }
      }

      const MAX_RESULTS = 500;
      const args = [
        '--json',
        '--smart-case',
        '--max-filesize', '1M',
        '--max-count', String(MAX_RESULTS),
        ...(glob ? ['-g', glob] : []),
        '--', query, '.',
      ];

      const results: { file: string; line: number; text: string }[] = [];
      await new Promise<void>((resolve) => {
        const child = spawn(rgPath, args, { cwd });
        let buf = '';
        let done = false;
        const finish = () => { if (!done) { done = true; try { child.kill(); } catch {} resolve(); } };
        const timer = setTimeout(finish, 10_000);

        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const line = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              const ev = JSON.parse(line);
              if (ev.type !== 'match') continue;
              const file = ev.data.path?.text ?? '';
              const lineNum = ev.data.line_number ?? 0;
              const text = ev.data.lines?.text?.replace(/\r?\n$/, '') ?? '';
              results.push({ file: file.replace(/^\.\//, ''), line: lineNum, text });
              if (results.length >= MAX_RESULTS) { finish(); return; }
            } catch { /* skip non-JSON line */ }
          }
        });
        child.on('error', finish);
        child.on('close', () => { clearTimeout(timer); finish(); });
      });

      res.json({ results, cwd });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.get('/fs/:sessionId/find', async (req, res) => {
    try {
      const { sessionId } = req.params;
      const query = (req.query.q as string | undefined ?? '').trim();
      const dir   = (req.query.dir as string | undefined ?? '').trim();
      if (!query) return res.json({ results: [] });

      const sessionCwd = getSessionCwd(sessionId);
      if (!sessionCwd) return res.status(404).json({ error: 'Session not found' });

      // Same scoping rule as /search — when `dir` is supplied, restrict the
      // filename-walk to that subtree so the user gets folder-local results.
      let cwd = sessionCwd;
      if (dir) {
        try {
          const resolved = nodePath.resolve(dir);
          if (statSync(resolved).isDirectory()) cwd = resolved;
        } catch { /* fall through to sessionCwd */ }
      }

      const MAX_RESULTS = 100;
      const needle = query.toLowerCase();
      const args = ['--files', '--hidden', '-g', '!.git'];

      const results: string[] = [];
      await new Promise<void>((resolve) => {
        const child = spawn(rgPath, args, { cwd });
        let buf = '';
        let done = false;
        const finish = () => { if (!done) { done = true; try { child.kill(); } catch {} resolve(); } };
        const timer = setTimeout(finish, 5_000);

        child.stdout.on('data', (chunk: Buffer) => {
          buf += chunk.toString('utf8');
          let nl: number;
          while ((nl = buf.indexOf('\n')) !== -1) {
            const file = buf.slice(0, nl);
            buf = buf.slice(nl + 1);
            if (!file) continue;
            if (file.toLowerCase().includes(needle)) {
              results.push(file.replace(/^\.\//, ''));
              if (results.length >= MAX_RESULTS) { finish(); return; }
            }
          }
        });
        child.on('error', finish);
        child.on('close', () => { clearTimeout(timer); finish(); });
      });

      res.json({ results, cwd });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post('/fs/upload', async (req, res) => {
    const dir = expandHome(req.query.dir as string | undefined ?? '');
    const name = req.query.name as string | undefined ?? '';
    if (!dir || !name) return res.status(400).json({ error: 'Missing dir or name' });
    const safeName = nodePath.basename(name);
    if (!safeName) return res.status(400).json({ error: 'Invalid filename' });
    const destPath = nodePath.join(dir, safeName);
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      writeFileSync(destPath, Buffer.concat(chunks));
      res.json({ ok: true, path: destPath });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post('/fs/write', (req, res) => {
    const filePath = expandHome(req.query.path as string | undefined ?? '');
    if (!filePath) return res.status(400).json({ error: 'Missing path' });
    try {
      const { content } = req.body as { content?: string };
      if (content === undefined) return res.status(400).json({ error: 'Missing content' });
      writeFileSync(filePath, content, 'utf-8');
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.post('/fs/mkdir', (req, res) => {
    const dirPath = expandHome(req.query.path as string | undefined ?? '');
    if (!dirPath) return res.status(400).json({ error: 'Missing path' });
    try {
      mkdirSync(dirPath, { recursive: true });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  router.delete('/fs/delete', (req, res) => {
    const filePath = expandHome(req.query.path as string | undefined ?? '');
    if (!filePath) return res.status(400).json({ error: 'Missing path' });
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    try {
      rmSync(filePath, { recursive: false });
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: String(e) });
    }
  });

  // Open a file with the host OS default application (the machine running the
  // server, not the browser). vipershell is "your machine, anywhere", so this
  // surfaces a file in the host's native GUI app.
  router.post('/fs/open', (req, res) => {
    const filePath = expandHome(req.query.path as string | undefined ?? '');
    if (!filePath) return res.status(400).json({ error: 'Missing path' });
    if (!existsSync(filePath)) return res.status(404).json({ error: 'Not found' });
    const platform = process.platform;
    const [cmd, args] = platform === 'darwin' ? ['open', [filePath]]
      : platform === 'win32'                  ? ['cmd', ['/c', 'start', '', filePath]]
      :                                         ['xdg-open', [filePath]];
    const child = spawn(cmd as string, args as string[], { detached: true, stdio: 'ignore' });
    let settled = false;
    child.on('error', (err) => { if (!settled) { settled = true; res.status(500).json({ error: String(err) }); } });
    child.on('spawn', () => { if (!settled) { settled = true; child.unref(); res.json({ ok: true }); } });
  });

  router.get('/fs/raw', (req, res) => {
    const filePath = expandHome(req.query.path as string | undefined ?? '');
    if (!filePath) return res.status(400).send('Missing path');
    if (!existsSync(filePath)) return res.status(404).send('Not found');
    try {
      const stat = statSync(filePath);
      if (stat.isDirectory()) return res.status(400).send('Path is a directory');
      if (stat.size > 2 * 1024 * 1024) return res.status(413).send('File too large (> 2 MB)');
      const ext = nodePath.extname(filePath).toLowerCase();
      const imageExts  = new Set(['.png','.jpg','.jpeg','.gif','.webp','.svg','.ico','.bmp']);
      const pdfExts    = new Set(['.pdf']);
      if (imageExts.has(ext)) return res.sendFile(filePath);
      if (pdfExts.has(ext))   return res.sendFile(filePath);
      // Serve as plain text for source files
      res.type('text/plain; charset=utf-8').send(readFileSync(filePath, 'utf-8'));
    } catch (e) {
      res.status(500).send(String(e));
    }
  });

  router.get('/logs/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    for (const entry of logBuffer.entries()) {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    }

    const unsub = logBuffer.subscribe((entry) => {
      res.write(`data: ${JSON.stringify(entry)}\n\n`);
    });

    req.on('close', () => unsub());
  });

  // ── Hindsight reverse proxy ──────────────────────────────────────────────────

  router.all('/hindsight/*', (req, res) => {
    if (!memory.active) {
      return res.status(503).json({ error: 'Hindsight not running' });
    }
    const subpath = (req.params as Record<string, string>)[0];
    const target = new URL(`${memory.apiUrl}/${subpath}`);

    // Log retain/recall/reflect activity from plugins.
    // For retain we can log immediately; for recall we log after the response so
    // we can capture the result preview that was actually sent back to the hook.
    let pendingRecall: MemoryActivity | null = null;
    if (req.method === 'POST' && subpath) {
      const source = _detectPluginSource(req);

      // Try to resolve vipershell session ID from the request context.
      // The retain body may have metadata.session_id (Claude Code UUID) — we match
      // it to a vipershell session by finding an isClaudeCode session whose path matches.
      let vsSessionId: string | undefined;
      const sessions = bridge.getCachedSessions();
      const claudeSessions = sessions.filter(s => s.isClaudeCode);

      // Stringify metadata values so the activity log carries simple k/v pairs.
      const flattenMeta = (m: unknown): Record<string, string> | undefined => {
        if (!m || typeof m !== 'object') return undefined;
        const out: Record<string, string> = {};
        for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
          if (v == null) continue;
          out[k] = typeof v === 'string' ? v : JSON.stringify(v);
        }
        return Object.keys(out).length > 0 ? out : undefined;
      };

      if (subpath.match(/\/memories$/) && req.body) {
        // Retain call — POST /banks/{id}/memories
        const content = typeof req.body.content === 'string' ? req.body.content : JSON.stringify(req.body.content ?? '');
        const ctx = req.body.context
          ?? (typeof req.body.content === 'string' ? req.body.content.slice(0, 120) : undefined);
        // Match by most recently active Claude Code session (retain happens at session end)
        if (claudeSessions.length === 1) {
          vsSessionId = claudeSessions[0]!.id;
        } else if (claudeSessions.length > 1) {
          // Pick the one with most recent activity
          vsSessionId = claudeSessions.sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0))[0]?.id;
        }
        const capped = capPayload(content);
        logMemoryActivity({
          ts: Date.now(), type: 'retain', source,
          sessionId: vsSessionId,
          contentSize: content.length,
          context: typeof ctx === 'string' ? ctx.slice(0, 120) : undefined,
          subpath,
          payload: capped.value,
          payloadTruncated: capped.truncated,
          metadata: flattenMeta(req.body.metadata),
        });
      } else if (subpath.includes('/recall') && req.body) {
        // Recall call — attribute to the most recently active Claude Code session
        if (claudeSessions.length > 0) {
          vsSessionId = claudeSessions.sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0))[0]?.id;
        }
        const query = typeof req.body.query === 'string'
          ? req.body.query
          : typeof req.body.content === 'string'
            ? req.body.content
            : '';
        const capped = capPayload(query);
        pendingRecall = {
          ts: Date.now(), type: 'recall', source,
          sessionId: vsSessionId,
          context: query.slice(0, 120),
          subpath,
          payload: capped.value,
          payloadTruncated: capped.truncated,
          metadata: flattenMeta(req.body.metadata),
        };
      } else if (subpath.includes('/reflect') && req.body) {
        if (claudeSessions.length > 0) {
          vsSessionId = claudeSessions.sort((a, b) => (b.last_activity ?? 0) - (a.last_activity ?? 0))[0]?.id;
        }
        const query = typeof req.body.query === 'string' ? req.body.query : '';
        const capped = capPayload(query);
        pendingRecall = {
          ts: Date.now(), type: 'recall', source,
          sessionId: vsSessionId,
          context: query.slice(0, 120),
          subpath,
          payload: capped.value,
          payloadTruncated: capped.truncated,
          metadata: flattenMeta(req.body.metadata),
        };
      }
    }
    if (req.url.includes('?')) target.search = req.url.split('?')[1]!;

    // Re-serialize body since express.json() already consumed the stream
    const bodyStr = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : null;

    const proxyHeaders = { ...req.headers };
    delete proxyHeaders['host'];
    delete proxyHeaders['content-length'];
    if (bodyStr) {
      proxyHeaders['content-length'] = String(Buffer.byteLength(bodyStr));
    }

    const proxyReq = http.request({
      hostname: target.hostname,
      port: parseInt(target.port || '80'),
      path: target.pathname + target.search,
      method: req.method,
      headers: { ...proxyHeaders, host: target.host },
    }, (proxyRes) => {
      res.status(proxyRes.statusCode ?? 200);
      for (const [k, v] of Object.entries(proxyRes.headers)) {
        if (v && k.toLowerCase() !== 'content-encoding') res.setHeader(k, v as string);
      }
      if (pendingRecall) {
        // Tee the response: buffer it (capped) so we can extract the result preview
        // that the hook actually received, while still streaming bytes to the client.
        const captured = pendingRecall;
        const chunks: Buffer[] = [];
        let captured_bytes = 0;
        const CAP = 64 * 1024; // upper bound on what we buffer for parsing
        proxyRes.on('data', (chunk: Buffer) => {
          if (captured_bytes < CAP) {
            const room = CAP - captured_bytes;
            chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
            captured_bytes += Math.min(chunk.length, room);
          }
          res.write(chunk);
        });
        proxyRes.on('end', () => {
          res.end();
          try {
            const body = Buffer.concat(chunks).toString('utf8');
            const parsed = JSON.parse(body);
            const results = Array.isArray(parsed?.results) ? parsed.results : [];
            captured.resultCount = results.length;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const joined = results.map((r: any) => typeof r?.text === 'string' ? r.text : JSON.stringify(r)).join('\n---\n');
            const cappedResults = capPayload(joined);
            captured.resultsPreview = cappedResults.value;
            captured.resultsPreviewTruncated = cappedResults.truncated;
          } catch { /* upstream returned non-JSON or partial — leave preview empty */ }
          logMemoryActivity(captured);
        });
        proxyRes.on('error', () => {
          // Still log what we have, even if upstream errored mid-stream
          logMemoryActivity(captured);
        });
      } else {
        proxyRes.pipe(res);
      }
    });

    proxyReq.on('error', (e) => {
      if (!res.headersSent) res.status(502).json({ error: `Proxy error: ${e.message}` });
    });

    if (bodyStr) {
      proxyReq.end(bodyStr);
    } else {
      proxyReq.end();
    }
  });

  // ── Memory config & control ──────────────────────────────────────────────────

  // ── Memory activity + bank stats ──────────────────────────────────────────
  router.get('/memory/activity', async (_req, res) => {
    const activity = getMemoryActivity();
    let bankStats = null;
    let healthy = false;
    let bankId = 'vipershell';

    // Read the configured bank ID from plugin config
    try {
      const pluginCfg = JSON.parse(readFileSync(nodePath.join(os.homedir(), '.hindsight', 'claude-code.json'), 'utf-8'));
      if (pluginCfg.bankId) bankId = pluginCfg.bankId;
    } catch { /* use default */ }

    if (memory.active && memory.apiUrl) {
      try {
        const resp = await fetch(`${memory.apiUrl}/v1/default/banks/${encodeURIComponent(bankId)}/stats`, {
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          bankStats = await resp.json();
          healthy = true;
        }
      } catch { /* hindsight unreachable */ }

      if (!healthy) {
        try {
          const resp = await fetch(`${memory.apiUrl}/health`, { signal: AbortSignal.timeout(2000) });
          healthy = resp.ok;
        } catch { /* still unhealthy */ }
      }
    }

    res.json({
      enabled: memory.getConfig().hindsightEnabled,
      active: memory.active,
      healthy,
      bankId,
      bankStats,
      activity,
    });
  });

  router.get('/memory/config', async (_req, res) => {
    const cfg = memory.getConfig();
    let controlPlaneActive = false;
    try {
      const resp = await fetch(`http://127.0.0.1:${cfg.uiPort}/api/health`, { signal: AbortSignal.timeout(1500) });
      controlPlaneActive = resp.ok;
    } catch {
      // Fallback: try root path (Next.js may not have /api/health)
      try {
        const resp = await fetch(`http://127.0.0.1:${cfg.uiPort}/`, { signal: AbortSignal.timeout(1500) });
        controlPlaneActive = resp.ok;
      } catch { /* not running */ }
    }
    res.json({
      ...cfg,
      active: memory.active,
      started_at: memory.startedAt,
      controlPlaneActive,
    });
  });

  router.post('/memory/restart', async (req, res) => {
    const body = req.body as Record<string, unknown>;
    const cfg = memory.getConfig();

    memory.saveConfig({
      hindsightEnabled: body.hindsightEnabled !== undefined ? Boolean(body.hindsightEnabled) : cfg.hindsightEnabled,
      hindsightApiUrl: typeof body.hindsightApiUrl === 'string' ? body.hindsightApiUrl : cfg.hindsightApiUrl,
      hindsightApiToken: typeof body.hindsightApiToken === 'string' ? body.hindsightApiToken : cfg.hindsightApiToken,
      retainChunkChars: typeof body.retainChunkChars === 'number' ? body.retainChunkChars : cfg.retainChunkChars,
      observationsEnabled: body.observationsEnabled !== undefined ? Boolean(body.observationsEnabled) : cfg.observationsEnabled,
    });

    // Restart in background
    memory.restart().catch((e) => {
      console.error('Hindsight restart failed:', e);
    });

    res.json({ ok: true });
  });

  // ── Plugin config (writes to ~/.hindsight/claude-code.json, no server restart needed) ──

  const pluginConfigPath = nodePath.join(os.homedir(), '.hindsight', 'claude-code.json');

  router.get('/memory/plugin-config', (_req, res) => {
    try {
      const data = JSON.parse(readFileSync(pluginConfigPath, 'utf-8'));
      res.json(data);
    } catch {
      res.json({});
    }
  });

  router.post('/memory/plugin-config', (req, res) => {
    const updates = req.body as Record<string, unknown>;
    try {
      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(readFileSync(pluginConfigPath, 'utf-8')); } catch { /* fresh */ }
      const merged = { ...existing, ...updates };
      mkdirSync(nodePath.dirname(pluginConfigPath), { recursive: true });
      writeFileSync(pluginConfigPath, JSON.stringify(merged, null, 2) + '\n');
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: false, error: String(e) });
    }
  });

  router.get('/memory/logs', (req, res) => {
    const logPath = memory.logPath;
    const lines = parseInt(req.query.lines as string) || 200;

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send initial tail
    try {
      const content = readFileSync(logPath, 'utf-8');
      const tail = content.split('\n').slice(-lines).join('\n');
      res.write(`data: ${JSON.stringify({ type: 'initial', text: tail })}\n\n`);
    } catch {
      res.write(`data: ${JSON.stringify({ type: 'initial', text: '(no log file yet)' })}\n\n`);
    }

    // Watch for changes and stream new content
    let lastSize = 0;
    try { lastSize = statSync(logPath).size; } catch { /* file may not exist */ }

    const onChange = () => {
      try {
        const currentSize = statSync(logPath).size;
        if (currentSize > lastSize) {
          const stream = createReadStream(logPath, { start: lastSize, encoding: 'utf-8' });
          let chunk = '';
          stream.on('data', (data) => { chunk += data; });
          stream.on('end', () => {
            if (chunk) res.write(`data: ${JSON.stringify({ type: 'append', text: chunk })}\n\n`);
          });
          lastSize = currentSize;
        } else if (currentSize < lastSize) {
          // File was truncated/rotated — re-read
          lastSize = currentSize;
        }
      } catch { /* ignore */ }
    };

    watchFile(logPath, { interval: 1000 }, onChange);

    req.on('close', () => {
      unwatchFile(logPath, onChange);
    });
  });

  router.get('/memory/claude-code-status', async (_req, res) => {
    const configPath = nodePath.join(os.homedir(), '.hindsight', 'claude-code.json');
    let configExists = false;
    let configUrl = '';
    try {
      const data = JSON.parse(readFileSync(configPath, 'utf-8'));
      configExists = true;
      configUrl = data.hindsightApiUrl ?? '';
    } catch { /* no config */ }

    let pluginInstalled = false;
    let pluginEnabled = false;
    try {
      const { stdout } = await execAsync('claude plugin list 2>/dev/null', { timeout: 10_000 });
      const lines = stdout.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.includes('hindsight-memory@hindsight')) {
          pluginInstalled = true;
          // Check next few lines for status
          for (let j = i + 1; j < Math.min(i + 5, lines.length); j++) {
            if (lines[j]!.includes('enabled')) { pluginEnabled = true; break; }
          }
          break;
        }
      }
    } catch { /* claude CLI not available */ }

    // Get installed version
    let pluginVersion = '';
    try {
      const cacheDir = nodePath.join(os.homedir(), '.claude', 'plugins', 'cache', 'hindsight', 'hindsight-memory');
      const versions = readdirSync(cacheDir).sort().reverse();
      if (versions.length > 0) pluginVersion = versions[0]!;
    } catch { /* no cache */ }

    res.json({
      pluginInstalled,
      pluginEnabled,
      configExists,
      configUrl,
      pluginVersion,
    });
  });

  router.post('/memory/claude-code-setup', async (req, res) => {
    if (!memory.active) return res.json({ ok: false, error: 'Hindsight not running' });

    const host = req.headers.host ?? 'localhost:4445';
    const hindsightUrl = `http://${host}/api/hindsight`;

    const steps: string[] = [];
    const errors: string[] = [];

    // Step 1: Add marketplace
    try {
      await execAsync('claude plugin marketplace add vectorize-io/hindsight', { timeout: 30_000 });
      steps.push('marketplace');
    } catch (e: unknown) {
      const err = e as { code?: number; stderr?: string; message?: string };
      if (err.code === 127) return res.json({ ok: false, error: "'claude' CLI not found in PATH. Install Claude Code first." });
      // Marketplace might already be added — continue
      if (err.stderr?.includes('already') || err.stderr?.includes('exists')) {
        steps.push('marketplace');
      } else {
        errors.push(`Marketplace: ${err.stderr?.trim() || err.message || String(e)}`);
      }
    }

    // Step 2: Install plugin
    try {
      await execAsync('claude plugin install hindsight-memory', { timeout: 30_000 });
      steps.push('plugin');
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      if (err.stderr?.includes('already') || err.stderr?.includes('exists')) {
        steps.push('plugin');
      } else {
        errors.push(`Plugin: ${err.stderr?.trim() || err.message || String(e)}`);
      }
    }

    // Step 3: Write config pointing to vipershell's Hindsight proxy
    try {
      const configDir = nodePath.join(os.homedir(), '.hindsight');
      const configPath = nodePath.join(configDir, 'claude-code.json');
      mkdirSync(configDir, { recursive: true });

      let existing: Record<string, unknown> = {};
      try { existing = JSON.parse(readFileSync(configPath, 'utf-8')); } catch { /* fresh */ }

      const updated = {
        ...existing,
        hindsightApiUrl: hindsightUrl,
      };
      writeFileSync(configPath, JSON.stringify(updated, null, 2) + '\n');
      steps.push('config');
    } catch (e) {
      errors.push(`Config: ${String(e)}`);
    }

    // Step 4: Run setup_hooks.py to register hooks
    if (errors.length === 0) {
      try {
        const cacheDir = nodePath.join(os.homedir(), '.claude', 'plugins', 'cache', 'hindsight', 'hindsight-memory');
        const versions = readdirSync(cacheDir).sort().reverse();
        if (versions.length > 0) {
          const setupScript = nodePath.join(cacheDir, versions[0]!, 'scripts', 'setup_hooks.py');
          if (existsSync(setupScript)) {
            await execAsync(`python3 "${setupScript}"`, { timeout: 15_000 });
            steps.push('hooks');
          }
        }
      } catch (e) {
        errors.push(`Hooks: ${String(e)}`);
      }
    }

    if (errors.length > 0) {
      return res.json({ ok: false, error: errors.join('; '), steps });
    }
    return res.json({ ok: true, steps, hindsightUrl });
  });

  router.post('/memory/claude-code-disable', async (_req, res) => {
    try {
      await execAsync('claude plugin disable hindsight-memory@hindsight', { timeout: 10_000 });
      res.json({ ok: true });
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      res.json({ ok: false, error: err.stderr?.trim() || err.message || String(e) });
    }
  });

  router.post('/memory/claude-code-enable', async (_req, res) => {
    try {
      await execAsync('claude plugin enable hindsight-memory@hindsight', { timeout: 10_000 });
      res.json({ ok: true });
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      res.json({ ok: false, error: err.stderr?.trim() || err.message || String(e) });
    }
  });

  router.post('/memory/claude-code-remove', async (_req, res) => {
    try {
      await execAsync('claude plugin uninstall hindsight-memory@hindsight', { timeout: 10_000 });
      res.json({ ok: true });
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      res.json({ ok: false, error: err.stderr?.trim() || err.message || String(e) });
    }
  });

  router.post('/memory/claude-code-update', async (_req, res) => {
    const errors: string[] = [];

    // Clear cache and reinstall to force fresh pull
    try {
      const cacheDir = nodePath.join(os.homedir(), '.claude', 'plugins', 'cache', 'hindsight', 'hindsight-memory');
      const marketDir = nodePath.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'hindsight');
      rmSync(cacheDir, { recursive: true, force: true });
      rmSync(marketDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    try {
      await execAsync('claude plugin install hindsight-memory@hindsight', { timeout: 30_000 });
    } catch (e: unknown) {
      const err = e as { stderr?: string; message?: string };
      errors.push(err.stderr?.trim() || err.message || String(e));
    }

    // Run setup_hooks.py to register hooks
    if (errors.length === 0) {
      try {
        const cacheDir = nodePath.join(os.homedir(), '.claude', 'plugins', 'cache', 'hindsight', 'hindsight-memory');
        const versions = readdirSync(cacheDir).sort().reverse();
        if (versions.length > 0) {
          const setupScript = nodePath.join(cacheDir, versions[0]!, 'scripts', 'setup_hooks.py');
          if (existsSync(setupScript)) {
            await execAsync(`python3 "${setupScript}"`, { timeout: 15_000 });
          }
        }
      } catch (e: unknown) {
        const err = e as { stderr?: string; message?: string };
        errors.push(`Hook setup: ${err.stderr?.trim() || err.message || String(e)}`);
      }
    }

    if (errors.length > 0) {
      res.json({ ok: false, error: errors.join('; ') });
    } else {
      res.json({ ok: true });
    }
  });

  router.post('/memory/claude-code-reload-plugins', async (_req, res) => {
    try {
      const injected = await bridge.injectClaudeCodeCommand('/reload-plugins');
      res.json({ ok: true, sessions: injected.length });
    } catch (e: unknown) {
      const err = e as { message?: string };
      res.json({ ok: false, error: err.message ?? String(e) });
    }
  });

  // ── Codex plugin ──────────────────────────────────────────────────────────

  router.get('/memory/codex-status', (_req, res) => {
    const scriptsDir = nodePath.join(os.homedir(), '.hindsight', 'codex', 'scripts');
    const hooksFile = nodePath.join(os.homedir(), '.codex', 'hooks.json');
    const configToml = nodePath.join(os.homedir(), '.codex', 'config.toml');
    const userConfig = nodePath.join(os.homedir(), '.hindsight', 'codex.json');
    const settingsFile = nodePath.join(os.homedir(), '.hindsight', 'codex', 'settings.json');

    const scriptsInstalled = existsSync(nodePath.join(scriptsDir, 'recall.py'));
    const hooksConfigured = existsSync(hooksFile);
    let hooksEnabled = false;
    try {
      const toml = readFileSync(configToml, 'utf-8');
      hooksEnabled = /codex_hooks\s*=\s*true/.test(toml);
    } catch { /* no config.toml */ }

    let pluginVersion = '';
    try {
      const settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
      pluginVersion = settings.version ?? '';
    } catch { /* no settings */ }

    let userSettings: Record<string, unknown> = {};
    try {
      userSettings = JSON.parse(readFileSync(userConfig, 'utf-8'));
    } catch { /* no user config */ }

    res.json({
      installed: scriptsInstalled && hooksConfigured,
      hooksEnabled,
      pluginVersion,
      userConfig: userSettings,
    });
  });

  router.post('/memory/codex-setup', async (_req, res) => {
    try {
      const { stdout, stderr } = await execAsync(
        'curl -fsSL https://hindsight.vectorize.io/get-codex | bash -s -- --mode local',
        { timeout: 60_000, env: { ...process.env, TERM: 'dumb' } }
      );
      res.json({ ok: true, output: stdout + stderr });
    } catch (e: unknown) {
      const err = e as { message?: string; stderr?: string };
      res.json({ ok: false, error: err.stderr || err.message || String(e) });
    }
  });

  router.post('/memory/codex-uninstall', async (_req, res) => {
    try {
      await execAsync(
        'curl -fsSL https://hindsight.vectorize.io/get-codex | bash -s -- --uninstall',
        { timeout: 30_000 }
      );
      res.json({ ok: true });
    } catch (e: unknown) {
      const err = e as { message?: string };
      res.json({ ok: false, error: err.message || String(e) });
    }
  });

  router.post('/memory/ui', async (req, res) => {
    if (!memory.active) return res.json({ active: false, url: null });

    const browserHost = req.headers.host?.split(':')[0] ?? '127.0.0.1';
    const cfg = memory.getConfig();
    // Pass the daemon URL directly — control plane server-side can always reach it
    const url = await memory.startUi();
    if (!url) return res.json({ active: false, url: null });

    // Return URL using the same hostname the user is browsing with
    const uiUrl = `${req.protocol}://${browserHost}:${cfg.uiPort}`;
    res.json({ active: true, url: uiUrl });
  });

  // ── AI Features ──────────────────────────────────────────────────────────────

  router.get('/ai/config', (_req, res) => {
    res.json(ai.getConfig());
  });

  router.post('/ai/config', (req, res) => {
    const body = req.body as Record<string, unknown>;
    const cfg = ai.getConfig();

    ai.saveConfig({
      aiEnabled: body.aiEnabled !== undefined ? Boolean(body.aiEnabled) : cfg.aiEnabled,
      aiProvider: typeof body.aiProvider === 'string' && (body.aiProvider === 'claude-code' || body.aiProvider === 'codex')
        ? body.aiProvider : cfg.aiProvider,
      autoNaming: body.autoNaming !== undefined ? Boolean(body.autoNaming) : cfg.autoNaming,
      autoNamingIntervalSecs: typeof body.autoNamingIntervalSecs === 'number'
        ? body.autoNamingIntervalSecs : cfg.autoNamingIntervalSecs,
      claudeCommand: typeof body.claudeCommand === 'string' ? body.claudeCommand : cfg.claudeCommand,
    });

    ai.restart();
    res.json({ ok: true });
  });

  return router;
}
