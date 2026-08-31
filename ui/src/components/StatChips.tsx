import React, { useState } from 'react';
import { GitBranch, GitCommitHorizontal, GitPullRequest, CircleDot, Github, GitFork, Loader2, CircleCheck, CircleX, Clock, ListTree } from 'lucide-react';
import { useStats } from '../hooks/useStats';
import { useGit, useGithubPR, type GitStatus, type GithubPR } from '../hooks/useGit';
import useStore from '../store';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';

// ── Types ────────────────────────────────────────────────────────────────────

// GitStatus and GithubPR come from the hooks that fetch them (../hooks/useGit).
// They used to be declared again here and the fetched values cast to the
// copies, so the endpoint could grow a field the component could not see —
// which is exactly what happened to `owner`/`repo`.

export interface StatsProcess {
  pid: number;
  name: string;
  cpu_percent: number;
  mem_mb: number;
}

export interface Stats {
  cpu_percent: number;
  mem_percent: number;
  mem_used_gb: number;
  processes?: StatsProcess[];
}

// ── ProcessList popover ───────────────────────────────────────────────────────

interface CpuBarProps {
  pct: number;
}

function CpuBar({ pct }: CpuBarProps): React.ReactElement {
  const w: number = Math.min(100, pct);
  const color: string = pct > 95 ? 'var(--destructive)' : pct > 80 ? 'var(--warning)' : 'var(--primary)';
  return (
    <div style={{ width: 48, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', flexShrink: 0 }}>
      <div style={{ width: `${w}%`, height: '100%', borderRadius: 2, background: color, transition: 'width 0.4s ease' }} />
    </div>
  );
}

interface ProcessListProps {
  processes: StatsProcess[] | null;
  sessionId: string;
}

function ProcessList({ processes, sessionId }: ProcessListProps): React.ReactElement {
  const [killing, setKilling] = useState<number | null>(null);

  if (!processes || processes.length === 0) {
    return (
      <div style={{ padding: '20px 16px', textAlign: 'center', fontSize: 12, color: 'var(--muted-foreground)', opacity: 0.6 }}>
        No child processes
      </div>
    );
  }

  const sorted = [...processes].sort((a, b) => b.cpu_percent - a.cpu_percent);

  async function handleKill(pid: number): Promise<void> {
    setKilling(pid);
    try {
      await fetch(`/api/stats/process/${pid}?session_id=${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
    } finally {
      setKilling(null);
    }
  }

  return (
    <div style={{ minWidth: 300 }}>
      {/* Header */}
      <div style={{
        display: 'grid', gridTemplateColumns: '1fr 56px 48px 52px 36px',
        gap: 8, padding: '8px 14px 6px',
        fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em',
        color: 'var(--muted-foreground)', opacity: 0.6,
        borderBottom: '1px solid var(--border)',
      }}>
        <span>Name</span>
        <span style={{ textAlign: 'right' }}>CPU</span>
        <span style={{ textAlign: 'right' }}>Mem</span>
        <span style={{ textAlign: 'right' }}>PID</span>
        <span />
      </div>

      {/* Rows */}
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {sorted.map((p, i) => (
          <div key={p.pid} style={{
            display: 'grid', gridTemplateColumns: '1fr 56px 48px 52px 36px',
            gap: 8, padding: '5px 14px',
            alignItems: 'center',
            background: i % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.025)',
          }}>
            {/* Name */}
            <span style={{
              fontFamily: '"JetBrains Mono",monospace',
              color: 'var(--foreground)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 11,
            }}>
              {p.name}
            </span>

            {/* CPU */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, justifyContent: 'flex-end' }}>
              <CpuBar pct={p.cpu_percent} />
              <span style={{
                fontFamily: '"JetBrains Mono",monospace',
                fontSize: 10, minWidth: 30, textAlign: 'right',
                color: p.cpu_percent > 95 ? 'var(--destructive)' : p.cpu_percent > 80 ? 'var(--warning)' : 'var(--muted-foreground)',
              }}>
                {p.cpu_percent.toFixed(0)}%
              </span>
            </div>

            {/* Mem */}
            <span style={{
              fontFamily: '"JetBrains Mono",monospace',
              fontSize: 10, textAlign: 'right', color: 'var(--muted-foreground)',
            }}>
              {p.mem_mb >= 1024
                ? `${(p.mem_mb / 1024).toFixed(1)}G`
                : `${p.mem_mb.toFixed(0)}M`}
            </span>

            {/* PID */}
            <span style={{
              fontFamily: '"JetBrains Mono",monospace',
              fontSize: 10, textAlign: 'right', opacity: 0.4,
              color: 'var(--muted-foreground)',
            }}>
              {p.pid}
            </span>

            {/* Kill */}
            <button
              onClick={() => handleKill(p.pid)}
              disabled={killing === p.pid}
              title={`Kill ${p.name} (${p.pid})`}
              style={{
                fontFamily: '"JetBrains Mono",monospace',
                fontSize: 9, fontWeight: 700, letterSpacing: '0.04em',
                padding: '2px 5px', borderRadius: 3,
                background: 'none', border: '1px solid transparent',
                cursor: killing === p.pid ? 'wait' : 'pointer',
                color: '#E0907B', opacity: killing === p.pid ? 0.4 : 0.65,
                flexShrink: 0, transition: 'opacity 0.15s, border-color 0.15s, background 0.15s',
              }}
              onMouseEnter={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.borderColor = '#E0907B'; e.currentTarget.style.background = 'rgba(224, 144, 123,0.1)'; }}
              onMouseLeave={(e: React.MouseEvent<HTMLElement>) => { e.currentTarget.style.opacity = '0.65'; e.currentTarget.style.borderColor = 'transparent'; e.currentTarget.style.background = 'none'; }}
            >
              KILL
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── GitHub references ─────────────────────────────────────────────────────────

/** Split a PR/issue URL back into `owner/repo`, for the popover's subtitle. */
const GH_REF_RE = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\/(\d+)/;

/** A PR or issue the agent's hooks reported for this pane (Session.prRefs),
 *  or the one `gh` found for the branch. Newest first. */
interface PrRef {
  kind: 'pr' | 'issue';
  num: number;
  url?: string;
  repo?: string;
}

/** Where a reference can be opened, for one that arrived without a URL — a
 *  bare `#42` in a prompt, or a `gh pr view 42` command line. GitHub redirects
 *  /pull/<n> to the issue when the number is an issue, so one shape serves. */
function refUrl(ref: PrRef, repo: string | null): string | null {
  if (ref.url) return ref.url;
  const owner = ref.repo ?? repo;
  return owner ? `https://github.com/${owner}/${ref.kind === 'issue' ? 'issues' : 'pull'}/${ref.num}` : null;
}

// ── GitChip ───────────────────────────────────────────────────────────────────

interface GitDetailsProps {
  git: GitStatus;
  github: GithubPR | null;
  sessionId: string;
  send: (msg: Record<string, unknown>) => void;
  /** What the agent's hooks reported for this pane, newest first. */
  refs?: PrRef[];
}

function GitDetails({ git, github, sessionId, send, refs = [] }: GitDetailsProps): React.ReactElement {
  const Icon = git.detached ? GitCommitHorizontal : GitBranch;
  const branchColor: string = git.dirty ? '#D9B84A' : '#9CBC7F';
  const [wtLoading, setWtLoading] = useState<boolean>(false);
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtAdding, setWtAdding] = useState<boolean>(false);
  const [wtName, setWtName] = useState<string>('');

  async function createWorktree(name: string): Promise<void> {
    if (!name.trim()) return;
    setWtLoading(true);
    setWtError(null);
    try {
      const res = await fetch(`/api/git/${encodeURIComponent(sessionId)}/worktree`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setWtError(data.error ?? 'Failed'); return; }
      send({ type: 'create_session', path: data.path });
      setWtAdding(false);
      setWtName('');
    } catch (e) {
      setWtError(String(e));
    } finally {
      setWtLoading(false);
    }
  }

  // What the agent touched, then the PR of the branch it is on. The first is
  // reported by the hooks and is right even when the branch has no PR of its
  // own; the second is what `gh pr view` resolves, and is the only one that
  // carries state and check results.
  const repo = github?.owner && github?.repo ? `${github.owner}/${github.repo}` : null;
  const allRefs: PrRef[] = [...refs];
  if (github?.prNum && !allRefs.some(r => r.num === github.prNum)) {
    allRefs.push({ kind: 'pr', num: github.prNum, url: github.prUrl ?? undefined, repo: repo ?? undefined });
  }

  return (
    <div style={{ minWidth: 240, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <Icon size={13} style={{ color: branchColor, flexShrink: 0 }} />
        <span style={{ fontSize: 13, fontFamily: '"JetBrains Mono",monospace', color: branchColor, fontWeight: 600 }}>
          {git.branch}
        </span>
        {git.detached && (
          <span style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.6 }}>detached</span>
        )}
        {github?.repoUrl && allRefs.length === 0 && (
          <a
            href={github.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e: React.MouseEvent<HTMLElement>) => e.stopPropagation()}
            title="Open repository on GitHub"
            style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto', color: 'var(--muted-foreground)', textDecoration: 'none', fontSize: 11, flexShrink: 0 }}
            className="hover:text-foreground"
          >
            <Github size={12} />
          </a>
        )}
      </div>
      {/* Pull requests and issues */}
      {allRefs.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {allRefs.map(pr => {
            const href = refUrl(pr, repo);
            // Only ever the reference's OWN repository. `href` may have been
            // built from the pane's repo as a fallback, and labelling a
            // reference with a repository it never claimed is a confident lie
            // — `gh pr view 3730 --repo other/repo` would read as ours.
            const m = pr.url?.match(GH_REF_RE);
            const refRepo = pr.repo ?? (m ? `${m[1]}/${m[2]}` : '');
            // Show state/checks for the PR that matches the github hook
            const isHookPr = github?.prNum === pr.num;
            const prState = isHookPr ? github?.prState : null;
            const prStateColor = prState === 'MERGED' ? '#B79CCA' : prState === 'CLOSED' ? '#E0907B' : '#9CBC7F';
            const checks = isHookPr ? github?.prChecks : null;
            const review = isHookPr ? github?.prReviewDecision : null;
            return (
              <a
                key={`${pr.kind}${pr.num}`}
                href={href ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e: React.MouseEvent<HTMLElement>) => e.stopPropagation()}
                style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  textDecoration: 'none', padding: '3px 4px', borderRadius: 4,
                }}
                className="hover:bg-white/5"
              >
                {pr.kind === 'issue'
                  ? <CircleDot size={11} style={{ color: prStateColor, flexShrink: 0 }} />
                  : <GitPullRequest size={11} style={{ color: prStateColor, flexShrink: 0 }} />}
                <span style={{ fontSize: 12, fontWeight: 700, color: prStateColor, fontFamily: '"JetBrains Mono",monospace' }}>
                  #{pr.num}
                </span>
                {prState && (
                  <span style={{ fontSize: 9, color: prStateColor, textTransform: 'lowercase' }}>
                    {prState}
                  </span>
                )}
                {checks && (() => {
                  const CheckIcon = checks === 'PASS' ? CircleCheck : checks === 'FAIL' ? CircleX : Clock;
                  const checkColor = checks === 'PASS' ? '#9CBC7F' : checks === 'FAIL' ? '#E0907B' : '#D9B84A';
                  return <CheckIcon size={10} strokeWidth={2.5} style={{ color: checkColor, flexShrink: 0 }} />;
                })()}
                {review && (
                  <span style={{ fontSize: 9, color: review === 'APPROVED' ? '#9CBC7F' : review === 'CHANGES_REQUESTED' ? '#E0907B' : '#D9B84A' }}>
                    {review === 'APPROVED' ? 'approved' : review === 'CHANGES_REQUESTED' ? 'changes requested' : 'review needed'}
                  </span>
                )}
                {refRepo && (
                  <span style={{ fontSize: 10, color: 'var(--muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginLeft: 'auto' }}>
                    {refRepo}
                  </span>
                )}
              </a>
            );
          })}
        </div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 11, color: 'var(--muted-foreground)' }}>
        <Row label="Status" value={git.dirty ? 'Uncommitted changes' : 'Clean'} color={git.dirty ? '#D9B84A' : '#9CBC7F'} />
        {git.ahead > 0  && <Row label="Ahead"  value={`${git.ahead} commit${git.ahead  > 1 ? 's' : ''}`} color="#9CBC7F" />}
        {git.behind > 0 && <Row label="Behind" value={`${git.behind} commit${git.behind > 1 ? 's' : ''}`} color="#E0907B" />}
        {git.ahead === 0 && git.behind === 0 && !git.detached && (
          <Row label="Remote" value="Up to date" color="var(--muted-foreground)" />
        )}
      </div>
      <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 2 }}>
          <span style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.06em', opacity: 0.65, display: 'flex', alignItems: 'center', gap: 4 }}>
            <GitFork size={9} /> Worktrees
          </span>
          {wtAdding ? (
            <input
              autoFocus
              value={wtName}
              onChange={(e) => setWtName(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === 'Enter') createWorktree(wtName);
                if (e.key === 'Escape') { setWtAdding(false); setWtName(''); setWtError(null); }
              }}
              placeholder="branch name…"
              disabled={wtLoading}
              style={{
                width: 150, fontSize: 11, padding: '2px 6px',
                background: 'var(--input)', border: '1px solid var(--ring)', borderRadius: 3,
                color: 'var(--foreground)', fontFamily: '"JetBrains Mono",monospace', outline: 'none',
              }}
            />
          ) : (
            <button
              onClick={(e) => { e.stopPropagation(); setWtError(null); setWtAdding(true); }}
              disabled={wtLoading}
              title="Create new worktree"
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                width: 18, height: 18, background: 'none', border: '1px solid var(--border)',
                borderRadius: 3, cursor: wtLoading ? 'default' : 'pointer',
                color: 'var(--muted-foreground)', opacity: wtLoading ? 0.5 : 1, flexShrink: 0,
              }}
              className="hover:bg-white/5 hover:text-foreground"
            >
              {wtLoading ? <Loader2 size={10} className="animate-spin" /> : <span style={{ fontSize: 14, lineHeight: 1, marginTop: -1 }}>+</span>}
            </button>
          )}
        </div>
        {wtError && <span style={{ fontSize: 10, color: '#E0907B' }}>{wtError}</span>}
      </div>
    </div>
  );
}

interface RowProps {
  label: string;
  value: string;
  color: string;
}

function Row({ label, value, color }: RowProps): React.ReactElement {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ opacity: 0.6 }}>{label}</span>
      <span style={{ fontFamily: '"JetBrains Mono",monospace', color }}>{value}</span>
    </div>
  );
}

interface GitChipProps {
  sessionId: string;
  send: (msg: Record<string, unknown>) => void;
}

const NO_REFS: PrRef[] = [];

function GitChip({ sessionId, send }: GitChipProps): React.ReactElement | null {
  const git = useGit(sessionId);
  const github = useGithubPR(sessionId);
  // Reported by the agent's hooks and carried on the session itself — see
  // src/pr-refs.ts. This used to be scraped out of the pane's own output in
  // the browser, which meant a PR the agent had opened vanished on reload and
  // was never seen at all if its URL wrapped.
  const refs = useStore(s => s.sessionMap[sessionId]?.prRefs ?? NO_REFS) as PrRef[];
  if (!git) return null;

  const branchColor: string = git.dirty ? '#D9B84A' : '#9CBC7F';
  // The most recent thing the agent touched wins the bar; the branch's own PR
  // stands in when it has touched nothing. Most-recent rather than
  // highest-numbered: a session that has just checked out #3672 is about
  // #3672, whatever else it read along the way.
  const topPr: PrRef | null = refs[0]
    ?? (github?.prNum ? { kind: 'pr', num: github.prNum, url: github.prUrl ?? undefined } : null);
  const extraCount = Math.max(0, refs.length - 1);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          style={{
            display: 'flex', alignItems: 'center', gap: 3,
            background: 'none', border: 'none', cursor: 'pointer',
            padding: '1px 4px', borderRadius: 4,
            lineHeight: 1,
          }}
          className="hover:bg-white/5"
          title="Git info"
        >
          {/* The branch NAME is gone from the bar, and with it ahead/behind.
              It was the only arbitrary-length string up here, so it set the
              chip's width — and a long one squeezed the pane's title, which
              matters more. The full branch, its counts and everything else
              are one click away in the popover this icon opens, and the icon
              still carries the dirty signal in its colour. The pen card in
              the sidebar keeps the branch too. */}
          <GitBranch size={11} style={{ color: branchColor, flexShrink: 0 }} />
          {topPr && topPr.num > 0 && (() => {
            // State and checks come from `gh pr view`, which answers for the
            // branch. They belong to this number only when the two agree —
            // otherwise the bar would paint one PR's checks onto another's.
            const isBranchPr = github?.prNum === topPr.num;
            const prState = isBranchPr ? github?.prState : null;
            const prColor = prState === 'MERGED' ? '#B79CCA' : prState === 'CLOSED' ? '#E0907B' : '#9CBC7F';
            const checks = isBranchPr ? github?.prChecks : null;
            const CheckIcon = checks === 'PASS' ? CircleCheck : checks === 'FAIL' ? CircleX : checks === 'PENDING' ? Clock : null;
            const checkColor = checks === 'PASS' ? '#9CBC7F' : checks === 'FAIL' ? '#E0907B' : '#D9B84A';
            const RefIcon = topPr.kind === 'issue' ? CircleDot : GitPullRequest;
            return (
              <span style={{ display: 'flex', alignItems: 'center', gap: 2, fontSize: 9, color: prColor }}>
                <RefIcon size={8} strokeWidth={2} />#{topPr.num}
                {CheckIcon && <CheckIcon size={7} strokeWidth={2.5} style={{ color: checkColor }} />}
                {extraCount > 0 && (
                  <span style={{ fontSize: 8, opacity: 0.7 }}>+{extraCount}</span>
                )}
              </span>
            );
          })()}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="end">
        <GitDetails git={git} github={github} sessionId={sessionId} send={send} refs={refs} />
      </PopoverContent>
    </Popover>
  );
}

// ── StatChips ─────────────────────────────────────────────────────────────────

interface StatChipsProps {
  sessionId: string;
  send: (msg: Record<string, unknown>) => void;
}

export default function StatChips({ sessionId, send }: StatChipsProps): React.ReactElement {
  // The bar only needs to know *whether* this pane has children, to decide if
  // the handle is worth drawing — a fact that changes when you start or finish
  // a command, not several times a second. The live figures are in the
  // popover, so that is the only time worth paying for a fast poll.
  const [open, setOpen] = useState(false);
  const stats = useStats(sessionId, open ? 2000 : 20000) as Stats | null;

  // The pane's own child processes (not system-wide). Still polled, because
  // the popover lists them and lets you kill one; the totals are no longer
  // summarised in the bar.
  const processes: StatsProcess[] | null = stats?.processes ?? null;
  const procCount: number | null = processes?.length ?? null;

  // The bar itself does not report CPU / memory — the pane bar is for identity
  // (name, branch, PR, cwd), not telemetry. The process list is still a real
  // tool (you can kill a runaway child), so it keeps a single quiet handle
  // here, shown only when there is actually something behind it.
  //
  // A list of every URL seen in the pane used to hang off the same handle. It
  // was built by scanning the output in the browser, which the agents defeat
  // by wrapping and redrawing their own text, and it was gone on reload. What
  // anyone actually wanted out of it — the PR — is on the git chip, reported
  // by the agent's hooks.
  const hasProcesses = (procCount ?? 0) > 0;
  if (!hasProcesses) {
    return (
      <div className="stat-chips">
        <GitChip sessionId={sessionId} send={send} />
      </div>
    );
  }

  const label = `${procCount} process${procCount === 1 ? '' : 'es'}`;

  return (
    <div className="stat-chips">
      <GitChip sessionId={sessionId} send={send} />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button className="pane-bar-more" title={`This sheep: ${label}`}>
            <ListTree size={12} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start">
          <div style={{ minWidth: 300, display: 'flex', flexDirection: 'column', gap: 0 }}>
            <ProcessList processes={processes} sessionId={sessionId} />
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
