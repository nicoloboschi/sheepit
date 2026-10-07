import { useState } from 'react';
import { Wifi, Loader2, KeyRound } from 'lucide-react';
import { getServerUrl, getServerKey, authHeader } from '../serverUrl';
import SheepIcon from './SheepIcon';

interface ConnectScreenProps {
  /** Awaited, so whatever it does after the handshake — loading preferences,
   *  the theme, the app chunk — reports its failure on this screen instead of
   *  rejecting into nothing. Without the await a rejection here left the
   *  screen sitting there: the error cleared, the spinner stopped, and the
   *  button went back to "Connect" as though nothing had been asked. */
  onConnected: (serverUrl: string, key: string) => void | Promise<void>;
}

export default function ConnectScreen({ onConnected }: ConnectScreenProps) {
  const [url, setUrl] = useState(() => {
    const saved = getServerUrl();
    if (saved) return saved;
    // Default to current network
    return 'http://192.168.1.100:4445';
  });
  const [key, setKey] = useState(getServerKey);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState('');

  async function connect() {
    setTesting(true);
    setError('');
    // A pasted URL often carries its own credentials, and typing them twice is
    // a way to get one of them wrong. `https://user:pass@host` is split here,
    // the password kept and the userinfo dropped — it must not be sent on the
    // wire, where proxies log it.
    let cleaned = url.trim().replace(/\/+$/, '');
    // **A bare hostname is a relative URL to fetch()**, which resolves against
    // the WebView's own `localhost` origin and quietly returns the app's own
    // index.html. That is indistinguishable from a server answering wrongly,
    // so the scheme is filled in rather than left to chance: http for an IP or
    // localhost, which is a LAN server, https for a name, which is a tunnel.
    if (!/^https?:\/\//i.test(cleaned)) {
      const bare = cleaned.split('/')[0]!.split(':')[0]!;
      const local = /^(\d{1,3}\.){3}\d{1,3}$/.test(bare) || /^localhost$/i.test(bare) || bare.endsWith('.local');
      cleaned = `${local ? 'http' : 'https'}://${cleaned}`;
    }
    let k = key;
    try {
      const u = new URL(cleaned);
      if (u.password) { k = decodeURIComponent(u.password); u.username = ''; u.password = ''; cleaned = u.toString().replace(/\/+$/, ''); }
    } catch { /* not a full URL yet — let the fetch below say so */ }

    try {
      const res = await fetch(`${cleaned}/api/version`, {
        headers: authHeader(k),
        signal: AbortSignal.timeout(5000),
      });
      // 401 is not "cannot reach it" — it is the one failure with an obvious
      // fix, and saying `HTTP 401` instead of naming it is how someone ends up
      // retyping a URL that was right all along.
      if (res.status === 401) throw new Error(k ? 'wrong password' : 'this server needs a password');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // **Check what came back before parsing it.** Several things answer 200
      // with HTML — a tunnel's own interstitial, a reverse proxy's error page,
      // this very app when the address was relative — and letting JSON.parse
      // be the one to notice reports it as `Unexpected token '<'`, which sends
      // people off to debug their server when the address is the problem.
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('json')) {
        throw new Error('that address answered with a web page, not sheepit — check it is the right host');
      }
      const data = await res.json();
      if (!data.version) throw new Error('Not a sheepit server');
      setUrl(cleaned); setKey(k);
      await onConnected(cleaned, k);
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
              fontFamily: 'var(--font-mono)',
              outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        <div style={{ position: 'relative' }}>
          <KeyRound size={14} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--muted-foreground)' }} />
          <input
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && connect()}
            placeholder="password (if the server has one)"
            autoComplete="current-password"
            style={{
              width: '100%',
              padding: '10px 12px 10px 34px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--card)',
              color: 'var(--foreground)',
              fontSize: 14,
              fontFamily: 'var(--font-mono)',
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
