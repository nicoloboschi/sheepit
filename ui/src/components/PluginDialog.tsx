import { useCallback, useEffect, useState } from 'react';
import { Loader2, RefreshCw, Check, X } from 'lucide-react';
import ClaudeIcon from './ClaudeIcon';
import OpenAIIcon from './OpenAIIcon';

interface AgentPluginState {
  available: boolean;
  installed: string | null;
}

interface PluginStatus {
  shipped: string | null;
  claude: AgentPluginState;
  codex: AgentPluginState;
}

interface HookTraceEntry {
  at: number;
  firstAt: number;
  count: number;
  endpoint: string;
  sessionId: string | null;
  source: string | null;
  event: string | null;
  state: string | null;
  turn: string | null;
  outcome: 'ok' | 'unknown-session' | 'unresolved' | 'rejected';
  detail?: string;
}

/** Colour by outcome, not by state: the question this list answers is whether
 *  the hook landed, and a perfectly ordinary `busy` that hit a dead pane is
 *  the interesting row, not the successful one. */
const OUTCOME_COLOR: Record<HookTraceEntry['outcome'], string> = {
  ok: 'var(--success)',
  'unknown-session': 'var(--warning)',
  unresolved: 'var(--destructive)',
  rejected: 'var(--destructive)',
};

function ago(ms: number): string {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h`;
}

/**
 * What has actually reached us, newest first.
 *
 * Read it for the gaps: both reporters are silent by design, so a hook that
 * was never wired and a hook that was wired and failed look identical from a
 * pane. Here they don't — one is a red row and the other is no row at all.
 */
function HookTrace() {
  const [entries, setEntries] = useState<HookTraceEntry[] | null>(null);
  const [retentionMs, setRetentionMs] = useState(3600_000);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/hook-trace');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const body = await r.json();
      setEntries(body.entries);
      setRetentionMs(body.retentionMs);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Polled, not pushed: this panel is open for seconds at a time and only
  // while someone is debugging, so a socket message type for it would cost
  // every client something to serve the one that asked.
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [load]);

  const rows = entries ? entries.slice().reverse() : [];

  return (
    <div className="mt-6">
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-semibold">Hook trace</h3>
        <button
          onClick={() => void load()}
          className="text-[11px] text-muted-foreground"
          style={{ cursor: 'pointer' }}
        >
          Refresh
        </button>
      </div>
      <p className="text-xs text-muted-foreground mb-3">
        Every hook that reached sheepit in the last {Math.round(retentionMs / 60000)} minutes, newest
        first. Identical hooks in a row are collapsed with a count. Both reporters exit silently on
        purpose, so this is the only place a hook that failed differs from one that never fired.
      </p>

      {error && <p className="text-[11px]" style={{ color: 'var(--destructive)' }}>{error}</p>}

      {!error && entries && rows.length === 0 && (
        <p className="text-[11px] text-muted-foreground">
          Nothing yet. Either no agent has run since the server started, or the plugin is not
          reaching us at all.
        </p>
      )}

      {rows.length > 0 && (
        <div
          className="rounded-md border overflow-auto"
          style={{ borderColor: 'var(--border)', background: 'var(--card)', maxHeight: 260 }}
        >
          {rows.map((e, i) => (
            <div
              key={`${e.firstAt}-${i}`}
              className="flex items-center gap-2 px-3 py-1.5 text-[11px]"
              style={{ borderTop: i ? '1px solid var(--border)' : undefined }}
            >
              <span
                className="shrink-0 rounded-full"
                style={{ width: 6, height: 6, background: OUTCOME_COLOR[e.outcome] }}
                title={e.outcome}
              />
              <span className="shrink-0 text-muted-foreground" style={{ width: 30 }}>{ago(e.at)}</span>
              <span className="shrink-0 font-semibold" style={{ width: 52 }}>{e.source ?? '—'}</span>
              <span className="shrink-0 truncate" style={{ width: 130 }}>{e.event ?? e.endpoint}</span>
              <span className="shrink-0 text-muted-foreground" style={{ width: 56 }}>{e.state ?? ''}</span>
              {/* Naming reads nothing but these two strings, so a column of
                  blanks here is the whole explanation for a session that
                  lights up correctly and is never renamed. */}
              <span
                className="shrink-0"
                style={{ width: 96, color: e.turn ? 'var(--primary)' : 'var(--muted-foreground)' }}
                title={e.turn ? 'carried the exchange sessions are named from' : undefined}
              >
                {e.turn ?? ''}
              </span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {e.outcome === 'ok' ? (e.sessionId ?? '') : `${e.outcome}${e.detail ? ` — ${e.detail}` : ''}`}
              </span>
              {e.count > 1 && (
                <span className="shrink-0 text-muted-foreground">×{e.count}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** One agent's row: is its CLI here, and what has it got installed. */
function AgentRow({
  label, icon, state, shipped,
}: {
  label: string;
  icon: React.ReactNode;
  state: AgentPluginState;
  shipped: string | null;
}) {
  const upToDate = !!state.installed && state.installed === shipped;
  const detail = !state.available
    ? 'not installed on this machine'
    : state.installed
      ? `plugin ${state.installed}${upToDate ? '' : ` — sheepit ships ${shipped ?? '?'}`}`
      : 'plugin not installed';

  return (
    <div
      className="flex items-center gap-3 rounded-md border px-3 py-2.5"
      style={{ borderColor: 'var(--border)', background: 'var(--card)' }}
    >
      <span className="grid place-items-center shrink-0" style={{ width: 18, height: 18 }}>{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold">{label}</div>
        <div className="text-[11px] text-muted-foreground truncate">{detail}</div>
      </div>
      {/* Three states worth distinguishing: current, present-but-behind, absent. */}
      {!state.available ? (
        <span className="text-[10px] text-muted-foreground shrink-0">—</span>
      ) : upToDate ? (
        <Check size={14} style={{ color: 'var(--success)', flexShrink: 0 }} />
      ) : (
        <X size={14} style={{ color: 'var(--warning)', flexShrink: 0 }} />
      )}
    </div>
  );
}

/** Settings → Plugin. What the agent-state plugin is, and a way to push the
 *  current code into the agents without inventing a version number. */
export function PluginContent() {
  const [status, setStatus] = useState<PluginStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/plugin');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus(await r.json());
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const reinstall = useCallback(async () => {
    setBusy(true); setError(null); setDone(false);
    try {
      // Shells out to `claude` and `codex`, each up to a minute, so this is
      // deliberately not given a short client-side timeout.
      const r = await fetch('/api/plugin/reinstall', { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setStatus(await r.json());
      setDone(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const anyAgent = !!status && (status.claude.available || status.codex.available);

  return (
    <div className="p-5">
      <h3 className="text-sm font-semibold mb-1">Agent plugin</h3>
      <p className="text-xs text-muted-foreground mb-4">
        Hooks that report each agent's state back to sheepit, so a sheep grazes while
        its agent works and settles the moment a turn ends. It also carries the prompt
        and reply that sessions get named from. Installed automatically when the
        bundled version changes.
      </p>

      {!status && !error && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 size={13} className="animate-spin" /> Checking…
        </div>
      )}

      {status && (
        <div className="flex flex-col gap-2">
          <AgentRow
            label="Claude Code"
            icon={<ClaudeIcon size={16} />}
            state={status.claude}
            shipped={status.shipped}
          />
          <AgentRow
            label="Codex"
            icon={<OpenAIIcon size={15} />}
            state={status.codex}
            shipped={status.shipped}
          />
        </div>
      )}

      {status && (
        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={() => void reinstall()}
            disabled={busy || !anyAgent}
            className="flex items-center gap-2 rounded-md border px-3 py-2 text-xs"
            style={{
              borderColor: 'var(--border)',
              background: busy || !anyAgent ? 'var(--card)' : 'var(--accent)',
              color: busy || !anyAgent ? 'var(--muted-foreground)' : 'var(--foreground)',
              cursor: busy || !anyAgent ? 'default' : 'pointer',
            }}
          >
            {busy
              ? <><Loader2 size={13} className="animate-spin" /> Reinstalling…</>
              : <><RefreshCw size={13} /> Reinstall from this build</>}
          </button>
          <span className="text-[11px] text-muted-foreground">
            sheepit ships {status.shipped ?? '?'}
          </span>
        </div>
      )}

      {!anyAgent && status && (
        <p className="mt-3 text-[11px] text-muted-foreground">
          Neither <code>claude</code> nor <code>codex</code> is on this machine's PATH, so
          there is nothing to install into.
        </p>
      )}

      {done && !error && (
        // The trap worth naming: both agents read their hooks once, at
        // startup. Reinstalling changes nothing for a session already running.
        <p
          className="mt-4 rounded-md border px-3 py-2.5 text-[11px]"
          style={{
            borderColor: 'color-mix(in srgb, var(--warning) 45%, transparent)',
            background: 'color-mix(in srgb, var(--warning) 10%, transparent)',
          }}
        >
          Reinstalled. <strong>Agents already running keep the old hooks</strong> — both
          Claude Code and Codex read them once, when they start. Restart the agent in a
          pane for it to report again; restarting sheepit or reloading this page will not
          do it.
        </p>
      )}

      {error && (
        <p className="mt-4 text-[11px]" style={{ color: 'var(--destructive)' }}>{error}</p>
      )}

      <p className="mt-4 text-[11px] text-muted-foreground">
        Use this after editing <code>plugin/</code> in a checkout: the version has not
        moved, so the automatic install at startup sees nothing to do, and the agent goes
        on loading the previous copy.
      </p>

      <HookTrace />
    </div>
  );
}

export default PluginContent;
