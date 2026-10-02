/**
 * Report this Pi session's state to the sheepit pane that owns the terminal.
 *
 * Pi has no hook system — no `hooks.json`, no subprocess per event — so this
 * is the same job as `plugin/bin/report-state.mjs` done from inside the agent
 * instead of beside it. It is a Pi *extension*: a module Pi loads at startup
 * and calls back on its own lifecycle events.
 *
 * In-process changes what the rules are, and both directions matter:
 *
 *  - There is nothing to spawn, so the per-tool-call ping costs a function
 *    call rather than the ~25ms interpreter start that `post.sh` exists to
 *    avoid. The whole reason that file is POSIX sh does not apply here.
 *  - **A handler is awaited by the agent.** Pi awaits event handlers in order,
 *    so anything slow here is latency in somebody's turn. Nothing in this file
 *    is ever awaited: every POST is fire-and-forget with its rejection
 *    swallowed, which is the in-process spelling of post.sh backgrounding its
 *    curl.
 *  - **A throw here lands in the agent**, not in a subprocess nobody reads. So
 *    every handler is wrapped and every path returns undefined — an event
 *    handler that returns a value is how an extension changes Pi's behaviour,
 *    and this one must never change anything.
 *
 * It reports the states sheepit knows (`busy`, `idle`, `waiting`, `unknown`)
 * through the same agent-agnostic endpoint the other two agents post to, as
 * `source: "pi"` — so the hook trace, the pane's activity dot, the session
 * name and ⌘K all work the way they do for Claude Code, with no server-side
 * knowledge of Pi beyond reading its transcript.
 *
 * @typedef {import("@earendil-works/pi-coding-agent").ExtensionAPI} ExtensionAPI
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Matches report-state.mjs: long enough to name a session by, short enough
 *  that the request is never the slow part. */
const MAX_TURN_CHARS = 2000;
/** A tool result can be a whole file. Bounded before anything scans it. */
const MAX_SCAN_CHARS = 64 * 1024;
const TIMEOUT_MS = 3000;

/** The PR/issue shapes `post.sh` greps out of a tool call, as one regex.
 *  A bare `#42` is deliberately absent: in a tool result it is far more often
 *  a colour, a comment or a line number than a pull request. The server reads
 *  that form from the turn text, where a person wrote it. */
const REF_RE =
  /https?:\/\/(?:www\.)?github\.com\/[\w.-]+\/[\w.-]+\/(?:pull|issues)\/\d+|gh (?:pr|issue) [a-z-]+ #?\d+|--repo[= ][\w.-]+\/[\w.-]+/g;

/** Where the server said it is listening (written at startup). Read once:
 *  a session outliving a server restart keeps the same port. */
let baseUrl;
function serverUrl() {
  if (baseUrl !== undefined) return baseUrl;
  baseUrl = process.env.SHEEPIT_URL || null;
  if (!baseUrl) {
    try {
      baseUrl = JSON.parse(readFileSync(join(homedir(), ".config", "sheepit", "server.json"), "utf8")).url || null;
    } catch {
      // Not running under a sheepit server — the normal case for Pi in a
      // plain terminal, and it must be silent.
      baseUrl = null;
    }
  }
  if (baseUrl) baseUrl = baseUrl.replace(/\/+$/, "");
  return baseUrl;
}

/** Which pane we are in.
 *
 *  `SHEEPIT_SESSION_ID` is in the pane's shell environment, so it is simply
 *  inherited — but a pane created before sheepit seeded that variable has
 *  none, and starting Pi in it does not add one. So fall back to what the
 *  other reporter does: walk our own ancestry and let the server say which
 *  pane owns one of those pids.
 *
 *  Resolved lazily and remembered, including the failure: this is a dozen
 *  `ps` calls and a round trip, and it must not happen per tool call. */
let sessionId;
let resolving;
function paneId() {
  if (sessionId !== undefined) return Promise.resolve(sessionId);
  if (process.env.SHEEPIT_SESSION_ID) {
    sessionId = process.env.SHEEPIT_SESSION_ID;
    return Promise.resolve(sessionId);
  }
  const url = serverUrl();
  if (!url) { sessionId = null; return Promise.resolve(null); }
  // One in-flight resolve, however many events arrive while it is out.
  resolving ??= post(`${url}/api/sessions/resolve`, { pids: ancestorPids() })
    .then(res => (res && res.ok ? res.json() : null))
    .then(body => { sessionId = (body && body.sessionId) || null; return sessionId; })
    .catch(() => { sessionId = null; return null; });
  return resolving;
}

/** Our process ancestry, nearest first: pi -> the pane's shell -> … Bounded,
 *  because a reparent or a cycle would otherwise spin. */
function ancestorPids() {
  const pids = [process.pid];
  let pid = process.ppid;
  for (let i = 0; i < 12 && pid > 1; i++) {
    pids.push(pid);
    try {
      const parent = parseInt(String(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { timeout: 1000 })).trim(), 10);
      if (!Number.isInteger(parent) || parent === pid) break;
      pid = parent;
    } catch { break; }
  }
  return pids;
}

function post(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
}

const text = v => (typeof v === "string" ? v.trim().slice(0, MAX_TURN_CHARS) : undefined);

/** The text blocks of a Pi message, which is where anything anybody said is.
 *  Thinking and tool calls are deliberately not included. */
function saidText(message) {
  const content = message && message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n");
}

/** References out of a tool call, gated the way post.sh gates them: only from
 *  a call that was ABOUT a pull request. Without the gate, reading any file
 *  that merely contains a PR link — a changelog, a fixture — relabels the
 *  pane. */
function refsIn(value) {
  let raw;
  try { raw = typeof value === "string" ? value : JSON.stringify(value); } catch { return undefined; }
  if (!raw) return undefined;
  raw = raw.slice(0, MAX_SCAN_CHARS);
  if (!raw.includes("gh pr") && !raw.includes("gh issue")) return undefined;
  const found = raw.match(REF_RE);
  return found ? found.slice(0, 5) : undefined;
}

/**
 * Report a state. Never awaited by a caller, never throws, never prints.
 *
 * The transcript path and session id ride along on every report rather than
 * only on the first: sheepit uses them to search the conversation and to
 * describe the pane, and Pi can switch session (`/new`, `--resume`, a fork)
 * without anything here being told twice. `setAgentSession` on the server
 * ignores a report that says what it already knows.
 */
function report(ctx, state, extra) {
  const url = serverUrl();
  if (!url) return;
  void paneId().then(id => {
    if (!id) return;
    let transcriptPath, agentSessionId;
    try {
      transcriptPath = ctx && ctx.sessionManager && ctx.sessionManager.getSessionFile();
      agentSessionId = ctx && ctx.sessionManager && ctx.sessionManager.getSessionId();
    } catch { /* a session that has not been written yet has no file */ }
    return post(`${url}/api/sessions/${encodeURIComponent(id)}/agent-state`, {
      state, source: "pi", transcriptPath: transcriptPath || undefined,
      agentSessionId: agentSessionId || undefined, ...extra,
    });
  }).catch(() => { /* server down or restarting — the pane falls back */ });
}

/** Every handler goes through this: a throw inside an extension handler lands
 *  in the agent, and returning a value is how an extension changes Pi's
 *  behaviour. This does neither. */
const safe = fn => (event, ctx) => { try { fn(event, ctx); } catch { /* never break the agent */ } };

/** @param {ExtensionAPI} pi */
export default function (pi) {
  /** The last thing Pi said, so `idle` can carry the reply. Pi's settle event
   *  is notification-only and carries no message, and the transcript read the
   *  other reporter does would be a file read on the agent's own thread. */
  let lastSaid;

  // A new session, or one picked back up. `fresh` is what sheepit calls a pane
  // nothing has been asked of yet, and `cleared` is its own endpoint because
  // it also drops the pane's name — Pi's `new` is the `/clear` of the other
  // two agents, which is the one reason this is not a plain state report.
  pi.on("session_start", safe((event, ctx) => {
    lastSaid = undefined;
    const url = serverUrl();
    if (!url) return;
    const endpoint = event.reason === "new" ? "cleared" : "fresh";
    void paneId().then(id => { if (id) return post(`${url}/api/sessions/${encodeURIComponent(id)}/${endpoint}`, {}); })
      .catch(() => {});
    report(ctx, "idle", { event: `session_start:${event.reason}` });
  }));

  // The turn began. Claude Code's `UserPromptSubmit` and Codex's equivalent
  // both land here.
  pi.on("turn_start", safe((_event, ctx) => report(ctx, "busy", { event: "turn_start" })));

  // What was asked, and what was answered. Pi files both as messages, so this
  // one handler is both halves of the exchange sheepit names a pane from.
  pi.on("message_end", safe((event, ctx) => {
    const role = event.message && event.message.role;
    if (role === "user") {
      const prompt = text(saidText(event.message));
      if (prompt) report(ctx, "busy", { event: "message_end:user", prompt });
    } else if (role === "assistant") {
      const said = text(saidText(event.message));
      if (said) lastSaid = said;
    }
  }));

  // Still working. Free here — see the note at the top about what post.sh is
  // paying for and this is not.
  pi.on("tool_execution_start", safe((event, ctx) =>
    report(ctx, "busy", { event: "tool_execution_start", refs: refsIn(event.args) })));
  pi.on("tool_execution_end", safe((event, ctx) =>
    report(ctx, "busy", { event: "tool_execution_end", refs: refsIn(event.result) })));

  // **Pi's answer to "waiting on you"** — the one state Codex still cannot
  // report. Any prompt Pi puts up (an approval, a choice, an input) is a
  // question only the person can answer, which is exactly what a bleating
  // sheep means. Notification-only on Pi's side, so this cannot affect what
  // the person is being asked.
  pi.on("ui_prompt_start", safe((event, ctx) =>
    report(ctx, "waiting", { event: `ui_prompt_start:${event.kind}` })));
  // The question was answered. Back to busy if a turn is still running, idle
  // if it is not — `isIdle()` is Pi's own answer and beats guessing.
  pi.on("ui_prompt_end", safe((_event, ctx) =>
    report(ctx, ctx && ctx.isIdle && ctx.isIdle() ? "idle" : "busy", { event: "ui_prompt_end" })));

  // The turn is over and Pi will not continue by itself: the `Stop` of the
  // other two agents. `agent_end` is not it — automatic retries, recovery and
  // compaction can still follow one, and a pane that went quiet and then
  // started working again is the wrong notification twice.
  pi.on("agent_settled", safe((_event, ctx) => {
    report(ctx, "idle", { event: "agent_settled", response: lastSaid });
    lastSaid = undefined;
  }));

  // Pi is leaving. The pane keeps its shell, so the state is unknown rather
  // than idle — there is no longer an agent in there to be idle.
  pi.on("session_shutdown", safe((event, ctx) => {
    if (event.reason === "quit") report(ctx, "unknown", { event: "session_shutdown" });
  }));
}
