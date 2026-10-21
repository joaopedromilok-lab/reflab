// Transcrição local com whisper.cpp (sem internet depois de baixar o modelo).
// Mac: o whisper-cli vem dentro do app (compilado no GitHub Actions, com Metal).
// Windows: é baixado das releases oficiais do whisper.cpp na primeira vez.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const extract = require('extract-zip');
const { start } = require('./proc');
const tools = require('./tools');
const media = require('./media');

const IS_WIN = process.platform === 'win32';

const MODELS = {
  base: { file: 'ggml-base.bin', label: 'Rápido (150 MB)' },
  small: { file: 'ggml-small.bin', label: 'Equilibrado (490 MB)' },
  turbo: { file: 'ggml-large-v3-turbo-q5_0.bin', label: 'Preciso (575 MB)' },
};
const MODEL_URL = (f) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${f}`;

let modelsDir = null;
function init(dir) {
  modelsDir = dir;
}

function whisperDir() {
  return path.join(tools.binDir(), 'whisper');
}

function whisperPath() {
  const name = IS_WIN ? 'whisper-cli.exe' : 'whisper-cli';
  const bundled = process.resourcesPath && path.join(process.resourcesPath, 'whisper', name);
  if (bundled && fs.existsSync(bundled)) return bundled;
  return path.join(whisperDir(), name);
}

async function findFile(dir, name) {
  for (const e of await fsp.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const f = await findFile(p, name);
      if (f) return f;
    } else if (e.name === name) {
      return p;
    }
  }
  return null;
}

async function downloadTo(url, dest, onProgress) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'RefLab' } });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ao baixar ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  let done = 0;
  const { Readable } = require('stream');
  const { pipeline } = require('stream/promises');
  const body = Readable.fromWeb(res.body);
  body.on('data', (c) => { done += c.length; if (total && onProgress) onProgress(done / total); });
  await pipeline(body, fs.createWriteStream(`${dest}.part`));
  await fsp.rename(`${dest}.part`, dest);
}

async function ensureWhisper(onPhase, onProgress) {
  if (fs.existsSync(whisperPath())) return whisperPath();
  if (!IS_WIN) throw new Error('O transcritor não veio com esta versão do app. Atualize o RefLab.');
  onPhase('Baixando o transcritor (whisper.cpp)...');
  const res = await fetch('https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=15', {
    headers: { 'User-Agent': 'RefLab' },
  });
  const releases = await res.json();
  let url = null;
  for (const r of Array.isArray(releases) ? releases : []) {
    const a = (r.assets || []).find((x) => x.name === 'whisper-bin-x64.zip');
    if (a) { url = a.browser_download_url; break; }
  }
  if (!url) throw new Error('Não encontrei o whisper.cpp para Windows.');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflab-whisper-'));
  const zip = path.join(tmp, 'w.zip');
  await downloadTo(url, zip, onProgress);
  await extract(zip, { dir: path.join(tmp, 'x') });
  const cli = await findFile(path.join(tmp, 'x'), 'whisper-cli.exe');
  if (!cli) throw new Error('whisper-cli.exe não encontrado no pacote.');
  await fsp.rm(whisperDir(), { recursive: true, force: true });
  await fsp.cp(path.dirname(cli), whisperDir(), { recursive: true });
  await fsp.rm(tmp, { recursive: true, force: true });
  return whisperPath();
}

async function ensureModel(model, onPhase, onProgress) {
  const m = MODELS[model] || MODELS.small;
  await fsp.mkdir(modelsDir, { recursive: true });
  const dest = path.join(modelsDir, m.file);
  if (fs.existsSync(dest)) return dest;
  onPhase(`Baixando o modelo de transcrição ${m.label} (só na primeira vez)...`);
  await downloadTo(MODEL_URL(m.file), dest, onProgress);
  return dest;
}

function transcriptDir(file) {
  return path.join(path.dirname(file), `${path.basename(file, path.extname(file))} - Transcrição`);
}

async function load(file) {
  try {
    return JSON.parse(await fsp.readFile(path.join(transcriptDir(file), 'transcricao.json'), 'utf8'));
  } catch {
    return null;
  }
}

async function transcribe(file, { language = 'pt', model = 'small', onPhase = () => {}, onProgress, onStart } = {}) {
  const info = await media.probe(file);
  if (!info.hasAudio) throw new Error('O arquivo não tem áudio.');
  const cli = await ensureWhisper(onPhase, onProgress);
  const modelPath = await ensureModel(model, onPhase, onProgress);

  onPhase('Preparando o áudio...');
  const outDir = transcriptDir(file);
  await fsp.mkdir(outDir, { recursive: true });
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflab-tr-'));
  const wav = path.join(tmp, 'audio.wav');
  await media.ffmpeg(['-i', file, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
    { duration: info.duration, onProgress, onStart });

  onPhase('Transcrevendo...');
  if (onProgress) onProgress(0);
  const base = path.join(tmp, 'saida');
  const threads = String(Math.max(2, Math.min(8, os.cpus().length)));
  const p = start(cli, [
    '-m', modelPath, '-f', wav, '-l', language || 'auto', '-t', threads,
    '-osrt', '-oj', '-of', base, '-pp',
  ], {
    cwd: path.dirname(cli),
    onLine: (line) => {
      const m = line.match(/progress\s*=\s*(\d+)%/);
      if (m && onProgress) onProgress(Number(m[1]) / 100);
    },
  });
  if (onStart) onStart(p);
  const r = await p.promise;
  if (r.code !== 0 || !fs.existsSync(`${base}.json`)) {
    await fsp.rm(tmp, { recursive: true, force: true });
    throw new Error(`Falha na transcrição: ${r.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`);
  }

  const raw = JSON.parse(await fsp.readFile(`${base}.json`, 'utf8'));
  const segments = (raw.transcription || [])
    .map((s) => ({ start: s.offsets.from / 1000, end: s.offsets.to / 1000, text: String(s.text || '').trim() }))
    .filter((s) => s.text && !/^\[.*\]$/.test(s.text));

  const name = path.basename(file, path.extname(file));
  const srt = path.join(outDir, `${name}.srt`);
  const txt = path.join(outDir, `${name} - texto.txt`);
  await fsp.copyFile(`${base}.srt`, srt);
  await fsp.writeFile(txt, segments.map((s) => s.text).join('\n'), 'utf8');
  await fsp.rm(tmp, { recursive: true, force: true });

  const result = { file, language, model, outDir, srt, txt, segments, info, createdAt: Date.now() };
  await fsp.writeFile(path.join(outDir, 'transcricao.json'), JSON.stringify(result, null, 2));
  return result;
}

function modelsStatus() {
  return Object.entries(MODELS).map(([id, m]) => ({
    id, label: m.label, installed: !!modelsDir && fs.existsSync(path.join(modelsDir, m.file)),
  }));
}

module.exports = { init, transcribe, load, modelsStatus, MODELS };
