import { useEffect, useMemo, useState } from 'react';
import { Search, X, ChevronDown, ChevronUp, Copy, Folder, Cog, SquareTerminal } from 'lucide-react';
import { keyedUrl } from '../serverUrl';
import SheepIcon from './SheepIcon';
import { useShallow } from 'zustand/react/shallow';
import useStore from '../store';

interface Proc { pid: number; ppid: number; cpu: number; memMb: number; user: string; name: string; path: string; args?: string; sessionId?: string; app?: string }
interface Activity {
  processes: Proc[]; cpu: number; cores: number; load: number[];
  memUsed: number; memTotal: number; uptime: number; self: number;
}
type SortKey = 'name' | 'cpu' | 'memMb' | 'pid' | 'user';

const POLL_MS = 2000;

/** How far back the CPU and memory columns average. A live `% CPU` reorders the list on
 *  every poll and a spike looks like a culprit; over a minute, the process
 *  that is *actually* holding the machine stays on top. */
const WINDOWS = [{ s: 0, label: 'Now' }, { s: 60, label: '1 min' }, { s: 300, label: '5 min' }] as const;
const KEEP_MS = 300_000;
/** pid → CPU samples. Module-level, so switching pages and back keeps what
 *  has been seen; it fills only while the page is polling. */
const history = new Map<number, { t: number; cpu: number; mem: number }[]>();
let historyStart = 0;
let lastRecord = 0;

function record(procs: Proc[], now: number): void {
  // A gap (the page was closed, or the tab hidden and throttled) would read as
  // idle time; start the window over instead.
  if (now - lastRecord > 10_000) { history.clear(); historyStart = now; }
  lastRecord = now;
  const live = new Set<number>();
  for (const p of procs) {
    live.add(p.pid);
    const h = history.get(p.pid) ?? [];
    h.push({ t: now, cpu: p.cpu, mem: p.memMb });
    while (h.length && h[0]!.t < now - KEEP_MS) h.shift();
    history.set(p.pid, h);
  }
  for (const pid of history.keys()) if (!live.has(pid)) history.delete(pid);
}

/** Mean CPU over the window. A process younger than the window counts as 0
 *  for the time before it existed — so a 2 s blip does not outrank a process
 *  that has burned a core all minute. */
function average(pid: number, windowS: number, now: number): number {
  const h = history.get(pid);
  if (!h?.length) return 0;
  if (!windowS) return h[h.length - 1]!.cpu;
  const from = now - windowS * 1000;
  const span = Math.min(windowS * 1000, now - historyStart) || 1;
  let sum = 0, n = 0;
  for (const x of h) if (x.t >= from) { sum += x.cpu; n++; }
  const seen = Math.min(span, n * POLL_MS);
  return n ? (sum / n) * (seen / span) : 0;
}
/** Rows drawn at once. Past this you are scrolling, not looking — search. */
const MAX_ROWS = 300;

const gb = (b: number) => `${(b / 2 ** 30).toFixed(1)} GB`;
const mem = (mb: number) => (mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`);
function uptime(s: number): string {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

/** The sheep a process runs under: its name, and where to find it. */
function useSheep(sessionId: string | undefined) {
  return useStore(useShallow((s): { wsId: string; idx: number; name: string } | null => {
    if (!sessionId) return null;
    for (const id of s.workspaceOrder) {
      const ws = s.workspaces[id];
      const idx = ws?.cells.indexOf(sessionId) ?? -1;
      if (ws && idx >= 0) return { wsId: id, idx, name: s.sessionMap[sessionId]?.name || ws.title || 'sheep' };
    }
    return null;
  }));
}

function SheepTag({ sessionId }: { sessionId?: string }) {
  const sheep = useSheep(sessionId);
  if (!sheep) return null;
  return (
    <span title={`Runs in the sheep "${sheep.name}"`} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, marginLeft: 6, fontSize: 10, color: 'var(--primary)' }}>
      <SheepIcon size={10} />{sheep.name.length > 24 ? sheep.name.slice(0, 24) + '…' : sheep.name}
    </span>
  );
}

/** Everything about the picked process that tells you whether to kill it or
 *  wait for it: the whole command, the folder it runs in, what started it and
 *  which sheep it belongs to. */
function Details({ p, parent }: { p: Proc; parent?: Proc }) {
  const [cwd, setCwd] = useState<string | null | undefined>(undefined);
  const sheep = useSheep(p.sessionId);
  useEffect(() => {
    let alive = true;
    setCwd(undefined);
    fetch(`/api/system/proc/${p.pid}`).then(r => r.json()).then(d => alive && setCwd(d.cwd ?? null)).catch(() => alive && setCwd(null));
    return () => { alive = false; };
  }, [p.pid]);
  const label: React.CSSProperties = { color: 'var(--muted-foreground)', width: 70, flexShrink: 0 };
  const link: React.CSSProperties = { background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--primary)', textAlign: 'left', fontSize: 12, fontFamily: 'inherit' };
  return (
    <div style={{ borderTop: '1px solid var(--border)', padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, background: 'var(--card)', maxHeight: '40%', overflow: 'auto', flexShrink: 0 }}>
      <div style={{ display: 'flex', gap: 8 }}>
        <span style={label}>Command</span>
        <code style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)', fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--foreground)', userSelect: 'text' }}>
          {p.args || p.path}
        </code>
        <button title="Copy the command" aria-label="Copy the command" onClick={() => navigator.clipboard?.writeText(p.args || p.path)}
          style={{ display: 'flex', alignSelf: 'flex-start', background: 'none', border: 'none', padding: 2, cursor: 'pointer', color: 'var(--muted-foreground)' }}>
          <Copy size={12} />
        </button>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <span style={label}>Folder</span>
        {cwd === undefined ? <span style={{ color: 'var(--muted-foreground)' }}>…</span>
          : cwd ? (
            <button style={{ ...link, display: 'inline-flex', alignItems: 'center', gap: 5, fontFamily: 'var(--font-mono)', fontSize: 11 }} title="Open in Files"
              onClick={() => window.dispatchEvent(new CustomEvent('sheepit:open-folder', { detail: { path: cwd } }))}>
              <Folder size={12} />{cwd}
            </button>
          ) : <span style={{ color: 'var(--muted-foreground)' }}>Not readable (another user&rsquo;s process, or it ended)</span>}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <span style={label}>Started by</span>
        <span style={{ color: 'var(--foreground)' }}>{parent ? `${parent.name} (pid ${parent.pid})` : `pid ${p.ppid}`}</span>
      </div>
      {sheep && (
        <div style={{ display: 'flex', gap: 8 }}>
          <span style={label}>Sheep</span>
          <button style={{ ...link, display: 'inline-flex', alignItems: 'center', gap: 5 }} title="Go to this sheep"
            onClick={() => { const st = useStore.getState(); st.setCurrentSessionId(sheep.wsId); st.setActivePane(sheep.wsId, sheep.idx); }}>
            <SheepIcon size={12} />{sheep.name}
          </button>
        </div>
      )}
    </div>
  );
}

/** Mean memory over the window. Memory is a level, not a rate, so a young
 *  process is not discounted: 2 GB held for ten seconds is 2 GB held. */
function averageMem(pid: number, windowS: number, now: number): number {
  const h = history.get(pid);
  if (!h?.length) return 0;
  if (!windowS) return h[h.length - 1]!.mem;
  let sum = 0, n = 0;
  for (const x of h) if (x.t >= now - windowS * 1000) { sum += x.mem; n++; }
  return n ? Math.round(sum / n) : 0;
}

/** The app's own icon when the process lives in a `.app`; otherwise a gear
 *  for the system's daemons and a terminal for command-line programs. */
const SYSTEM_PATH = /^\/(System|usr\/(libexec|sbin)|sbin|Library\/Apple)\//;
function ProcIcon({ p }: { p: Proc }) {
  const [dead, setDead] = useState(false);
  const box: React.CSSProperties = { display: 'inline-block', width: 16, height: 16, flexShrink: 0, verticalAlign: -3, marginRight: 7 };
  if (p.app && !dead) {
    return <img src={keyedUrl(`/api/system/icon?app=${encodeURIComponent(p.app)}`)} alt="" loading="lazy" style={box} onError={() => setDead(true)} />;
  }
  const Icon = SYSTEM_PATH.test(p.path) || p.user === 'root' || p.user.startsWith('_') ? Cog : SquareTerminal;
  return <Icon size={14} style={{ ...box, width: 14, height: 14, margin: '0 8px 0 1px', color: 'var(--muted-foreground)', opacity: 0.7 }} />;
}

function Meter({ label, value, pct }: { label: string; value: string; pct: number }) {
  const color = pct > 85 ? 'var(--destructive)' : pct > 60 ? 'var(--warning)' : 'var(--primary)';
  return (
    <div style={{ flex: 1, minWidth: 140 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 4 }}>
        <span>{label}</span><span style={{ color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>{value}</span>
      </div>
      <div style={{ height: 6, borderRadius: 3, background: 'var(--accent)', overflow: 'hidden' }}>
        <div style={{ width: `${Math.min(100, pct)}%`, height: '100%', background: color, transition: 'width 0.4s' }} />
      </div>
    </div>
  );
}

/** A small Activity Monitor: what is running, what it costs, and a way to
 *  stop it. Polls only while mounted, and the System panel mounts it only
 *  while it is the page on screen. */
export default function ActivityMonitor() {
  const [raw, setRaw] = useState<Activity | null>(null);
  const [windowS, setWindowS] = useState<number>(60);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'cpu', desc: true });
  const [selected, setSelected] = useState<number | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const load = () => fetch('/api/system/activity')
      .then(r => r.json())
      .then((d: Activity & { error?: string }) => {
        if (!alive) return;
        if (d.error) { setError(d.error); return; }
        record(d.processes, Date.now());
        setRaw(d); setError(null);
      })
      .catch(e => alive && setError(String(e)));
    void load();
    const t = setInterval(load, POLL_MS);
    return () => { alive = false; clearInterval(t); };
  }, [tick]);

  /** The same snapshot with `cpu` averaged over the chosen window; `cpuNow`
   *  keeps the live figure for the tooltip. */
  const data = useMemo(() => {
    if (!raw) return null;
    const now = Date.now();
    return { ...raw, processes: raw.processes.map(p => ({ ...p, cpuNow: p.cpu, cpu: average(p.pid, windowS, now), memNow: p.memMb, memMb: averageMem(p.pid, windowS, now) })) };
  }, [raw, windowS]);
  const covered = raw && historyStart ? Math.round((Date.now() - historyStart) / 1000) : 0;

  const rows = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const list = q
      ? data.processes.filter(p => p.name.toLowerCase().includes(q) || (p.args ?? p.path).toLowerCase().includes(q) || String(p.pid) === q)
      : data.processes.slice();
    const { key, desc } = sort;
    list.sort((a, b) => {
      const av = a[key], bv = b[key];
      const c = typeof av === 'string' ? av.localeCompare(bv as string) : (av as number) - (bv as number);
      return desc ? -c : c;
    });
    return list;
  }, [data, query, sort]);

  const sel = selected != null ? data?.processes.find(p => p.pid === selected) : undefined;

  const kill = async (force: boolean) => {
    if (!sel) return;
    const ok = await useStore.getState().showConfirm(
      `${force ? 'Force quit' : 'Quit'} ${sel.name} (pid ${sel.pid})?${force ? ' It will not get a chance to save anything.' : ''}`);
    if (!ok) return;
    const r = await fetch('/api/system/kill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid: sel.pid, force }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }));
    if (r.error) setError(r.error); else { setSelected(null); setTick(t => t + 1); }
  };

  const col = (key: SortKey, label: string, align: 'left' | 'right', width?: number) => (
    <th
      onClick={() => setSort(s => ({ key, desc: s.key === key ? !s.desc : key !== 'name' && key !== 'user' }))}
      style={{
        textAlign: align, width, padding: '5px 10px', fontWeight: 600, cursor: 'pointer', userSelect: 'none',
        color: sort.key === key ? 'var(--foreground)' : 'var(--muted-foreground)', whiteSpace: 'nowrap',
        position: 'sticky', top: 0, background: 'var(--card)', borderBottom: '1px solid var(--border)',
      }}
    >
      {label}
      {sort.key === key && (sort.desc ? <ChevronDown size={11} style={{ verticalAlign: -1 }} /> : <ChevronUp size={11} style={{ verticalAlign: -1 }} />)}
    </th>
  );

  const btn: React.CSSProperties = {
    fontSize: 12, padding: '4px 10px', borderRadius: 5, border: '1px solid var(--border)',
    background: 'var(--accent)', color: 'var(--foreground)', cursor: 'pointer',
  };

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', padding: '12px 14px', borderBottom: '1px solid var(--border)' }}>
        <Meter label="CPU" value={data ? `${data.cpu}% · ${data.cores} cores` : '—'} pct={data?.cpu ?? 0} />
        <Meter
          label="Memory"
          value={data ? `${gb(data.memUsed)} of ${gb(data.memTotal)}` : '—'}
          pct={data ? (100 * data.memUsed) / data.memTotal : 0}
        />
        <div style={{ fontSize: 11, color: 'var(--muted-foreground)', display: 'flex', flexDirection: 'column', gap: 3, fontVariantNumeric: 'tabular-nums' }}>
          <span>Load {data ? data.load.map(l => l.toFixed(2)).join(' ') : '—'}</span>
          <span>{data ? `${data.processes.length} processes · up ${uptime(data.uptime)}` : ''}</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: '1px solid var(--border)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1, maxWidth: 320, padding: '3px 8px', borderRadius: 5, background: 'var(--input)', border: '1px solid var(--border)' }}>
          <Search size={12} style={{ color: 'var(--muted-foreground)', flexShrink: 0 }} />
          <input
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Find a process or command"
            style={{ flex: 1, minWidth: 0, background: 'none', border: 'none', outline: 'none', fontSize: 12, color: 'var(--foreground)' }}
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear" style={{ display: 'flex', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--muted-foreground)' }}>
              <X size={12} />
            </button>
          )}
        </div>
        <div role="radiogroup" aria-label="Averaged over" style={{ display: 'flex', alignItems: 'center', gap: 2, padding: 2, borderRadius: 6, background: 'var(--accent)', fontSize: 11 }}>
          <span style={{ color: 'var(--muted-foreground)', padding: '0 6px' }}>Average over</span>
          {WINDOWS.map(w => (
            <button
              key={w.s}
              role="radio"
              aria-checked={windowS === w.s}
              onClick={() => setWindowS(w.s)}
              style={{
                padding: '2px 8px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 11,
                background: windowS === w.s ? 'var(--background)' : 'none',
                color: windowS === w.s ? 'var(--foreground)' : 'var(--muted-foreground)',
              }}
            >
              {w.label}
            </button>
          ))}
        </div>
        {windowS > 0 && covered < windowS && (
          <span style={{ fontSize: 11, color: 'var(--muted-foreground)' }} title="The average fills in while this page is open">
            {covered}s seen so far
          </span>
        )}
        {error && <span style={{ fontSize: 11, color: 'var(--destructive)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{error}</span>}
        <div style={{ flex: 1 }} />
        <button style={{ ...btn, opacity: sel ? 1 : 0.4 }} disabled={!sel} onClick={() => kill(false)}>Quit</button>
        <button style={{ ...btn, opacity: sel ? 1 : 0.4, color: sel ? 'var(--destructive)' : undefined }} disabled={!sel} onClick={() => kill(true)}>Force quit</button>
      </div>

      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
          <thead>
            <tr>
              {col('name', 'Process', 'left')}
              {col('cpu', '% CPU', 'right', 80)}
              {col('memMb', 'Memory', 'right', 90)}
              {col('pid', 'PID', 'right', 70)}
              {col('user', 'User', 'left', 110)}
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, MAX_ROWS).map(p => {
              const on = p.pid === selected;
              return (
                <tr
                  key={p.pid}
                  onClick={() => setSelected(on ? null : p.pid)}
                  title={p.args || p.path}
                  style={{ cursor: 'pointer', background: on ? 'var(--accent)' : undefined, boxShadow: on ? 'inset 2px 0 0 var(--primary)' : undefined }}
                >
                  <td style={{ padding: '3px 10px', maxWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'var(--foreground)' }}>
                    <ProcIcon p={p} />
                    {p.name}
                    {data && p.pid === data.self && <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--primary)' }}>sheepit</span>}
                    <SheepTag sessionId={p.sessionId} />
                    {/* The command after the name, quiet: "python3" says
                        nothing, "python3 train.py --epochs 50" says what it is. */}
                    {p.args && p.args !== p.path && (
                      <span style={{ marginLeft: 8, color: 'var(--muted-foreground)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        {p.args.replace(/^\S+\s*/, '')}
                      </span>
                    )}
                  </td>
                  <td title={`Now: ${p.cpuNow.toFixed(1)}%`} style={{ padding: '3px 10px', textAlign: 'right', color: p.cpu >= 50 ? 'var(--warning)' : 'var(--foreground)' }}>{p.cpu.toFixed(1)}</td>
                  <td title={`Now: ${mem(p.memNow)}`} style={{ padding: '3px 10px', textAlign: 'right', color: p.memMb >= 2048 ? 'var(--warning)' : undefined }}>{mem(p.memMb)}</td>
                  <td style={{ padding: '3px 10px', textAlign: 'right', color: 'var(--muted-foreground)' }}>{p.pid}</td>
                  <td style={{ padding: '3px 10px', color: 'var(--muted-foreground)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 110 }}>{p.user}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > MAX_ROWS && (
          <div style={{ padding: 10, fontSize: 11, color: 'var(--muted-foreground)', textAlign: 'center' }}>
            {rows.length - MAX_ROWS} more — search to find them.
          </div>
        )}
      </div>
      {sel && <Details p={sel} parent={data?.processes.find(x => x.pid === sel.ppid)} />}
    </div>
  );
}
