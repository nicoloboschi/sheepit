import { useState, useCallback, useEffect } from 'react';
import { usePoll } from './usePoll';

export interface GitStatus {
  branch: string;
  dirty: boolean;
  detached: boolean;
  ahead: number;
  behind: number;
}

export interface GitRoot {
  [sessionId: string]: string | null;
}

export interface Worktree {
  path: string;
  branch?: string;
}

export interface GithubPR {
  prUrl?: string;
  prNum?: number;
  prState?: 'OPEN' | 'MERGED' | 'CLOSED';
  prChecks?: 'PASS' | 'FAIL' | 'PENDING' | null;
  prReviewDecision?: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  repoUrl?: string;
  /** Owner and repo parsed from the remote. Used to build a link for a
   *  reference the agent reported as a bare number, which has nowhere else to
   *  learn which repository it belongs to. */
  owner?: string;
  repo?: string;
  /** The branch `gh pr view` answered for. */
  branch?: string;
}

/** GET a JSON endpoint, or null if it is unreachable or unhappy. Every one of
 *  these polls decorates the UI, so a failure means "show nothing", never an
 *  error state. */
async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? (await res.json() as T) : null;
  } catch {
    return null;
  }
}

export function useGit(sessionId: string | null, intervalMs = 5000): GitStatus | null {
  const [git, setGit] = useState<GitStatus | null>(null);

  usePoll(useCallback(async () => {
    if (!sessionId) { setGit(null); return; }
    const data = await getJson<GitStatus>(`/api/git/${encodeURIComponent(sessionId)}`);
    if (data) setGit(data);
  }, [sessionId]), intervalMs, sessionId);

  return git;
}

export function useGitRoots(intervalMs = 15000): GitRoot | null {
  const [roots, setRoots] = useState<GitRoot | null>(null);

  usePoll(useCallback(async () => {
    const data = await getJson<GitRoot>('/api/sessions/git-roots');
    if (data) setRoots(data);
  }, []), intervalMs);

  return roots;
}

export function useWorktrees(sessionId: string | null, intervalMs = 10000): [Worktree[] | null, () => Promise<void>] {
  const [data, setData] = useState<Worktree[] | null>(null);

  const fetchData = useCallback(async () => {
    if (!sessionId) { setData(null); return; }
    const res = await getJson<Worktree[]>(`/api/git/${encodeURIComponent(sessionId)}/worktrees`);
    if (res) setData(res);
  }, [sessionId]);

  useEffect(() => { setData(null); }, [sessionId]);
  usePoll(fetchData, intervalMs, sessionId);

  return [data, fetchData];
}

export function useGithubPR(sessionId: string | null, intervalMs = 30000): GithubPR | null {
  const [data, setData] = useState<GithubPR | null>(null);

  const fetchData = useCallback(async () => {
    if (!sessionId) { setData(null); return; }
    const res = await getJson<GithubPR>(`/api/git/${encodeURIComponent(sessionId)}/github`);
    if (res) setData(res);
  }, [sessionId]);

  useEffect(() => { setData(null); }, [sessionId]);
  usePoll(fetchData, intervalMs, sessionId);

  return data;
}
