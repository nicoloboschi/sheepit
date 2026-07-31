const { app, BrowserWindow, dialog } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');

const isDev = process.env.VIPERSHELL_DESKTOP_DEV === '1';
const rootDir = path.resolve(__dirname, '..');
const backendPort = Number(process.env.VIPERSHELL_DESKTOP_PORT ?? 4445);
const vitePort = Number(process.env.VIPERSHELL_VITE_PORT ?? 4444);

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
    const node = process.env.VIPERSHELL_NODE_BINARY || process.env.npm_node_execpath || 'node';
    start(node, [
      path.join(rootDir, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      'watch', '--clear-screen=false', '--ignore', 'ui/**', '--ignore', 'bench/**',
      '--ignore', '*.md', '--ignore', 'branding-preview.html',
      'src/index.ts', '--port', String(backendPort), '--log-level', 'debug',
    ], { NODE_ENV: 'development', VIPERSHELL_HOST: '127.0.0.1' });
  } else {
    start(process.execPath, [path.join(app.getAppPath(), 'dist', 'index.js'),
      '--host', '127.0.0.1', '--port', String(backendPort)], {
      ELECTRON_RUN_AS_NODE: '1',
      NODE_ENV: 'production',
      VIPERSHELL_HOST: '127.0.0.1',
    });
  }
  await waitForPort(backendPort, 'Vipershell backend');
}

async function ensureVite() {
  if (await canConnect(vitePort)) return;
  const node = process.env.VIPERSHELL_NODE_BINARY || process.env.npm_node_execpath || 'node';
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
    },
  });
  mainWindow.on('closed', () => { mainWindow = null; });
  await mainWindow.loadURL(isDev
    ? `http://127.0.0.1:${vitePort}`
    : `http://127.0.0.1:${backendPort}`);
}

function stopOwnedProcesses() {
  for (const child of ownedProcesses) {
    if (!child.killed) child.kill('SIGTERM');
  }
}

app.whenReady().then(createWindow).catch((error) => {
  dialog.showErrorBox('Vipershell failed to start', error.stack || error.message);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('before-quit', stopOwnedProcesses);
