// Estudo de roteiro a partir da transcrição: métricas de fala e capítulos.
const { allWords } = require('./captions');

function clockShort(t) {
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function metrics(segments, duration) {
  const words = allWords(segments).filter((w) => /[\p{L}\p{N}]/u.test(w.w));
  if (!words.length) {
    return { words: 0, wpm: 0, wpmTotal: 0, firstSpeech: null, speechRatio: 0, pauses: 0, avgPause: 0, longestPause: 0, sentences: 0, wordsPerSentence: 0, longestSentence: '' };
  }
  // Tempo de fala: une palavras separadas por menos de 0,7 s.
  let speech = 0;
  let pauses = 0;
  let pauseSum = 0;
  let longestPause = 0;
  let runStart = words[0].start;
  let runEnd = words[0].end;
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - runEnd;
    if (gap > 0.7) {
      speech += runEnd - runStart;
      pauses++;
      pauseSum += gap;
      longestPause = Math.max(longestPause, gap);
      runStart = words[i].start;
    }
    runEnd = Math.max(runEnd, words[i].end);
  }
  speech += runEnd - runStart;

  const text = segments.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
  const sentences = text.split(/(?<=[.!?…])\s+/).map((s) => s.trim()).filter((s) => /[\p{L}]/u.test(s));
  const counts = sentences.map((s) => s.split(/\s+/).length);
  const longest = sentences[counts.indexOf(Math.max(...counts))] || '';

  return {
    words: words.length,
    wpm: speech > 0 ? words.length / (speech / 60) : 0,
    wpmTotal: duration > 0 ? words.length / (duration / 60) : 0,
    firstSpeech: words[0].start,
    speechTime: speech,
    speechRatio: duration > 0 ? Math.min(1, speech / duration) : 0,
    pauses,
    avgPause: pauses ? pauseSum / pauses : 0,
    longestPause,
    sentences: sentences.length,
    wordsPerSentence: sentences.length ? words.length / sentences.length : 0,
    longestSentence: longest,
  };
}

function titleFrom(text) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 7).join(' ').replace(/[,;:.!?…]+$/, '');
  return words ? words[0].toUpperCase() + words.slice(1) : 'Trecho';
}

// Capítulos para a descrição do YouTube: começa em 0:00, mínimo de 3,
// cada um com pelo menos 10 s, cortando nas maiores pausas perto do ideal.
function chapters(segments, duration) {
  if (!segments.length || duration < 60) return [];
  const n = Math.max(3, Math.min(12, Math.round(duration / 90)));
  const candidates = segments.map((s, i) => ({
    t: s.start,
    gap: i ? s.start - segments[i - 1].end : 0,
    seg: s,
  })).filter((c) => c.t >= 10 && duration - c.t >= 10);
  const picked = [{ t: 0, seg: segments[0] }];
  for (let k = 1; k < n; k++) {
    const target = (k * duration) / n;
    const last = picked[picked.length - 1].t;
    let best = null;
    for (const c of candidates) {
      if (c.t - last < 10) continue;
      const score = Math.abs(c.t - target) / (duration / n) - Math.min(c.gap, 3) * 0.4;
      if (!best || score < best.score) best = { ...c, score };
    }
    if (best && Math.abs(best.t - target) < duration / n) picked.push(best);
  }
  if (picked.length < 3) return [];
  return picked.map((p) => ({ t: p.t, title: titleFrom(p.seg.text) }));
}

function chaptersText(list) {
  return list.map((c) => `${clockShort(c.t)} ${c.title}`).join('\n');
}

module.exports = { metrics, chapters, chaptersText, clockShort };
