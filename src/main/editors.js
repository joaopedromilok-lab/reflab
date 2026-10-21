// Encontra o Premiere e o DaVinci instalados e abre arquivos neles.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

function safeList(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function find() {
  const found = [];
  if (IS_MAC) {
    // Ex.: /Applications/Adobe Premiere Pro 2025/Adobe Premiere Pro 2025.app
    const premiere = safeList('/Applications')
      .filter((d) => /^Adobe Premiere Pro/.test(d))
      .sort()
      .reverse()
      .map((d) => {
        const dir = path.join('/Applications', d);
        const app = safeList(dir).find((f) => /^Adobe Premiere Pro.*\.app$/.test(f));
        return app ? path.join(dir, app) : null;
      })
      .find(Boolean);
    if (premiere) found.push({ id: 'premiere', name: 'Premiere', path: premiere });
    const resolve = ['/Applications/DaVinci Resolve/DaVinci Resolve.app', '/Applications/DaVinci Resolve.app']
      .find((p) => fs.existsSync(p));
    if (resolve) found.push({ id: 'resolve', name: 'DaVinci Resolve', path: resolve });
  } else if (IS_WIN) {
    const adobe = 'C:\\Program Files\\Adobe';
    const premiere = safeList(adobe)
      .filter((d) => /^Adobe Premiere Pro/.test(d))
      .sort()
      .reverse()
      .map((d) => path.join(adobe, d, 'Adobe Premiere Pro.exe'))
      .find((p) => fs.existsSync(p));
    if (premiere) found.push({ id: 'premiere', name: 'Premiere', path: premiere });
    const resolve = 'C:\\Program Files\\Blackmagic Design\\DaVinci Resolve\\Resolve.exe';
    if (fs.existsSync(resolve)) found.push({ id: 'resolve', name: 'DaVinci Resolve', path: resolve });
  }
  return found;
}

// O Premiere abre o arquivo (vídeo ou XML de timeline). O DaVinci não aceita
// abrir arquivos assim: ele só é aberto, e o arquivo é importado por dentro dele.
function open(editorId, file) {
  const ed = find().find((e) => e.id === editorId);
  if (!ed) throw new Error('Editor não encontrado neste computador.');
  const args = editorId === 'premiere' && file ? [file] : [];
  if (IS_MAC) {
    spawn('open', ['-a', ed.path, ...args], { detached: true, stdio: 'ignore' }).unref();
  } else {
    spawn(ed.path, args, { detached: true, stdio: 'ignore' }).unref();
  }
  return true;
}

module.exports = { find, open };
