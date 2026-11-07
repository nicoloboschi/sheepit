import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowUp, Home, HardDrive, RefreshCw, FolderOpen, Copy, Trash2, Folder, File } from 'lucide-react';
import DockButton from './DockButton';
import useStore from '../store';

/** What fills the disk: one scan (`du`, on the server), then a treemap and a
 *  list of the folder you are in. The layout and the colours by kind follow
 *  disktree (github.com/tobi/disktree). */

interface Entry { name: string; path: string; bytes: number; dir: boolean }
interface Disk {
  path: string;
  volume: { total: number; free: number } | null;
  size: number | null;
  entries: Entry[];
  /** What is drawn: the last complete scan (or the first one, filling in). */
  scan: { root: string; finished: number | null } | null;
  /** A scan under way in the background, if any. */
  running: { root: string; count: number; at: string; started: number } | null;
}

export function fmtBytes(b: number): string {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (b >= 1000 && i < u.length - 1) { b /= 1024; i++; }
  return `${b < 10 && i ? b.toFixed(1) : Math.round(b)} ${u[i]}`;
}

function ago(t: number): string {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

// ── Kinds, for colour (disktree's classify.rs, cut down) ─────────────────────
const KINDS: [string, string, RegExp][] = [
  ['Code', '#8fae73', /^(src|code|projects|repos|dev|work|workspaces?|github\.com|sites)$/],
  ['Agent scratch', '#c49a5a', /^(\.codex|\.claude|\.pi|\.cursor|\.gemini|worktrees|experiments|scratch|playground)$/],
  ['Toolchain', '#a487b8', /^(\.cargo|\.rustup|\.local|\.npm|\.pnpm-store|\.bun|\.deno|go|\.gradle|\.m2|\.pyenv|\.nvm|\.gem|\.rbenv|\.config|\.vscode|\.conda|anaconda3|miniconda3|\.android|\.docker|xcode|coresimulator|developer|orbstack|\.orbstack)$/],
  ['Git', '#d4826c', /^\.git$/],
  ['Media', '#d9b84a', /^(pictures|photos|music|movies|videos|models|\.ollama|\.lmstudio|games|steam)$/],
  ['Documents', '#b9a98a', /^(documents|desktop|downloads|books|notes|mobile documents)$/],
  ['Cache', '#6f7d6a', /^(\.cache|caches?|node_modules|__pycache__|\.trash|trash|tmp|\.tmp|temp|deriveddata|\.next|\.turbo|target|dist|build)$/],
];
const OTHER = '#535b4e';
const MEDIA_EXT = /\.(mp4|mov|mkv|avi|webm|mp3|wav|flac|m4a|png|jpe?g|heic|gif|psd|raw|gguf|safetensors|bin|ckpt|iso|dmg)$/i;
const DOC_EXT = /\.(pdf|docx?|xlsx?|pptx?|key|pages|numbers|zip|tar|gz|7z|rar)$/i;
function kindOf(e: Entry): [string, string] {
  const n = e.name.toLowerCase();
  if (!e.dir) return MEDIA_EXT.test(n) ? ['Media', '#d9b84a'] : DOC_EXT.test(n) ? ['Documents', '#b9a98a'] : ['Other', OTHER];
  const k = KINDS.find(([, , re]) => re.test(n));
  return k ? [k[0], k[1]] : ['Other', OTHER];
}

// ── Squarified treemap (Bruls, Huizing, van Wijk; as disktree's treemap.rs) ──
interface R { x: number; y: number; w: number; h: number }
export function squarify(values: number[], area: R): R[] {
  const out: R[] = values.map(() => ({ x: 0, y: 0, w: 0, h: 0 }));
  const total = values.reduce((a, v) => a + (v > 0 ? v : 0), 0);
  if (total <= 0 || area.w <= 0 || area.h <= 0) return out;
  const order = values.map((_, i) => i).filter(i => values[i]! > 0).sort((a, b) => values[b]! - values[a]!);
  const scale = (area.w * area.h) / total;
  const areas = order.map(i => values[i]! * scale);
  const worst = (from: number, to: number, sum: number, side: number) => {
    const t = sum / side;
    let w = 0;
    for (let i = from; i < to; i++) { const o = areas[i]! / t; w = Math.max(w, t / o, o / t); }
    return w;
  };
  const free = { ...area };
  let start = 0;
  while (start < areas.length) {
    const side = Math.min(free.w, free.h);
    let end = start + 1, sum = areas[start]!, best = worst(start, end, sum, side);
    while (end < areas.length) {
      const next = worst(start, end + 1, sum + areas[end]!, side);
      if (next > best) break;
      sum += areas[end]!; best = next; end++;
    }
    if (free.w >= free.h) {
      const sw = Math.min(sum / free.h, free.w);
      let y = free.y;
      for (let i = start; i < end; i++) { const h = Math.max(0, Math.min(areas[i]! / sw, free.y + free.h - y)); out[order[i]!] = { x: free.x, y, w: sw, h }; y += h; }
      free.x += sw; free.w -= sw;
    } else {
      const sh = Math.min(sum / free.w, free.h);
      let x = free.x;
      for (let i = start; i < end; i++) { const w = Math.max(0, Math.min(areas[i]! / sh, free.x + free.w - x)); out[order[i]!] = { x, y: free.y, w, h: sh }; x += w; }
      free.y += sh; free.h -= sh;
    }
    start = end;
  }
  return out;
}

export default function DiskPage() {
  const [path, setPath] = useState<string | null>(null);
  const [data, setData] = useState<Disk | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const scanning = !!data?.running;

  useEffect(() => {
    let alive = true;
    const q = path ? `?path=${encodeURIComponent(path)}` : '';
    fetch(`/api/system/disk${q}`).then(r => r.json()).then((d: Disk) => {
      if (!alive) return;
      setData(d); setError(null);
      if (!path && d.scan) setPath(d.scan.root);
    }).catch(e => alive && setError(String(e)));
    return () => { alive = false; };
  }, [path, tick]);
  // Follow a running scan: folders fill in as `du` finishes them.
  useEffect(() => {
    if (!scanning) return;
    const t = setTimeout(() => setTick(x => x + 1), 1000);
    return () => clearTimeout(t);
  }, [scanning, data]);

  const scan = async (root: string) => {
    const r = await fetch('/api/system/disk/scan', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: root }),
    }).then(r => r.json()).catch(e => ({ error: String(e) }));
    if (r.error) return setError(r.error);
    setSelected(null); setPath(r.root); setTick(x => x + 1);
  };

  const trash = async (e: Entry) => {
    const ok = await useStore.getState().showConfirm(`Move ${e.name} (${fmtBytes(e.bytes)}) to the Trash? You can put it back from the Trash until you empty it.`);
    if (!ok) return;
    const r = await fetch('/api/system/disk/trash', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: e.path }),
    }).then(r => r.json()).catch(err => ({ error: String(err) }));
    if (r.error) setError(r.error); else { setSelected(null); setTick(x => x + 1); }
  };

  // What the treemap draws: the folder's big entries plus what the scan left
  // out (folders under 1 MB, small files) as one grey tile.
  const tiles = useMemo(() => {
    if (!data) return [];
    const list = data.entries.map(e => ({ ...e, rest: false }));
    const sum = list.reduce((a, e) => a + e.bytes, 0);
    if (data.size != null && data.size - sum > data.size * 0.002) list.push({ name: 'Smaller items', path: '', bytes: data.size - sum, dir: false, rest: true });
    return list;
  }, [data]);

  // A callback ref: the treemap's box first exists after the first scan
  // arrives, not on mount.
  const [box, setBox] = useState({ w: 0, h: 0 });
  const roRef = useRef<ResizeObserver | null>(null);
  const boxRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    if (!el) return;
    roRef.current = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    roRef.current.observe(el);
  }, []);
  const rects = useMemo(() => squarify(tiles.map(t => t.bytes), { x: 0, y: 0, w: box.w, h: box.h }), [tiles, box]);

  const vol = data?.volume;
  const usedPct = vol ? 100 * (1 - vol.free / vol.total) : 0;
  const root = data?.scan?.root;
  const canUp = !!path && !!root && path !== root && path.startsWith(root);
  const sel = tiles.find(t => t.path && t.path === selected);
  const crumbs = path && root && path.startsWith(root)
    ? [root, ...path.slice(root.length).split('/').filter(Boolean).map((_, i, a) => root.replace(/\/$/, '') + '/' + a.slice(0, i + 1).join('/'))]
    : [];

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', fontSize: 12 }}>
      {/* The volume, always in view: how full, how much is free. */}
      <div style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--muted-foreground)', marginBottom: 4 }}>
            <span>Disk</span>
            <span style={{ color: 'var(--foreground)', fontVariantNumeric: 'tabular-nums' }}>
              {vol ? `${fmtBytes(vol.free)} free of ${fmtBytes(vol.total)}` : '…'}
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--accent)', overflow: 'hidden' }}>
            <div style={{ width: `${usedPct}%`, height: '100%', background: usedPct > 90 ? 'var(--destructive)' : usedPct > 75 ? 'var(--warning)' : 'var(--primary)' }} />
          </div>
        </div>
        <DockButton icon={<Home size={14} />} label="Scan home" onClick={() => scan('~')} />
        <DockButton icon={<HardDrive size={14} />} label="Scan disk" title="Scan the whole disk (slow)" onClick={() => scan('/')} />
        {root && <DockButton icon={<RefreshCw size={14} className={scanning ? 'animate-spin' : ''} />} label={scanning ? 'Scanning' : 'Rescan'} disabled={scanning} onClick={() => scan(root)} />}
      </div>

      {!data?.scan ? (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted-foreground)', textAlign: 'center', padding: 24 }}>
          Scan your home folder or the whole disk to see what fills it.<br />Nothing is read until you pick one.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderBottom: '1px solid var(--border)', minWidth: 0 }}>
            <button disabled={!canUp} onClick={() => { setSelected(null); setPath(p => p && p.replace(/\/[^/]+\/?$/, '') || root!); }}
              title="Up" style={{ display: 'flex', background: 'none', border: 'none', padding: 3, cursor: canUp ? 'pointer' : 'default', color: canUp ? 'var(--foreground)' : 'var(--muted-foreground)', opacity: canUp ? 1 : 0.4 }}>
              <ArrowUp size={14} />
            </button>
            <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', direction: 'rtl', textAlign: 'left' }}>
              <bdi>
                {crumbs.map((c, i) => (
                  <span key={c}>
                    {i > 0 && <span style={{ color: 'var(--muted-foreground)' }}> / </span>}
                    <button onClick={() => { setSelected(null); setPath(c); }}
                      style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: c === path ? 'var(--foreground)' : 'var(--muted-foreground)', fontSize: 12 }}>
                      {i === 0 ? c : c.split('/').pop()}
                    </button>
                  </span>
                ))}
              </bdi>
            </div>
            {data.scan.finished && (
              <span style={{ color: 'var(--muted-foreground)', fontSize: 11, flexShrink: 0 }} title={new Date(data.scan.finished).toLocaleString()}>
                scanned {ago(data.scan.finished)}
              </span>
            )}
            <span style={{ color: 'var(--muted-foreground)', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
              {data.size != null ? fmtBytes(data.size) : scanning ? 'still counting…' : ''}
            </span>
          </div>
          {scanning && (
            <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--muted-foreground)', borderBottom: '1px solid var(--border)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {data.scan.finished ? 'Refreshing in the background' : 'Scanning'} · {data.running!.count.toLocaleString()} folders · {data.running!.at}
            </div>
          )}

          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {/* The treemap: every tile sized by what it costs on disk. */}
            <div ref={boxRef} style={{ flex: 3, minWidth: 0, position: 'relative', margin: 8 }}>
              {tiles.map((t, i) => {
                const r = rects[i]!;
                if (r.w < 1 || r.h < 1) return null;
                const [, color] = t.rest ? ['', '#3a4036'] : kindOf(t);
                const big = r.w > 70 && r.h > 34;
                return (
                  <button
                    key={t.path || 'rest'}
                    title={`${t.name} · ${fmtBytes(t.bytes)}${t.dir ? ' · double-click to open' : ''}`}
                    onClick={() => !t.rest && setSelected(t.path)}
                    onDoubleClick={() => { if (t.dir) { setSelected(null); setPath(t.path); } }}
                    style={{
                      position: 'absolute', left: r.x, top: r.y, width: r.w, height: r.h,
                      padding: big ? '4px 6px' : 0, border: '1px solid var(--background)', borderRadius: 3,
                      background: color, opacity: selected && selected !== t.path ? 0.75 : 1,
                      outline: selected === t.path ? '2px solid var(--foreground)' : 'none', outlineOffset: -2,
                      cursor: t.rest ? 'default' : 'pointer', overflow: 'hidden', textAlign: 'left', color: '#0b0d0a',
                      display: 'flex', flexDirection: 'column', alignItems: 'flex-start', justifyContent: 'flex-start',
                    }}
                  >
                    {big && <>
                      <span style={{ fontWeight: 600, fontSize: 11, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.name}</span>
                      <span style={{ fontSize: 10, opacity: 0.8 }}>{fmtBytes(t.bytes)}</span>
                    </>}
                  </button>
                );
              })}
            </div>

            {/* The same entries as a list, biggest first. */}
            <div style={{ flex: 2, minWidth: 220, maxWidth: 420, borderLeft: '1px solid var(--border)', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              {sel && (
                <div style={{ padding: 8, borderBottom: '1px solid var(--border)' }}>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sel.path}>{sel.name}</div>
                  <div style={{ color: 'var(--muted-foreground)', fontSize: 11, marginBottom: 6 }}>{fmtBytes(sel.bytes)} · {kindOf(sel)[0]}</div>
                  <div style={{ display: 'flex', gap: 2, flexWrap: 'wrap' }}>
                    {sel.dir && <DockButton icon={<Folder size={14} />} label="Open" title="Look inside" onClick={() => { setSelected(null); setPath(sel.path); }} />}
                    <DockButton icon={<FolderOpen size={14} />} label="In Files" title="Show in the Files page"
                      onClick={() => window.dispatchEvent(new CustomEvent(sel.dir ? 'sheepit:open-folder' : 'sheepit:open-file', { detail: { path: sel.path } }))} />
                    <DockButton icon={<Copy size={14} />} label="Copy path" onClick={() => navigator.clipboard?.writeText(sel.path)} />
                    <DockButton icon={<Trash2 size={14} />} label="Trash" title="Move to the Trash" danger onClick={() => trash(sel)} />
                  </div>
                </div>
              )}
              {error && <div style={{ padding: 8, color: 'var(--destructive)' }}>{error}</div>}
              <div style={{ flex: 1, overflowY: 'auto' }}>
                {tiles.map(t => {
                  const pct = data.size ? (100 * t.bytes) / data.size : 0;
                  return (
                    <div key={t.path || 'rest'}
                      onClick={() => !t.rest && setSelected(t.path)}
                      onDoubleClick={() => { if (t.dir) { setSelected(null); setPath(t.path); } }}
                      style={{ padding: '5px 10px', cursor: t.rest ? 'default' : 'pointer', background: selected === t.path ? 'var(--accent)' : 'none', display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 8, height: 8, borderRadius: 2, flexShrink: 0, background: t.rest ? '#3a4036' : kindOf(t)[1] }} />
                      {t.dir ? <Folder size={13} style={{ flexShrink: 0, color: 'var(--muted-foreground)' }} /> : <File size={13} style={{ flexShrink: 0, color: 'var(--muted-foreground)' }} />}
                      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: t.rest ? 'var(--muted-foreground)' : undefined }}>{t.name}</span>
                      <span style={{ width: 50, height: 4, borderRadius: 2, background: 'var(--accent)', flexShrink: 0, overflow: 'hidden' }}>
                        <span style={{ display: 'block', width: `${pct}%`, height: '100%', background: 'var(--primary)' }} />
                      </span>
                      <span style={{ width: 62, textAlign: 'right', fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{fmtBytes(t.bytes)}</span>
                    </div>
                  );
                })}
                {!tiles.length && !scanning && <div style={{ padding: 12, color: 'var(--muted-foreground)' }}>Nothing over 1 MB here.</div>}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
