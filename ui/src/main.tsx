import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import 'xterm/css/xterm.css';
import { initServerUrl, needsConnect, setServerUrl, installFetchInterceptor } from './serverUrl';
import ConnectScreen from './components/ConnectScreen';
import { initializePreferences } from './preferences';
import { applyTheme, readTheme } from './theme';
import { initNative } from './native';

// The connection URL is the only browser-local bootstrap setting. Once it is
// known, every durable Sheepit preference comes from the backend profile.
initServerUrl();
installFetchInterceptor();

// Swallow xterm.js's benign async renderer race:
// "Cannot read properties of undefined (reading 'dimensions')"
// This fires when xterm's Viewport schedules a refresh before its
// renderer is fully initialized. The error is harmless — the terminal
// recovers on the next render cycle.
window.addEventListener('error', (e) => {
  if (e.message?.includes("reading 'dimensions'") || e.error?.message?.includes("reading 'dimensions'")) {
    e.preventDefault();
    e.stopImmediatePropagation();
    return false;
  }
}, true);

/**
 * Import App only once the preference profile is in memory.
 *
 * store.ts reads the persisted workspace layout at *module* scope, so
 * importing App is what freezes the store's starting state. If that happens
 * before initializePreferences() has run — which is exactly the standalone /
 * APK first-connect path, where the profile only becomes reachable after the
 * user supplies a server URL — the store starts from an empty layout, then
 * reconciles it against the session list, invents one single-pane workspace
 * per session and persists that over the real layout (store.ts:610).
 *
 * Loading it lazily keeps "preferences first, store second" true on both the
 * already-configured path and the connect path.
 */
function Root() {
  const [App, setApp] = useState<React.ComponentType | null>(null);
  const [needsServer, setNeedsServer] = useState(needsConnect());

  const loadApp = async (): Promise<void> => {
    const { default: Loaded } = await import('./App');
    // setState with a function value needs the updater form, or React would
    // call the component as an updater.
    setApp(() => Loaded);
  };

  useEffect(() => {
    if (!needsServer) void loadApp();
  }, [needsServer]);

  if (needsServer) {
    return (
      <ConnectScreen
        onConnected={async (url) => {
          setServerUrl(url);
          installFetchInterceptor();
          await initializePreferences();
          applyTheme(readTheme());
          setNeedsServer(false);
        }}
      />
    );
  }

  // Blank on the app background while the App chunk loads — a spinner would
  // flash for a few frames on an already-configured client.
  if (!App) return <div style={{ height: '100dvh', background: '#0b0d0a' }} />;

  return <App />;
}

async function bootstrap(): Promise<void> {
  // Status bar / keyboard / notification permission in the Android app.
  // No-ops in a browser. Not awaited: nothing below depends on it, and the
  // notification permission prompt shouldn't hold up first paint.
  void initNative();

  if (!needsConnect()) {
    await initializePreferences();
  }
  applyTheme(readTheme());
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}

void bootstrap();
