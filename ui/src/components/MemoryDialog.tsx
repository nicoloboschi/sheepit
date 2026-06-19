import { useState, useEffect, useRef } from 'react';
import { ExternalLink, Check, Loader, RotateCw, Copy, Power, PowerOff, Trash2, ArrowUpCircle } from 'lucide-react';
import ConfigDialog from './ConfigDialog';
import { Button } from './ui/button';
import ClaudeIcon from './ClaudeIcon';
import OpenAIIcon from './OpenAIIcon';

const TABS = ['Overview', 'API Server', 'Claude Code', 'Codex', 'Logs'] as const;
type Tab = typeof TABS[number];

interface ServerConfig {
  hindsightEnabled: boolean;
  hindsightApiUrl: string;
  hindsightApiToken: string;
  retainChunkChars: number;
  observationsEnabled: boolean;
  active?: boolean;
  controlPlaneActive?: boolean;
}

interface PluginConfig {
  bankId?: string;
  [key: string]: unknown;
}

type AsyncState = 'idle' | 'loading' | 'ok' | 'error';

interface MemoryDialogProps {
  onClose: () => void;
}

/* ── tiny reusable field ── */
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-foreground">
        {label}
        {hint && <span className="text-muted-foreground font-normal"> ({hint})</span>}
      </label>
      {children}
    </div>
  );
}

const INPUT = 'text-xs px-2 py-1.5 rounded border border-border bg-background text-foreground placeholder:text-muted-foreground';

export function MemoryContent() {
  const [tab, setTab] = useState<Tab>('Overview');

  // Server config (requires restart)
  const [srv, setSrv] = useState<ServerConfig | null>(null);
  const [srvState, setSrvState] = useState<AsyncState>('idle');
  const [srvError, setSrvError] = useState('');

  // Plugin config (writes to ~/.hindsight/claude-code.json, no restart)
  const [plg, setPlg] = useState<PluginConfig | null>(null);
  const [plgState, setPlgState] = useState<AsyncState>('idle');

  // Claude Code status
  const [ccState, setCcState] = useState<AsyncState>('idle');
  const [ccError, setCcError] = useState('');
  const [copied, setCopied] = useState(false);
  const [ccStatus, setCcStatus] = useState<{
    pluginInstalled: boolean;
    pluginEnabled: boolean;
    configExists: boolean;
    configUrl: string;
    pluginVersion: string;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');
  const [actionDone, setActionDone] = useState(false);

  const [cpError, setCpError] = useState('');

  // Codex status
  const [codexStatus, setCodexStatus] = useState<{
    installed: boolean;
    hooksEnabled: boolean;
    pluginVersion: string;
    userConfig: Record<string, unknown>;
  } | null>(null);
  const [codexState, setCodexState] = useState<AsyncState>('idle');
  const [codexError, setCodexError] = useState('');

  useEffect(() => {
    fetch('/api/memory/config').then(r => r.json()).then(setSrv).catch(() => {});
    fetch('/api/memory/plugin-config').then(r => r.json()).then(setPlg).catch(() => {});
    fetch('/api/memory/claude-code-status').then(r => r.json()).then(setCcStatus).catch(() => {});
    fetch('/api/memory/codex-status').then(r => r.json()).then(setCodexStatus).catch(() => {});
  }, []);

  /* ── server actions ── */

  async function saveServer() {
    setSrvState('loading'); setSrvError('');
    try {
      const res = await fetch('/api/memory/restart', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(srv),
      });
      const { ok, error } = await res.json();
      if (!ok) { setSrvState('error'); setSrvError(error || 'Save failed'); return; }
      setSrvState('ok');
      setTimeout(() => setSrvState('idle'), 2000);
    } catch { setSrvState('error'); setSrvError('Request failed'); }
  }

  async function savePlugin() {
    setPlgState('loading');
    try {
      const res = await fetch('/api/memory/plugin-config', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ bankId: plg?.bankId }),
      });
      const { ok } = await res.json();
      setPlgState(ok ? 'ok' : 'error');
      if (ok) setTimeout(() => setPlgState('idle'), 2000);
    } catch { setPlgState('error'); }
  }

  async function openControlPlane() {
    setCpError('');
    try {
      const res = await fetch('/api/memory/ui', { method: 'POST' });
      const { active, url } = await res.json();
      if (active && url) window.open(url, '_blank');
      else setCpError('Hindsight is not active yet.');
    } catch { setCpError('Failed to start control plane.'); }
  }

  /* ── Claude Code actions ── */

  async function reloadPluginsInSessions(): Promise<number> {
    try {
      const res = await fetch('/api/memory/claude-code-reload-plugins', { method: 'POST' });
      const { sessions } = await res.json();
      return sessions ?? 0;
    } catch { return 0; }
  }

  async function setupClaudeCode() {
    setCcState('loading'); setCcError('');
    try {
      const res = await fetch('/api/memory/claude-code-setup', { method: 'POST' });
      const { ok, error } = await res.json();
      if (ok) {
        setCcState('ok');
        fetch('/api/memory/claude-code-status').then(r => r.json()).then(setCcStatus).catch(() => {});
        reloadPluginsInSessions();
      }
      else { setCcState('error'); setCcError(error || 'Unknown error'); }
    } catch { setCcState('error'); setCcError('Request failed'); }
  }

  async function ccAction(endpoint: string) {
    setActionLoading(endpoint); setActionError(''); setActionDone(false);
    try {
      const res = await fetch(`/api/memory/${endpoint}`, { method: 'POST' });
      const { ok, error } = await res.json();
      if (ok) {
        setActionDone(true);
        fetch('/api/memory/claude-code-status').then(r => r.json()).then(setCcStatus).catch(() => {});
        reloadPluginsInSessions();
      }
      else { setActionError(error || 'Unknown error'); }
    } catch { setActionError('Request failed'); }
    setActionLoading(null);
  }

  /* ── Logs ── */

  const [logText, setLogText] = useState('');
  const logRef = useRef<HTMLPreElement>(null);
  const logEventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (tab !== 'Logs') { logEventSourceRef.current?.close(); logEventSourceRef.current = null; return; }
    const es = new EventSource('/api/memory/logs?lines=300');
    logEventSourceRef.current = es;
    es.onmessage = (ev) => {
      try {
        const { type, text } = JSON.parse(ev.data);
        if (type === 'initial') setLogText(text);
        else if (type === 'append') setLogText(prev => prev + text);
        setTimeout(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight; }, 16);
      } catch { /* ignore */ }
    };
    return () => { es.close(); };
  }, [tab]);

  const manualCommands = `claude plugin marketplace add vectorize-io/hindsight\nclaude plugin install hindsight-memory\n\n# Then add to ~/.hindsight/claude-code.json:\n# { "hindsightApiUrl": "http://${window.location.host}/api/hindsight" }`;

  function copyCommand() {
    navigator.clipboard.writeText(manualCommands);
    setCopied(true); setTimeout(() => setCopied(false), 2000);
  }

  /* ── render ── */

  return (
    <>
      {/* Tab bar */}
      <div className="flex border-b border-border">
          {TABS.map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={[
                'px-4 py-2 text-xs border-b-2 transition-colors bg-transparent cursor-pointer flex items-center gap-1.5',
                tab === t ? 'font-semibold text-foreground border-primary' : 'font-normal text-muted-foreground border-transparent hover:text-foreground',
              ].join(' ')}
            >
              {t === 'Claude Code' && <ClaudeIcon size={12} />}
              {t === 'Codex' && <OpenAIIcon size={12} />}
              {t}
            </button>
          ))}
        </div>

        <div className="p-5 flex flex-col gap-4 min-h-[220px]">

          {/* ════════════════════════ OVERVIEW ════════════════════════ */}
          {tab === 'Overview' && (
            <>
              {/* Status */}
              {srv && (
                <div className="rounded-md border border-border px-3 py-2.5 flex flex-col gap-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${srv.active ? 'bg-green-500' : srv.hindsightEnabled ? 'bg-yellow-500' : 'bg-muted-foreground'}`} />
                    <span className="text-muted-foreground">
                      API: {srv.active
                        ? <span className="text-green-500 font-medium">active</span>
                        : srv.hindsightEnabled
                          ? <span className="text-yellow-500 font-medium">inactive</span>
                          : 'disabled'}
                    </span>
                  </div>
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${srv.controlPlaneActive ? 'bg-green-500' : 'bg-muted-foreground'}`} />
                      <span className="text-muted-foreground">
                        Control Plane: {srv.controlPlaneActive ? <span className="text-green-500 font-medium">running</span> : 'not running'}
                      </span>
                    </div>
                    {srv.controlPlaneActive && (
                      <Button variant="ghost" size="sm" className="h-5 px-1.5 text-[10px] flex items-center gap-1" onClick={openControlPlane}>
                        <ExternalLink size={10} /> Open
                      </Button>
                    )}
                  </div>
                </div>
              )}
              {cpError && <p className="text-xs text-destructive">{cpError}</p>}

              <p className="text-sm text-muted-foreground leading-relaxed">
                <strong className="text-foreground font-semibold">Hindsight</strong> gives your coding agents
                long-term memory. Conversations are retained and recalled automatically so context carries
                across sessions.
              </p>

              {/* Plugin config (no restart) */}
              {plg && (
                <div className="flex flex-col gap-3">
                  <span className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Plugin</span>

                  <Field label="Bank ID" hint="shared across integrations">
                    <input
                      type="text"
                      value={plg.bankId ?? 'hindsight-code'}
                      onChange={e => setPlg({ ...plg, bankId: e.target.value })}
                      placeholder="hindsight-code"
                      className={INPUT}
                    />
                    <p className="text-xs text-muted-foreground">Memory bank used by Claude Code and future integrations.</p>
                  </Field>

                  <Button size="sm" variant="outline" className="self-start flex items-center gap-2" onClick={savePlugin} disabled={plgState === 'loading'}>
                    {plgState === 'loading' && <Loader size={13} className="animate-spin" />}
                    {plgState === 'ok' && <Check size={13} />}
                    {plgState === 'idle' && <Check size={13} className="opacity-0" />}
                    {plgState === 'loading' ? 'Saving\u2026' : plgState === 'ok' ? 'Saved' : 'Save'}
                  </Button>
                </div>
              )}
            </>
          )}

          {/* ════════════════════════ API SERVER ════════════════════════ */}
          {tab === 'API Server' && (
            <>
              {!srv ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader size={13} className="animate-spin" /> Loading&hellip;
                </div>
              ) : (
                <div className="flex flex-col gap-3">
                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={srv.hindsightEnabled} onChange={e => setSrv({ ...srv, hindsightEnabled: e.target.checked })} className="rounded" />
                    <span className="text-xs font-medium text-foreground">Enable Hindsight</span>
                  </label>

                  <Field label="API URL">
                    <input type="text" value={srv.hindsightApiUrl} onChange={e => setSrv({ ...srv, hindsightApiUrl: e.target.value })} placeholder="https://hindsight.example.com" className={INPUT} />
                  </Field>
                  <Field label="API Token" hint="optional">
                    <input type="password" value={srv.hindsightApiToken} onChange={e => setSrv({ ...srv, hindsightApiToken: e.target.value })} placeholder="Bearer token" className={INPUT} />
                  </Field>

                  <label className="flex items-center gap-2 cursor-pointer select-none">
                    <input type="checkbox" checked={srv.observationsEnabled} onChange={e => setSrv({ ...srv, observationsEnabled: e.target.checked })} className="rounded" />
                    <span className="text-xs font-medium text-foreground">Enable observations</span>
                    <span className="text-xs text-muted-foreground">(requires LLM on the Hindsight server)</span>
                  </label>

                  {srvState === 'error' && <p className="text-xs text-destructive">{srvError}</p>}

                  <Button size="sm" className="self-start flex items-center gap-2" onClick={saveServer} disabled={srvState === 'loading'}>
                    {srvState === 'loading' && <Loader size={13} className="animate-spin" />}
                    {srvState === 'ok' && <Check size={13} />}
                    {(srvState === 'idle' || srvState === 'error') && <RotateCw size={13} />}
                    {srvState === 'loading' ? 'Saving\u2026' : srvState === 'ok' ? 'Saved' : 'Save & Restart'}
                  </Button>
                </div>
              )}
            </>
          )}

          {/* ════════════════════════ CLAUDE CODE ════════════════════════ */}
          {tab === 'Claude Code' && (
            <>
              <div className="flex items-center gap-3 mb-1">
                <div className="flex items-center justify-center rounded-lg" style={{ width: 40, height: 40, background: 'linear-gradient(135deg, #D4A574 0%, #CC785C 100%)' }}>
                  <ClaudeIcon size={22} className="text-white" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Connect to Claude Code</p>
                  <p className="text-xs text-muted-foreground">Give Claude long-term memory of your terminal sessions</p>
                </div>
              </div>

              {/* Status */}
              {ccStatus && (
                <div className="rounded-md border border-border px-3 py-2.5 flex flex-col gap-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ccStatus.pluginInstalled && ccStatus.pluginEnabled ? 'bg-green-500' : ccStatus.pluginInstalled ? 'bg-yellow-500' : 'bg-muted-foreground'}`} />
                    <span className="text-muted-foreground">
                      Plugin: {ccStatus.pluginInstalled ? (ccStatus.pluginEnabled ? <span className="text-green-500 font-medium">installed & enabled</span> : <span className="text-yellow-500 font-medium">installed (not enabled)</span>) : 'not installed'}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${ccStatus.configExists ? 'bg-green-500' : 'bg-muted-foreground'}`} />
                    <span className="text-muted-foreground">
                      Config: {ccStatus.configExists ? (
                        <><span className="text-green-500 font-medium">configured</span>{ccStatus.configUrl && <> &rarr; <code className="text-[10px] bg-muted px-1 rounded">{ccStatus.configUrl}</code></>}</>
                      ) : 'not configured'}
                    </span>
                  </div>
                </div>
              )}

              {ccStatus?.pluginInstalled && ccStatus?.configExists ? (
                <>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    The <strong className="text-foreground">Hindsight plugin</strong>
                    {ccStatus.pluginVersion && <> <code className="text-[10px] bg-muted px-1 rounded">v{ccStatus.pluginVersion}</code></>}
                    {' '}is installed and configured.
                  </p>
                  {actionError && <p className="text-xs text-destructive break-words">{actionError}</p>}
                  {actionDone && (
                    <p className="text-xs text-green-500">
                      Done &mdash; reloaded plugins in open Claude Code sessions.
                    </p>
                  )}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button variant="outline" size="sm" className="flex items-center gap-2" onClick={() => ccAction('claude-code-update')} disabled={!!actionLoading}>
                      {actionLoading === 'claude-code-update' ? <Loader size={13} className="animate-spin" /> : <ArrowUpCircle size={13} />} Update
                    </Button>
                    {ccStatus.pluginEnabled ? (
                      <Button variant="outline" size="sm" className="flex items-center gap-2" onClick={() => ccAction('claude-code-disable')} disabled={!!actionLoading}>
                        {actionLoading === 'claude-code-disable' ? <Loader size={13} className="animate-spin" /> : <PowerOff size={13} />} Disable
                      </Button>
                    ) : (
                      <Button size="sm" className="flex items-center gap-2" onClick={() => ccAction('claude-code-enable')} disabled={!!actionLoading}>
                        {actionLoading === 'claude-code-enable' ? <Loader size={13} className="animate-spin" /> : <Power size={13} />} Enable
                      </Button>
                    )}
                    <Button variant="outline" size="sm" className="flex items-center gap-2 text-destructive hover:text-destructive" onClick={() => ccAction('claude-code-remove')} disabled={!!actionLoading}>
                      {actionLoading === 'claude-code-remove' ? <Loader size={13} className="animate-spin" /> : <Trash2 size={13} />} Remove
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Install the <strong className="text-foreground">Hindsight plugin</strong> for Claude Code.
                    It captures conversations and recalls relevant context &mdash; Claude gains memory across all sessions.
                  </p>
                  <div className="rounded-lg border border-border p-4 flex flex-col gap-3" style={{ background: 'var(--accent)' }}>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-foreground">Automatic setup</span>
                      {!srv?.active && <span className="text-xs text-yellow-500">(requires Hindsight to be running)</span>}
                    </div>
                    {ccState === 'error' && <p className="text-xs text-destructive break-words">{ccError}</p>}
                    <Button size="sm" className="self-start flex items-center gap-2" onClick={setupClaudeCode} disabled={ccState === 'loading' || ccState === 'ok' || !srv?.active}>
                      {ccState === 'loading' && <Loader size={13} className="animate-spin" />}
                      {ccState === 'ok' && <Check size={13} />}
                      {(ccState === 'idle' || ccState === 'error') && <ClaudeIcon size={13} />}
                      {ccState === 'loading' ? 'Installing\u2026' : ccState === 'ok' ? 'Installed & configured' : 'Install Hindsight Plugin'}
                    </Button>
                    {ccState === 'ok' && (
                      <p className="text-xs text-green-500">
                        Installed &mdash; reloaded plugins in open Claude Code sessions.
                      </p>
                    )}
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-semibold text-foreground">Or install manually</span>
                    <div className="relative group">
                      <pre className="text-[10px] text-muted-foreground bg-muted rounded-md px-3 py-2.5 pr-9 leading-relaxed font-mono select-all whitespace-pre-wrap">{manualCommands}</pre>
                      <button onClick={copyCommand} className="absolute top-2 right-2 p-1 rounded opacity-0 group-hover:opacity-100 transition-opacity hover:bg-background/50" title="Copy" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--muted-foreground)' }}>
                        {copied ? <Check size={12} className="text-green-500" /> : <Copy size={12} />}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </>
          )}

          {/* ════════════════════════ CODEX ════════════════════════ */}
          {tab === 'Codex' && (
            <>
              <div className="flex items-center gap-3 mb-1">
                <div className="flex items-center justify-center rounded-lg" style={{ width: 40, height: 40, background: 'linear-gradient(135deg, #10a37f 0%, #0e8f6e 100%)' }}>
                  <OpenAIIcon size={22} className="brightness-0 invert" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-foreground">Connect to Codex CLI</p>
                  <p className="text-xs text-muted-foreground">Give OpenAI Codex persistent memory across sessions</p>
                </div>
              </div>

              {/* Status */}
              {codexStatus && (
                <div className="rounded-md border border-border px-3 py-2.5 flex flex-col gap-1.5 text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${codexStatus.installed && codexStatus.hooksEnabled ? 'bg-green-500' : codexStatus.installed ? 'bg-yellow-500' : 'bg-muted-foreground'}`} />
                    <span className="text-muted-foreground">
                      Plugin: {codexStatus.installed
                        ? (codexStatus.hooksEnabled
                          ? <span className="text-green-500 font-medium">installed & enabled{codexStatus.pluginVersion ? ` (v${codexStatus.pluginVersion})` : ''}</span>
                          : <span className="text-yellow-500 font-medium">installed (hooks not enabled in config.toml)</span>)
                        : 'not installed'}
                    </span>
                  </div>
                </div>
              )}

              {codexStatus?.installed ? (
                <>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    The <strong className="text-foreground">Hindsight plugin for Codex</strong> is installed.
                    Memories are automatically retained after conversations and recalled before each prompt.
                  </p>
                  {codexError && <p className="text-xs text-destructive break-words">{codexError}</p>}
                  {codexState === 'ok' && <p className="text-xs text-green-500">Done.</p>}
                  <div className="flex items-center gap-2 flex-wrap">
                    <Button variant="outline" size="sm" className="flex items-center gap-2" onClick={async () => {
                      setCodexState('loading'); setCodexError('');
                      try {
                        const res = await fetch('/api/memory/codex-setup', { method: 'POST' });
                        const { ok, error } = await res.json();
                        if (ok) { setCodexState('ok'); fetch('/api/memory/codex-status').then(r => r.json()).then(setCodexStatus).catch(() => {}); }
                        else { setCodexState('error'); setCodexError(error || 'Unknown error'); }
                      } catch { setCodexState('error'); setCodexError('Request failed'); }
                    }} disabled={codexState === 'loading'}>
                      {codexState === 'loading' ? <Loader size={13} className="animate-spin" /> : <ArrowUpCircle size={13} />} Reinstall / Update
                    </Button>
                    <Button variant="outline" size="sm" className="flex items-center gap-2 text-destructive hover:text-destructive" onClick={async () => {
                      setCodexState('loading'); setCodexError('');
                      try {
                        const res = await fetch('/api/memory/codex-uninstall', { method: 'POST' });
                        const { ok, error } = await res.json();
                        if (ok) { setCodexState('ok'); fetch('/api/memory/codex-status').then(r => r.json()).then(setCodexStatus).catch(() => {}); }
                        else { setCodexState('error'); setCodexError(error || 'Unknown error'); }
                      } catch { setCodexState('error'); setCodexError('Request failed'); }
                    }} disabled={codexState === 'loading'}>
                      {codexState === 'loading' ? <Loader size={13} className="animate-spin" /> : <Trash2 size={13} />} Uninstall
                    </Button>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    Install the <strong className="text-foreground">Hindsight plugin</strong> for OpenAI Codex CLI.
                    It captures conversations and recalls relevant context &mdash; Codex gains memory across all sessions.
                  </p>
                  <div className="rounded-lg border border-border p-4 flex flex-col gap-3" style={{ background: 'var(--accent)' }}>
                    <span className="text-xs font-semibold text-foreground">Install</span>
                    {codexState === 'error' && <p className="text-xs text-destructive break-words">{codexError}</p>}
                    <Button size="sm" className="self-start flex items-center gap-2" onClick={async () => {
                      setCodexState('loading'); setCodexError('');
                      try {
                        const res = await fetch('/api/memory/codex-setup', { method: 'POST' });
                        const { ok, error } = await res.json();
                        if (ok) { setCodexState('ok'); fetch('/api/memory/codex-status').then(r => r.json()).then(setCodexStatus).catch(() => {}); }
                        else { setCodexState('error'); setCodexError(error || 'Unknown error'); }
                      } catch { setCodexState('error'); setCodexError('Request failed'); }
                    }} disabled={codexState === 'loading' || codexState === 'ok'}>
                      {codexState === 'loading' && <Loader size={13} className="animate-spin" />}
                      {codexState === 'ok' && <Check size={13} />}
                      {codexState === 'loading' ? 'Installing\u2026' : codexState === 'ok' ? 'Installed' : 'Install Hindsight Plugin'}
                    </Button>
                  </div>
                  <div className="flex flex-col gap-2">
                    <span className="text-xs font-semibold text-foreground">Or install manually</span>
                    <pre className="text-[10px] text-muted-foreground bg-muted rounded-md px-3 py-2.5 leading-relaxed font-mono select-all whitespace-pre-wrap">curl -fsSL https://hindsight.vectorize.io/get-codex | bash</pre>
                  </div>
                </>
              )}
            </>
          )}

          {/* ════════════════════════ LOGS ════════════════════════ */}
          {tab === 'Logs' && (
            <div className="flex flex-col gap-2" style={{ margin: '-20px -20px -20px -20px' }}>
              <pre
                ref={logRef}
                className="font-mono text-[10px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-all"
                style={{ height: 360, overflow: 'auto', padding: '12px 16px', background: '#0c0c0c', margin: 0, borderRadius: 0 }}
              >{logText || 'Connecting\u2026'}</pre>
            </div>
          )}
    </div>
    </>
  );
}

export default function MemoryDialog({ onClose }: MemoryDialogProps) {
  return (
    <ConfigDialog open onClose={onClose}>
      <MemoryContent />
    </ConfigDialog>
  );
}
