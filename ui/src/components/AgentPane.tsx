import { useCallback, useState } from 'react';
import { Bot, Copy, Check, RefreshCw, Link2, ExternalLink, FileText, Info, Gauge, MessageSquare } from 'lucide-react';
import { externalClick } from '../openExternal';
import { usePoll } from '../hooks/usePoll';
import { usePaneOnScreen } from '../store';
import { copyText } from '../utils';

/**
 * What the agent in this pane has been asked to do.
 *
 * The pane bar says what a pane *is*; ⌘K finds which pane a thing is in; the
 * hook trace says a turn happened without saying what was in it. None of them
 * answer "what have I asked this one to do?", which is the question you have
 * when you come back to a pane after an hour — and the answer is already on
 * disk, in the agent's own transcript.
 *
 * Your prompts only. Both agents file them in the same row type they use for
 * tool results, background notifications and injected preambles, and the noise
 * outnumbers the signal roughly fifty to one — the filtering is in
 * `src/agent-info.ts`, and `rowsScanned` beside the count is what makes a wrong
 * filter visible here rather than silent.
 */

interface AgentLink { url: string; kind: 'url' | 'file'; from: 'me' | 'agent'; at: number | null }
interface AgentPrompt { text: string; at: number | null; kind: 'prompt' | 'command' }
interface AgentContext { used: number; limit?: number; input?: number; cacheRead?: number; cacheWrite?: number; output?: number }
interface AgentRateLimit { usedPercent: number; windowMinutes?: number; resetsAt?: number }
interface AgentInfo {
  agent: 'claude' | 'codex' | 'pi' | null;
  agentSessionId?: string;
  title?: string;
  model?: string;
  cwd?: string;
  version?: string;
  gitBranch?: string;
  context?: AgentContext;
  serving?: string;
  effort?: string;
  approvalPolicy?: string;
  sandboxPolicy?: string;
  rateLimits?: { primary?: AgentRateLimit; secondary?: AgentRateLimit };
  costUsd?: number;
  turns?: number;
  firstAt?: number | null;
  lastAt?: number | null;
  transcriptPath: string;
  transcriptBytes: number;
  rowsScanned: number;
  prompts: AgentPrompt[];
  links: AgentLink[];
  truncated: boolean;
}

const AGENT_LABEL: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi' };

/** What the session has cost, when the agent prices its own turns — Pi does,
 *  and the other two record no money anywhere this can read. Cents matter at
 *  the start of a session and stop mattering at a dollar, so the precision
 *  follows the number rather than being fixed. */
const money = (n: number): string => n < 1 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`;

function when(at: number | null): string {
  if (!at) return '';
  const d = new Date(at);
  const sameDay = new Date().toDateString() === d.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' +
      d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1e6).toFixed(2)}M`
  : n >= 1000 ? `${Math.round(n / 1000)}k`
  : String(n);

/** Minutes to the words a limit window is actually described in. */
const window_ = (m?: number): string =>
  !m ? '' : m % 1440 === 0 ? `${m / 1440}d` : m % 60 === 0 ? `${m / 60}h` : `${m}m`;

const bytes = (n: number): string =>
  n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="agent-fact">
      <span className="agent-fact-k">{label}</span>
      <span className="agent-fact-v" title={value}>{value}</span>
    </div>
  );
}

/**
 * How full the context is.
 *
 * **A percentage when the agent says how big its window is, a count when it
 * does not** — and that asymmetry is on purpose, because the agents are.
 * Codex records `model_context_window`, so its panes get a bar and a percent.
 * Claude Code records no window size anywhere its transcript can be read from,
 * so its panes get the count alone. Filling in 200k to have something to divide
 * by would report a real 1M session holding 952k tokens as 476% full, which is
 * worse than saying nothing.
 */
function Context({ ctx }: { ctx: AgentContext }) {
  const pct = ctx.limit ? Math.min(100, (ctx.used / ctx.limit) * 100) : null;
  return (
    <div className="agent-ctx">
      <div className="agent-ctx-head">
        <span>Context</span>
        <b>{tokens(ctx.used)}</b>
        {ctx.limit
          ? <span className="agent-dim">of {tokens(ctx.limit)} · {pct!.toFixed(0)}%</span>
          : <span className="agent-dim" title="This agent does not record its window size, so there is nothing to divide by.">window not reported</span>}
      </div>
      {pct !== null && (
        <div className="agent-bar"><div className="agent-bar-fill" style={{ width: `${pct}%` }} /></div>
      )}
      {/* The split matters: on a long session the cache read IS the context —
          a 950k conversation reports 2 fresh input tokens. Seeing one number
          without the other makes a full window look empty. */}
      <div className="agent-ctx-parts">
        {ctx.input !== undefined && <span>{tokens(ctx.input)} fresh</span>}
        {ctx.cacheRead !== undefined && <span>{tokens(ctx.cacheRead)} cached</span>}
        {ctx.cacheWrite !== undefined && ctx.cacheWrite > 0 && <span>{tokens(ctx.cacheWrite)} written</span>}
        {ctx.output !== undefined && <span>{tokens(ctx.output)} out</span>}
      </div>
    </div>
  );
}

function Limit({ label, rl }: { label: string; rl: AgentRateLimit }) {
  const resets = rl.resetsAt ? new Date(rl.resetsAt) : null;
  return (
    <div className="agent-fact">
      <span className="agent-fact-k">{label}</span>
      <span className="agent-fact-v">
        {rl.usedPercent.toFixed(0)}% used
        {rl.windowMinutes ? ` · per ${window_(rl.windowMinutes)}` : ''}
        {resets ? ` · resets ${when(resets.getTime())}` : ''}
      </span>
    </div>
  );
}

function Prompt({ p }: { p: AgentPrompt }) {
  // A pasted essay is a legitimate prompt, so the long ones open rather than
  // being cut off for ever — but they open on a click, because a list where
  // every entry is forty lines is not a list you can scan.
  const [open, setOpen] = useState(false);
  const long = p.text.length > 220 || p.text.includes('\n');
  return (
    <li className={`agent-prompt${p.kind === 'command' ? ' agent-prompt-cmd' : ''}`}>
      <div className="agent-prompt-head">
        <span className="agent-prompt-time">{when(p.at)}</span>
        {long && (
          <button className="agent-prompt-more" onClick={() => setOpen(o => !o)}>
            {open ? 'less' : 'more'}
          </button>
        )}
      </div>
      <div className={`agent-prompt-text${open ? ' agent-prompt-open' : ''}`}>{p.text}</div>
    </li>
  );
}

/**
 * One thing that was pointed at, and where it opens.
 *
 * A url leaves for the user's own browser. A **path opens in the app-wide Files
 * panel**, on the same `sheepit:open-file` channel a path clicked in the
 * terminal uses — these are mostly files the agent made somewhere else (an
 * export under `~/Downloads`, a scratchpad under `/tmp`), which is exactly the
 * case the panel exists for and not something the pane's own repository view
 * can show.
 */
function LinkRow({ l }: { l: AgentLink }) {
  const file = l.kind === 'file';
  // A path is shown whole — which file it is, is the end of it, and shortening
  // one to its basename hides that two exports with the same name are in
  // different directories. A url drops only its scheme: twenty rows of
  // `https://` is twenty rows of the same eight characters.
  const label = file ? l.url : l.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const open = (e: React.MouseEvent) => {
    e.preventDefault();
    window.dispatchEvent(new CustomEvent('sheepit:open-file', { detail: { path: l.url, line: null } }));
  };
  return (
    <li className={`agent-link agent-link-${l.from}`}>
      <span className="agent-link-from" title={l.from === 'me' ? 'You sent this' : 'The agent sent this'}>
        {l.from === 'me' ? 'you' : 'agent'}
      </span>
      <a href={file ? undefined : l.url} onClick={file ? open : externalClick(l.url)} title={l.url}>{label}</a>
      {/* When it was shared — same clock as the prompts, so "this is the export
          from this morning" is answerable without opening anything. */}
      <span className="agent-link-time">{when(l.at)}</span>
      {file
        ? <FileText size={9} className="agent-link-out" />
        : <ExternalLink size={9} className="agent-link-out" />}
    </li>
  );
}

export default function AgentPane({ sessionId }: { sessionId: string }) {
  const [info, setInfo] = useState<AgentInfo | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/agent`);
      if (!res.ok) { setError(`HTTP ${res.status}`); return; }
      const data = await res.json();
      setError(null);
      setInfo(data);
    } catch (e) {
      setError(String(e));
    }
  }, [sessionId]);

  // Every sheep in a pen stays mounted, so without the gate this polls for
  // panes nobody can see. The server answers from a cache keyed on the
  // transcript's mtime, so a poll on an idle pane costs a stat.
  usePoll(load, 5000, sessionId, usePaneOnScreen(sessionId));

  const copyAll = useCallback(() => {
    if (!info) return;
    copyText(info.prompts.map(p => p.text).join('\n\n'));
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  }, [info]);

  if (error) {
    return (
      <div className="agent-pane agent-pane-empty">
        <p>{error}</p>
        <button className="agent-retry" onClick={() => { setError(null); void load(); }}>
          <RefreshCw size={11} /> Retry
        </button>
      </div>
    );
  }

  if (info === undefined) return <div className="agent-pane agent-pane-empty"><p>Reading…</p></div>;

  // null is a real answer, not a failure: a plain shell has no agent, and a
  // fresh pane has no transcript yet. Saying so beats an empty list, which
  // would claim the agent had been asked nothing.
  if (info === null) {
    return (
      <div className="agent-pane agent-pane-empty">
        <Bot size={20} />
        <p>No agent transcript for this pane.</p>
        <p className="agent-dim">A shell has none, and an agent gets one on its first turn.</p>
        {/* Hermes is the one agent that genuinely never gets one: it keeps its
            conversation in a SQLite state.db rather than in a JSONL, so there
            is nothing here to read however long it runs. */}
        <p className="agent-dim">Hermes keeps its own in a database, so it has none either.</p>
      </div>
    );
  }

  return (
    <div className="agent-pane">
      <div className="agent-head">
        <Bot size={13} />
        <b>{AGENT_LABEL[info.agent ?? ''] ?? 'Agent'}</b>
        {info.model && <span className="agent-model">{info.model}</span>}
        <button className="agent-copy" onClick={copyAll} title="Copy every prompt" disabled={!info.prompts.length}>
          {copied ? <Check size={11} /> : <Copy size={11} />}
        </button>
      </div>

      {info.context && <Context ctx={info.context} />}

      {/* Every list in this half gets a band, including the facts — three
          headed sections and one unheaded one reads as the facts belonging to
          whatever is above them. */}
      <div className="agent-section"><Info size={11} /> Session</div>

      <div className="agent-facts">
        {info.title && <Row label="Title" value={info.title} />}
        {info.gitBranch && <Row label="Branch" value={info.gitBranch} />}
        {info.cwd && <Row label="Directory" value={info.cwd} />}
        {info.turns !== undefined && <Row label="Turns" value={String(info.turns)} />}
        {info.costUsd !== undefined && <Row label="Cost" value={money(info.costUsd)} />}
        {info.effort && <Row label="Effort" value={info.effort} />}
        {info.serving && <Row label="Serving" value={info.serving} />}
        {info.approvalPolicy && <Row label="Approval" value={info.approvalPolicy} />}
        {info.sandboxPolicy && <Row label="Sandbox" value={info.sandboxPolicy} />}
        {info.lastAt && <Row label="Last asked" value={when(info.lastAt)} />}
        {info.version && <Row label="Version" value={info.version} />}
        {info.agentSessionId && <Row label="Session" value={info.agentSessionId} />}
        <Row label="Transcript" value={`${bytes(info.transcriptBytes)} · ${info.rowsScanned.toLocaleString()} rows`} />
      </div>

      {info.rateLimits && (
        <>
          <div className="agent-section"><Gauge size={11} /> Plan</div>
          <div className="agent-facts">
            {info.rateLimits.primary && <Limit label="Short window" rl={info.rateLimits.primary} />}
            {info.rateLimits.secondary && <Limit label="Long window" rl={info.rateLimits.secondary} />}
          </div>
        </>
      )}

      {!!info.links?.length && (
        <>
          <div className="agent-section">
            <Link2 size={11} /> Links &amp; files
            <span className="agent-count">{info.links.length}</span>
          </div>
          {/* Newest first, same as the prompts: the link you want is almost
              always the last one either of you pasted. */}
          <ul className="agent-links">
            {[...info.links].reverse().map(l => <LinkRow key={l.url} l={l} />)}
          </ul>
        </>
      )}

      <div className="agent-section">
        <MessageSquare size={11} /> You asked
        <span className="agent-count">{info.prompts.length}</span>
        {info.truncated && <span className="agent-dim"> (capped)</span>}
      </div>

      {info.prompts.length === 0 ? (
        <p className="agent-dim agent-pad">Nothing typed in this session yet.</p>
      ) : (
        // Newest first: the reason to open this is almost always the last thing
        // you said, not the first.
        <ul className="agent-prompts">
          {[...info.prompts].reverse().map((p, i) => <Prompt key={i} p={p} />)}
        </ul>
      )}
    </div>
  );
}
