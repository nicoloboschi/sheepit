import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
import 'xterm/css/xterm.css';
import { initServerUrl, needsConnect, setServerUrl, installFetchInterceptor } from './serverUrl';
import ConnectScreen from './components/ConnectScreen';
import { initializePreferences, installServerBackedStorage } from './preferences';

// The connection URL is the only browser-local bootstrap setting. Once it is
// known, every durable Vipershell preference comes from the backend profile.
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

function Root({ App }: { App: React.ComponentType }) {
  const [connected, setConnected] = useState(!needsConnect());

  if (!connected) {
    return (
      <ConnectScreen
        onConnected={async (url) => {
          setServerUrl(url);
          installFetchInterceptor();
          await initializePreferences();
          installServerBackedStorage();
          setConnected(true);
        }}
      />
    );
  }

  return <App />;
}

async function bootstrap(): Promise<void> {
  if (!needsConnect()) {
    await initializePreferences();
    installServerBackedStorage();
  }
  const { default: App } = await import('./App');
  createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Root App={App} />
    </React.StrictMode>
  );
}

void bootstrap();
