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
  /** A background-only session. It stays running but is not presented as a workspace. */
  isHeadless?: boolean;
}

export type BridgeMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'output'; data: string }
  | { type: 'preview'; session_id: string; preview: string; busy: boolean }
  | { type: 'current_input'; session_id: string; input: string }
  /** The app in the PTY asked for the user's attention (OSC 9) — for coding
   *  agents this is emitted when a turn completes. */
  | { type: 'attention'; session_id: string; message: string };
