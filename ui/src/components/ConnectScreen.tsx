import { useState } from 'react';
import { Wifi, Loader2 } from 'lucide-react';
import { getServerUrl } from '../serverUrl';
import SheepIcon from './SheepIcon';

interface ConnectScreenProps {
  onConnected: (serverUrl: string) => void;
}

export default function ConnectScreen({ onConnected }: ConnectScreenProps) {
  const [url, setUrl] = useState(() => {
    const saved = getServerUrl();
    if (saved) return saved;
    // Default to current network
    return 'http://192.168.1.100:4445';
  });
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');

  async function connect() {
    setTesting(true);
    setError('');
    const cleaned = url.replace(/\/+$/, '');
    try {
      const res = await fetch(`${cleaned}/api/version`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data.version) throw new Error('Not a sheepit server');
      onConnected(cleaned);
    } catch (e) {
      setError(`Can't connect: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setTesting(false);
    }
  }

  return (
    <div
      style={{
        height: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'var(--background)',
        color: 'var(--foreground)',
        fontFamily: "'Space Grotesk',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif",
        padding: 24,
        gap: 24,
      }}
    >
      <div style={{ textAlign: 'center', marginBottom: 8 }}>
        <div style={{ marginBottom: 8 }}><SheepIcon size={40} color="var(--primary)" /></div>
        <h1 className="brand-gradient-text" style={{ fontSize: 20, fontWeight: 700, margin: 0, fontFamily: "'Space Grotesk', sans-serif", letterSpacing: '-0.5px' }}>sheepit</h1>
        <p style={{ fontSize: 13, color: 'var(--muted-foreground)', margin: '6px 0 0' }}>Point it at your flock</p>
      </div>

      <div style={{ width: '100%', maxWidth: 340, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ position: 'relative' }}>
          <Wifi size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-foreground)' }} />
          <input
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && connect()}
            placeholder="http://192.168.1.100:4445"
            autoFocus
            style={{
              width: '100%',
              padding: '10px 12px 10px 34px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--card)',
              color: 'var(--foreground)',
              fontSize: 14,
              fontFamily: '"JetBrains Mono",monospace',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {error && (
          <p style={{ fontSize: 12, color: '#E0907B', margin: 0, textAlign: 'center' }}>{error}</p>
        )}

        <button
          onClick={connect}
          disabled={testing || !url.trim()}
          style={{
            padding: '10px 0',
            borderRadius: 8,
            border: 'none',
            background: testing ? 'var(--secondary)' : 'linear-gradient(135deg, #9cbc7f 0%, #6fa98c 100%)',
            color: testing ? 'var(--muted-foreground)' : '#ffffff',
            fontSize: 14,
            fontWeight: 600,
            cursor: testing ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 8,
          }}
        >
          {testing && <Loader2 size={14} className="animate-spin" />}
          {testing ? 'Connecting\u2026' : 'Connect'}
        </button>
      </div>

      <p style={{ fontSize: 11, color: 'var(--muted-foreground)', textAlign: 'center', maxWidth: 280, lineHeight: 1.5 }}>
        Enter the IP and port of your sheepit server.
        Find it in the terminal where you started sheepit.
      </p>
    </div>
  );
}
