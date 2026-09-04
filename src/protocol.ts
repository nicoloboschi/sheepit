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
  /** A background-only session. It stays running but is not presented as a workspace. */
  isHeadless?: boolean;
}

export type BridgeMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'output'; data: string }
  /** A session's busy flag flipped. Was a `preview` message carrying two
   *  decoded lines of output; nothing rendered the text, and the signal is the
   *  agent's hooks firing rather than bytes moving. */
  | { type: 'activity'; session_id: string; busy: boolean }
  | { type: 'current_input'; session_id: string; input: string }
  /** The app in the PTY asked for the user's attention (OSC 9) — for coding
   *  agents this is emitted when a turn completes. */
  | { type: 'attention'; session_id: string; message: string }
  /** Preference keys just written by some client, echoed to all of them so no
   *  browser goes on editing the profile it read when it started. Carries the
   *  patch, not the profile, and the `origin` of the tab that wrote it — which
   *  is how that tab ignores its own echo. */
  | { type: 'preferences'; values: Record<string, string>; origin?: string };
