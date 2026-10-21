// Gerencia as ferramentas externas: yt-dlp, ffmpeg, ffprobe e deno.
// Elas são baixadas na primeira execução para a pasta de dados do app.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const extract = require('extract-zip');
const { run, IS_WIN } = require('./proc');

const IS_MAC = process.platform === 'darwin';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const exe = (name) => (IS_WIN ? `${name}.exe` : name);

let binDir = null;

function init(dir) {
  binDir = dir;
  fs.mkdirSync(binDir, { recursive: true });
}

function toolPath(name) {
  return path.join(binDir, exe(name));
}

function catalog() {
  const gh = (repo, file) => `https://github.com/${repo}/releases/latest/download/${file}`;
  if (IS_MAC) {
    const riedl = (kind, file) =>
      `https://ffmpeg.martin-riedl.de/redirect/latest/macos/${ARCH === 'arm64' ? 'arm64' : 'amd64'}/${kind}/${file}`;
    return [
      { id: 'yt-dlp', label: 'yt-dlp', files: ['yt-dlp'], sources: [{ url: gh('yt-dlp/yt-dlp', 'yt-dlp_macos'), type: 'bin' }] },
      { id: 'ffmpeg', label: 'ffmpeg', files: ['ffmpeg'], sources: [
        { url: riedl('release', 'ffmpeg.zip'), type: 'zip' },
        { url: riedl('snapshot', 'ffmpeg.zip'), type: 'zip' },
      ] },
      { id: 'ffprobe', label: 'ffprobe', files: ['ffprobe'], sources: [
        { url: riedl('release', 'ffprobe.zip'), type: 'zip' },
        { url: riedl('snapshot', 'ffprobe.zip'), type: 'zip' },
      ] },
      { id: 'deno', label: 'Deno', files: ['deno'], sources: [
        { url: gh('denoland/deno', `deno-${ARCH === 'arm64' ? 'aarch64' : 'x86_64'}-apple-darwin.zip`), type: 'zip' },
      ] },
    ];
  }
  if (IS_WIN) {
    return [
      { id: 'yt-dlp', label: 'yt-dlp', files: ['yt-dlp'], sources: [{ url: gh('yt-dlp/yt-dlp', 'yt-dlp.exe'), type: 'bin' }] },
      { id: 'ffmpeg', label: 'ffmpeg + ffprobe', files: ['ffmpeg', 'ffprobe'], sources: [
        { url: gh('BtbN/FFmpeg-Builds', 'ffmpeg-master-latest-win64-gpl.zip'), type: 'zip' },
      ] },
      { id: 'deno', label: 'Deno', files: ['deno'], sources: [
        { url: gh('denoland/deno', 'deno-x86_64-pc-windows-msvc.zip'), type: 'zip' },
      ] },
    ];
  }
  // Linux (não é o alvo principal, mas funciona se as ferramentas existirem)
  return [
    { id: 'yt-dlp', label: 'yt-dlp', files: ['yt-dlp'], sources: [{ url: gh('yt-dlp/yt-dlp', 'yt-dlp_linux'), type: 'bin' }] },
    { id: 'ffmpeg', label: 'ffmpeg + ffprobe', files: ['ffmpeg', 'ffprobe'], sources: [
      { url: gh('BtbN/FFmpeg-Builds', 'ffmpeg-master-latest-linux64-gpl.tar.xz'), type: 'tar' },
    ] },
    { id: 'deno', label: 'Deno', files: ['deno'], sources: [
      { url: gh('denoland/deno', 'deno-x86_64-unknown-linux-gnu.zip'), type: 'zip' },
    ] },
  ];
}

function status() {
  const tools = catalog().map((t) => ({
    id: t.id,
    label: t.label,
    installed: t.files.every((f) => fs.existsSync(toolPath(f))),
  }));
  return { ready: tools.every((t) => t.installed), tools, binDir };
}

async function download(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ao baixar ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    done += chunk.length;
    onProgress(total ? done / total : 0, done, total);
  });
  await pipeline(body, fs.createWriteStream(dest));
}

async function findFile(dir, name) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = await findFile(p, name);
      if (found) return found;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}

async function installTool(tool, onProgress) {
  let lastErr;
  for (const src of tool.sources) {
    const tmpDir = path.join(binDir, `.tmp-${tool.id}-${Date.now()}`);
    await fsp.mkdir(tmpDir, { recursive: true });
    try {
      if (src.type === 'bin') {
        const dest = toolPath(tool.files[0]);
        const part = `${dest}.part`;
        await download(src.url, part, onProgress);
        await fsp.rename(part, dest);
      } else {
        const archive = path.join(tmpDir, src.type === 'zip' ? 'pkg.zip' : 'pkg.tar.xz');
        await download(src.url, archive, onProgress);
        onProgress(1, 0, 0, 'Extraindo...');
        if (src.type === 'zip') {
          await extract(archive, { dir: path.resolve(tmpDir, 'x') });
        } else {
          await fsp.mkdir(path.join(tmpDir, 'x'));
          const r = await run('tar', ['-xJf', archive, '-C', path.join(tmpDir, 'x')]);
          if (r.code !== 0) throw new Error(r.stderr);
        }
        for (const f of tool.files) {
          const found = await findFile(path.join(tmpDir, 'x'), exe(f));
          if (!found) throw new Error(`${exe(f)} não encontrado no pacote`);
          await fsp.copyFile(found, toolPath(f));
        }
      }
      if (!IS_WIN) for (const f of tool.files) await fsp.chmod(toolPath(f), 0o755);
      await fsp.rm(tmpDir, { recursive: true, force: true });
      return;
    } catch (err) {
      lastErr = err;
      await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw lastErr;
}

// Instala o que estiver faltando (ou tudo, se force=true).
async function installAll(onProgress, force = false) {
  const list = catalog();
  for (let i = 0; i < list.length; i++) {
    const tool = list[i];
    const installed = tool.files.every((f) => fs.existsSync(toolPath(f)));
    if (installed && !force) continue;
    onProgress({ tool: tool.label, index: i, count: list.length, progress: 0, message: `Baixando ${tool.label}...` });
    await installTool(tool, (p, done, total, msg) => {
      onProgress({
        tool: tool.label, index: i, count: list.length, progress: p,
        message: msg || `Baixando ${tool.label}... ${total ? `${(done / 1048576).toFixed(0)} de ${(total / 1048576).toFixed(0)} MB` : ''}`,
      });
    });
  }
  onProgress({ done: true, message: 'Ferramentas prontas' });
}

async function updateYtDlp() {
  const r = await run(toolPath('yt-dlp'), ['-U']);
  const text = `${r.stdout}\n${r.stderr}`.trim();
  return { ok: r.code === 0, output: text };
}

async function versions() {
  const first = async (name, args) => {
    try {
      const r = await run(toolPath(name), args);
      return (r.stdout || r.stderr).split(/\r?\n/)[0].trim();
    } catch {
      return 'não instalado';
    }
  };
  return {
    'yt-dlp': await first('yt-dlp', ['--version']),
    ffmpeg: (await first('ffmpeg', ['-hide_banner', '-version'])).replace(/ Copyright.*$/, ''),
    deno: await first('deno', ['--version']),
  };
}

module.exports = { init, toolPath, status, installAll, updateYtDlp, versions, binDir: () => binDir };
