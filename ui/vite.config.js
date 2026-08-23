import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// Ports and the proxy target are environment-driven so several checkouts
// (git worktrees, mainly) can run side by side without colliding, and so the
// UI can be pointed at a backend that is already running somewhere else.
// dev.sh exports these; the defaults below keep a bare `npx vite` working.
const uiPort = Number(process.env.VIPERSHELL_UI_PORT ?? 4444);
const backendHost = process.env.VIPERSHELL_BACKEND_HOST ?? 'localhost';
const backendPort = Number(process.env.VIPERSHELL_BACKEND_PORT ?? 4445);

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
  ],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.js'],
  },
  server: {
    port: uiPort,
    host: '0.0.0.0',
    allowedHosts: true,
    proxy: {
      '/api': `http://${backendHost}:${backendPort}`,
      '/ws': {
        target: `ws://${backendHost}:${backendPort}`,
        ws: true,
      },
    },
  },
});
