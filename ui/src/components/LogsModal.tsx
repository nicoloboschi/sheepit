import { useEffect, useRef, useState } from 'react';
import ConfigDialog from './ConfigDialog';
import { apiUrl } from '../serverUrl';

interface LogEntry {
  ts: string;
  level: string;
  msg: string;
}

interface LogsModalProps {
  onClose: () => void;
}

export function LogsContent() {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // apiUrl() rather than a bare path: when the UI is detached from the
    // server that served it (installed PWA, Android APK) a relative URL points
    // at the app bundle, not the dataplane. Note that EventSource is one of
    // the few requests CapacitorHttp does not proxy, so this stays subject to
    // CORS and will stay empty against a server that sends no CORS headers.
    const es = new EventSource(apiUrl('/api/logs/stream'));
    es.onmessage = (e) => {
      const entry: LogEntry = JSON.parse(e.data);
      setLogs(prev => {
        const next = [...prev, entry];
        return next.length > 500 ? next.slice(-500) : next;
      });
    };
    return () => es.close();
  }, []);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'instant' as ScrollBehavior });
  }, [logs]);

  return (
    <div className="p-4 flex-1 min-h-0">
      <div className="settings-logs-body">
        {logs.length === 0 && <span style={{ color: 'var(--muted-foreground)' }}>No logs yet\u2026</span>}
        {logs.map((l, i) => (
          <div key={i} className={`log-entry ${l.level}`}>
            {l.ts} {l.level.padEnd(8)} {l.msg}
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

export default function LogsModal({ onClose }: LogsModalProps) {
  return (
    <ConfigDialog open onClose={onClose}>
      <LogsContent />
    </ConfigDialog>
  );
}
