/**
 * A short-lived record of every agent hook that reached this server.
 *
 * Why it exists: the hook path is the one part of sheepit with no feedback of
 * any kind. `report-state.mjs` and `post.sh` both exit 0 and print nothing by
 * design — a hook that talks back corrupts the session it is watching — so a
 * hook that never fires, never resolves its session, or posts to a pane that
 * has already gone looks exactly like a hook that worked. The only trace was
 * `logger.info('agent-state ...')` in DirectBridge, which fires *after* the
 * report has been accepted and only when the state actually moved: it can tell
 * you a report landed, never that one was rejected or missing.
 *
 * So this sits at the edge, in front of that: it records what arrived, from
 * which agent, for which event, and — the part that matters — what happened to
 * it. Diagnosing "the plugin never fires when X" is then a matter of looking
 * for X's event and finding nothing, which is a different and much faster
 * conclusion than "something in the chain is broken".
 *
 * It is deliberately in memory only. This is a debugging window, not a record:
 * an hour is long enough to still be looking at the turn that surprised you,
 * and short enough that nothing about it needs to be written to disk, pruned
 * on startup or reasoned about across restarts.
 */

/** How long an entry stays visible. Long enough to cover "I noticed something
 *  odd a while ago and went to look", which is when anyone actually opens
 *  this. Matches AGENT_STATE_TTL_MS by coincidence, not by dependency. */
const RETENTION_MS = 60 * 60_000;

/** Hard ceiling, so a runaway agent cannot turn an hour into a heap problem.
 *  Reached only by something pathological: a tool-heavy turn posts two pings
 *  per tool call, and consecutive identical ones collapse (see `count`). */
const MAX_ENTRIES = 1000;

/** What became of a hook once we had it.
 *
 *  `unknown-session` and `unresolved` are the two that are otherwise
 *  completely silent, and between them they cover every "the plugin is
 *  installed but nothing lights up" report so far: the pane closed under a
 *  turn still in flight, or the hook could not work out which pane it was in
 *  because SHEEPIT_SESSION_ID was absent and the ancestry walk came up empty. */
export type HookOutcome = 'ok' | 'unknown-session' | 'unresolved' | 'rejected';

export interface HookTraceEntry {
  /** Most recent occurrence. Sort key, and what the retention window is
   *  measured against — a ping that keeps repeating stays visible. */
  at: number;
  /** First occurrence of a run of identical hooks, so a collapsed row still
   *  says when it started. Equal to `at` for a row that happened once. */
  firstAt: number;
  /** How many identical hooks in a row this row stands for. */
  count: number;
  /** Which endpoint it hit: `agent-state`, `cleared`, `fresh`, `resolve`. */
  endpoint: string;
  /** The session it was about, once known. Null when resolution failed —
   *  which is itself the finding. */
  sessionId: string | null;
  /** Which agent reported, as the hook itself claimed: `claude`, `codex`, … */
  source: string | null;
  /** The agent's own name for the event (`Stop`, `PermissionRequest`, …).
   *  The whole point of recording it verbatim rather than normalising it is
   *  that the two agents do not name the same moments the same way, and the
   *  gaps between their vocabularies are exactly the bugs. */
  event: string | null;
  /** The state being reported, for agent-state. */
  state: string | null;
  /** Which halves of the exchange this hook carried: `prompt`, `response`,
   *  `prompt+response`, or null for none.
   *
   *  Not a detail. Session naming is driven entirely by these two strings and
   *  by nothing else — no turn, no name — so "the pane lights up but never
   *  gets named" and "the pane never lights up" are separate faults with
   *  separate causes, and this column is what tells them apart at a glance. */
  turn: string | null;
  /** PR/issue references this hook carried, e.g. `pr#322`. The pane bar's PR
   *  number comes from these and from nothing else now that no one scrapes the
   *  terminal, so a bar with no PR on it is answered here: either the hooks
   *  never carried one, or they did and it was rejected. */
  refs: string | null;
  outcome: HookOutcome;
  /** Free text for the outcome — the rejection reason, or the ancestry that
   *  failed to resolve. Absent when there is nothing to add. */
  detail?: string;
}

const entries: HookTraceEntry[] = [];

/** Would these two rows be indistinguishable to a reader? Used to collapse the
 *  per-tool-call ping, which arrives dozens of times a turn saying the same
 *  thing and would otherwise push everything interesting out of the window. */
function sameShape(a: HookTraceEntry, b: Omit<HookTraceEntry, 'at' | 'firstAt' | 'count'>): boolean {
  return a.endpoint === b.endpoint
    && a.sessionId === b.sessionId
    && a.source === b.source
    && a.event === b.event
    && a.state === b.state
    && a.turn === b.turn
    && a.refs === b.refs
    && a.outcome === b.outcome
    && a.detail === b.detail;
}

function prune(now: number): void {
  while (entries.length && now - entries[0]!.at > RETENTION_MS) entries.shift();
  while (entries.length > MAX_ENTRIES) entries.shift();
}

/**
 * Record one hook.
 *
 * Called from the request handlers rather than from DirectBridge on purpose:
 * a hook that is rejected never reaches the bridge, and those are the ones
 * worth having.
 *
 * Must never throw — it runs inside the handler for a request the agent is
 * blocked on.
 */
export function recordHook(entry: Omit<HookTraceEntry, 'at' | 'firstAt' | 'count'>): void {
  try {
    const now = Date.now();
    const last = entries[entries.length - 1];
    if (last && sameShape(last, entry)) {
      last.at = now;
      last.count++;
      return;
    }
    entries.push({ ...entry, at: now, firstAt: now, count: 1 });
    prune(now);
  } catch { /* a trace that breaks a hook is worse than no trace */ }
}

/** Everything still inside the window, oldest first.
 *
 *  Pruned on read as well as on write: a server nobody is talking to stops
 *  recording, and stale rows would otherwise sit there looking current. */
export function hookTrace(): HookTraceEntry[] {
  prune(Date.now());
  return entries.slice();
}

/** Retention, so the client can say how far back it is looking without
 *  hardcoding the same hour in two places. */
export const HOOK_TRACE_RETENTION_MS = RETENTION_MS;
