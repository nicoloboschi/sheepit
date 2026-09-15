// The desktop shell's one addition to the UI: native browser views a pane can
// place over itself. Everything else in the app is the same web UI as in a tab.
const { contextBridge, ipcRenderer } = require('electron');

// The window has no title bar (titleBarStyle: 'hiddenInset'), so the top bars
// are where it is dragged from, and the traffic lights sit over the sidebar
// header. Desktop-only, so it lives here rather than in the UI's stylesheet.
const DESKTOP_CSS = `
.desktop-app .sidebar-header,
.desktop-app .workspace-bar,
.desktop-app .sidebar-shell-collapsed { -webkit-app-region: drag; }
.desktop-app :is(.sidebar-header, .workspace-bar, .sidebar-shell-collapsed)
  :is(button, input, select, textarea, a, [role="button"], [contenteditable="true"]),
.desktop-app .sidebar-resize-handle { -webkit-app-region: no-drag; }
/* Room for the traffic lights (trafficLightPosition in main.cjs). */
.desktop-app .sidebar-header { padding-left: 84px; }
.desktop-app .sidebar-shell-collapsed { padding-top: 40px; }
.desktop-app:has(.sidebar-shell-collapsed) .workspace-bar { padding-left: 52px; }
`;
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.classList.add('desktop-app');
  const style = document.createElement('style');
  style.textContent = DESKTOP_CSS;
  document.head.appendChild(style);
});

// A sheepit shortcut pressed while a page had focus (see before-input-event in
// main.cjs), replayed as the keydown App.tsx already listens for. DOM events
// cross from this isolated world to the page's, so the UI needs no new code.
ipcRenderer.on('browser:shortcut', (_event, { key, shiftKey }) => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, metaKey: true, bubbles: true, cancelable: true }));
});

contextBridge.exposeInMainWorld('sheepitDesktop', {
  browser: {
    open: (id, url) => ipcRenderer.send('browser:open', id, url),
    bounds: (id, rect) => ipcRenderer.send('browser:bounds', id, rect),
    close: id => ipcRenderer.send('browser:close', id),
    navigate: (id, url) => ipcRenderer.send('browser:navigate', id, url),
    back: id => ipcRenderer.send('browser:back', id),
    forward: id => ipcRenderer.send('browser:forward', id),
    reload: id => ipcRenderer.send('browser:reload', id),
    zoom: (id, factor) => ipcRenderer.send('browser:zoom', id, factor),
    screenshot: id => ipcRenderer.invoke('browser:screenshot', id),
    onState: cb => {
      const handler = (_event, id, state) => cb(id, state);
      ipcRenderer.on('browser:state', handler);
      return () => ipcRenderer.removeListener('browser:state', handler);
    },
  },
});
