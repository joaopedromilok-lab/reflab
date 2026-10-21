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

// Formatos de saída: proporção e jeito de encaixar o vídeo.
const FORMATS = {
  '9x16-blur': { w: 1080, h: 1920, fit: 'blur', label: 'Vertical 9:16 (Reels, TikTok, Shorts) com fundo desfocado' },
  '9x16-crop': { w: 1080, h: 1920, fit: 'crop', label: 'Vertical 9:16 cortando o centro' },
  '4x5-blur': { w: 1080, h: 1350, fit: 'blur', label: 'Feed 4:5 com fundo desfocado' },
  '4x5-crop': { w: 1080, h: 1350, fit: 'crop', label: 'Feed 4:5 cortando o centro' },
  '1x1-blur': { w: 1080, h: 1080, fit: 'blur', label: 'Quadrado 1:1 com fundo desfocado' },
  '1x1-crop': { w: 1080, h: 1080, fit: 'crop', label: 'Quadrado 1:1 cortando o centro' },
};
const LEGACY = { blur: '9x16-blur', crop: '9x16-crop' };

function formatOf(name) {
  return FORMATS[LEGACY[name] || name] || null;
}

function fitFilter(f) {
  const { w, h } = f;
  if (f.fit === 'crop') {
    return `crop='min(iw,ih*${w}/${h})':'min(ih,iw*${h}/${w})',scale=${w}:${h}:flags=lanczos,setsar=1`;
  }
  return `split[va][vb];[va]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},boxblur=24:6[bg];`
    + `[vb]scale=${w}:${h}:force_original_aspect_ratio=decrease:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1`;
}

// Posição do logo (margem de 4% da largura).
function logoXY(pos) {
  const m = 'W*0.04';
  return {
    tl: `${m}:${m}`,
    tr: `W-w-${m}:${m}`,
    bl: `${m}:H-h-${m}`,
    br: `W-w-${m}:H-h-${m}`,
  }[pos] || `W-w-${m}:${m}`;
}

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
  vertical = '', format = '', withCaptions = false, words = [], style, logo, title, outDir,
  previewAt = null, previewOut = null, onProgress, onStart,
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
    const useAudio = info.hasAudio && !previewOut;
    clips.forEach((c, i) => {
      parts.push(`[0:v]trim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`);
      if (useAudio) parts.push(`[0:a]atrim=start=${c.start.toFixed(3)}:end=${c.end.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`);
      labels.push(`[v${i}]${useAudio ? `[a${i}]` : ''}`);
    });
    parts.push(`${labels.join('')}concat=n=${clips.length}:v=1:a=${useAudio ? 1 : 0}[vc]${useAudio ? '[ac]' : ''}`);

    let last = 'vc';
    const fmt = formatOf(format || vertical);
    if (fmt) {
      parts.push(`[${last}]${fitFilter(fmt)}[vv]`);
      last = 'vv';
    }
    const width = fmt ? fmt.w : info.width;
    const height = fmt ? fmt.h : info.height;
    const inputs = ['-i', path.resolve(file)];
    if (logo && logo.path && fs.existsSync(logo.path)) {
      inputs.push('-i', path.resolve(logo.path));
      const size = Math.max(0.04, Math.min(0.5, (Number(logo.size) || 15) / 100));
      const alpha = Math.max(0.1, Math.min(1, (Number(logo.opacity) || 90) / 100));
      parts.push(`[1:v]scale=${Math.round(width * size)}:-1,format=rgba,colorchannelmixer=aa=${alpha.toFixed(2)}[lg]`);
      parts.push(`[${last}][lg]overlay=${logoXY(logo.position)}[vl]`);
      last = 'vl';
    }
    if (withCaptions) {
      const shifted = [];
      let offset = 0;
      for (const c of clips) {
        const len = c.end - c.start;
        for (const w of words) {
          // Palavras que tocam o trecho (cortadas nas bordas).
          const mid = (w.start + w.end) / 2;
          if (w.end > c.start + 0.02 && w.start < c.end - 0.02 && mid >= c.start - 0.15 && mid <= c.end + 0.15) {
            const a = Math.min(len, Math.max(0, w.start - c.start));
            const b = Math.min(len, Math.max(a + 0.05, w.end - c.start));
            shifted.push({ w: w.w, start: a + offset, end: b + offset });
          }
        }
        offset += c.end - c.start;
      }
      if (!shifted.length) throw new Error('Não há fala transcrita nesses trechos para virar legenda.');
      await fsp.writeFile(path.join(tmp, 'legenda.ass'), captions.buildAss(shifted, { width, height, style }), 'utf8');
      await fsp.mkdir(path.join(tmp, 'fonts'));
      for (const f of Object.values(captions.FONT_FILES)) {
        await fsp.copyFile(assetPath('fonts', f), path.join(tmp, 'fonts', f));
      }
      parts.push(`[${last}]ass=legenda.ass:fontsdir=fonts[vs]`);
      last = 'vs';
    }

    const video = enc.has('libx264')
      ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p']
      : ['-c:v', 'h264_videotoolbox', '-b:v', '14M', '-pix_fmt', 'yuv420p'];
    const total = clips.reduce((a, c) => a + c.end - c.start, 0);
    if (previewOut) {
      // Prévia: um quadro só, no tempo pedido.
      await media.ffmpeg([
        ...inputs, '-filter_complex', parts.join(';'), '-map', `[${last}]`,
        '-ss', String(Math.max(0, Math.min(total - 0.05, previewAt || 0))), '-frames:v', '1', '-update', '1', previewOut,
      ], { cwd: tmp });
      return { output: previewOut };
    }
    const dir = outDir || path.dirname(file);
    await fsp.mkdir(dir, { recursive: true });
    const name = title || `${baseName(file)} - Montagem ${stamp()}`;
    const tag = fmt ? ` - ${(LEGACY[format || vertical] || format || vertical).split('-')[0].replace('x', ' por ')}` : '';
    const out = path.join(dir, `${name}${tag}.mp4`);
    await media.ffmpeg([
      ...inputs,
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

// Prévia de um quadro com formato, logo e legenda aplicados.
async function preview(file, range, opts = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflab-prev-'));
  const out = path.join(dir, 'previa.png');
  await render(file, [range], { ...opts, previewAt: opts.at ?? (range.end - range.start) / 2, previewOut: out });
  return out;
}

module.exports = { exportXml, render, preview, removeSilence, assAvailable, FORMATS };
