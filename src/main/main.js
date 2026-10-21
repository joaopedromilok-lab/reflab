const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const tools = require('./tools');
const settings = require('./settings');
const history = require('./history');
const jobs = require('./jobs');
const study = require('./study');

let win = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0f0f10',
    title: 'RefLab',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  // Links externos abrem no navegador padrão.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

async function autoUpdateYtDlp() {
  const s = settings.get();
  if (!s.autoUpdate || !tools.status().ready) return;
  if (Date.now() - s.lastUpdateCheck < 24 * 3600 * 1000) return;
  settings.set({ lastUpdateCheck: Date.now() });
  const r = await tools.updateYtDlp().catch(() => null);
  if (r) send('tools:autoUpdated', r);
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({ version: app.getVersion(), platform: process.platform, arch: process.arch }));

  ipcMain.handle('tools:status', () => tools.status());
  ipcMain.handle('tools:install', async (_e, force) => {
    await tools.installAll((p) => send('tools:progress', p), !!force);
    return tools.status();
  });
  ipcMain.handle('tools:updateYtDlp', () => tools.updateYtDlp());
  ipcMain.handle('tools:versions', () => tools.versions());

  ipcMain.handle('settings:get', () => settings.get());
  ipcMain.handle('settings:set', (_e, partial) => {
    const s = settings.set(partial);
    jobs.setConcurrency(s.concurrency);
    return s;
  });

  ipcMain.handle('dialog:folder', async (_e, current) => {
    const r = await dialog.showOpenDialog(win, { defaultPath: current, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('dialog:video', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [
        { name: 'Vídeos', extensions: ['mp4', 'mov', 'mkv', 'webm', 'm4v', 'avi', 'mxf', 'mts', 'm2ts'] },
        { name: 'Todos os arquivos', extensions: ['*'] },
      ],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('jobs:list', () => jobs.list());
  ipcMain.handle('jobs:add', (_e, kind, params) => jobs.add(kind, params));
  ipcMain.handle('jobs:cancel', (_e, id) => jobs.cancel(id));
  ipcMain.handle('jobs:remove', (_e, id) => jobs.remove(id));
  ipcMain.handle('jobs:retry', (_e, id) => jobs.retry(id));
  ipcMain.handle('jobs:clearFinished', () => jobs.clearFinished());

  ipcMain.handle('study:load', (_e, file) => study.loadAnalysis(file));

  ipcMain.handle('history:list', () => history.list());
  ipcMain.handle('history:remove', (_e, id) => history.remove(id));
  ipcMain.handle('history:clear', () => history.clear());

  ipcMain.handle('fs:exists', (_e, p) => !!p && fs.existsSync(p));
  ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:external', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  jobs.events.on('update', (job) => send('jobs:update', job));
  jobs.events.on('removed', (id) => send('jobs:removed', id));
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  tools.init(path.join(userData, 'bin'));
  settings.init(userData, app.getPath('downloads'));
  history.init(userData);
  jobs.setConcurrency(settings.get().concurrency);
  registerIpc();
  createWindow();
  setTimeout(autoUpdateYtDlp, 5000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  jobs.cancelAll();
  settings.flush();
  history.flush();
});

app.on('window-all-closed', () => app.quit());
