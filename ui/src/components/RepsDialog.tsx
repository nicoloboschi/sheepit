import { useCallback, useEffect, useMemo, useState } from 'react';
import { Repeat, Play, FolderInput, RefreshCw } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import FloatingPanel from './FloatingPanel';
import * as sharedWs from '../sharedWs';
import { relativeTime } from '../utils';

/** One run, as `reps runs --json` reports it. Times are unix seconds. */
interface RepsRun {
  id: string;
  status: string;
  started?: number;
  ended?: number;
  sync?: string | null;
  error?: string | null;
  new_commits: boolean;
  summary: boolean;
}

/** One job, as `reps list --json` reports it. `error` alone means its JOB.md
 *  could not be read; the rest is then missing. */
interface RepsJob {
  name: string;
  dir: string;
  error?: string;
  every?: string | null;
  agent?: string;
  repo?: string | null;
  worktree?: string | null;
  scheduled?: boolean;
  running?: boolean;
  runs?: number;
  ok?: number;
  failed?: number;
  prompt?: string;
  last?: RepsRun | null;
  history?: RepsRun[];
}

interface RunDetail extends RepsRun {
  summary_text?: string | null;
  output?: string | null;
}

const POLL_MS = 5_000;

function statusColor(status: string | undefined): string {
  if (status === 'ok') return 'var(--success)';
  if (status === 'running') return 'var(--warning)';
  return 'var(--destructive)';
}

function Dot({ status }: { status?: string }) {
  return (
    <span
      title={status}
      style={{
        width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
        background: status ? statusColor(status) : 'transparent',
        border: status ? 'none' : '1px solid var(--muted-foreground)',
      }}
    />
  );
}

const ago = (secs?: number) => relativeTime(secs ? secs * 1000 : null) ?? '';
const took = (r: RepsRun) => r.started && r.ended ? `${((r.ended - r.started) / 60).toFixed(1)}m` : '';

const btn: React.CSSProperties = {
  display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 12, padding: '3px 9px',
  borderRadius: 5, border: '1px solid var(--border)', background: 'var(--accent)',
  color: 'var(--foreground)', cursor: 'pointer',
};

/**
 * reps — scheduled agent jobs (github.com/nicoloboschi/reps) — in a floating
 * panel: every job, how its runs went, and each run's summary and output.
 *
 * Read-only apart from two buttons: run now, and open the job's worktree in a
 * new pen, which is where its commits are and where the git tools can show
 * what the scheduled agent changed. Editing a job is editing its JOB.md, and
 * that pen is the place to do it.
 */
export default function RepsDialog({ onClose }: { onClose: () => void }) {
  const [jobs, setJobs] = useState<RepsJob[] | null>(null);
  const [installed, setInstalled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [jobName, setJobName] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), POLL_MS);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    let live = true;
    fetch('/api/reps').then(r => r.json()).then(d => {
      if (!live) return;
      setInstalled(d.installed !== false);
      setError(d.error ?? null);
      if (d.jobs) setJobs(d.jobs);
    }).catch(e => live && setError(String(e)));
    return () => { live = false; };
  }, [tick]);

  // First job selected by default, once the list arrives.
  useEffect(() => {
    if (!jobName && jobs?.[0]) setJobName(jobs[0].name);
  }, [jobs, jobName]);

  const job = jobs?.find(j => j.name === jobName) ?? null;

  // Newest first. `reps list` already carries every run, so no second call.
  const runs = useMemo(() => job?.history?.slice().reverse() ?? null, [job?.history]);

  // Newest run selected whenever the job changes.
  useEffect(() => { setRunId(null); setDetail(null); }, [jobName]);
  const shownRun = runId ?? runs?.[0]?.id ?? null;
  const shownStatus = runs?.find(r => r.id === shownRun)?.status;

  useEffect(() => {
    if (!jobName || !shownRun) return;
    let live = true;
    fetch(`/api/reps/${encodeURIComponent(jobName)}/runs/${encodeURIComponent(shownRun)}`)
      .then(r => r.json())
      .then(d => { if (live && !d.error) setDetail({ ...d, summary_text: d.summary }); })
      .catch(() => {});
    return () => { live = false; };
    // A finished run never changes, so only a running one is re-read on the tick.
  }, [jobName, shownRun, shownStatus === 'running' ? tick : 0]);

  const runNow = useCallback(() => {
    if (!jobName) return;
    fetch(`/api/reps/${encodeURIComponent(jobName)}/run`, { method: 'POST' })
      .then(() => setTimeout(() => setTick(n => n + 1), 800));
  }, [jobName]);

  const openPen = useCallback((path: string) => {
    sharedWs.send({ type: 'create_session', path });
  }, []);

  const body = !installed ? (
    <div style={{ padding: 24, fontSize: 13, color: 'var(--muted-foreground)', lineHeight: 1.6 }}>
      reps is not installed. It runs coding agents on a schedule, each job in its own worktree.
      <pre style={{ marginTop: 10, fontSize: 12, color: 'var(--foreground)' }}>
        curl -fsSL https://raw.githubusercontent.com/nicoloboschi/reps/main/install.sh | sh
      </pre>
    </div>
  ) : !jobs ? (
    <div style={{ padding: 24, fontSize: 13, color: error ? 'var(--destructive)' : 'var(--muted-foreground)' }}>
      {error ?? 'Loading…'}
    </div>
  ) : !jobs.length ? (
    <div style={{ padding: 24, fontSize: 13, color: 'var(--muted-foreground)' }}>
      No jobs yet. Ask an agent to schedule one, or add <code>~/.reps/jobs/&lt;name&gt;/JOB.md</code>.
    </div>
  ) : (
    <div style={{ display: 'flex', height: '100%', minHeight: 0 }}>
      <div style={{ width: 200, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto' }}>
        {jobs?.map(j => (
          <button
            key={j.name}
            onClick={() => setJobName(j.name)}
            style={{
              display: 'block', width: '100%', textAlign: 'left', padding: '8px 12px',
              background: j.name === jobName ? 'var(--accent)' : 'none', border: 'none',
              borderBottom: '1px solid var(--border)', cursor: 'pointer', color: 'var(--foreground)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 13 }}>
              <Dot status={j.error ? 'error' : j.running ? 'running' : j.last?.status} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.name}</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--muted-foreground)', marginTop: 2, paddingLeft: 14 }}>
              {j.error ? 'broken JOB.md'
                : `${j.every ? `every ${j.every}` : 'by hand'}${j.every && !j.scheduled ? ' · not installed' : ''}`
                  + (j.last ? ` · ${ago(j.last.started)}` : ' · never ran')}
            </div>
          </button>
        ))}
        {error && <div style={{ padding: 12, fontSize: 12, color: 'var(--destructive)' }}>{error}</div>}
      </div>

      {job && (
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 14, fontWeight: 600 }}>{job.name}</span>
              <span style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>
                {job.runs ?? 0} {job.runs === 1 ? 'run' : 'runs'} · {job.ok ?? 0} ok · {job.failed ?? 0} failed
              </span>
              <div style={{ flex: 1 }} />
              <button style={btn} onClick={runNow} disabled={!!job.running || !!job.error}
                title={job.running ? 'A run is going' : 'Run now'}>
                {job.running ? <RefreshCw size={12} className="animate-spin" /> : <Play size={12} />}
                {job.running ? 'Running' : 'Run now'}
              </button>
              <button style={btn} onClick={() => openPen(job.worktree ?? job.dir)}
                title={job.worktree ? `Open ${job.worktree} in a new pen` : `Open ${job.dir} in a new pen`}>
                <FolderInput size={12} /> {job.worktree ? 'Open worktree' : 'Open job folder'}
              </button>
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--muted-foreground)', marginTop: 4, fontFamily: 'var(--font-mono, monospace)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={job.error ?? job.agent}>
              {job.error ?? `${job.repo ?? job.dir} · ${job.agent}`}
            </div>
          </div>

          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <div style={{ width: 210, flexShrink: 0, borderRight: '1px solid var(--border)', overflowY: 'auto' }}>
              {!runs?.length && (
                <div style={{ padding: 12, fontSize: 12, color: 'var(--muted-foreground)' }}>No runs yet.</div>
              )}
              {runs?.map(r => (
                <button
                  key={r.id}
                  onClick={() => setRunId(r.id)}
                  title={r.error ?? r.sync ?? ''}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 7, width: '100%', textAlign: 'left',
                    padding: '6px 10px', fontSize: 12, border: 'none', cursor: 'pointer',
                    background: r.id === shownRun ? 'var(--accent)' : 'none', color: 'var(--foreground)',
                  }}
                >
                  <Dot status={r.status} />
                  <span style={{ flex: 1 }}>{ago(r.started) || r.id}</span>
                  {r.new_commits && <span style={{ color: 'var(--primary)', fontSize: 11 }} title="New commits">+</span>}
                  <span style={{ color: 'var(--muted-foreground)', fontSize: 11 }}>{r.status === 'ok' ? took(r) : r.status}</span>
                </button>
              ))}
            </div>

            <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: '10px 14px' }}>
              {detail && detail.id === shownRun ? <>
                {(detail.error || detail.sync) && (
                  <div style={{ fontSize: 12, color: detail.error ? 'var(--destructive)' : 'var(--muted-foreground)', marginBottom: 8 }}>
                    {detail.error ?? detail.sync}
                  </div>
                )}
                {detail.summary_text ? (
                  <div className="md-preview" style={{ fontSize: 13, lineHeight: 1.6 }}>
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.summary_text}</ReactMarkdown>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, color: 'var(--muted-foreground)', fontStyle: 'italic' }}>
                    {detail.status === 'running' ? 'Running — the summary is written at the end.' : 'No summary was written.'}
                  </div>
                )}
                {detail.output && (
                  <details style={{ marginTop: 12 }} open={!detail.summary_text}>
                    <summary style={{ fontSize: 12, cursor: 'pointer', color: 'var(--muted-foreground)' }}>Output</summary>
                    <pre style={{ fontSize: 11.5, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', marginTop: 6 }}>
                      {detail.output}
                    </pre>
                  </details>
                )}
              </> : shownRun ? (
                <div style={{ fontSize: 12, color: 'var(--muted-foreground)' }}>Loading…</div>
              ) : job.prompt ? (
                <div className="md-preview" style={{ fontSize: 13, lineHeight: 1.6 }}>
                  <ReactMarkdown remarkPlugins={[remarkGfm]}>{job.prompt}</ReactMarkdown>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <FloatingPanel
      title="Reps"
      icon={<Repeat size={13} style={{ color: 'var(--primary)' }} />}
      onClose={onClose}
      width={900}
      height={560}
      minWidth={620}
      minHeight={320}
    >
      {body}
    </FloatingPanel>
  );
}
