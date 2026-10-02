/**
 * Wire types shared by the PTY bridge and the WebSocket server.
 *
 * These outlived the tmux bridge they were declared in: that implementation
 * was replaced by DirectBridge and deleted, but its message and session shapes
 * are the protocol the UI still speaks.
 */

export interface Session {
  id: string;
  name: string;
  path: string;
  username: string;
  last_activity: number;
  busy: boolean;
  isClaudeCode?: boolean;
  isCodex?: boolean;
  isOpencode?: boolean;
  /** Hermes — the harness the sheepdog runs in. See src/sheepdog.ts. */
  isHermes?: boolean;
  /** Pi — the pi coding agent. */
  isPi?: boolean;
  /** This pane IS the sheepdog. It is drawn as a dog, and it is never
   *  counted as a sheep. */
  isDog?: boolean;
  isAntigravity?: boolean;
  isCopilot?: boolean;
  isGrok?: boolean;
  isCursor?: boolean;
  /** Aggregate CPU % of all child processes */
  cpuPercent?: number;
  /** Aggregate RSS memory in MB of all child processes */
  memMb?: number;
  /** Git common dir — shared across worktrees of the same repo */
  gitRoot?: string;
  /** Current git branch */
  gitBranch?: string;
  /** Whether the working tree has uncommitted changes */
  gitDirty?: boolean;
  /** PR number if one exists for the current branch */
  prNum?: number;
  /** PR state: OPEN, MERGED, CLOSED */
  prState?: string;
  /** PR URL */
  prUrl?: string;
  /** PR/issue references the agent's hooks reported for THIS session, newest
   *  first — see pr-refs.ts. Distinct from prNum above, which belongs to the
   *  session's branch: a session can work on a PR that its branch knows
   *  nothing about. */
  prRefs?: { kind: 'pr' | 'issue'; num: number; url?: string; repo?: string }[];
  /** How many tokens the agent's context holds right now, read from its own
   *  transcript. Absent for a pane with no agent, or one that has not replied
   *  yet. It is what is *used*, not what fits. */
  ctxTokens?: number;
  /** The model's context window, when the agent records it — Codex writes
   *  `model_context_window`, Claude Code writes no window size anywhere. Its
   *  presence is what lets a pane show a percentage instead of a count; its
   *  absence means we do not know, never that there is no limit. */
  ctxLimit?: number;
  /** A background-only session: a scratch terminal that stays running but
   *  never gets a pen. Shown in the Terminals panel, or — when `sideOf` names
   *  a pane — in that pane's own Terminals split. */
  isHeadless?: boolean;
  /** Set on a **side terminal**: the id of the pane it was opened beside. Such
   *  a shell is headless (it gets no pen) but belongs to one pane, runs in that
   *  pane's directory, and is closed with it. Absent on the global scratch
   *  shells, which is what tells the two apart. */
  sideOf?: string;
}

/** How many **side terminals** one pane may hold — the shells in its own
 *  Terminals split. Four for the same reason as the panel below, and capped
 *  per pane rather than globally: twenty panes with four apiece would be
 *  eighty shells, so the cost has to be bounded where it is incurred. */
export const MAX_SIDE_TERMINALS = 4;

/** How many *global* scratch terminals may exist at once (the ones with no
 *  `sideOf`, shown in the Terminals panel).
 *
 *  Four, because that is what the Terminals panel can tile and still leave
 *  each one readable — a scratch shell is something you glance at, and eight
 *  postage stamps is not a glance. There was exactly one before it was a
 *  panel, which was not enough to run a build in and tail a log beside it.
 *
 *  Enforced on the server (see `create_session`), which is the only place that
 *  can count them without racing. */
export const MAX_HEADLESS = 4;

export type BridgeMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'output'; data: string }
  /** A session's busy flag flipped. Was a `preview` message carrying two
   *  decoded lines of output; nothing rendered the text, and the signal is the
   *  agent's hooks firing rather than bytes moving. */
  | { type: 'activity'; session_id: string; busy: boolean }
  /** The app in the PTY asked for the user's attention (OSC 9) — for coding
   *  agents this is emitted when a turn completes. */
  | { type: 'attention'; session_id: string; message: string }
  /** Preference keys just written by some client, echoed to all of them so no
   *  browser goes on editing the profile it read when it started. Carries the
   *  patch, not the profile, and the `origin` of the tab that wrote it — which
   *  is how that tab ignores its own echo. */
  | { type: 'preferences'; values: Record<string, string>; origin?: string };
