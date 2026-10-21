// Montagem: junta trechos escolhidos (pelo texto, pelos momentos ou pela
// remoção de silêncios) numa timeline XML ou num vídeo final, opcionalmente
// vertical e com legenda estilo Reels gravada.
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const media = require('./media');
const study = require('./study');
const captions = require('./captions');
const tools = require('./tools');
const { run } = require('./proc');
const { assetPath } = require('./paths');

const VERTICAL = {
  crop: "crop='min(iw,ih*9/16)':ih,scale=1080:1920:flags=lanczos,setsar=1",
  blur: "split[va][vb];[va]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:6[bg];[vb]scale=1080:-2:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1",
};

function baseName(file) {
  return path.basename(file, path.extname(file));
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}m${p(d.getSeconds())}s`;
}

let hasAss = null;
async function assAvailable() {
  if (hasAss === null) {
    const r = await run(tools.toolPath('ffmpeg'), ['-hide_banner', '-filters']);
    hasAss = /\sass\s/.test(r.stdout);
  }
  return hasAss;
}

function cleanRanges(ranges, duration) {
  return ranges
    .map((r) => ({ ...r, start: Math.max(0, r.start), end: Math.min(duration || r.end, r.end) }))
    .filter((r) => r.end - r.start > 0.05);
}

async function exportXml(file, ranges, { title, outDir } = {}) {
  const info = await media.probe(file);
  const clips = cleanRanges(ranges, info.duration);
  if (!clips.length) throw new Error('Nenhum trecho para montar.');
  const name = title || `${baseName(file)} - Montagem ${stamp()}`;
  const dir = outDir || path.dirname(file);
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${name} (Premiere e DaVinci).xml`);
  const xml = study.buildXmeml({
    file, info, name,
    clips: clips.map((c, i) => ({ start: c.start, end: c.end, name: c.name || `Trecho ${i + 1}` })),
  });
  await fsp.writeFile(out, xml, 'utf8');
  return { xml: out, clips: clips.length, duration: clips.reduce((a, c) => a + c.end - c.start, 0) };
}

// words: palavras da transcrição no tempo do arquivo original (para a legenda).
async function render(file, ranges, {
  vertical = '', withCaptions = false, words = [], title, outDir, highlight, onProgress, onStart,
} = {}) {
  const info = await media.probe(file);
  if (!info.hasVideo) throw new Error('O arquivo não tem vídeo.');
  const clips = cleanRanges(ranges, info.duration);
  if (!clips.length) throw new Error('Nenhum trecho para montar.');
  if (withCaptions && !(await assAvailable())) {
    throw new Error('O ffmpeg instalado não grava legendas (falta o libass). Use a legenda .srt no editor.');
  }
  const enc = await media.encoders();
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflab-mont-'));
  try {
    const parts = [];
    const labels = [];
    clips.forEach((c, i) => {
      parts.push(`[0:v]trim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      if (info.hasAudio) parts.push(`[0:a]atrim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[v${i}]${info.hasAudio ? `[a${i}]` : ''}`);
    });
    parts.push(`${labels.join('')}concat=n=${clips.length}:v=1:a=${info.hasAudio ? 1 : 0}[vc]${info.hasAudio ? '[ac]' : ''}`);

    let last = 'vc';
    if (vertical) {
      parts.push(`[${last}]${VERTICAL[vertical] || VERTICAL.blur}[vv]`);
      last = 'vv';
    }
    if (withCaptions) {
      const width = vertical ? 1080 : info.width;
      const height = vertical ? 1920 : info.height;
      const shifted = [];
      let offset = 0;
      for (const c of clips) {
        for (const w of words) {
          if (w.start >= c.start - 0.05 && w.end <= c.end + 0.05) {
            shifted.push({ w: w.w, start: Math.max(0, w.start - c.start) + offset, end: Math.max(0, w.end - c.start) + offset });
          }
        }
        offset += c.end - c.start;
      }
      if (!shifted.length) throw new Error('Não há fala transcrita nesses trechos para virar legenda.');
      await fsp.writeFile(path.join(tmp, 'legenda.ass'), captions.buildAss(shifted, { width, height, highlight }), 'utf8');
      await fsp.mkdir(path.join(tmp, 'fonts'));
      await fsp.copyFile(assetPath('fonts', 'Anton-Regular.ttf'), path.join(tmp, 'fonts', 'Anton-Regular.ttf'));
      parts.push(`[${last}]ass=legenda.ass:fontsdir=fonts[vs]`);
      last = 'vs';
    }

    const video = enc.has('libx264')
      ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'h264_videotoolbox', '-b:v', '14M', '-pix_fmt', 'yuv420p'];
    const dir = outDir || path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const name = title || `${baseName(file)} - Montagem ${stamp()}`;
    const out = path.join(dir, `${name}${vertical ? ' - vertical' : ''}.mp4`);
    const total = clips.reduce((a, c) => a + c.end - c.start, 0);
    await media.ffmpeg([
      '-i', path.resolve(file),
      '-filter_complex', parts.join(';'),
      '-map', `[${last}]`, ...(info.hasAudio ? ['-map', '[ac]', '-c:a', 'aac', '-b:a', '320k'] : []),
      ...video, '-movflags', '+faststart', out,
    ], { duration: total, onProgress, onStart, cwd: tmp });
    return { output: out, duration: total, clips: clips.length };
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

// ---------- remover silêncios ----------

async function detectSpeech(file, { noise = -35, minSilence = 0.5, pad = 0.12, onProgress, onStart } = {}) {
  const info = await media.probe(file);
  if (!info.hasAudio) throw new Error('O arquivo não tem áudio.');
  const silences = [];
  let open = null;
  await media.ffmpeg(['-i', file, '-vn', '-af', `silencedetect=noise=${noise}dB:d=${minSilence}`, '-f', 'null', '-'], {
    duration: info.duration, onProgress, onStart,
    onStderrLine: (line) => {
      const a = line.match(/silence_start:\s*(-?[\d.]+)/);
      const b = line.match(/silence_end:\s*([\d.]+)/);
      if (a) open = Math.max(0, Number(a[1]));
      if (b && open !== null) { silences.push([open, Number(b[1])]); open = null; }
    },
  });
  if (open !== null) silences.push([open, info.duration]);
  // Fala = o que sobra entre os silêncios, com uma folga nas bordas.
  const speech = [];
  let cur = 0;
  for (const [s, e] of silences) {
    if (s > cur) speech.push({ start: Math.max(0, cur - pad), end: Math.min(info.duration, s + pad) });
    cur = e;
  }
  if (cur < info.duration) speech.push({ start: Math.max(0, cur - pad), end: info.duration });
  const merged = [];
  for (const r of speech) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < 0.25) last.end = r.end;
    else merged.push({ ...r });
  }
  const kept = merged.reduce((a, r) => a + r.end - r.start, 0);
  return { info, ranges: merged, kept, removed: Math.max(0, info.duration - kept) };
}

async function removeSilence(file, { noise, minSilence, renderVideo = false, onProgress, onStart, onPhase = () => {} } = {}) {
  onPhase('Procurando silêncios...');
  const d = await detectSpeech(file, { noise, minSilence, onProgress, onStart });
  if (!d.ranges.length) throw new Error('O áudio inteiro foi considerado silêncio. Diminua o limite (ex.: -45 dB).');
  const title = `${baseName(file)} - sem silêncios`;
  const x = await exportXml(file, d.ranges, { title });
  let output = null;
  if (renderVideo) {
    onPhase('Gerando o vídeo sem silêncios...');
    output = (await render(file, d.ranges, { title, onProgress, onStart })).output;
  }
  return { xml: x.xml, output, removed: d.removed, kept: d.kept, cuts: d.ranges.length };
}

module.exports = { exportXml, render, removeSilence, assAvailable };
