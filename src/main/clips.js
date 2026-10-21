// Recortar vários trechos de um vídeo e gerar versões verticais (9:16).
const fsp = require('fs').promises;
const path = require('path');
const media = require('./media');

function baseName(file) {
  return path.basename(file, path.extname(file));
}

function stamp(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}m${String(s).padStart(2, '0')}s`;
}

// Converte "1:20-1:45, 3:00-3:30" (ou um por linha) em [{start, end}].
function parseRanges(text, parseTime) {
  const out = [];
  for (const part of String(text || '').split(/[,;\n]+/)) {
    const p = part.trim();
    if (!p) continue;
    const m = p.match(/^(.+?)\s*(?:-|–|até|a)\s*(.+)$/i);
    if (!m) throw new Error(`Trecho inválido: "${p}". Use o formato 1:20-1:45`);
    const start = parseTime(m[1]);
    const end = parseTime(m[2]);
    if (start === null || end === null || end <= start) throw new Error(`Trecho inválido: "${p}". O fim precisa ser depois do início.`);
    out.push({ start, end });
  }
  return out;
}

const VERTICAL_FILTERS = {
  // Recorta o centro do quadro.
  crop: "crop='min(iw,ih*9/16)':ih,scale=1080:1920:flags=lanczos,setsar=1",
  // Vídeo inteiro no meio, com o próprio vídeo desfocado atrás.
  blur: "split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:6[bg];[b]scale=1080:-2:flags=lanczos[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1",
};

async function videoArgs(precise) {
  const enc = await media.encoders();
  if (!precise) return ['-c', 'copy'];
  const v = enc.has('libx264')
    ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '18', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'h264_videotoolbox', '-b:v', '14M', '-pix_fmt', 'yuv420p'];
  return [...v, '-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart'];
}

// ranges: [{start, end, name?}]; mode: 'precise' (reconverte, corte exato) ou 'fast' (sem reconverter).
async function cutClips(file, ranges, { mode = 'precise', vertical = '', onProgress, onStart, onClip } = {}) {
  if (!ranges.length) throw new Error('Nenhum trecho informado.');
  const info = await media.probe(file);
  const outDir = path.join(path.dirname(file), `${baseName(file)} - Clipes`);
  await fsp.mkdir(outDir, { recursive: true });
  const precise = mode !== 'fast' || !!vertical;
  const codec = await videoArgs(precise);
  const total = ranges.reduce((a, r) => a + (r.end - r.start), 0);
  let done = 0;
  const outputs = [];
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    const end = Math.min(r.end, info.duration || r.end);
    const dur = end - r.start;
    if (dur <= 0) continue;
    const label = r.name ? ` - ${r.name.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 60)}` : '';
    const out = path.join(outDir,
      `${baseName(file)} - Clipe ${String(i + 1).padStart(2, '0')} (${stamp(r.start)})${label}${vertical ? ' - vertical' : ''}.mp4`);
    const vf = vertical ? ['-vf', VERTICAL_FILTERS[vertical] || VERTICAL_FILTERS.crop] : [];
    await media.ffmpeg([
      '-ss', r.start.toFixed(3), '-i', file, '-t', dur.toFixed(3),
      '-map', '0:v:0?', '-map', '0:a:0?', ...vf, ...codec,
      ...(precise ? [] : ['-avoid_negative_ts', 'make_zero']),
      out,
    ], {
      duration: dur,
      onStart,
      onProgress: onProgress && ((p) => onProgress((done + p * dur) / total)),
    });
    done += dur;
    outputs.push(out);
    if (onClip) onClip(out);
  }
  return { outDir, files: outputs };
}

async function makeVertical(file, { style = 'blur', onProgress, onStart } = {}) {
  const info = await media.probe(file);
  if (!info.hasVideo) throw new Error('O arquivo não tem vídeo.');
  const out = path.join(path.dirname(file), `${baseName(file)} - Vertical.mp4`);
  await media.ffmpeg([
    '-i', file, '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', VERTICAL_FILTERS[style] || VERTICAL_FILTERS.blur,
    ...(await videoArgs(true)), out,
  ], { duration: info.duration, onProgress, onStart });
  return out;
}

module.exports = { parseRanges, cutClips, makeVertical };
