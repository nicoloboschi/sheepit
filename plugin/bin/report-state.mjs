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
import { readFileSync } from 'fs';
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

    let agentSessionId;
    try { agentSessionId = JSON.parse(raw).session_id; } catch { /* optional */ }

    await post(
      `${base}/api/sessions/${encodeURIComponent(sessionId)}/agent-state`,
      { state: STATE, source: SOURCE, agentSessionId },
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
