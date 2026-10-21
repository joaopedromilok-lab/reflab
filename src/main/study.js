// Ferramentas de estudo: detecção de cortes, exportação para o editor
// (XML para Premiere/DaVinci, EDL de marcadores para DaVinci, CSV),
// divisão em planos, folha de contato e extração de frames.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const media = require('./media');
const audio = require('./audio');

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

async function analyze(file, { threshold = 0.3, minShot = 0.3, withBeats = true, onProgress, onStart } = {}) {
  const info = await media.probe(file);
  if (!info.hasVideo) throw new Error('O arquivo não tem vídeo.');
  const outDir = analysisDir(file);
  const framesDir = path.join(outDir, 'Frames dos planos');
  await fsp.rm(framesDir, { recursive: true, force: true });
  await fsp.mkdir(framesDir, { recursive: true });

  // 1ª passada (50% do progresso): encontra os cortes.
  const times = [];
  await media.ffmpeg([
    '-i', file, '-an', '-sn', '-dn',
    '-vf', `scale=480:-2,select='gt(scene,${threshold})',showinfo`,
    '-f', 'null', '-',
  ], {
    duration: info.duration,
    onProgress: onProgress && ((p) => onProgress(p * 0.5)),
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

  // 2ª passada (25%): um frame do meio de cada plano (o primeiro frame
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
      onProgress: onProgress && ((p) => onProgress(0.5 + 0.25 * ((b + p * group.length) / shots.length))),
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

  // Paleta de cores de cada plano e do vídeo todo.
  const palette = await computePalettes(shots, outDir).catch(() => []);

  // Batidas da música e quantos cortes caem na batida.
  let beats = null;
  if (info.hasAudio && withBeats) {
    try {
      beats = await audio.detectBeats(file, {
        duration: info.duration,
        onStart,
        onProgress: onProgress && ((p) => onProgress(0.75 + 0.25 * p)),
      });
      if (beats.confidence < audio.MIN_BEAT_CONFIDENCE) {
        // Sem batida marcada: não inventa BPM.
        stats.noBeat = true;
        beats = { bpm: 0, beats: [], confidence: beats.confidence };
      } else {
        const align = audio.cutsOnBeat(shots.slice(1).map((s) => s.start), beats.beats);
        stats.bpm = beats.bpm;
        stats.cutsOnBeat = align.onBeat;
        stats.cutsOnBeatRatio = align.ratio;
      }
    } catch {
      beats = null;
    }
  }

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
    palette,
    beats,
    favorites: [],
    exports: {},
    createdAt: Date.now(),
  };

  if (beats && beats.beats.length) {
    const marks = beats.beats.map((t, i) => ({ t, name: `Batida ${i + 1}` }));
    result.exports.beatsXml = await writeMarkersXml(file, info, `${result.name} - Batidas (${beats.bpm} BPM)`, marks,
      path.join(outDir, `${result.name} - Batidas ${Math.round(beats.bpm)} BPM (Premiere e DaVinci).xml`));
    result.exports.beatsEdl = await writeMarkersEdl(result.name, info.fps, marks,
      path.join(outDir, `${result.name} - Batidas (DaVinci).edl`), 'Green');
  }
  result.exports.xml = await writeXml(result);
  result.exports.edl = await writeEdl(result);
  result.exports.csv = await writeCsv(result);
  result.exports.sheets = await writeContactSheets(result);
  result.exports.html = await writeHtml(result);
  await fsp.writeFile(path.join(outDir, 'analise.json'), JSON.stringify(result, null, 2));
  return result;
}

// ---------- paleta de cores ----------

function kmeans(pixels, k, iterations = 8) {
  if (!pixels.length) return [];
  const lum = (p) => p[0] * 0.3 + p[1] * 0.59 + p[2] * 0.11;
  const sorted = [...pixels].sort((a, b) => lum(a) - lum(b));
  let centers = Array.from({ length: k }, (_, i) => [...sorted[Math.floor(((i + 0.5) / k) * sorted.length)]]);
  let counts = new Array(k).fill(0);
  for (let it = 0; it < iterations; it++) {
    const sums = centers.map(() => [0, 0, 0]);
    counts = new Array(k).fill(0);
    for (const p of pixels) {
      let best = 0;
      let bd = Infinity;
      for (let c = 0; c < k; c++) {
        const d = (p[0] - centers[c][0]) ** 2 + (p[1] - centers[c][1]) ** 2 + (p[2] - centers[c][2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      }
      sums[best][0] += p[0];
      sums[best][1] += p[1];
      sums[best][2] += p[2];
      counts[best]++;
    }
    centers = centers.map((c, i) => (counts[i] ? sums[i].map((v) => v / counts[i]) : c));
  }
  const hex = (c) => `#${c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  return centers
    .map((c, i) => ({ color: hex(c), weight: counts[i] / pixels.length }))
    .filter((c) => c.weight > 0)
    .sort((a, b) => b.weight - a.weight);
}

async function computePalettes(shots, outDir) {
  const withThumbs = shots.filter((s) => s.thumb);
  if (!withThumbs.length) return [];
  const W = 24;
  const H = 14;
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'reflab-pal-'));
  const list = path.join(tmp, 'lista.txt');
  const raw = path.join(tmp, 'pixels.rgb');
  const esc = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  await fsp.writeFile(list, withThumbs.map((s) => `file '${esc(s.thumb)}'\nduration 1`).join('\n'), 'utf8');
  try {
    await media.ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-vf', `scale=${W}:${H}`,
      '-fps_mode', 'passthrough', '-f', 'rawvideo', '-pix_fmt', 'rgb24', raw]);
    const buf = await fsp.readFile(raw);
    const frame = W * H * 3;
    const all = [];
    withThumbs.forEach((s, i) => {
      const px = [];
      for (let o = i * frame; o < (i + 1) * frame && o + 2 < buf.length; o += 3) px.push([buf[o], buf[o + 1], buf[o + 2]]);
      s.palette = kmeans(px, 5).map((c) => c.color);
      for (let j = 0; j < px.length; j += 3) all.push(px[j]);
    });
    const overall = kmeans(all, 8, 10);
    await fsp.writeFile(path.join(outDir, 'Paleta de cores.txt'),
      ['Paleta geral (da cor mais presente para a menos presente):', ...overall.map((c) => `${c.color}  ${(c.weight * 100).toFixed(1)}%`)].join('\n'), 'utf8');
    return overall;
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function loadAnalysis(file) {
  try {
    const raw = await fsp.readFile(path.join(analysisDir(file), 'analise.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Salva favoritos e anotações dos planos (um salvamento por vez).
let updateQueue = Promise.resolve();
function updateAnalysis(file, patch) {
  const next = updateQueue.then(() => doUpdateAnalysis(file, patch));
  updateQueue = next.catch(() => {});
  return next;
}

async function doUpdateAnalysis(file, patch) {
  const r = await loadAnalysis(file);
  if (!r) throw new Error('Análise não encontrada.');
  if (Array.isArray(patch.favorites)) r.favorites = patch.favorites;
  if (patch.notes && typeof patch.notes === 'object') r.notes = { ...(r.notes || {}), ...patch.notes };
  await fsp.writeFile(path.join(r.outDir, 'analise.json'), JSON.stringify(r, null, 2));
  return r;
}

// ---------- exportações ----------

// XML (Final Cut Pro 7 / xmeml): importável no Premiere (Arquivo > Importar)
// e no DaVinci Resolve (Arquivo > Importar > Timeline).
// clips: trechos do arquivo colocados em sequência na timeline;
// markers: marcadores da sequência [{ t, name, comment }].
function buildXmeml({ file, info, name, clips, markers = [] }) {
  const { fps, width, height, duration, hasAudio, hasVideo, sampleRate, channels } = info;
  const { base, ntsc } = timebase(fps || 30);
  const f = (t) => frameOf(t, fps || 30);
  const rate = `<rate><timebase>${base}</timebase><ntsc>${ntsc ? 'TRUE' : 'FALSE'}</ntsc></rate>`;
  const total = f(duration);
  const tc = `<timecode>${rate}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`;
  const videoChars = `<samplecharacteristics>${rate}<width>${width || 1920}</width><height>${height || 1080}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics>`;
  const fileDef = `<file id="file-1"><name>${xmlEsc(path.basename(file))}</name><pathurl>${xmlEsc(fileUrlForEditors(file))}</pathurl>${rate}<duration>${total}</duration>${tc}<media>${hasVideo !== false ? `<video>${videoChars}</video>` : ''}${hasAudio ? `<audio><samplecharacteristics><depth>16</depth><samplerate>${sampleRate || 48000}</samplerate></samplecharacteristics><channelcount>${channels || 2}</channelcount></audio>` : ''}</media></file>`;

  let pos = 0;
  let defined = false;
  const placed = clips.map((c, i) => {
    const inF = f(c.start);
    const outF = f(c.end);
    const item = { ...c, i, inF, outF, startF: pos, endF: pos + (outF - inF) };
    pos = item.endF;
    return item;
  });
  const clipXml = (c, kind) => {
    const fileXml = defined ? '<file id="file-1"/>' : fileDef;
    defined = true;
    const src = kind === 'a' ? '<sourcetrack><mediatype>audio</mediatype><trackindex>1</trackindex></sourcetrack>' : '';
    return `<clipitem id="clipitem-${kind}${c.i + 1}"><name>${xmlEsc(c.name || `Trecho ${c.i + 1}`)}</name><enabled>TRUE</enabled><duration>${total}</duration>${rate}<start>${c.startF}</start><end>${c.endF}</end><in>${c.inF}</in><out>${c.outF}</out>${fileXml}${src}</clipitem>`;
  };
  const videoTrack = hasVideo !== false ? `<track>\n${placed.map((c) => clipXml(c, 'v')).join('\n')}\n</track>` : '';
  const audioTrack = hasAudio ? `<track>\n${placed.map((c) => clipXml(c, 'a')).join('\n')}\n</track>` : '';
  const markerXml = markers.map((m) =>
    `<marker><name>${xmlEsc(m.name)}</name><comment>${xmlEsc(m.comment || '')}</comment><in>${f(m.t)}</in><out>-1</out></marker>`).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE xmeml>
<xmeml version="5">
<sequence id="sequence-1">
<name>${xmlEsc(name)}</name>
<duration>${pos}</duration>
${rate}
${tc}
<media>
<video>
<format>${videoChars}</format>
${videoTrack}
</video>
<audio>
<numOutputChannels>2</numOutputChannels>
<format><samplecharacteristics><depth>16</depth><samplerate>${sampleRate || 48000}</samplerate></samplecharacteristics></format>
${audioTrack}
</audio>
</media>
${markerXml}
</sequence>
</xmeml>
`;
}

// Timeline já cortada em cada plano, com um marcador em cada corte.
async function writeXml(r) {
  const xml = buildXmeml({
    file: r.file,
    info: r.info,
    name: `${r.name} - Cortes`,
    clips: r.shots.map((s) => ({ start: s.start, end: s.end, name: `Plano ${String(s.index).padStart(3, '0')}` })),
    markers: r.shots.slice(1).map((s) => ({ t: s.start, name: `Plano ${s.index}`, comment: `Corte em ${clock(s.start)}` })),
  });
  const out = path.join(r.outDir, `${r.name} - Timeline cortada (Premiere e DaVinci).xml`);
  await fsp.writeFile(out, xml, 'utf8');
  return out;
}

// Timeline com o arquivo inteiro e marcadores (momentos, batidas, palavras...).
async function writeMarkersXml(file, info, title, markers, out) {
  const xml = buildXmeml({ file, info, name: title, clips: [{ start: 0, end: info.duration, name: path.basename(file) }], markers });
  await fsp.writeFile(out, xml, 'utf8');
  return out;
}

// EDL de marcadores no formato do DaVinci Resolve
// (Timeline > Importar > Marcadores da timeline de EDL). Começa em 01:00:00:00.
async function writeMarkersEdl(title, fps, markers, out, color = 'Blue') {
  const { base } = timebase(fps || 30);
  const lines = [`TITLE: ${String(title).replace(/[^\x20-\x7E]/g, '_')}`, 'FCM: NON-DROP FRAME', ''];
  markers.forEach((m, i) => {
    const fr = frameOf(m.t, fps || 30);
    const a = tcFromFrames(fr, base, 1);
    const b = tcFromFrames(fr + 1, base, 1);
    lines.push(`${String(i + 1).padStart(3, '0')}  001      V     C        ${a} ${b} ${a} ${b}  `);
    lines.push(` |C:ResolveColor${color} |M:${String(m.name).replace(/\|/g, '/')} |D:1`);
    lines.push('');
  });
  await fsp.writeFile(out, lines.join('\r\n'), 'utf8');
  return out;
}

async function writeEdl(r) {
  return writeMarkersEdl(r.name, r.info.fps,
    r.shots.map((s) => ({ t: s.start, name: `Plano ${s.index}` })),
    path.join(r.outDir, `${r.name} - Marcadores (DaVinci).edl`));
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
      ${sh.palette ? `<div class="pal">${sh.palette.map((c) => `<i style="background:${c}"></i>`).join('')}</div>` : ''}
      <figcaption><b>Plano ${sh.index}</b><span>${clock(sh.start)} · ${sh.duration.toFixed(2)}s</span></figcaption></figure>`).join('');
  const overall = (r.palette || []).map((c) => `<i style="background:${c.color};flex:${Math.max(0.05, c.weight)}" title="${c.color}"></i>`).join('');
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
.pal{display:flex;height:8px}.pal i{flex:1}.overall{display:flex;height:34px;border-radius:8px;overflow:hidden;margin:16px 0}.overall i{display:block}
</style></head><body>
<h1>${xmlEsc(r.name)}</h1><div class="sub">Análise de cortes · gerado pelo RefLab</div>
<div class="stats">
<div class="stat"><b>${s.shots}</b><span>planos</span></div>
<div class="stat"><b>${s.average.toFixed(2)}s</b><span>duração média do plano</span></div>
<div class="stat"><b>${s.median.toFixed(2)}s</b><span>mediana</span></div>
<div class="stat"><b>${s.cutsPerMinute.toFixed(1)}</b><span>cortes por minuto</span></div>
<div class="stat"><b>${s.shortest.toFixed(2)}s</b><span>plano mais curto</span></div>
<div class="stat"><b>${s.longest.toFixed(2)}s</b><span>plano mais longo</span></div>
${s.bpm ? `<div class="stat"><b>${s.bpm}</b><span>BPM da música</span></div>` : ''}
${s.bpm && s.cuts ? `<div class="stat"><b>${Math.round((s.cutsOnBeatRatio || 0) * 100)}%</b><span>dos cortes na batida</span></div>` : ''}
</div>
${overall ? `<p class="sub">Paleta de cores do vídeo</p><div class="overall">${overall}</div>` : ''}
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
  analyze, loadAnalysis, updateAnalysis, splitShots, frameAt, framesEvery, parseTime,
  writeMarkersXml, writeMarkersEdl, clock, buildXmeml,
};
