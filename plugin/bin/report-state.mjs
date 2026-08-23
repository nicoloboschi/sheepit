#!/usr/bin/env node
/**
 * Report this agent's state to the vipershell session that owns the terminal.
 *
 * Invoked by ../hooks/hooks.json with the state as argv[2]; the hook payload
 * arrives on stdin as JSON.
 *
 * Design rules, in order of importance:
 *
 *  1. Never break the agent. Every path exits 0 and prints nothing. A hook
 *     that errors or writes stray output corrupts the session it is meant to
 *     be observing, while a missed report only costs a fallback to
 *     vipershell's output heuristics.
 *  2. Never hang. Hooks run on the agent's critical path, so requests are
 *     time-bounded and abandoned.
 *  3. Stay agent-agnostic. Nothing here is Claude-specific beyond the stdin
 *     shape, so Codex can invoke the same script.
 */
// .mjs, not .js, on purpose: this file is ESM inside the vipershell package
// (which is "type": "module") but would be treated as CommonJS once
// `claude plugin install` copies it into ~/.claude/plugins/cache, where no
// package.json applies. The explicit extension makes it ESM in both places.
import { execFileSync } from 'child_process';
import { readFileSync, openSync, fstatSync, readSync, closeSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STATE = process.argv[2];
const SOURCE = process.env.VIPERSHELL_AGENT_SOURCE || 'claude';
const TIMEOUT_MS = 3000;

function done() { process.exit(0); }
if (!STATE) done();

/** Where the server said it is listening (written at startup). */
function discoverBaseUrl() {
  if (process.env.VIPERSHELL_URL) return process.env.VIPERSHELL_URL;
  for (const dir of ['vipershell', 'sheepit']) {
    try {
      const raw = readFileSync(join(homedir(), '.config', dir, 'server.json'), 'utf8');
      const url = JSON.parse(raw).url;
      if (url) return url;
    } catch { /* try the next one */ }
  }
  return null;
}

/** Our process ancestry, nearest first: hook -> agent -> ... -> session shell.
 *
 *  Only walked when VIPERSHELL_SESSION_ID is absent, which is the case for
 *  panes created before vipershell seeded it. Bounded because a cycle or a
 *  reparent would otherwise spin, and `ps` is cheap but not free. */
function ancestorPids() {
  const pids = [];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    pids.push(pid);
    try {
      const out = execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 1000 });
      const parent = parseInt(String(out).trim(), 10);
      if (!Number.isInteger(parent) || parent === pid) break;
      pid = parent;
    } catch { break; }
  }
  return pids;
}


/** Longest prompt/response we forward. Enough to name a session by; short
 *  enough that the naming model is cheap and the request never becomes the
 *  slow part of a hook. */
const MAX_TURN_CHARS = 2000;

/** Last assistant reply in a Claude Code transcript.
 *
 *  Read from the tail rather than the whole file: transcripts grow without
 *  bound and this runs on the agent's critical path. Sidechain rows are
 *  skipped — those belong to subagents, and naming a session after what a
 *  subagent happened to say last would be actively misleading. */
function lastAssistantText(transcriptPath) {
  let fd;
  try {
    fd = openSync(transcriptPath, 'r');
    const size = fstatSync(fd).size;
    const want = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(want);
    readSync(fd, buf, 0, want, size - want);

    const lines = buf.toString('utf8').split('\n');
    // A partial first line is expected when we started mid-file.
    if (size > want) lines.shift();

    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row.type !== 'assistant' || row.isSidechain === true) continue;
      const content = row.message?.content;
      const text = Array.isArray(content)
        ? content.filter(b => b?.type === 'text').map(b => b.text).join('\n')
        : typeof content === 'string' ? content : '';
      if (text.trim()) return text.trim().slice(0, MAX_TURN_CHARS);
    }
  } catch {
    // No transcript, unreadable, or a shape we do not recognise — naming just
    // falls back to whatever it had.
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* ignore */ } }
  }
  return undefined;
}

async function post(url, body, signal) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

async function run(raw) {
  const baseUrl = discoverBaseUrl();
  // Not running under a vipershell server — the normal case for an agent in a
  // plain terminal. Must be silent.
  if (!baseUrl) return;
  const base = baseUrl.replace(/\/+$/, '');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let sessionId = process.env.VIPERSHELL_SESSION_ID;
    if (!sessionId) {
      const res = await post(`${base}/api/sessions/resolve`, { pids: ancestorPids() }, controller.signal);
      if (!res.ok) return;
      sessionId = (await res.json()).sessionId;
      if (!sessionId) return;
    }

    let payload = {};
    try { payload = JSON.parse(raw) ?? {}; } catch { /* optional */ }

    // Carry the actual interaction so the server can name the session from
    // what was asked and answered, instead of scraping the TUI. The prompt is
    // handed to us directly; the reply has to come from the transcript.
    const prompt = typeof payload.prompt === 'string'
      ? payload.prompt.trim().slice(0, MAX_TURN_CHARS)
      : undefined;
    const response = STATE === 'idle' && payload.transcript_path
      ? lastAssistantText(payload.transcript_path)
      : undefined;

    await post(
      `${base}/api/sessions/${encodeURIComponent(sessionId)}/agent-state`,
      { state: STATE, source: SOURCE, agentSessionId: payload.session_id, prompt, response },
      controller.signal,
    );
  } catch {
    // Server down, restarting, or slow — heuristics take over.
  } finally {
    clearTimeout(timer);
  }
}

let raw = '';
let finished = false;
const finish = () => { if (!finished) { finished = true; run(raw).finally(done); } };
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', finish);
process.stdin.on('error', finish);
// stdin may never arrive if a caller does not pipe anything.
setTimeout(finish, 500).unref();
