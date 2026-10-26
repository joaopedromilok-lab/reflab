// Transcrição local com whisper.cpp (sem internet depois de baixar o modelo).
// Mac: o whisper-cli vem dentro do app (compilado no GitHub Actions, com Metal).
// Windows: é baixado das releases oficiais do whisper.cpp na primeira vez.
// Para vídeos do YouTube, pode usar a legenda publicada pelo autor.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const extract = require('extract-zip');
const { start } = require('./proc');
const tools = require('./tools');
const media = require('./media');
const captions = require('./captions');
const script = require('./script');
const { assetPath } = require('./paths');
const { jsonStore } = require('./store');
const blocos = require('./blocos');

const IS_WIN = process.platform === 'win32';

const MODELS = {
  base: { file: 'ggml-base.bin', label: 'Rápido (150 MB)' },
  small: { file: 'ggml-small.bin', label: 'Equilibrado (490 MB)' },
  turbo: { file: 'ggml-large-v3-turbo-q5_0.bin', label: 'Preciso (575 MB)' },
  large: { file: 'ggml-large-v3-q5_0.bin', label: 'Máxima qualidade (1,1 GB, mais lento)' },
};
const MODEL_URL = (f) => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${f}`;

let modelsDir = null;
let index = null; // lista de transcrições, para a busca nas falas

function init(dir, userData) {
  modelsDir = dir;
  index = jsonStore(path.join(userData, 'transcricoes.json'), []);
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

// Detector de fala do próprio whisper.cpp (mesmo modelo Silero do --vad).
function vadToolPath() {
  const name = IS_WIN ? 'whisper-vad-speech-segments.exe' : 'whisper-vad-speech-segments';
  const bundled = process.resourcesPath && path.join(process.resourcesPath, 'whisper', name);
  if (bundled && fs.existsSync(bundled)) return bundled;
  const local = path.join(whisperDir(), name);
  return fs.existsSync(local) ? local : null;
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
  const m = MODELS[model] || MODELS.turbo;
  await fsp.mkdir(modelsDir, { recursive: true });
  const dest = path.join(modelsDir, m.file);
  if (fs.existsSync(dest)) return dest;
  onPhase(`Baixando o modelo de transcrição ${m.label} (só na primeira vez)...`);
  await downloadTo(MODEL_URL(m.file), dest, onProgress);
  return dest;
}

function baseName(file) {
  return path.basename(file, path.extname(file));
}

function transcriptDir(file) {
  return path.join(path.dirname(file), `${baseName(file)} - Transcrição`);
}

function jsonPath(file, translated) {
  return path.join(transcriptDir(file), translated ? 'transcricao-ingles.json' : 'transcricao.json');
}

async function load(file, translated = false) {
  let r;
  try {
    r = JSON.parse(await fsp.readFile(jsonPath(file, translated), 'utf8'));
  } catch {
    return null;
  }
  // Transcrições da versão 1.1 não tinham métricas nem capítulos.
  if (!r.metrics) {
    r.metrics = script.metrics(r.segments, r.info.duration);
    r.chapters = script.chapters(r.segments, r.info.duration);
    r.chaptersText = script.chaptersText(r.chapters);
  }
  return r;
}

// ---------- leitura do resultado do whisper ----------

// Junta os tokens do whisper em palavras com tempo de início e fim.
// offset: início do bloco no áudio original (s); limite: duração do bloco.
function wordsFromTokens(tokens, offset = 0, limite = Infinity) {
  const words = [];
  for (const tk of tokens || []) {
    const text = tk.text || '';
    if (/^\[_|^\[(BLANK|MUSIC|Música)/i.test(text) || /^<\|/.test(text)) continue;
    const from = tk.offsets ? Math.min(tk.offsets.from / 1000, limite) + offset : null;
    const to = tk.offsets ? Math.min(tk.offsets.to / 1000, limite) + offset : null;
    if (from === null) continue;
    if (!words.length || /^\s/.test(text)) {
      if (!text.trim()) continue;
      words.push({ w: text.trim(), start: from, end: to });
    } else {
      const last = words[words.length - 1];
      last.w += text;
      last.end = Math.max(last.end, to);
    }
  }
  return words.filter((w) => w.w);
}

function cleanText(t) {
  return String(t || '').replace(/\s+/g, ' ').trim();
}

function isNoise(text) {
  return !text || /^[[(].*[\])]$/.test(text) || /^(♪|\*|\.)+$/.test(text);
}

function parseWhisper(raw, offset = 0, limite = Infinity) {
  return (raw.transcription || [])
    .map((s) => {
      const text = cleanText(s.text);
      const words = wordsFromTokens(s.tokens, offset, limite);
      return {
        start: Math.min(s.offsets.from / 1000, limite) + offset,
        end: Math.min(s.offsets.to / 1000, limite) + offset,
        text,
        words,
      };
    })
    .filter((s) => !isNoise(s.text));
}

// ---------- legenda publicada no YouTube ----------

async function youtubeSubtitles(url, language, ytdlpArgs) {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflab-yt-'));
  try {
    const langs = language && language !== 'auto' ? `${language}.*,${language}` : 'all,-live_chat';
    const p = start(tools.toolPath('yt-dlp'), [
      ...ytdlpArgs, '--skip-download', '--no-playlist', '--write-subs', '--sub-langs', langs,
      '--sub-format', 'json3', '-o', path.join(tmp, 'leg.%(ext)s'), '--', url,
    ]);
    await p.promise;
    const file = (await fsp.readdir(tmp)).find((f) => f.endsWith('.json3'));
    if (!file) return null;
    const j = JSON.parse(await fsp.readFile(path.join(tmp, file), 'utf8'));
    const segments = (j.events || [])
      .filter((e) => e.segs && e.tStartMs !== undefined)
      .map((e) => {
        const text = cleanText(e.segs.map((s) => s.utf8 || '').join(''));
        const start = e.tStartMs / 1000;
        const end = (e.tStartMs + (e.dDurationMs || 0)) / 1000;
        return { start, end, text };
      })
      .filter((s) => !isNoise(s.text));
    for (const s of segments) s.words = captions.spreadWords(s);
    return segments.length ? { segments, lang: file.split('.').slice(-2, -1)[0] } : null;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

// ---------- gravar resultado ----------

async function writeOutputs(r) {
  await fsp.mkdir(r.outDir, { recursive: true });
  const name = baseName(r.file);
  const suffix = r.translated ? ' - inglês' : '';
  r.srt = path.join(r.outDir, `${name}${suffix}.srt`);
  r.srtYoutube = path.join(r.outDir, `${name}${suffix} - para o YouTube.srt`);
  r.srtReels = path.join(r.outDir, `${name}${suffix} - curta (Reels).srt`);
  r.txt = path.join(r.outDir, `${name}${suffix} - texto.txt`);
  await fsp.writeFile(r.srt, captions.segmentsSrt(r.segments), 'utf8');
  await fsp.writeFile(r.srtYoutube, captions.youtubeSrt(r.segments), 'utf8');
  await fsp.writeFile(r.srtReels, captions.reelsSrt(r.segments), 'utf8');
  await fsp.writeFile(r.txt, r.segments.map((s) => s.text).join('\n'), 'utf8');
  r.metrics = script.metrics(r.segments, r.info.duration);
  r.chapters = script.chapters(r.segments, r.info.duration);
  r.chaptersText = script.chaptersText(r.chapters);
  if (r.chapters.length) {
    await fsp.writeFile(path.join(r.outDir, `${name}${suffix} - capítulos.txt`), r.chaptersText, 'utf8');
  }
  await fsp.writeFile(jsonPath(r.file, r.translated), JSON.stringify(r, null, 2));
  if (!r.translated) register(r);
  return r;
}

function register(r) {
  const list = index.get().filter((e) => e.file !== r.file);
  list.unshift({ file: r.file, name: baseName(r.file), date: Date.now(), url: r.url || null });
  index.set(list.slice(0, 3000));
}

// ---------- transcrever ----------

// Detecta os intervalos com fala (segundos). Devolve null se o detector não
// estiver disponível ou falhar (aí usa-se o comportamento anterior).
async function detectarFala(wav, onStart) {
  const tool = vadToolPath();
  const modelo = assetPath('models', 'ggml-silero-v5.1.2.bin');
  if (!tool || !fs.existsSync(modelo)) return null;
  const p = start(tool, ['-f', wav, '-vm', modelo, '-np', '-vsd', '300', '-vp', '0'], { cwd: path.dirname(tool), keepAll: true });
  if (onStart) onStart(p);
  const r = await p.promise;
  if (r.code !== 0) return null;
  return blocos.lerSegmentosVad(r.stdout);
}

// Roda o whisper-cli num WAV e devolve o JSON completo.
async function rodarWhisperCli(cli, args, saida, { onProgress, onStart } = {}) {
  const p = start(cli, [...args, '-of', saida], {
    cwd: path.dirname(cli),
    onLine: (line) => {
      const m = line.match(/progress\s*=\s*(\d+)%/);
      if (m && onProgress) onProgress(Number(m[1]) / 100);
    },
  });
  if (onStart) onStart(p);
  const r = await p.promise;
  if (r.code !== 0 || !fs.existsSync(`${saida}.json`)) {
    throw new Error(`Falha na transcrição: ${r.stderr.trim().split(/\r?\n/).slice(-2).join(' ')}`);
  }
  return JSON.parse(await fsp.readFile(`${saida}.json`, 'utf8'));
}

// Roda o whisper num arquivo de áudio ou vídeo e devolve os trechos.
// Com "vad", a detecção de voz roda à parte e o áudio é transcrito em blocos
// do arquivo original (tempos corretos). Sem o detector, usa o --vad interno.
async function runWhisper(input, duration, {
  language = 'pt', model = 'turbo', prompt = '', translate = false, vad = true, blocosOpcoes,
  onPhase = () => {}, onProgress, onStart,
} = {}) {
  const cli = await ensureWhisper(onPhase, onProgress);
  const modelPath = await ensureModel(model, onPhase, onProgress);
  onPhase('Preparando o áudio...');
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflab-tr-'));
  try {
    const wav = path.join(tmp, 'audio.wav');
    await media.ffmpeg(['-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav],
      { duration, onProgress, onStart });
    const threads = String(Math.max(2, Math.min(8, os.cpus().length)));
    const args = ['-l', language || 'auto', '-t', threads, '-ojf', '-pp', '-m', modelPath];
    if (prompt && prompt.trim()) args.push('--prompt', prompt.trim().slice(0, 600));
    if (translate) args.push('-tr');
    const fase = translate ? 'Transcrevendo e traduzindo para inglês' : 'Transcrevendo';

    if (vad) {
      onPhase('Procurando os trechos com fala...');
      const fala = await detectarFala(wav, onStart);
      if (fala) {
        const info = blocos.lerWav(wav);
        const plano = blocos.planejarBlocos(fala, blocos.duracaoWav(info), blocosOpcoes);
        if (!plano.length) return { segments: [], segmentacao: { modo: 'blocos', blocos: 0, fala: 0 } };
        const total = plano.reduce((acc, b) => acc + (b.end - b.start), 0);
        onPhase(plano.length > 1 ? `${fase} (${plano.length} partes)...` : `${fase}...`);
        if (onProgress) onProgress(0);
        const segments = [];
        let feito = 0;
        for (let i = 0; i < plano.length; i++) {
          const b = plano[i];
          const dur = b.end - b.start;
          const wavBloco = path.join(tmp, `bloco-${i}.wav`);
          blocos.recortarWav(wav, wavBloco, b.start, b.end, info);
          const raw = await rodarWhisperCli(cli, [...args, '-f', wavBloco], path.join(tmp, `saida-${i}`), {
            onStart,
            onProgress: onProgress && ((p) => onProgress(Math.min(1, (feito + p * dur) / total))),
          });
          segments.push(...parseWhisper(raw, b.start, dur));
          await fsp.rm(wavBloco, { force: true });
          feito += dur;
        }
        segments.sort((x, y) => x.start - y.start);
        return {
          segments,
          segmentacao: { modo: 'blocos', blocos: plano.length, fala: +total.toFixed(1), plano },
        };
      }
    }

    // Sem detecção de voz, ou detector indisponível: uma execução só (comportamento anterior).
    onPhase(`${fase}...`);
    if (onProgress) onProgress(0);
    const extra = [];
    const vadModel = assetPath('models', 'ggml-silero-v5.1.2.bin');
    if (vad && fs.existsSync(vadModel)) extra.push('--vad', '-vm', vadModel, '-vsd', '300', '-vp', '200');
    const raw = await rodarWhisperCli(cli, [...args, '-f', wav, ...extra], path.join(tmp, 'saida'), { onProgress, onStart });
    return { segments: parseWhisper(raw), segmentacao: { modo: extra.length ? 'vad-interno' : 'sem-vad', blocos: 1 } };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function transcribe(file, {
  language = 'pt', model = 'turbo', prompt = '', translate = false, vad = true,
  url = null, useYoutubeSubs = false, ytdlpArgs = [], blocosOpcoes,
  onPhase = () => {}, onProgress, onStart,
} = {}) {
  const info = await media.probe(file);
  if (!info.hasAudio) throw new Error('O arquivo não tem áudio.');
  const outDir = transcriptDir(file);
  let segments = null;
  let source = 'whisper';
  let segmentacao = null;

  if (url && useYoutubeSubs && !translate) {
    onPhase('Procurando a legenda publicada pelo autor...');
    const yt = await youtubeSubtitles(url, language, ytdlpArgs).catch(() => null);
    if (yt) {
      // Se o arquivo é só um trecho do vídeo, a legenda do YouTube não bate: usa o whisper.
      const lastEnd = yt.segments[yt.segments.length - 1].end;
      if (lastEnd > info.duration + 5) yt.segments = null;
    }
    if (yt && yt.segments) {
      segments = yt.segments;
      source = `legenda do YouTube (${yt.lang})`;
    }
  }

  if (!segments) {
    ({ segments, segmentacao } = await runWhisper(file, info.duration, {
      language, model, prompt, translate, vad, blocosOpcoes, onPhase, onProgress, onStart,
    }));
  }

  const result = {
    file, url, language, model, source, translated: !!translate, prompt,
    outDir, info, segments, segmentacao, createdAt: Date.now(),
  };
  return writeOutputs(result);
}

function safeName(s) {
  return String(s || 'video').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'video';
}

// Só a transcrição de um link, sem guardar o vídeo. Usa a legenda do autor
// quando existe (nada é baixado); senão baixa só o áudio numa pasta
// temporária, transcreve e apaga.
// O "arquivo" da transcrição é um atalho .url para o vídeo original.
async function transcribeLink(url, linkInfo, {
  baseDir, language = 'pt', model = 'turbo', prompt = '', vad = true, useYoutubeSubs = true, ytdlpArgs = [],
  onPhase = () => {}, onProgress, onStart,
} = {}) {
  const dir = path.join(baseDir, 'Transcrições');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${safeName(linkInfo.title)}.url`);
  await fsp.writeFile(file, `[InternetShortcut]\r\nURL=${url}\r\n`, 'utf8');
  const info = {
    duration: linkInfo.duration || 0, hasAudio: true, hasVideo: false, fps: 0, width: 0, height: 0, linkOnly: true,
  };
  let segments = null;
  let source = 'whisper';

  if (useYoutubeSubs) {
    onPhase('Procurando a legenda publicada pelo autor...');
    const yt = await youtubeSubtitles(url, language, ytdlpArgs).catch(() => null);
    if (yt) {
      segments = yt.segments;
      source = `legenda do YouTube (${yt.lang})`;
    }
  }

  if (!segments) {
    onPhase('Baixando só o áudio (temporário)...');
    const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflab-link-'));
    try {
      const p = start(tools.toolPath('yt-dlp'), [
        ...ytdlpArgs, '--no-playlist', '-f', 'ba/b', '--newline',
        '--progress-template', 'download:RLP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s',
        '-o', path.join(tmp, 'audio.%(ext)s'), '--', url,
      ], {
        onLine: (line) => {
          if (!line.startsWith('RLP|') || !onProgress) return;
          const [, d, t, te] = line.split('|').map(Number);
          const total = t || te;
          if (total) onProgress(Math.min(1, d / total));
        },
      });
      if (onStart) onStart(p);
      const r = await p.promise;
      const audio = (await fsp.readdir(tmp)).find((f) => f.startsWith('audio.'));
      if (r.code !== 0 || !audio) {
        throw new Error(`Não foi possível baixar o áudio: ${r.stderr.trim().split(/\r?\n/).filter((l) => /ERROR/.test(l)).pop() || ''}`);
      }
      ({ segments } = await runWhisper(path.join(tmp, audio), info.duration, { language, model, prompt, vad, onPhase, onProgress, onStart }));
    } finally {
      await fsp.rm(tmp, { recursive: true, force: true });
    }
  }
  if (!info.duration && segments.length) info.duration = segments[segments.length - 1].end;

  const result = {
    file, url, language, model, source, translated: false, prompt, linkOnly: true,
    title: linkInfo.title, uploader: linkInfo.uploader, thumbnail: linkInfo.thumbnail,
    outDir: transcriptDir(file), info, segments, createdAt: Date.now(),
  };
  return writeOutputs(result);
}

// Salva correções feitas no texto (o tempo das palavras é redistribuído
// nos trechos alterados).
async function update(file, edits) {
  const r = await load(file);
  if (!r) throw new Error('Transcrição não encontrada.');
  for (const e of edits) {
    const seg = r.segments[e.index];
    if (!seg) continue;
    const text = cleanText(e.text);
    if (text === seg.text) continue;
    seg.text = text;
    seg.edited = true;
    seg.words = captions.spreadWords(seg);
  }
  r.segments = r.segments.filter((s) => s.text);
  return writeOutputs(r);
}

// ---------- busca nas falas de todas as transcrições ----------

const cache = new Map();
function normalize(t) {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

async function searchAll(query) {
  const q = normalize(query.trim());
  if (q.length < 2) return [];
  const results = [];
  for (const entry of index.get()) {
    const p = jsonPath(entry.file);
    let st;
    try { st = await fsp.stat(p); } catch { continue; }
    let c = cache.get(p);
    if (!c || c.mtime !== st.mtimeMs) {
      try {
        const r = JSON.parse(await fsp.readFile(p, 'utf8'));
        c = { mtime: st.mtimeMs, segments: r.segments.map((s) => ({ start: s.start, text: s.text, n: normalize(s.text) })) };
        cache.set(p, c);
      } catch { continue; }
    }
    for (const s of c.segments) {
      if (s.n.includes(q)) {
        results.push({ file: entry.file, name: entry.name, start: s.start, text: s.text });
        if (results.length >= 500) return results;
      }
    }
  }
  return results;
}

function modelsStatus() {
  return Object.entries(MODELS).map(([id, m]) => ({
    id, label: m.label, installed: !!modelsDir && fs.existsSync(path.join(modelsDir, m.file)),
  }));
}

module.exports = {
  init, transcribe, transcribeLink, load, update, searchAll, modelsStatus, MODELS, transcriptDir, flush: () => index && index.flush(),
  parseWhisper, // exportado para os testes
};
