// Ferramentas de estudo: detecção de cortes, exportação para o editor
// (XML para Premiere/DaVinci, EDL de marcadores para DaVinci, CSV),
// divisão em planos, folha de contato e extração de frames.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const media = require('./media');

const IS_WIN = process.platform === 'win32';

function baseName(file) {
  return path.basename(file, path.extname(file));
}

function analysisDir(file) {
  return path.join(path.dirname(file), `${baseName(file)} - Análise`);
}

// ---------- tempo / timecode ----------

function timebase(fps) {
  const base = Math.round(fps) || 30;
  const ntsc = Math.abs(fps - base) > 0.01;
  return { base, ntsc };
}

function frameOf(seconds, fps) {
  return Math.round(seconds * fps);
}

function tcFromFrames(frames, base, offsetHours = 0) {
  const f = frames % base;
  const totalSec = Math.floor(frames / base);
  const s = totalSec % 60;
  const m = Math.floor(totalSec / 60) % 60;
  const h = Math.floor(totalSec / 3600) + offsetHours;
  const p = (n) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`;
}

function clock(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds - m * 60;
  return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

function xmlEsc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fileUrlForEditors(p) {
  const abs = path.resolve(p);
  const parts = abs.split(/[\\/]/).map((seg, i) => (IS_WIN && i === 0 ? seg : encodeURIComponent(seg)));
  return `file://localhost${IS_WIN ? '/' : ''}${parts.join('/')}`;
}

// ---------- detecção de cortes ----------

async function analyze(file, { threshold = 0.3, minShot = 0.3, onProgress, onStart } = {}) {
  const info = await media.probe(file);
  if (!info.hasVideo) throw new Error('O arquivo não tem vídeo.');
  const outDir = analysisDir(file);
  const framesDir = path.join(outDir, 'Frames dos planos');
  await fsp.rm(framesDir, { recursive: true, force: true });
  await fsp.mkdir(framesDir, { recursive: true });

  // 1ª passada (60% do progresso): encontra os cortes.
  const times = [];
  await media.ffmpeg([
    '-i', file, '-an', '-sn', '-dn',
    '-vf', `scale=480:-2,select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ], {
    duration: info.duration,
    onProgress: onProgress && ((p) => onProgress(p * 0.6)),
    onStart,
    onStderrLine: (line) => {
      if (!line.includes('showinfo')) return;
      const m = line.match(/pts_time:\s*([\d.]+)/);
      if (m) times.push(Number(m[1]));
    },
  });

  // Monta os planos, descartando cortes muito próximos (flashes).
  const starts = [0];
  for (const t of times) {
    if (t - starts[starts.length - 1] >= minShot && info.duration - t >= minShot / 2) starts.push(t);
  }
  const shots = starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1] : info.duration;
    return { index: i + 1, start, end, duration: end - start, thumb: null };
  });

  // 2ª passada (40%): um frame do meio de cada plano (o primeiro frame
  // costuma ser fade ou desfoque de transição). Em lotes, para não estourar
  // o tamanho máximo da linha de comando.
  const BATCH = 250;
  for (let b = 0; b < shots.length; b += BATCH) {
    const group = shots.slice(b, b + BATCH);
    const expr = group
      .map((s) => { const m = (s.start + s.duration / 2).toFixed(3); return `gte(t,${m})*lt(prev_t,${m})`; })
      .join('+');
    await media.ffmpeg([
      '-i', file, '-an', '-sn', '-dn',
      '-vf', `select='${expr}',scale=480:-2`,
      '-fps_mode', 'vfr', '-q:v', '3', '-start_number', String(b + 1),
      path.join(framesDir, 'plano_%04d.jpg'),
    ], {
      duration: info.duration,
      onProgress: onProgress && ((p) => onProgress(0.6 + 0.4 * ((b + p * group.length) / shots.length))),
      onStart,
    });
  }
  for (const s of shots) {
    const thumb = path.join(framesDir, `plano_${String(s.index).padStart(4, '0')}.jpg`);
    if (fs.existsSync(thumb)) s.thumb = thumb;
  }

  const durations = shots.map((s) => s.duration).sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const stats = {
    shots: shots.length,
    cuts: shots.length - 1,
    duration: info.duration,
    average: info.duration / shots.length,
    median: durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2,
    shortest: durations[0],
    longest: durations[durations.length - 1],
    cutsPerMinute: info.duration > 0 ? (shots.length - 1) / (info.duration / 60) : 0,
  };

  const result = {
    file,
    name: baseName(file),
    outDir,
    framesDir,
    info,
    threshold,
    minShot,
    stats,
    shots,
    exports: {},
    createdAt: Date.now(),
  };

  result.exports.xml = await writeXml(result);
  result.exports.edl = await writeEdl(result);
  result.exports.csv = await writeCsv(result);
  result.exports.sheets = await writeContactSheets(result);
  result.exports.html = await writeHtml(result);
  await fsp.writeFile(path.join(outDir, 'analise.json'), JSON.stringify(result, null, 2));
  return result;
}

async function loadAnalysis(file) {
  try {
    const raw = await fsp.readFile(path.join(analysisDir(file), 'analise.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------- exportações ----------

// XML (Final Cut Pro 7 / xmeml): importável no Premiere (Arquivo > Importar)
// e no DaVinci Resolve (Arquivo > Importar > Timeline). Cria uma timeline já
// cortada em cada plano, com um marcador em cada corte.
async function writeXml(r) {
  const { fps, width, height, duration, hasAudio, sampleRate, channels } = r.info;
  const { base, ntsc } = timebase(fps);
  const rate = `<rate><timebase>${base}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const total = frameOf(duration, fps);
  const fileName = path.basename(r.file);
  const tc = `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`;
  const fileDef = `<file id="file-1"><name>${xmlEsc(fileName)}</name><pathurl>${xmlEsc(fileUrlForEditors(r.file))}</pathurl>${rate}<duration>${total}</duration>${tc}<media><video><samplecharacteristics>${rate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>${hasAudio ? `<audio><samplecharacteristics><depth>16</depth><samplerate>${sampleRate || 48000}</samplerate></samplecharacteristics><channelcount>${channels || 2}</channelcount></audio>` : ''}</media></file>`;

  const clip = (s, kind, idx) => {
    const a = frameOf(s.start, fps);
    const b = frameOf(s.end, fps);
    const file = kind === 'v' && idx === 0 ? fileDef : '<file id="file-1"/>';
    const src = kind === 'a' ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>' : '';
    return `<clipitem id="clipitem-${kind}${s.index}"><name>Plano ${String(s.index).padStart(3, '0')}</name><enabled>TRUE</enabled><duration>${total}</duration>${rate}<start>${a}</start><end>${b}</end><in>${a}</in><out>${b}</out>${file}${src}</clipitem>`;
  };

  const videoClips = r.shots.map((s, i) => clip(s, 'v', i)).join('\n');
  const audioClips = hasAudio ? r.shots.map((s, i) => clip(s, 'a', i)).join('\n') : '';
  const markers = r.shots.slice(1).map((s) =>
    `<marker><name>Plano ${s.index}</name><comment>Corte em ${clock(s.start)}</comment><in>${frameOf(s.start, fps)}</in><out>-1</out></marker>`).join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
<sequence id="sequence-1">
<name>${xmlEsc(r.name)} - Cortes</name>
<duration>${total}</duration>
${rate}
${tc}
<media>
<video>
<format><samplecharacteristics>${rate}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>
<track>
${videoClips}
</track>
</video>
<audio>
<numOutputChannels>2</numOutputChannels>
<format><samplecharacteristics><depth>16</depth><samplerate>${sampleRate || 48000}</samplerate></samplecharacteristics></format>
${hasAudio ? `<track>\n${audioClips}\n</track>` : ''}
</audio>
</media>
${markers}
</sequence>
</xmeml>
`;
  const out = path.join(r.outDir, `${r.name} - Timeline cortada (Premiere e DaVinci).xml`);
  await fsp.writeFile(out, xml, 'utf8');
  return out;
}

// EDL de marcadores no formato do DaVinci Resolve
// (Timeline > Importar > Marcadores da timeline de EDL). Começa em 01:00:00:00.
async function writeEdl(r) {
  const { fps } = r.info;
  const { base } = timebase(fps);
  const lines = [`TITLE: ${r.name.replace(/[^\x20-\x7E]/g, '_')}`, 'FCM: NON-DROP FRAME', ''];
  r.shots.forEach((s, i) => {
    const f = frameOf(s.start, fps);
    const a = tcFromFrames(f, base, 1);
    const b = tcFromFrames(f + 1, base, 1);
    lines.push(`${String(i + 1).padStart(3, '0')}  001      V     C        ${a} ${b} ${a} ${b}  `);
    lines.push(` |C:ResolveColorBlue |M:Plano ${s.index} |D:1`);
    lines.push('');
  });
  const out = path.join(r.outDir, `${r.name} - Marcadores (DaVinci).edl`);
  await fsp.writeFile(out, lines.join('\r\n'), 'utf8');
  return out;
}

async function writeCsv(r) {
  const { fps } = r.info;
  const { base } = timebase(fps);
  const num = (n) => n.toFixed(3).replace('.', ',');
  const rows = ['Plano;Início (s);Fim (s);Duração (s);Início (TC);Fim (TC)'];
  for (const s of r.shots) {
    rows.push([
      s.index, num(s.start), num(s.end), num(s.duration),
      tcFromFrames(frameOf(s.start, fps), base), tcFromFrames(frameOf(s.end, fps), base),
    ].join(';'));
  }
  const out = path.join(r.outDir, `${r.name} - Lista de cortes.csv`);
  await fsp.writeFile(out, `﻿${rows.join('\r\n')}`, 'utf8');
  return out;
}

// Folha de contato: páginas com 5x8 frames (um por plano).
async function writeContactSheets(r) {
  const withThumbs = r.shots.filter((s) => s.thumb);
  if (!withThumbs.length) return [];
  const listFile = path.join(r.outDir, '.frames.txt');
  const esc = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  await fsp.writeFile(listFile, withThumbs.map((s) => `file '${esc(s.thumb)}'\nduration 1`).join('\n'), 'utf8');
  for (const f of await fsp.readdir(r.outDir)) {
    if (/^Folha de contato \d+\.jpg$/.test(f)) await fsp.unlink(path.join(r.outDir, f));
  }
  const cols = Math.min(5, withThumbs.length);
  const rows = Math.min(8, Math.ceil(withThumbs.length / cols));
  await media.ffmpeg([
    '-f', 'concat', '-safe', '0', '-i', listFile,
    '-vf', `scale=480:270:force_original_aspect_ratio=decrease,pad=480:270:(ow-iw)/2:(oh-ih)/2,tile=${cols}x${rows}:padding=6:margin=6:color=0x111111`,
    '-fps_mode', 'vfr', '-q:v', '3',
    path.join(r.outDir, 'Folha de contato %02d.jpg'),
  ]);
  await fsp.unlink(listFile).catch(() => {});
  return (await fsp.readdir(r.outDir))
    .filter((f) => /^Folha de contato \d+\.jpg$/.test(f))
    .sort()
    .map((f) => path.join(r.outDir, f));
}

function pacingSvg(r, w = 1000, h = 160) {
  const max = Math.max(...r.shots.map((s) => s.duration), 1);
  const scaleY = (d) => Math.max(2, (Math.sqrt(d) / Math.sqrt(max)) * (h - 10));
  const bars = r.shots.map((s, i) => {
    const x = (s.start / r.info.duration) * w;
    const bw = Math.max(1, (s.duration / r.info.duration) * w - 1);
    const bh = scaleY(s.duration);
    return `<rect x="${x.toFixed(2)}" y="${(h - bh).toFixed(2)}" width="${bw.toFixed(2)}" height="${bh.toFixed(2)}" fill="${i % 2 ? '#e5484d' : '#ff7a59'}"><title>Plano ${s.index}: ${s.duration.toFixed(2)}s</title></rect>`;
  }).join('');
  return `<svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="width:100%;height:${h}px;background:#1a1a1a;border-radius:8px">${bars}</svg>`;
}

async function writeHtml(r) {
  const s = r.stats;
  const rel = (p) => encodeURI(path.relative(r.outDir, p).split(path.sep).join('/'));
  const cards = r.shots.map((sh) => `
    <figure>${sh.thumb ? `<img src="${rel(sh.thumb)}" loading="lazy">` : '<div class="ph"></div>'}
      <figcaption><b>Plano ${sh.index}</b><span>${clock(sh.start)} · ${sh.duration.toFixed(2)}s</span></figcaption></figure>`).join('');
  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${xmlEsc(r.name)} - Análise de cortes</title>
<style>
body{margin:0;background:#0f0f10;color:#eee;font:14px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:24px}
h1{font-size:20px;margin:0 0 4px}.sub{color:#999;margin-bottom:20px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:20px}
.stat{background:#1a1a1a;border-radius:8px;padding:12px}.stat b{display:block;font-size:22px}.stat span{color:#999;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px;margin-top:20px}
figure{margin:0;background:#1a1a1a;border-radius:8px;overflow:hidden}img,.ph{width:100%;aspect-ratio:16/9;object-fit:cover;display:block;background:#222}
figcaption{display:flex;justify-content:space-between;padding:6px 8px;font-size:12px}figcaption span{color:#999}
</style></head><body>
<h1>${xmlEsc(r.name)}</h1><div class="sub">Análise de cortes · gerado pelo RefLab</div>
<div class="stats">
<div class="stat"><b>${s.shots}</b><span>planos</span></div>
<div class="stat"><b>${s.average.toFixed(2)}s</b><span>duração média do plano</span></div>
<div class="stat"><b>${s.median.toFixed(2)}s</b><span>mediana</span></div>
<div class="stat"><b>${s.cutsPerMinute.toFixed(1)}</b><span>cortes por minuto</span></div>
<div class="stat"><b>${s.shortest.toFixed(2)}s</b><span>plano mais curto</span></div>
<div class="stat"><b>${s.longest.toFixed(2)}s</b><span>plano mais longo</span></div>
</div>
<p class="sub">Ritmo da edição: cada barra é um plano. Barras baixas e finas = cortes rápidos.</p>
${pacingSvg(r)}
<div class="grid">${cards}</div>
</body></html>`;
  const out = path.join(r.outDir, `${r.name} - Folha de contato.html`);
  await fsp.writeFile(out, html, 'utf8');
  return out;
}

// ---------- dividir em planos ----------

async function splitShots(file, shots, { onProgress, onStart } = {}) {
  const info = await media.probe(file);
  const enc = await media.encoders();
  const outDir = path.join(analysisDir(file), 'Planos');
  await fsp.rm(outDir, { recursive: true, force: true });
  await fsp.mkdir(outDir, { recursive: true });
  const cuts = shots.slice(1).map((s) => s.start.toFixed(3));
  const video = enc.has('libx264')
    ? ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p']
    : ['-c:v', 'h264_videotoolbox', '-b:v', '14M', '-pix_fmt', 'yuv420p'];
  const segment = cuts.length
    ? ['-force_key_frames', cuts.join(','), '-f', 'segment', '-segment_times', cuts.join(','),
      '-segment_start_number', '1', '-reset_timestamps', '1', path.join(outDir, `${baseName(file)} - Plano %03d.mp4`)]
    : [path.join(outDir, `${baseName(file)} - Plano 001.mp4`)];
  await media.ffmpeg([
    '-i', file, '-map', '0:v:0', '-map', '0:a:0?', ...video, '-c:a', 'aac', '-b:a', '320k', ...segment,
  ], { duration: info.duration, onProgress, onStart });
  return outDir;
}

// ---------- frames ----------

function parseTime(str) {
  const s = String(str || '').trim().replace(',', '.');
  if (!s) return null;
  const parts = s.split(':').map(Number);
  if (parts.some((n) => Number.isNaN(n))) return null;
  return parts.reduce((acc, n) => acc * 60 + n, 0);
}

async function frameAt(file, time, { onStart } = {}) {
  const t = parseTime(time);
  if (t === null) throw new Error('Tempo inválido. Use, por exemplo, 1:23 ou 83.5');
  const dir = path.join(path.dirname(file), `${baseName(file)} - Frames`);
  await fsp.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${baseName(file)} - ${clock(t).replace(/[:.]/g, '-')}.png`);
  await media.ffmpeg(['-ss', String(t), '-i', file, '-frames:v', '1', out], { onStart });
  if (!fs.existsSync(out)) throw new Error('Nenhum frame nesse tempo (o vídeo é mais curto?).');
  return out;
}

async function framesEvery(file, seconds, { onProgress, onStart } = {}) {
  const n = Number(String(seconds).replace(',', '.'));
  if (!(n > 0)) throw new Error('Intervalo inválido.');
  const info = await media.probe(file);
  const dir = path.join(path.dirname(file), `${baseName(file)} - Frames a cada ${n}s`);
  await fsp.mkdir(dir, { recursive: true });
  await media.ffmpeg(['-i', file, '-vf', `fps=1/${n}`, '-fps_mode', 'vfr', path.join(dir, 'frame_%05d.png')],
    { duration: info.duration, onProgress, onStart });
  return dir;
}

module.exports = {
  analyze, loadAnalysis, splitShots, frameAt, framesEvery, parseTime,
};
