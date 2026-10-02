import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import 'xterm/css/xterm.css';
import { initServerUrl, needsConnect, setServerUrl, installFetchInterceptor } from './serverUrl';
import ConnectScreen from './components/ConnectScreen';
import { initializePreferences } from './preferences';
import { applyTheme, readTheme } from './theme';
import { initNative } from './native';
import { startPerf } from './perf';

// The connection URL is the only browser-local bootstrap setting. Once it is
// known, every durable Sheepit preference comes from the backend profile.
initServerUrl();
installFetchInterceptor();
// The one perf measurement in the UI. Always on; see perf.ts.
startPerf();

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
  const [loadError, setLoadError] = useState<string | null>(null);

  // Retried, and never silent. A rejected `import('./App')` used to leave the
  // placeholder div below on screen for ever: a black rectangle, no spinner, no
  // message, and no second attempt — so a chunk that failed once (a dev server
  // mid-restart, a module briefly broken by an edit, a dropped network) looked
  // exactly like an app that had crashed with no way back but a manual reload.
  // Both halves matter: the retry gets the window back on its own, and the
  // message means a permanent failure says what it was.
  useEffect(() => {
    if (needsServer) return;
    let cancelled = false;
    void (async () => {
      for (let attempt = 0, delay = 300; !cancelled; attempt++, delay = Math.min(delay * 2, 5000)) {
        try {
          const { default: Loaded } = await import('./App');
          if (cancelled) return;
          // setState with a function value needs the updater form, or React
          // would call the component as an updater.
          setApp(() => Loaded);
          setLoadError(null);
          return;
        } catch (e) {
          if (cancelled) return;
          setLoadError(String(e));
          console.error(`[sheepit] could not load the app (try ${attempt + 1})`, e);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    })();
    return () => { cancelled = true; };
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
  // flash for a few frames on an already-configured client. Once a load has
  // actually failed there is nothing to be gained by staying blank, so it says
  // so and keeps retrying behind the message.
  if (!App) return (
    <div style={{
      height: '100dvh', background: '#0b0d0a', color: '#9cbc7f',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      font: '13px/1.6 ui-monospace, monospace', padding: 24, textAlign: 'center',
    }}>
      {loadError && <span>Could not load sheepit — retrying.<br /><span style={{ opacity: 0.6 }}>{loadError}</span></span>}
    </div>
  );

  return <App />;
}

/** Keep asking for the preference profile, backing off to 5s, saying so once. */
async function retryUntilPreferences(): Promise<void> {
  for (let attempt = 0, delay = 250; ; attempt++, delay = Math.min(delay * 2, 5000)) {
    try {
      await initializePreferences();
      if (attempt > 0) console.info(`[sheepit] preferences loaded after ${attempt + 1} tries`);
      return;
    } catch (e) {
      if (attempt === 0) console.warn('[sheepit] waiting for the server to answer —', String(e));
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

async function bootstrap(): Promise<void> {
  // Status bar / keyboard / notification permission in the Android app.
  // No-ops in a browser. Not awaited: nothing below depends on it, and the
  // notification permission prompt shouldn't hold up first paint.
  void initNative();

  if (!needsConnect()) {
    // Retried, not skipped. Proceeding without the profile is the destructive
    // path the comment above describes — the store would start from an empty
    // layout and persist its emptiness over the real pens. So a backend that is
    // not answering yet is waited out.
    //
    // Before this, an unreachable backend at load time threw here and nothing
    // was ever rendered: a blank window, with no spinner and no error, until
    // somebody thought to reload. A backend restart is routine in dev, so this
    // was the commonest way to end up looking at a black rectangle.
    await retryUntilPreferences();
  }
  applyTheme(readTheme());
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root />
    </React.StrictMode>
  );
}

void bootstrap();
