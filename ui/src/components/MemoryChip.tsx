import { useEffect, useState } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import hindsightIcon from '../assets/hindsight-icon.png';

interface Activity {
  ts: number;
  type: 'retain' | 'recall';
  source: string;
  sessionId?: string;
  contentSize?: number;
  resultCount?: number;
  context?: string;
  subpath?: string;
  payload?: string;
  payloadTruncated?: boolean;
  metadata?: Record<string, string>;
  resultsPreview?: string;
  resultsPreviewTruncated?: boolean;
}

function relTime(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  return `${(bytes / 1024).toFixed(1)}KB`;
}

interface MemoryChipProps {
  sessionId: string;
}

interface MemoryState {
  enabled: boolean;
  active: boolean;
  healthy: boolean;
}

export default function MemoryChip({ sessionId }: MemoryChipProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [state, setState] = useState<MemoryState | null>(null);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    function refresh() {
      fetch('/api/memory/activity')
        .then(r => r.ok ? r.json() : null)
        .then(d => {
          if (cancelled || !d) return;
          const mine = Array.isArray(d.activity)
            ? (d.activity as Activity[]).filter(a => a.sessionId === sessionId)
            : [];
          setActivities(mine);
          setState({
            enabled: !!d.enabled,
            active:  !!d.active,
            healthy: !!d.healthy,
          });
        })
        .catch(() => {});
    }
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [sessionId]);

  const retains = activities.filter(a => a.type === 'retain').length;
  const recalls = activities.filter(a => a.type === 'recall').length;
  const hasActivity = activities.length > 0;

  // Pick visual style from the combined state:
  //   disabled          → dim, "Hindsight disabled"
  //   enabled, not active → dim, "Hindsight starting…"
  //   active, unhealthy → dim red-ish, "Hindsight unhealthy"
  //   healthy + activity → bright green chip (original design)
  //   healthy + no activity → muted placeholder, "no activity yet"
  let chipColor: string;
  let chipBg: string;
  let chipBorder: string;
  let chipTitle: string;
  let iconOpacity: number;
  if (!state) {
    chipColor = '#525252';
    chipBg    = 'rgba(82,82,82,0.06)';
    chipBorder = 'rgba(82,82,82,0.2)';
    chipTitle = 'Hindsight: loading…';
    iconOpacity = 0.4;
  } else if (!state.enabled) {
    chipColor = '#525252';
    chipBg    = 'rgba(82,82,82,0.06)';
    chipBorder = 'rgba(82,82,82,0.2)';
    chipTitle = 'Hindsight: disabled (enable in settings)';
    iconOpacity = 0.4;
  } else if (!state.active || !state.healthy) {
    chipColor = '#FACC15';
    chipBg    = 'rgba(250,204,21,0.06)';
    chipBorder = 'rgba(250,204,21,0.2)';
    chipTitle = state.active ? 'Hindsight: unhealthy' : 'Hindsight: starting…';
    iconOpacity = 0.5;
  } else if (hasActivity) {
    chipColor = '#4ADE80';
    chipBg    = 'rgba(74,222,128,0.08)';
    chipBorder = 'rgba(74,222,128,0.2)';
    chipTitle = `Hindsight: ${retains} retain${retains !== 1 ? 's' : ''}, ${recalls} recall${recalls !== 1 ? 's' : ''}`;
    iconOpacity = 1;
  } else {
    chipColor = 'var(--muted-foreground)';
    chipBg    = 'rgba(255,255,255,0.03)';
    chipBorder = 'rgba(255,255,255,0.08)';
    chipTitle = 'Hindsight: ready — no memory activity for this session yet';
    iconOpacity = 0.45;
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          title={chipTitle}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            fontSize: 10, fontFamily: '"JetBrains Mono",monospace',
            padding: '1px 6px', borderRadius: 3, cursor: 'pointer',
            background: chipBg, border: `1px solid ${chipBorder}`,
            color: chipColor,
            transition: 'background 0.15s, border-color 0.15s, color 0.15s',
          }}
          className="hover:bg-white/5"
        >
          <img src={hindsightIcon} alt="" style={{ width: 10, height: 10, opacity: iconOpacity }} />
          {hasActivity ? (
            <>
              {retains > 0 && <span>{retains} ret</span>}
              {recalls > 0 && <span>{recalls} rec</span>}
            </>
          ) : (
            <span style={{ opacity: 0.85 }}>hindsight</span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent side="bottom" align="start" style={{ width: 460 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            padding: '6px 10px', borderBottom: '1px solid var(--border)',
          }}>
            <img src={hindsightIcon} alt="" style={{ width: 12, height: 12, opacity: iconOpacity }} />
            <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--foreground)' }}>
              Memory Activity
            </span>
            <span style={{ fontSize: 10, color: 'var(--muted-foreground)', opacity: 0.5 }}>
              {hasActivity ? 'this session — click a row to inspect' : chipTitle}
            </span>
          </div>
          {!hasActivity && (
            <div style={{
              padding: '18px 14px', textAlign: 'center',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
            }}>
              <img src={hindsightIcon} alt="" style={{ width: 20, height: 20, opacity: 0.35 }} />
              <div style={{ fontSize: 11, color: 'var(--muted-foreground)', opacity: 0.8 }}>
                No memory activity yet for this session.
              </div>
              <div style={{ fontSize: 10, color: 'var(--muted-foreground)', opacity: 0.5, maxWidth: 340, lineHeight: 1.5 }}>
                {!state?.enabled
                  ? 'Hindsight is disabled — enable it in Settings → Memory.'
                  : !state?.active
                    ? 'Hindsight is starting up — retains and recalls will appear here as soon as Claude/Codex talk to the memory bank.'
                    : 'Retains and recalls triggered by this pane will appear here. If this is a Claude Code session and you expect activity, check that the Hindsight plugin is loaded.'}
              </div>
            </div>
          )}
          <div style={{ maxHeight: 360, overflowY: 'auto' }}>
            {[...activities].reverse().map((a, i) => {
              const isOpen = expanded === i;
              return (
                <div key={i} style={{
                  borderBottom: i < activities.length - 1 ? '1px solid rgba(255,255,255,0.03)' : 'none',
                }}>
                  <div
                    onClick={() => setExpanded(isOpen ? null : i)}
                    style={{
                      display: 'flex', alignItems: 'baseline', gap: 6,
                      padding: '4px 10px', cursor: 'pointer',
                      background: isOpen ? 'rgba(255,255,255,0.04)' : undefined,
                    }}
                  >
                    <span style={{
                      fontSize: 9, padding: '0 4px', borderRadius: 2, flexShrink: 0,
                      background: a.type === 'retain' ? 'rgba(74,222,128,0.12)' : 'rgba(96,165,250,0.12)',
                      color: a.type === 'retain' ? '#4ADE80' : '#60A5FA',
                    }}>
                      {a.type}
                    </span>
                    <span style={{
                      fontSize: 9, color: 'var(--muted-foreground)', opacity: 0.5,
                      flexShrink: 0,
                    }}>
                      {a.source}
                    </span>
                    {a.contentSize != null && (
                      <span style={{ fontSize: 10, color: 'var(--foreground)', fontFamily: '"JetBrains Mono",monospace' }}>
                        {fmtSize(a.contentSize)}
                      </span>
                    )}
                    {a.type === 'recall' && a.resultCount != null && (
                      <span style={{ fontSize: 10, color: 'var(--foreground)', fontFamily: '"JetBrains Mono",monospace' }}>
                        {a.resultCount} hit{a.resultCount === 1 ? '' : 's'}
                      </span>
                    )}
                    {a.context && (
                      <span style={{
                        fontSize: 10, color: 'var(--muted-foreground)', opacity: 0.6,
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        flex: 1,
                      }} title={a.context}>
                        {a.context}
                      </span>
                    )}
                    {!a.context && <span style={{ flex: 1 }} />}
                    <span style={{ fontSize: 9, color: 'var(--muted-foreground)', opacity: 0.4, flexShrink: 0 }}>
                      {relTime(a.ts)}
                    </span>
                  </div>
                  {isOpen && (
                    <div style={{
                      padding: '6px 10px 10px 10px',
                      background: 'rgba(0,0,0,0.25)',
                      borderTop: '1px solid rgba(255,255,255,0.04)',
                    }}>
                      {a.subpath && (
                        <div style={{ fontSize: 9, color: 'var(--muted-foreground)', opacity: 0.6, marginBottom: 4, fontFamily: '"JetBrains Mono",monospace' }}>
                          POST /{a.subpath}
                        </div>
                      )}
                      {a.metadata && Object.keys(a.metadata).length > 0 && (
                        <div style={{ marginBottom: 6 }}>
                          <div style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>metadata</div>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {Object.entries(a.metadata).map(([k, v]) => (
                              <span key={k} style={{
                                fontSize: 9, padding: '0 4px', borderRadius: 2,
                                background: 'rgba(255,255,255,0.05)',
                                color: 'var(--muted-foreground)',
                                fontFamily: '"JetBrains Mono",monospace',
                              }}>
                                <span style={{ opacity: 0.6 }}>{k}:</span>{v.length > 40 ? v.slice(0, 40) + '…' : v}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      {a.payload && (
                        <div style={{ marginBottom: a.resultsPreview ? 6 : 0 }}>
                          <div style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                            {a.type === 'retain' ? 'ingested content' : 'query'}
                            {a.payloadTruncated && <span style={{ marginLeft: 6, color: '#FACC15' }}>(truncated)</span>}
                          </div>
                          <pre style={{
                            margin: 0, padding: 6,
                            fontSize: 10, lineHeight: 1.4,
                            color: 'var(--foreground)',
                            background: 'rgba(0,0,0,0.4)',
                            border: '1px solid rgba(255,255,255,0.05)',
                            borderRadius: 3,
                            maxHeight: 220, overflow: 'auto',
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            fontFamily: '"JetBrains Mono",monospace',
                          }}>{a.payload}</pre>
                        </div>
                      )}
                      {a.resultsPreview && (
                        <div>
                          <div style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 2 }}>
                            results returned
                            {a.resultsPreviewTruncated && <span style={{ marginLeft: 6, color: '#FACC15' }}>(truncated)</span>}
                          </div>
                          <pre style={{
                            margin: 0, padding: 6,
                            fontSize: 10, lineHeight: 1.4,
                            color: 'var(--foreground)',
                            background: 'rgba(0,0,0,0.4)',
                            border: '1px solid rgba(255,255,255,0.05)',
                            borderRadius: 3,
                            maxHeight: 220, overflow: 'auto',
                            whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                            fontFamily: '"JetBrains Mono",monospace',
                          }}>{a.resultsPreview}</pre>
                        </div>
                      )}
                      {!a.payload && !a.resultsPreview && (
                        <div style={{ fontSize: 10, color: 'var(--muted-foreground)', opacity: 0.5, fontStyle: 'italic' }}>
                          No payload captured for this entry.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
