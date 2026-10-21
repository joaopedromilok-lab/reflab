const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const tools = require('./tools');
const settings = require('./settings');
const history = require('./history');
const jobs = require('./jobs');
const study = require('./study');
const updater = require('./updater');
const moments = require('./moments');
const transcribe = require('./transcribe');
const editors = require('./editors');
const montage = require('./montage');
const decupagem = require('./decupagem');

let win = null;
let lastUpdate = null;

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

async function checkForUpdate(silent) {
  try {
    lastUpdate = await updater.check(app.getVersion());
    if (lastUpdate.available) send('update:available', lastUpdate);
    return lastUpdate;
  } catch (err) {
    if (silent) return null;
    throw err;
  }
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

  ipcMain.handle('update:check', () => checkForUpdate(false));
  ipcMain.handle('update:install', async () => {
    if (!lastUpdate || !lastUpdate.available) await checkForUpdate(false);
    if (!lastUpdate || !lastUpdate.available) throw new Error('Você já está na versão mais recente.');
    await updater.install(lastUpdate, (p) => send('update:progress', p));
    setTimeout(() => app.quit(), 300);
    return true;
  });

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
  ipcMain.handle('study:update', (_e, file, patch) => study.updateAnalysis(file, patch));
  ipcMain.handle('moments:load', (_e, file) => moments.load(file));
  ipcMain.handle('transcript:load', (_e, file) => transcribe.load(file));
  ipcMain.handle('transcript:models', () => transcribe.modelsStatus());
  ipcMain.handle('transcript:loadTranslated', (_e, file) => transcribe.load(file, true));
  ipcMain.handle('transcript:update', (_e, file, edits) => transcribe.update(file, edits));
  ipcMain.handle('transcript:searchAll', (_e, q) => transcribe.searchAll(q));
  ipcMain.handle('montage:exportXml', async (_e, file, ranges, title) => {
    const t = await transcribe.load(file);
    return montage.exportXml(file, ranges, { title, outDir: t ? t.outDir : undefined });
  });
  ipcMain.handle('compare:load', (_e, files) => decupagem.compare(files));
  ipcMain.handle('captions:presets', () => ({ presets: require('./captions').PRESETS, formats: montage.FORMATS }));
  ipcMain.handle('montage:preview', async (_e, file, range, opts) => {
    let words = [];
    if (opts.withCaptions) {
      const t = await transcribe.load(file);
      if (t) words = require('./captions').allWords(t.segments);
    }
    return montage.preview(file, range, { ...opts, words });
  });
  ipcMain.handle('dialog:image', async () => {
    const r = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      filters: [{ name: 'Imagens', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('dialog:folderOnly', async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle('fs:listMedia', async (_e, dir) => {
    const exts = /\.(mp4|mov|mkv|webm|m4v|avi|mxf|mts|m2ts|wav|mp3|m4a|aac|flac)$/i;
    const out = [];
    const walk = async (d, depth) => {
      for (const ent of await fs.promises.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) {
          if (depth < 2 && !/ - (Análise|Transcrição|Clipes|Momentos|Frames)/.test(ent.name) && ent.name !== 'Proxy') await walk(p, depth + 1);
        } else if (exts.test(ent.name)) {
          out.push({ file: p, transcribed: fs.existsSync(path.join(transcribe.transcriptDir(p), 'transcricao.json')) });
        }
      }
    };
    await walk(dir, 0);
    return out;
  });
  ipcMain.handle('transcript:exportHits', async (_e, file, query, hits) => {
    const t = await transcribe.load(file);
    if (!t) throw new Error('Transcrição não encontrada.');
    return moments.exportTranscriptHits(t, query, hits);
  });
  ipcMain.handle('url:info', (_e, url) => jobs.fetchInfo(url, settings.get()));
  ipcMain.handle('clipboard:read', () => clipboard.readText());
  ipcMain.handle('editors:list', () => editors.find());
  ipcMain.handle('editors:open', (_e, id, file) => editors.open(id, file));

  ipcMain.handle('history:list', () => history.list());
  ipcMain.handle('history:update', (_e, id, patch) => history.update(id, patch));
  ipcMain.handle('history:remove', (_e, id) => history.remove(id));
  ipcMain.handle('history:clear', () => history.clear());

  ipcMain.handle('fs:exists', (_e, p) => !!p && fs.existsSync(p));
  ipcMain.handle('shell:open', (_e, p) => shell.openPath(p));
  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('shell:external', (_e, url) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });

  const notified = new Set();
  jobs.events.on('update', (job) => {
    send('jobs:update', job);
    // Notificação do sistema quando a janela não está em foco.
    if (!['done', 'error'].includes(job.status) || notified.has(job.id)) return;
    notified.add(job.id);
    if (win && win.isFocused()) return;
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: job.status === 'done' ? `${job.kindLabel} concluído` : `${job.kindLabel}: erro`,
      body: job.title || '',
      silent: false,
    });
    n.on('click', () => { if (win) { win.show(); win.focus(); } });
    n.show();
  });
  jobs.events.on('removed', (id) => send('jobs:removed', id));
}

app.whenReady().then(() => {
  const userData = app.getPath('userData');
  tools.init(path.join(userData, 'bin'));
  settings.init(userData, app.getPath('downloads'));
  history.init(userData);
  transcribe.init(path.join(userData, 'modelos'), userData);
  jobs.setConcurrency(settings.get().concurrency);
  registerIpc();
  createWindow();
  setTimeout(autoUpdateYtDlp, 5000);
  if (app.isPackaged) setTimeout(() => checkForUpdate(true), 8000);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('before-quit', () => {
  jobs.cancelAll();
  settings.flush();
  history.flush();
  transcribe.flush();
});

app.on('window-all-closed', () => app.quit());
