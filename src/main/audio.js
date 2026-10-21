// Análise de áudio: detector de momentos (picos de volume) e batidas da música (BPM).
const { start } = require('./proc');
const tools = require('./tools');

// Decodifica o áudio em mono float32 e entrega blocos de amostras.
function decodePcm(file, rate, onChunk, { duration = 0, onProgress, onStart } = {}) {
  const p = start(tools.toolPath('ffmpeg'), [
    '-hide_banner', '-nostdin', '-i', file, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(rate),
    '-f', 'f32le', 'pipe:1',
  ]);
  if (onStart) onStart(p);
  let leftover = Buffer.alloc(0);
  let samples = 0;
  // A saída padrão vira dados de áudio, não texto: lemos direto do stream.
  p.child.stdout.removeAllListeners('data');
  p.child.stdout.on('data', (buf) => {
    const data = leftover.length ? Buffer.concat([leftover, buf]) : buf;
    const usable = data.length - (data.length % 4);
    leftover = data.subarray(usable);
    const copy = new Float32Array(usable / 4);
    Buffer.from(copy.buffer).set(data.subarray(0, usable));
    samples += copy.length;
    onChunk(copy);
    if (onProgress && duration > 0) onProgress(Math.min(1, samples / rate / duration));
  });
  return p.promise.then((r) => {
    if (r.code !== 0 && samples === 0) {
      throw new Error(/does not contain any stream|matches no streams/i.test(r.stderr)
        ? 'O arquivo não tem áudio.'
        : `Falha ao ler o áudio: ${r.stderr.trim().split(/\r?\n/).pop()}`);
    }
    return samples;
  });
}

// ---------- detector de momentos ----------

function rollingMedian(values, half) {
  const out = new Float32Array(values.length);
  for (let i = 0; i < values.length; i++) {
    const a = Math.max(0, i - half);
    const b = Math.min(values.length, i + half + 1);
    const win = Array.from(values.subarray(a, b)).sort((x, y) => x - y);
    out[i] = win[win.length >> 1];
  }
  return out;
}

// Encontra trechos bem mais altos que o entorno (torcida, narrador, aplausos).
async function detectMoments(file, {
  duration = 0, sensitivity = 8, before = 10, after = 5, max = 30, onProgress, onStart,
} = {}) {
  const RATE = 8000;
  const WIN = 0.5; // segundos por janela
  const winSize = RATE * WIN;
  const levels = [];
  let acc = 0;
  let n = 0;
  await decodePcm(file, RATE, (chunk) => {
    for (let i = 0; i < chunk.length; i++) {
      acc += chunk[i] * chunk[i];
      if (++n === winSize) {
        levels.push(10 * Math.log10(acc / n + 1e-10));
        acc = 0;
        n = 0;
      }
    }
  }, { duration, onProgress, onStart });
  if (!levels.length) return { moments: [], levels: [] };

  const lv = Float32Array.from(levels);
  const baseline = rollingMedian(lv, Math.round(30 / WIN)); // 30 s para cada lado
  const sorted = Array.from(lv).sort((a, b) => a - b);
  const globalMedian = sorted[sorted.length >> 1];

  // Janelas acima do entorno, agrupadas em eventos.
  const events = [];
  let cur = null;
  for (let i = 0; i < lv.length; i++) {
    const score = lv[i] - baseline[i];
    const hot = score >= sensitivity && lv[i] > globalMedian;
    if (hot) {
      if (!cur) cur = { from: i, to: i, peak: i, score, level: lv[i] };
      cur.to = i;
      if (score > cur.score) { cur.score = score; cur.peak = i; cur.level = lv[i]; }
    } else if (cur && i - cur.to > 2) {
      events.push(cur);
      cur = null;
    }
  }
  if (cur) events.push(cur);

  // Eventos de pelo menos 1 s; junta eventos próximos (15 s).
  const merged = [];
  for (const e of events.filter((ev) => (ev.to - ev.from + 1) * WIN >= 1)) {
    const last = merged[merged.length - 1];
    if (last && (e.from - last.to) * WIN < 15) {
      last.to = e.to;
      if (e.score > last.score) { last.score = e.score; last.peak = e.peak; last.level = e.level; }
    } else {
      merged.push({ ...e });
    }
  }

  const total = lv.length * WIN;
  const top = merged
    .map((e) => ({ ...e, intensity: e.score * Math.sqrt((e.to - e.from + 1) * WIN) }))
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, max)
    .sort((a, b) => a.from - b.from);
  const maxIntensity = Math.max(...top.map((e) => e.intensity), 1);

  const moments = top.map((e, i) => {
    const peak = e.peak * WIN;
    const loudFrom = e.from * WIN;
    const loudTo = (e.to + 1) * WIN;
    return {
      index: i + 1,
      peak,
      loudFrom,
      loudTo,
      start: Math.max(0, loudFrom - before),
      end: Math.min(total, loudTo + after),
      intensity: e.intensity / maxIntensity,
      score: e.score,
    };
  });

  // Curva resumida (até 1000 pontos) para o gráfico.
  const step = Math.max(1, Math.ceil(lv.length / 1000));
  const curve = [];
  for (let i = 0; i < lv.length; i += step) {
    let m = -Infinity;
    for (let j = i; j < Math.min(lv.length, i + step); j++) m = Math.max(m, lv[j]);
    curve.push(Number(m.toFixed(1)));
  }
  return { moments, curve, curveStep: step * WIN, duration: total };
}

// ---------- batidas (BPM) ----------

function fftMag(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const ai = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k + len / 2] = re[i + k] - ar;
        im[i + k + len / 2] = im[i + k] - ai;
        re[i + k] += ar;
        im[i + k] += ai;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}

// Detecta o andamento e a posição de cada batida (método de Ellis, 2007).
async function detectBeats(file, { duration = 0, onProgress, onStart } = {}) {
  const RATE = 22050;
  const N = 1024;
  const HOP = 256;
  const fps = RATE / HOP;
  const window = new Float32Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
  const ring = new Float32Array(N);
  let filled = 0;
  let sinceHop = 0;
  let prev = null;
  const onset = [];
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const bins = 256; // até ~5,5 kHz: onde estão bateria e ataques

  await decodePcm(file, RATE, (chunk) => {
    for (let s = 0; s < chunk.length; s++) {
      ring[filled % N] = chunk[s];
      filled++;
      if (filled >= N && ++sinceHop === HOP) {
        sinceHop = 0;
        for (let i = 0; i < N; i++) {
          re[i] = ring[(filled + i) % N] * window[i];
          im[i] = 0;
        }
        fftMag(re, im);
        const mag = new Float32Array(bins);
        let flux = 0;
        for (let b = 1; b < bins; b++) {
          mag[b] = Math.log1p(100 * Math.hypot(re[b], im[b]));
          if (prev) flux += Math.max(0, mag[b] - prev[b]);
        }
        prev = mag;
        onset.push(flux);
      }
    }
  }, { duration, onProgress, onStart });

  if (onset.length < fps * 4) return { bpm: 0, beats: [] };

  // Normaliza a curva de ataques (remove a média local).
  const env = Float32Array.from(onset);
  const local = Math.round(fps * 0.5);
  const norm = new Float32Array(env.length);
  let sum = 0;
  for (let i = 0; i < env.length; i++) {
    sum += env[i];
    if (i >= 2 * local) sum -= env[i - 2 * local];
    const mean = sum / Math.min(i + 1, 2 * local);
    norm[i] = Math.max(0, env[i] - mean);
  }
  let sd = 0;
  for (const v of norm) sd += v * v;
  sd = Math.sqrt(sd / norm.length) || 1;
  for (let i = 0; i < norm.length; i++) norm[i] /= sd;

  // Andamento: autocorrelação com preferência por ~120 BPM.
  const minLag = Math.round((60 / 200) * fps);
  const maxLag = Math.round((60 / 60) * fps);
  const L = Math.min(norm.length, Math.round(fps * 90));
  let bestLag = minLag;
  let best = -Infinity;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let i = lag; i < L; i++) ac += norm[i] * norm[i - lag];
    const bpm = (60 * fps) / lag;
    const weight = Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
    if (ac * weight > best) { best = ac * weight; bestLag = lag; }
  }
  const period = bestLag;

  // Programação dinâmica para achar as batidas.
  const alpha = 100;
  const score = new Float32Array(norm.length);
  const back = new Int32Array(norm.length).fill(-1);
  for (let t = 0; t < norm.length; t++) {
    let bestPrev = 0;
    let arg = -1;
    for (let p = t - Math.round(2 * period); p <= t - Math.round(period / 2); p++) {
      if (p < 0) continue;
      const pen = -alpha * Math.log((t - p) / period) ** 2;
      const v = score[p] + pen;
      if (arg === -1 || v > bestPrev) { bestPrev = v; arg = p; }
    }
    score[t] = norm[t] + (arg >= 0 ? bestPrev : 0);
    back[t] = arg;
  }
  let t = 0;
  for (let i = Math.max(0, norm.length - period); i < norm.length; i++) if (score[i] > score[t]) t = i;
  const frames = [];
  while (t >= 0) {
    frames.push(t);
    t = back[t];
  }
  frames.reverse();
  // O ataque aparece quando o som entra no fim da janela FFT.
  const offset = N / RATE;
  const beats = frames.map((f) => Number(((f * HOP) / RATE + offset).toFixed(3)));
  const bpm = (60 * fps) / period;
  return { bpm: Math.round(bpm * 10) / 10, beats };
}

// Quantos cortes caem perto de uma batida (tolerância em segundos).
function cutsOnBeat(cuts, beats, tolerance = 0.07) {
  if (!beats.length || !cuts.length) return { onBeat: 0, total: cuts.length, ratio: 0 };
  let j = 0;
  let on = 0;
  for (const c of cuts) {
    while (j + 1 < beats.length && beats[j + 1] <= c) j++;
    const d = Math.min(Math.abs(c - beats[j]), j + 1 < beats.length ? Math.abs(beats[j + 1] - c) : Infinity);
    if (d <= tolerance) on++;
  }
  return { onBeat: on, total: cuts.length, ratio: on / cuts.length };
}

module.exports = { decodePcm, detectMoments, detectBeats, cutsOnBeat };
