import { useState, useCallback } from 'react';
import { usePoll } from './usePoll';

export interface StatsProcess {
  pid: number;
  name: string;
  cpu_percent: number;
  mem_mb: number;
}

export interface Stats {
  /** This pane's child processes. The server used to also return machine-wide
   *  cpu/mem here; nothing rendered them, so they are gone. */
  processes: StatsProcess[];
}

export function useStats(sessionId: string | null, intervalMs = 2000): Stats | null {
  const [stats, setStats] = useState<Stats | null>(null);

  usePoll(useCallback(async () => {
    const url = sessionId
      ? `/api/stats?session_id=${encodeURIComponent(sessionId)}`
      : '/api/stats';
    try {
      const res = await fetch(url);
      if (res.ok) setStats(await res.json());
    } catch { /* decorative — show nothing rather than an error */ }
  }, [sessionId]), intervalMs, sessionId);

  return stats;
}
