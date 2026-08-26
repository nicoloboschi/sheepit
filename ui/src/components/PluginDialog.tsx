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
    </div>
  );
}

export default PluginContent;
