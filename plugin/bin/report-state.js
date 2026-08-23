#!/usr/bin/env node
/**
 * Report this agent's state to the vipershell session that owns the terminal.
 *
 * Invoked by the hooks in ../hooks/hooks.json with the state as argv[2]. The
 * hook payload arrives on stdin as JSON; we only need it for `session_id`,
 * which is passed through for debugging — the vipershell session is identified
 * by VIPERSHELL_SESSION_ID, exported into the shell when the pane was created.
 *
 * Design rules, in order of importance:
 *
 *  1. Never break the agent. Every failure path exits 0 and prints nothing to
 *     stdout. A hook that errors or writes stray output interferes with the
 *     session it is supposed to be observing, and a missed report only costs
 *     us a fallback to vipershell's output heuristics.
 *  2. Never hang. Hooks run on the agent's critical path, so the request is
 *     given a short timeout and abandoned.
 *  3. Stay agent-agnostic. Nothing here is Claude-specific beyond the stdin
 *     shape; Codex is expected to invoke the same script.
 */
'use strict';

const STATE = process.argv[2];
const SOURCE = process.env.VIPERSHELL_AGENT_SOURCE || 'claude';
const TIMEOUT_MS = 3000;

function done() { process.exit(0); }

const sessionId = process.env.VIPERSHELL_SESSION_ID;
const baseUrl = process.env.VIPERSHELL_URL;

// Not running inside a vipershell pane (or an older server that does not
// export these) — nothing to report to. This is the normal case for an agent
// started from a plain terminal, so it must be silent.
if (!sessionId || !baseUrl || !STATE) done();

// Read stdin so the hook protocol sees it consumed, but do not depend on it:
// a payload we cannot parse is not a reason to skip the report.
let raw = '';
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('error', done);
process.stdin.on('end', () => {
  let agentSessionId;
  try { agentSessionId = JSON.parse(raw).session_id; } catch { /* optional */ }

  const body = JSON.stringify({ state: STATE, source: SOURCE, agentSessionId });
  const url = `${baseUrl.replace(/\/+$/, '')}/api/sessions/${encodeURIComponent(sessionId)}/agent-state`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: controller.signal,
  })
    .catch(() => { /* server down or restarting — heuristics take over */ })
    .finally(() => { clearTimeout(timer); done(); });
});

// stdin may never arrive (a caller that does not pipe anything); do not wait
// forever on it.
setTimeout(() => process.stdin.emit('end'), 500).unref?.();
