import { useEffect, useState, useCallback } from 'react';
import { Popover, PopoverTrigger, PopoverContent } from './ui/popover';
import { Button } from './ui/button';
import hindsightIcon from '../assets/hindsight-icon.png';

interface BankStats {
  bank_id: string;
  total_nodes: number;
  total_links: number;
  total_documents: number;
  total_observations: number;
  pending_operations: number;
  failed_operations: number;
  last_consolidated_at: string | null;
  pending_consolidation: number;
}

interface MemoryData {
  enabled: boolean;
  active: boolean;
  healthy: boolean;
  bankId: string;
  bankStats: BankStats | null;
}

interface MemoryIndicatorProps {
  onOpenSettings?: () => void;
}

export default function MemoryIndicator({ onOpenSettings }: MemoryIndicatorProps) {
  const [data, setData] = useState<MemoryData | null>(null);

  const refresh = useCallback(() => {
    fetch('/api/memory/activity')
      .then(r => r.ok ? r.json() : null)
      .then(d => { if (d) setData(d); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => clearInterval(id);
  }, [refresh]);

  if (!data) return null;

  let color = '#525252';
  let title = 'Hindsight: disabled';
  if (data.enabled && data.active && data.healthy) {
    color = '#4ADE80';
    title = `Hindsight: active`;
    if (data.bankStats) {
      title += ` — ${data.bankStats.total_nodes} memories, ${data.bankStats.total_documents} docs`;
    }
  } else if (data.enabled && data.active) {
    color = '#FACC15';
    title = 'Hindsight: connecting...';
  } else if (data.enabled) {
    color = '#F87171';
    title = 'Hindsight: error';
  }

  const stats = data.bankStats;
  const bankId = data.bankId ?? 'vipershell';

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          title={title}
          className="h-7 w-7 text-muted-foreground hover:text-foreground"
          style={{ position: 'relative' }}
        >
          <img
            src={hindsightIcon}
            alt="Hindsight"
            style={{
              width: 14, height: 14,
              filter: data.healthy ? 'none' : 'grayscale(1) opacity(0.4)',
            }}
          />
          <span style={{
            position: 'absolute', top: 3, right: 3,
            width: 5, height: 5, borderRadius: '50%',
            background: color,
            boxShadow: data.healthy ? `0 0 4px ${color}` : 'none',
          }} />
        </Button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" style={{ width: 300 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
          {/* Header */}
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '8px 12px', borderBottom: '1px solid var(--border)',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <img src={hindsightIcon} alt="" style={{ width: 14, height: 14 }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--foreground)' }}>Hindsight</span>
              <span style={{
                fontSize: 10, color: 'var(--muted-foreground)',
                fontFamily: '"JetBrains Mono",monospace', opacity: 0.6,
              }}>
                {bankId}
              </span>
            </div>
            <span style={{
              fontSize: 10, padding: '1px 6px', borderRadius: 3,
              background: data.healthy ? 'rgba(74,222,128,0.15)' : data.enabled ? 'rgba(248,113,113,0.15)' : 'rgba(82,82,82,0.15)',
              color: data.healthy ? '#4ADE80' : data.enabled ? '#F87171' : '#737373',
            }}>
              {data.healthy ? 'healthy' : data.active ? 'unhealthy' : data.enabled ? 'inactive' : 'disabled'}
            </span>
          </div>

          {/* Bank Stats */}
          {stats && (
            <div style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--foreground)', fontFamily: '"JetBrains Mono",monospace' }}>
                    {stats.total_nodes}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>memories</div>
                </div>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--foreground)', fontFamily: '"JetBrains Mono",monospace' }}>
                    {stats.total_documents}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>documents</div>
                </div>
                <div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: 'var(--foreground)', fontFamily: '"JetBrains Mono",monospace' }}>
                    {stats.total_observations}
                  </div>
                  <div style={{ fontSize: 9, color: 'var(--muted-foreground)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>observations</div>
                </div>
              </div>
              {stats.pending_operations > 0 && (
                <div style={{ marginTop: 6, fontSize: 10, color: '#FACC15' }}>
                  {stats.pending_operations} operation{stats.pending_operations > 1 ? 's' : ''} pending
                </div>
              )}
              {stats.failed_operations > 0 && (
                <div style={{ marginTop: 4, fontSize: 10, color: '#F87171' }}>
                  {stats.failed_operations} failed operation{stats.failed_operations > 1 ? 's' : ''}
                </div>
              )}
            </div>
          )}

          {/* Footer */}
          {onOpenSettings && (
            <div style={{ padding: '6px 12px' }}>
              <button
                onClick={onOpenSettings}
                style={{
                  fontSize: 11, color: 'var(--muted-foreground)', background: 'none',
                  border: 'none', cursor: 'pointer', textDecoration: 'underline',
                  padding: 0, opacity: 0.7,
                }}
              >
                Memory settings...
              </button>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
