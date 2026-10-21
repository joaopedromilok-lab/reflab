// Decupagem (roteiro AV): cada plano com miniatura, tempo e o texto falado
// nele. Junta a análise de cortes com a transcrição. Também monta a
// comparação entre referências.
const fsp = require('fs').promises;
const path = require('path');
const study = require('./study');
const transcribe = require('./transcribe');
const captions = require('./captions');
const script = require('./script');

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pct(n) {
  return `${Math.round((n || 0) * 100)}%`;
}

function shotsWithText(analysis, transcript) {
  const words = captions.allWords(transcript.segments);
  return analysis.shots.map((sh) => {
    const inShot = words.filter((w) => {
      const mid = (w.start + w.end) / 2;
      return mid >= sh.start && mid < sh.end;
    });
    return { ...sh, text: inShot.map((w) => w.w).join(' ') };
  });
}

async function build(file) {
  const analysis = await study.loadAnalysis(file);
  const transcript = await transcribe.load(file);
  if (!analysis) throw new Error('Falta a análise de cortes.');
  if (!transcript) throw new Error('Falta a transcrição.');
  const rows = shotsWithText(analysis, transcript);
  const m = transcript.metrics || script.metrics(transcript.segments, transcript.info.duration);
  const s = analysis.stats;
  const name = analysis.name;
  const rel = (p) => encodeURI(path.relative(analysis.outDir, p).split(path.sep).join('/'));

  const tableRows = rows.map((r) => `<tr>
<td class="n">${r.index}</td>
<td class="img">${r.thumb ? `<img src="${rel(r.thumb)}">` : ''}<div class="tc">${study.clock(r.start)} · ${r.duration.toFixed(1)}s</div></td>
<td class="txt">${r.text ? esc(r.text) : '<span class="mute">(sem fala)</span>'}</td>
</tr>`).join('\n');

  const html = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
<title>${esc(name)} - Decupagem</title>
<style>
body{font:13px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;margin:28px;background:#fff}
h1{font-size:20px;margin:0 0 2px}.sub{color:#666;margin-bottom:16px}
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin-bottom:18px}
.metrics div{border:1px solid #ddd;border-radius:8px;padding:8px 10px}.metrics b{display:block;font-size:17px}.metrics span{color:#666;font-size:11px}
table{width:100%;border-collapse:collapse}th{text-align:left;font-size:11px;text-transform:uppercase;color:#666;border-bottom:2px solid #111;padding:6px}
td{border-bottom:1px solid #e5e5e5;padding:8px 6px;vertical-align:top}td.n{width:28px;color:#999}td.img{width:230px}
td.img img{width:220px;border-radius:4px;display:block}.tc{font-size:11px;color:#666;margin-top:3px}.txt{font-size:14px}.mute{color:#aaa}
@media print{body{margin:10mm}tr{page-break-inside:avoid}}
</style></head><body>
<h1>${esc(name)}</h1><div class="sub">Decupagem · roteiro AV (imagem | áudio) · gerado pelo RefLab</div>
<div class="metrics">
<div><b>${s.shots}</b><span>planos</span></div>
<div><b>${s.average.toFixed(1)}s</b><span>duração média do plano</span></div>
<div><b>${s.cutsPerMinute.toFixed(1)}</b><span>cortes por minuto</span></div>
<div><b>${s.bpm ? s.bpm : '-'}</b><span>BPM da música</span></div>
<div><b>${Math.round(m.wpm)}</b><span>palavras por minuto (na fala)</span></div>
<div><b>${m.firstSpeech === null ? '-' : `${m.firstSpeech.toFixed(1)}s`}</b><span>até a primeira fala</span></div>
<div><b>${pct(m.speechRatio)}</b><span>do vídeo com fala</span></div>
<div><b>${m.words}</b><span>palavras</span></div>
</div>
<table><tr><th>#</th><th>Imagem</th><th>Áudio (fala)</th></tr>
${tableRows}
</table></body></html>`;
  const out = path.join(analysis.outDir, `${name} - Decupagem (roteiro AV).html`);
  await fsp.writeFile(out, html, 'utf8');

  const csv = path.join(analysis.outDir, `${name} - Decupagem.csv`);
  const q = (t) => `"${String(t).replace(/"/g, '""')}"`;
  await fsp.writeFile(csv, `﻿${['Plano;Início;Duração (s);Fala',
    ...rows.map((r) => [r.index, study.clock(r.start), r.duration.toFixed(2).replace('.', ','), q(r.text)].join(';'))].join('\r\n')}`, 'utf8');
  return { html: out, csv, shots: rows.length };
}

// Métricas de várias referências lado a lado.
async function compare(files) {
  const out = [];
  for (const file of files) {
    const a = await study.loadAnalysis(file);
    const t = await transcribe.load(file);
    const m = t ? (t.metrics || script.metrics(t.segments, t.info.duration)) : null;
    out.push({
      file,
      name: path.basename(file, path.extname(file)),
      thumb: a && a.shots[0] && a.shots[0].thumb,
      duration: (a && a.info.duration) || (t && t.info.duration) || null,
      hasAnalysis: !!a,
      hasTranscript: !!t,
      shots: a ? a.stats.shots : null,
      avgShot: a ? a.stats.average : null,
      cutsPerMinute: a ? a.stats.cutsPerMinute : null,
      bpm: a ? a.stats.bpm || null : null,
      cutsOnBeat: a && a.stats.bpm ? a.stats.cutsOnBeatRatio : null,
      palette: a ? (a.palette || []).slice(0, 6).map((c) => c.color) : [],
      wpm: m ? m.wpm : null,
      firstSpeech: m ? m.firstSpeech : null,
      speechRatio: m ? m.speechRatio : null,
      words: m ? m.words : null,
      wordsPerSentence: m ? m.wordsPerSentence : null,
    });
  }
  return out;
}

module.exports = { build, compare };
