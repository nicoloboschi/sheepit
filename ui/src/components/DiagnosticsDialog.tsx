import { useEffect, useState } from 'react';
import ConfigDialog from './ConfigDialog';
import { perf, type PerfSnapshot } from '../perf';

interface PubsubChannel {
  channel: string;
  subscribers: number;
}

interface ServerMemory {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

interface WsClient {
  subscribedSessions: string[];
  connectedAt: number;
  messageCount: number;
  bytesSent: number;
}

interface ManagedPty {
  sessionId: string;
  pid: number;
  cols: number;
  rows: number;
}

interface Diagnostics {
  managedPtys: number;
  managedPtyDetails: ManagedPty[];
  scrollbackStreams: number;
  memBuffers: number;
  knownSessions: number;
  pubsubChannels: PubsubChannel[];
  serverMemory: ServerMemory;
  uptimeSeconds: number;
  websockets: {
    totalConnections: number;
    clients: WsClient[];
  };
}



function fmt(bytes: number): string {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function fmtUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${Math.floor(seconds % 60)}s`;
}

function fmtAge(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
}

const ROW: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '5px 0', borderBottom: '1px solid var(--border)',
  fontSize: 12,
};
const LABEL: React.CSSProperties = { color: 'var(--muted-foreground)' };
const VALUE: React.CSSProperties = { fontFamily: 'monospace', color: 'var(--foreground)' };
const WARN: React.CSSProperties = { ...VALUE, color: 'var(--destructive)' };
const SECTION: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: 'var(--foreground)', opacity: 0.7,
  textTransform: 'uppercase' as const, letterSpacing: '0.04em',
  marginTop: 14, marginBottom: 4,
};
const SUB_ROW: React.CSSProperties = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  padding: '3px 0 3px 12px', borderBottom: '1px solid rgba(255,255,255,0.03)',
  fontSize: 11,
};

interface DiagnosticsDialogProps {
  onClose: () => void;
}

export function DiagnosticsContent() {
  const [diag, setDiag] = useState<Diagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The dialog measures nothing itself. It used to sample `performance.memory`
  // and count websocket resource entries on its own timer, which made it a
  // second, shorter-lived answer beside perf.ts's. See ui/src/perf.ts.
  const [snap, setSnap] = useState<PerfSnapshot>(() => perf.live());
  const [hot, setHot] = useState(() => perf.hotspots(8));

  useEffect(() => {
    let cancelled = false;

    async function fetchDiag() {
      try {
        const res = await fetch('/api/diagnostics');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) { setDiag(data); setError(null); }
      } catch (e) {
        if (!cancelled) setError(String(e));
      }
    }

    function samplePerf() {
      setSnap(perf.live());
      setHot(perf.hotspots(8));
    }

    fetchDiag();
    samplePerf();
    const id = setInterval(() => { fetchDiag(); samplePerf(); }, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  const heapHigh = (snap.heapMb ?? 0) > 1024;
  const canvasCount = document.querySelectorAll('.xterm canvas').length;

  return (
    <div style={{ padding: 16, overflowY: 'auto', flex: 1, fontSize: 12 }}>
          {error && (
            <div style={{ color: 'var(--destructive)', marginBottom: 8 }}>
              Failed to fetch: {error}
            </div>
          )}

          {/* Performance — the one place the UI measures itself (ui/src/perf.ts) */}
          <div style={SECTION}>Performance ({snap.shell}, last {snap.secs}s)</div>
          <div style={ROW}>
            <span style={LABEL}>Frames per second</span>
            <span style={snap.fps < 45 ? WARN : VALUE}>{snap.fps}</span>
          </div>
          <div style={ROW}>
            <span style={LABEL}>Slow frames (&gt;20ms)</span>
            <span style={snap.slowFrames > 20 ? WARN : VALUE}>{snap.slowFrames}</span>
          </div>
          <div style={ROW}>
            <span style={LABEL}>Worst frame</span>
            <span style={snap.worstFrameMs > 100 ? WARN : VALUE}>
              {snap.worstFrameMs.toFixed(0)}ms{snap.worstFrameBlame ? ` — ${snap.worstFrameBlame}` : ''}
            </span>
          </div>
          <div style={ROW}>
            <span style={LABEL}>Long tasks</span>
            <span style={snap.longTaskMs > 1000 ? WARN : VALUE}>
              {snap.longTasks} ({snap.longTaskMs}ms, worst {snap.worstLongTaskMs}ms)
            </span>
          </div>
          {snap.main && (
            <div style={ROW}>
              <span style={LABEL}>Main process stalls</span>
              <span style={snap.main.stalls > 0 ? WARN : VALUE}>
                {snap.main.stalls} (worst {snap.main.worstMs}ms)
              </span>
            </div>
          )}

          {snap.loaf.length > 0 && (
            <>
              <div style={SECTION}>Worst long frames (what the browser blamed)</div>
              {snap.loaf.map((l, i) => (
                <div key={i} style={{ ...SUB_ROW, display: 'block' }}>
                  <div style={{ ...VALUE, color: l.durationMs > 200 ? 'var(--destructive)' : undefined }}>
                    {l.durationMs}ms — blocking {l.blockingMs}ms, style+layout {l.styleAndLayoutMs}ms
                  </div>
                  <div style={{ ...LABEL, fontFamily: 'monospace', fontSize: 10 }}>
                    {l.script}{l.scriptMs ? ` (${l.scriptMs}ms` : ''}{l.invoker ? `, ${l.invoker})` : l.scriptMs ? ')' : ''}
                  </div>
                </div>
              ))}
            </>
          )}

          <div style={SECTION}>Hotspots (kept history, worst total first)</div>
          {hot.length === 0 ? (
            <div style={{ color: 'var(--muted-foreground)', fontSize: 11 }}>
              Nothing timed yet — the first window closes after 10s.
            </div>
          ) : hot.map(h => (
            <div key={h.name} style={SUB_ROW}>
              <span style={LABEL}>{h.name}</span>
              <span style={VALUE}>
                {Math.round(h.totalMs)}ms / {h.n}× / max {h.maxMs.toFixed(1)}ms
              </span>
            </div>
          ))}

          <div style={SECTION}>Browser Tab</div>
          <div style={ROW}>
            <span style={LABEL}>JS Heap Used</span>
            <span style={heapHigh ? WARN : VALUE}>
              {snap.heapMb === null ? 'not available' : `${snap.heapMb} MB`}
            </span>
          </div>
          <div style={ROW}>
            <span style={LABEL}>Active xterm instances</span>
            <span style={snap.terminals > 15 ? WARN : VALUE}>{snap.terminals}</span>
          </div>
          <div style={ROW}>
            <span style={LABEL}>Browser panes</span>
            <span style={VALUE}>{snap.browserPanes}</span>
          </div>
          <div style={ROW}>
            <span style={LABEL}>Canvas elements</span>
            <span style={canvasCount > 30 ? WARN : VALUE}>{canvasCount}</span>
          </div>
          <div style={ROW}>
            <span style={LABEL}>DOM nodes (total)</span>
            <span style={snap.domNodes > 20000 ? WARN : VALUE}>{snap.domNodes}</span>
          </div>
          {heapHigh && (
            <div style={{ color: 'var(--destructive)', fontSize: 11, marginTop: 6, lineHeight: 1.5 }}>
              Heap is above 1 GB. Possible memory leak. Try closing and reopening the tab.
            </div>
          )}

          {diag && (
            <>
              {/* WebSocket Connections */}
              <div style={SECTION}>WebSocket Connections</div>
              <div style={ROW}>
                <span style={LABEL}>Active connections</span>
                <span style={diag.websockets.totalConnections > 15 ? WARN : VALUE}>
                  {diag.websockets.totalConnections}
                </span>
              </div>
              {diag.websockets.clients.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {diag.websockets.clients.map((c, i) => (
                    <div key={i} style={SUB_ROW}>
                      <span style={LABEL}>
                        {c.subscribedSessions.length > 0
                          ? `${c.subscribedSessions.length} session${c.subscribedSessions.length > 1 ? 's' : ''}`
                          : '(no sessions)'}
                      </span>
                      <span style={{ ...VALUE, fontSize: 10 }}>
                        {c.messageCount.toLocaleString()} msgs, {fmt(c.bytesSent)}, {fmtAge(c.connectedAt)}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Server Process */}
              <div style={SECTION}>Server Process</div>
              <div style={ROW}>
                <span style={LABEL}>Uptime</span>
                <span style={VALUE}>{fmtUptime(diag.uptimeSeconds)}</span>
              </div>
              <div style={ROW}>
                <span style={LABEL}>RSS</span>
                <span style={diag.serverMemory.rss > 512 * 1024 * 1024 ? WARN : VALUE}>
                  {fmt(diag.serverMemory.rss)}
                </span>
              </div>
              <div style={ROW}>
                <span style={LABEL}>Heap Used / Total</span>
                <span style={VALUE}>
                  {fmt(diag.serverMemory.heapUsed)} / {fmt(diag.serverMemory.heapTotal)}
                </span>
              </div>
              <div style={ROW}>
                <span style={LABEL}>External + ArrayBuffers</span>
                <span style={VALUE}>
                  {fmt(diag.serverMemory.external)} + {fmt(diag.serverMemory.arrayBuffers)}
                </span>
              </div>

              {/* Resources */}
              <div style={SECTION}>Resources</div>
              <div style={ROW}>
                <span style={LABEL}>Managed PTYs</span>
                <span style={diag.managedPtys > 20 ? WARN : VALUE}>{diag.managedPtys}</span>
              </div>
              {diag.managedPtyDetails.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  {diag.managedPtyDetails.map(p => (
                    <div key={p.sessionId} style={SUB_ROW}>
                      <span style={LABEL}>{p.sessionId.slice(0, 16)}</span>
                      <span style={{ ...VALUE, fontSize: 10 }}>
                        PID {p.pid}, {p.cols}x{p.rows}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <div style={ROW}>
                <span style={LABEL}>Scrollback Streams</span>
                <span style={VALUE}>{diag.scrollbackStreams}</span>
              </div>
              <div style={ROW}>
                <span style={LABEL}>Known Sessions</span>
                <span style={VALUE}>{diag.knownSessions}</span>
              </div>
              <div style={ROW}>
                <span style={LABEL}>Memory Buffers</span>
                <span style={VALUE}>{diag.memBuffers}</span>
              </div>

              {/* PubSub */}
              <div style={SECTION}>PubSub Channels ({diag.pubsubChannels.length})</div>
              {diag.pubsubChannels.length === 0 ? (
                <div style={{ color: 'var(--muted-foreground)' }}>No active channels</div>
              ) : (
                <>
                  <div style={ROW}>
                    <span style={LABEL}>Total subscribers</span>
                    <span style={VALUE}>
                      {diag.pubsubChannels.reduce((sum, ch) => sum + ch.subscribers, 0)}
                    </span>
                  </div>
                  {diag.pubsubChannels.map(ch => (
                    <div key={ch.channel} style={SUB_ROW}>
                      <span style={LABEL}>{ch.channel}</span>
                      <span style={ch.subscribers > 5 ? WARN : VALUE}>
                        {ch.subscribers} sub{ch.subscribers !== 1 ? 's' : ''}
                      </span>
                    </div>
                  ))}
                </>
              )}
            </>
          )}
    </div>
  );
}

export default function DiagnosticsDialog({ onClose }: DiagnosticsDialogProps) {
  return (
    <ConfigDialog open onClose={onClose}>
      <DiagnosticsContent />
    </ConfigDialog>
  );
}
