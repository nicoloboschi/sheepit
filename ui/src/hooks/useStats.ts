import { useState, useEffect, useRef } from 'react';

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
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    async function fetchStats() {
      try {
        const url = sessionId
          ? `/api/stats?session_id=${encodeURIComponent(sessionId)}`
          : '/api/stats';
        const res = await fetch(url);
        if (res.ok) setStats(await res.json());
      } catch {
        // ignore
      }
    }

    fetchStats();
    timerRef.current = setInterval(fetchStats, intervalMs);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [sessionId, intervalMs]);

  return stats;
}
