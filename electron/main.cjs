const { app, BrowserWindow, WebContentsView, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const isDev = process.env.SHEEPIT_DESKTOP_DEV === '1';
const rootDir = path.resolve(__dirname, '..');
const backendPort = Number(process.env.SHEEPIT_DESKTOP_PORT ?? 4445);
const vitePort = Number(process.env.SHEEPIT_VITE_PORT ?? 4444);

/** @type {import('child_process').ChildProcess[]} */
const ownedProcesses = [];
let mainWindow = null;

function canConnect(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(250, () => done(false));
  });
}

async function waitForPort(port, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await canConnect(port)) return;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`${label} did not start on port ${port}`);
}

function start(command, args, env) {
  const child = spawn(command, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: 'inherit',
  });
  ownedProcesses.push(child);
  return child;
}

async function ensureBackend() {
  if (await canConnect(backendPort)) return;

  if (isDev) {
    const node = process.env.SHEEPIT_NODE_BINARY || process.env.npm_node_execpath || 'node';
    start(node, [
      path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'watch', '--clear-screen=false', '--ignore', 'ui/**', '--ignore', 'bench/**',
      '--ignore', '*.md', '--ignore', 'branding-preview.html',
      'src/index.ts', '--port', String(backendPort), '--log-level', 'debug',
    ], { NODE_ENV: 'development', SHEEPIT_HOST: '127.0.0.1' });
  } else {
    start(process.execPath, [path.join(app.getAppPath(), 'dist', 'index.js'),
      '--host', '127.0.0.1', '--port', String(backendPort)], {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      SHEEPIT_HOST: '127.0.0.1',
    });
  }
  await waitForPort(backendPort, 'Sheepit backend');
}

async function ensureVite() {
  if (await canConnect(vitePort)) return;
  const node = process.env.SHEEPIT_NODE_BINARY || process.env.npm_node_execpath || 'node';
  start(node, [path.join(rootDir, 'ui', 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host', '127.0.0.1', '--port', String(vitePort)], { NODE_ENV: 'development' });
  await waitForPort(vitePort, 'Vite');
}

async function createWindow() {
  await ensureBackend();
  if (isDev) await ensureVite();

  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0c0c0c',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(isDev
    ? `http://127.0.0.1:${vitePort}`
    : `http://127.0.0.1:${backendPort}`);
}

// ── Native browser views ─────────────────────────────────────────────────────
// A pane's browser, as a real Chromium view laid over the pane's box — not the
// headless browser streamed as frames. It is in a window you are looking at, so
// it gets the priority, input, IME and clipboard of any browser tab. The UI
// owns the placement (it knows where the pane is); this side only obeys.

/** @type {Map<string, { view: import('electron').WebContentsView, win: BrowserWindow, owner: import('electron').WebContents }>} */
const views = new Map();
const watchedOwners = new WeakSet();

function browserState(view) {
  const wc = view.webContents;
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    loading: wc.isLoading(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
  };
}

function closeView(id) {
  const entry = views.get(id);
  if (!entry) return;
  views.delete(id);
  if (!entry.win.isDestroyed()) entry.win.contentView.removeChildView(entry.view);
  if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
}

/** A UI reload (HMR's full reload, ⌘R) never runs React's unmount, so the views
 *  that UI placed are closed here instead, or they would float over the new page. */
function watchOwner(owner) {
  if (watchedOwners.has(owner)) return;
  watchedOwners.add(owner);
  const closeAll = () => { for (const [id, e] of views) if (e.owner === owner) closeView(id); };
  owner.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) closeAll();
  });
  owner.on('destroyed', closeAll);
}

const viewOf = id => views.get(id)?.view;

ipcMain.on('browser:open', (event, id, url) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || views.has(id)) return;
  const view = new WebContentsView({
    // Its own persistent profile: logins survive restarts, and never mix with
    // the UI's own origin.
    webPreferences: { partition: 'persist:sheepit-browser', sandbox: true, contextIsolation: true },
  });
  view.setVisible(false); // until the UI says where the pane is
  win.contentView.addChildView(view);
  views.set(id, { view, win, owner: event.sender });
  watchOwner(event.sender);

  const push = () => {
    if (!event.sender.isDestroyed() && views.has(id)) event.sender.send('browser:state', id, browserState(view));
  };
  for (const name of ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'page-title-updated']) {
    view.webContents.on(name, push);
  }
  // A target=_blank link stays in the pane rather than opening a bare window.
  view.webContents.setWindowOpenHandler(({ url: next }) => {
    view.webContents.loadURL(next).catch(() => {});
    return { action: 'deny' };
  });
  if (url) view.webContents.loadURL(url).catch(() => {});
});

ipcMain.on('browser:bounds', (_event, id, rect) => {
  const view = viewOf(id);
  if (!view) return;
  if (!rect) { view.setVisible(false); return; }
  view.setBounds({
    x: Math.round(rect.x), y: Math.round(rect.y),
    width: Math.max(1, Math.round(rect.width)), height: Math.max(1, Math.round(rect.height)),
  });
  view.setVisible(true);
});

ipcMain.on('browser:close', (_event, id) => closeView(id));
// loadURL rejects when a navigation is superseded; that is not an error here.
ipcMain.on('browser:navigate', (_event, id, url) => viewOf(id)?.webContents.loadURL(url).catch(() => {}));
ipcMain.on('browser:back', (_event, id) => viewOf(id)?.webContents.navigationHistory.goBack());
ipcMain.on('browser:forward', (_event, id) => viewOf(id)?.webContents.navigationHistory.goForward());
ipcMain.on('browser:reload', (_event, id) => viewOf(id)?.webContents.reload());
ipcMain.on('browser:zoom', (_event, id, factor) => viewOf(id)?.webContents.setZoomFactor(factor));
ipcMain.handle('browser:screenshot', async (_event, id) => {
  const view = viewOf(id);
  if (!view) return '';
  return (await view.webContents.capturePage()).toPNG().toString('base64');
});

function stopOwnedProcesses() {
  for (const child of ownedProcesses) {
    if (!child.killed) child.kill('SIGTERM');
  }
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Sheepit failed to start', error.stack || error.message);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', stopOwnedProcesses);
