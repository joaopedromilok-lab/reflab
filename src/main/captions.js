// Legendas: SRT padrão, SRT pronto para o YouTube, legenda curta estilo Reels
// e arquivo ASS com a palavra atual destacada (para gravar no vídeo).

function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(h)}:${p(m)}:${p(s)},${p(ms % 1000, 3)}`;
}

function toSrt(cues) {
  return cues.map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}

// Distribui palavras ao longo de um segmento quando não há tempo por palavra.
function spreadWords(seg) {
  const tokens = seg.text.split(/\s+/).filter(Boolean);
  const total = tokens.reduce((a, w) => a + w.length + 1, 0) || 1;
  let t = seg.start;
  const span = Math.max(0.01, seg.end - seg.start);
  return tokens.map((w) => {
    const d = (span * (w.length + 1)) / total;
    const word = { w, start: t, end: t + d };
    t += d;
    return word;
  });
}

function allWords(segments) {
  return segments.flatMap((s) => (s.words && s.words.length ? s.words : spreadWords(s)));
}

// Agrupa palavras em legendas: cada uma com até maxChars por linha e maxLines linhas.
function groupWords(words, { maxChars = 42, maxLines = 2, maxDur = 6, minGap = 0.8, maxWords = 0 } = {}) {
  const cues = [];
  let cur = null;
  const flush = () => {
    if (!cur) return;
    cues.push(cur);
    cur = null;
  };
  for (const w of words) {
    const word = w.w.trim();
    if (!word) continue;
    if (cur) {
      const lines = wrap(`${cur.raw} ${word}`, maxChars);
      const gap = w.start - cur.end;
      const tooLong = lines.length > maxLines || w.end - cur.start > maxDur || gap > minGap
        || (maxWords && cur.words.length >= maxWords);
      const sentenceEnd = /[.!?…]$/.test(cur.raw) && cur.raw.length > maxChars * 0.5;
      if (tooLong || sentenceEnd) flush();
    }
    if (!cur) cur = { start: w.start, end: w.end, raw: word, words: [w] };
    else {
      cur.raw += ` ${word}`;
      cur.end = w.end;
      cur.words.push(w);
    }
  }
  flush();
  return cues.map((c, i) => ({
    start: c.start,
    end: Math.max(c.end, Math.min(c.start + 1, cues[i + 1] ? cues[i + 1].start : c.start + 1)),
    text: wrap(c.raw, maxChars).join('\n'),
    words: c.words,
  }));
}

function wrap(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && (line + ' ' + w).length > maxChars) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  // Equilibra duas linhas (evita uma linha longa e outra com uma palavra só).
  if (lines.length === 2 && lines[1].length < lines[0].length / 3) {
    const all = text.split(' ');
    let best = null;
    for (let i = 1; i < all.length; i++) {
      const a = all.slice(0, i).join(' ');
      const b = all.slice(i).join(' ');
      if (a.length > maxChars || b.length > maxChars) continue;
      const score = Math.abs(a.length - b.length);
      if (!best || score < best.score) best = { a, b, score };
    }
    if (best) return [best.a, best.b];
  }
  return lines;
}

function segmentsSrt(segments) {
  return toSrt(segments.map((s) => ({ start: s.start, end: s.end, text: s.text })));
}

function youtubeSrt(segments) {
  return toSrt(groupWords(allWords(segments), { maxChars: 42, maxLines: 2, maxDur: 6 }));
}

function reelsSrt(segments) {
  return toSrt(groupWords(allWords(segments), { maxChars: 16, maxLines: 1, maxDur: 2, minGap: 0.4 }));
}

// ---------- ASS (legenda gravada no vídeo) ----------

// Estilos prontos. Cada um pode ser ajustado na tela.
const PRESETS = {
  amarelo: { font: 'Anton', textColor: '#FFFFFF', highlight: '#FFD23F', uppercase: true, size: 'm', position: 'low', maxWords: 3, box: false },
  verde: { font: 'Anton', textColor: '#FFFFFF', highlight: '#3CFF6B', uppercase: true, size: 'l', position: 'low', maxWords: 2, box: false },
  caixa: { font: 'Poppins ExtraBold', textColor: '#FFFFFF', highlight: '#FFD23F', uppercase: false, size: 'm', position: 'low', maxWords: 3, box: true, boxColor: '#111111' },
  minimalista: { font: 'DM Serif Display', textColor: '#FFFFFF', highlight: '#FFFFFF', uppercase: false, size: 's', position: 'low', maxWords: 5, box: false },
  classico: { font: 'Poppins ExtraBold', textColor: '#FFFFFF', highlight: '#FFD23F', uppercase: false, size: 'm', position: 'low', maxWords: 3, box: false },
};

const FONT_FILES = {
  Anton: 'Anton-Regular.ttf',
  'Poppins ExtraBold': 'Poppins-ExtraBold.ttf',
  'DM Serif Display': 'DMSerifDisplay-Regular.ttf',
};

function normalizeStyle(style = {}) {
  const base = PRESETS[style.preset] || PRESETS.amarelo;
  return {
    keywordColor: '#FF5A4E',
    keywords: '',
    boxColor: '#000000',
    ...base,
    ...Object.fromEntries(Object.entries(style).filter(([, v]) => v !== undefined && v !== null && v !== '')),
  };
}

function assColor(hex) {
  const h = String(hex || '#FFFFFF').replace('#', '').padEnd(6, 'F');
  return `&H00${h.slice(4, 6)}${h.slice(2, 4)}${h.slice(0, 2)}`.toUpperCase();
}

function assTime(t) {
  const cs = Math.max(0, Math.round(t * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs % 100).padStart(2, '0')}`;
}

function assEscape(t) {
  return t.replace(/\\/g, '').replace(/[{}]/g, '');
}

function plain(t) {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]+/gu, '');
}

// words: [{w, start, end}] já no tempo do vídeo final.
function buildAss(words, { width, height, style: rawStyle } = {}) {
  const st = normalizeStyle(rawStyle);
  const vertical = height > width;
  const shortSide = Math.min(width, height);
  const sizeFactor = { s: 0.062, m: 0.08, l: 0.1 }[st.size] || 0.08;
  const fontSize = Math.round(sizeFactor * shortSide * (st.font === 'Anton' ? 1.05 : 0.9));
  const marginV = Math.round({
    low: height * (vertical ? 0.2 : 0.08),
    middle: height * 0.45,
    high: height * (vertical ? 0.72 : 0.8),
  }[st.position] || height * 0.2);
  const keywords = new Set(String(st.keywords || '').split(',').map((k) => plain(k)).filter(Boolean));
  const maxWords = Math.max(1, Math.min(6, Number(st.maxWords) || 3));
  const charsPerLine = Math.max(8, Math.round((width * 0.85) / (fontSize * 0.55)));
  const cues = groupWords(words, {
    maxChars: charsPerLine, maxLines: maxWords > 3 ? 2 : 1, maxDur: maxWords > 3 ? 3.5 : 2.2, minGap: 0.4, maxWords,
  });
  const fmt = (t) => (st.uppercase ? t.toUpperCase() : t);
  const textColor = assColor(st.textColor);
  const lines = [];
  for (const cue of cues) {
    cue.words.forEach((w, i) => {
      const start = i === 0 ? cue.start : w.start;
      const end = i + 1 < cue.words.length ? cue.words[i + 1].start : cue.end;
      if (end <= start) return;
      const text = cue.words.map((x, j) => {
        const t = assEscape(fmt(x.w.trim()));
        if (keywords.has(plain(x.w))) return `{\\c${assColor(st.keywordColor)}\\fscx118\\fscy118}${t}{\\c${textColor}\\fscx100\\fscy100}`;
        if (j === i && st.highlight && st.highlight.toUpperCase() !== String(st.textColor).toUpperCase()) {
          return `{\\c${assColor(st.highlight)}}${t}{\\c${textColor}}`;
        }
        return t;
      }).join(' ');
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Reels,,0,0,0,,${text}`);
    });
  }
  // Caixa: BorderStyle 3 desenha um retângulo com a cor do contorno.
  const borderStyle = st.box ? 3 : 1;
  const outlineColor = st.box ? assColor(st.boxColor) : '&H00000000';
  const outline = st.box ? Math.round(fontSize * 0.22) : Math.round(fontSize * (st.font === 'DM Serif Display' ? 0.04 : 0.08));
  const shadow = st.box ? 0 : Math.round(fontSize * 0.04);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Reels,${st.font},${fontSize},${textColor},${textColor},${outlineColor},&H80000000,0,0,0,0,100,100,1,0,${borderStyle},${outline},${shadow},2,${Math.round(width * 0.06)},${Math.round(width * 0.06)},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;
}

module.exports = {
  toSrt, segmentsSrt, youtubeSrt, reelsSrt, buildAss, spreadWords, allWords, srtTime, PRESETS, FONT_FILES, normalizeStyle,
};
