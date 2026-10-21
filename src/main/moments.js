// Detector de momentos: roda a análise de áudio, salva o resultado e exporta
// marcadores para o Premiere e o DaVinci.
const fsp = require('fs').promises;
const path = require('path');
const media = require('./media');
const audio = require('./audio');
const study = require('./study');

function baseName(file) {
  return path.basename(file, path.extname(file));
}

function momentsDir(file) {
  return path.join(path.dirname(file), `${baseName(file)} - Momentos`);
}

async function exportMarkers(r) {
  const name = baseName(r.file);
  const marks = r.moments.map((m) => ({
    t: m.peak,
    name: `Momento ${m.index}`,
    comment: `Intensidade ${Math.round(m.intensity * 100)}% · ${study.clock(m.loudFrom)} a ${study.clock(m.loudTo)}`,
  }));
  const xml = await study.writeMarkersXml(r.file, r.info, `${name} - Momentos`, marks,
    path.join(r.outDir, `${name} - Momentos (Premiere e DaVinci).xml`));
  const edl = await study.writeMarkersEdl(name, r.info.fps, marks,
    path.join(r.outDir, `${name} - Momentos (DaVinci).edl`), 'Red');
  const csv = path.join(r.outDir, `${name} - Momentos.csv`);
  const num = (n) => n.toFixed(2).replace('.', ',');
  await fsp.writeFile(csv, `﻿${[
    'Momento;Pico (s);Pico;Clipe início (s);Clipe fim (s);Intensidade (%)',
    ...r.moments.map((m) => [m.index, num(m.peak), study.clock(m.peak), num(m.start), num(m.end), Math.round(m.intensity * 100)].join(';')),
  ].join('\r\n')}`, 'utf8');
  return { xml, edl, csv };
}

async function detect(file, params = {}) {
  const info = await media.probe(file);
  if (!info.hasAudio) throw new Error('O arquivo não tem áudio.');
  const res = await audio.detectMoments(file, { ...params, duration: info.duration });
  const outDir = momentsDir(file);
  await fsp.mkdir(outDir, { recursive: true });
  const r = {
    file,
    info,
    outDir,
    params: { sensitivity: params.sensitivity, before: params.before, after: params.after, max: params.max },
    ...res,
    createdAt: Date.now(),
  };
  r.exports = await exportMarkers(r);
  await fsp.writeFile(path.join(outDir, 'momentos.json'), JSON.stringify(r, null, 2));
  return r;
}

async function load(file) {
  try {
    return JSON.parse(await fsp.readFile(path.join(momentsDir(file), 'momentos.json'), 'utf8'));
  } catch {
    return null;
  }
}

// Exporta marcadores de trechos da transcrição que contêm uma busca.
async function exportTranscriptHits(transcript, query, hits) {
  const name = baseName(transcript.file);
  const safe = query.replace(/[\\/:*?"<>|]+/g, '-').slice(0, 40);
  const marks = hits.map((s) => ({ t: s.start, name: s.text.slice(0, 60), comment: s.text }));
  const xml = await study.writeMarkersXml(transcript.file, transcript.info, `${name} - "${query}"`, marks,
    path.join(transcript.outDir, `${name} - busca ${safe} (Premiere e DaVinci).xml`));
  const edl = await study.writeMarkersEdl(name, transcript.info.fps, marks,
    path.join(transcript.outDir, `${name} - busca ${safe} (DaVinci).edl`), 'Yellow');
  return { xml, edl };
}

module.exports = { detect, load, exportTranscriptHits };
