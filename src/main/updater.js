// Atualização do próprio RefLab pelas Releases do GitHub.
// Mac: baixa o .zip, troca o RefLab.app em Aplicativos e reabre.
// Windows: baixa o instalador e roda em modo silencioso, que reabre o app.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { run } = require('./proc');

const REPO = 'joaopedromilok-lab/reflab';
const IS_MAC = process.platform === 'darwin';
const IS_WIN = process.platform === 'win32';

function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

function assetFor(release) {
  const assets = release.assets || [];
  if (IS_MAC) return assets.find((a) => /mac-arm64\.zip$/i.test(a.name));
  if (IS_WIN) return assets.find((a) => /Setup.*\.exe$/i.test(a.name));
  return null;
}

async function check(currentVersion) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'RefLab', Accept: 'application/vnd.github+json' },
  });
  if (res.status === 404) return { available: false, current: currentVersion, message: 'Nenhuma versão publicada ainda.' };
  if (!res.ok) throw new Error(`GitHub respondeu ${res.status}`);
  const release = await res.json();
  const latest = String(release.tag_name || '').replace(/^v/, '');
  const asset = assetFor(release);
  const available = compareVersions(latest, currentVersion) > 0 && !!asset;
  return {
    available,
    current: currentVersion,
    latest,
    notes: release.body || '',
    url: release.html_url,
    asset: asset ? { name: asset.name, url: asset.browser_download_url, size: asset.size } : null,
  };
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'RefLab' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ao baixar a atualização`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { done += c.length; if (total) onProgress(done / total); });
  await pipeline(body, fs.createWriteStream(dest));
}

function currentMacBundle() {
  // .../RefLab.app/Contents/MacOS/RefLab -> .../RefLab.app
  return path.resolve(process.execPath, '..', '..', '..');
}

// Baixa e prepara a atualização. Depois disso o app precisa fechar:
// um script separado termina a troca e reabre o RefLab.
async function install(info, onProgress) {
  if (!info || !info.asset) throw new Error('Nenhuma atualização disponível.');
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflab-update-'));
  const file = path.join(work, info.asset.name);
  await download(info.asset.url, file, onProgress);

  if (IS_MAC) {
    const dest = currentMacBundle();
    if (!dest.endsWith('.app')) throw new Error('Não encontrei o RefLab.app (rodando em modo de desenvolvimento?).');
    if (dest.includes('/AppTranslocation/')) {
      throw new Error('O macOS está rodando o app de uma pasta temporária. Mova o RefLab para Aplicativos, rode "xattr -cr /Applications/RefLab.app" e tente de novo.');
    }
    await fsp.access(path.dirname(dest), fs.constants.W_OK).catch(() => {
      throw new Error(`Sem permissão para escrever em ${path.dirname(dest)}.`);
    });
    const extracted = path.join(work, 'novo');
    await fsp.mkdir(extracted);
    const r = await run('ditto', ['-x', '-k', file, extracted]);
    if (r.code !== 0) throw new Error(`Falha ao extrair: ${r.stderr}`);
    const newApp = path.join(extracted, 'RefLab.app');
    if (!fs.existsSync(newApp)) throw new Error('O pacote da atualização não contém o RefLab.app.');

    const script = path.join(work, 'atualizar.sh');
    await fsp.writeFile(script, [
      '#!/bin/bash',
      'PID="$1"; NEW="$2"; DEST="$3"; WORK="$4"',
      'for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done',
      'rm -rf "$DEST.old"',
      'if mv "$DEST" "$DEST.old" && mv "$NEW" "$DEST"; then',
      '  rm -rf "$DEST.old"',
      'else',
      '  [ -d "$DEST.old" ] && [ ! -d "$DEST" ] && mv "$DEST.old" "$DEST"',
      'fi',
      'xattr -cr "$DEST" 2>/dev/null',
      'open "$DEST"',
      'rm -rf "$WORK"',
      '',
    ].join('\n'), { mode: 0o755 });
    const child = spawn('/bin/bash', [script, String(process.pid), newApp, dest, work], { detached: true, stdio: 'ignore' });
    child.unref();
    return;
  }

  if (IS_WIN) {
    // /S = instalação silenciosa no mesmo lugar; --force-run reabre o app no final.
    const child = spawn(file, ['/S', '--force-run'], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
    return;
  }

  throw new Error('Atualização automática não suportada neste sistema.');
}

module.exports = { check, install, compareVersions, REPO };
