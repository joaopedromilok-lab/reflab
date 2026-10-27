// Métricas da base de testes de transcrição (só Node.js, sem dependências).
//
// - WER: taxa de erro de palavras (substituições + remoções + inserções) / palavras da referência.
// - Erro de tempo: alinha as palavras previstas com as da referência e mede a
//   diferença entre o início previsto e o início real das palavras iguais.

'use strict';

// Normaliza para comparar texto: minúsculas, sem pontuação, espaços simples.
// Com semAcento = true, também ignora acentos (útil para separar erro de grafia).
function normalizar(texto, { semAcento = false } = {}) {
  let t = String(texto || '').toLowerCase();
  if (semAcento) t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .replace(/(^|\s)['-]+|['-]+(\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(texto, opcoes) {
  const n = normalizar(texto, opcoes);
  return n ? n.split(' ') : [];
}

// Alinhamento de Levenshtein entre duas listas de palavras.
// Retorna as operações: { tipo: 'igual'|'troca'|'remocao'|'insercao', ref, hip }
// (ref/hip são índices nas listas originais; -1 quando não se aplica).
function alinhar(ref, hip) {
  const n = ref.length;
  const m = hip.length;
  const d = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const custo = ref[i - 1] === hip[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + custo);
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + (ref[i - 1] === hip[j - 1] ? 0 : 1)) {
      ops.push({ tipo: ref[i - 1] === hip[j - 1] ? 'igual' : 'troca', ref: i - 1, hip: j - 1 });
      i--;
      j--;
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ tipo: 'remocao', ref: i - 1, hip: -1 });
      i--;
    } else {
      ops.push({ tipo: 'insercao', ref: -1, hip: j - 1 });
      j--;
    }
  }
  return ops.reverse();
}

// WER entre dois textos. Retorna contagens e a taxa (0 = perfeito).
function wer(textoRef, textoHip, opcoes) {
  const ref = tokens(textoRef, opcoes);
  const hip = tokens(textoHip, opcoes);
  const ops = alinhar(ref, hip);
  const c = { igual: 0, troca: 0, remocao: 0, insercao: 0 };
  for (const o of ops) c[o.tipo]++;
  const erros = c.troca + c.remocao + c.insercao;
  return {
    palavrasRef: ref.length,
    palavrasHip: hip.length,
    acertos: c.igual,
    trocas: c.troca,
    remocoes: c.remocao,
    insercoes: c.insercao,
    wer: ref.length ? erros / ref.length : (hip.length ? 1 : 0),
    ops,
    ref,
    hip,
  };
}

// Quebra uma lista de palavras com tempo ({ w, start }) em tokens normalizados,
// mantendo o tempo da palavra original (uma palavra pode virar mais de um token).
function tokensComTempo(palavras, opcoes) {
  const out = [];
  for (const p of palavras) {
    for (const t of tokens(p.w, opcoes)) out.push({ t, start: p.start, end: p.end });
  }
  return out;
}

function percentil(valores, p) {
  if (!valores.length) return null;
  const v = [...valores].sort((a, b) => a - b);
  const k = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[k];
}

// Erro de tempo das palavras: alinha previstas x referência pelo texto e,
// para cada palavra igual, mede previsto - real (segundos).
function errosDeTempo(palavrasRef, palavrasHip, { limite = 0.3, ...opcoes } = {}) {
  const ref = tokensComTempo(palavrasRef, opcoes);
  const hip = tokensComTempo(palavrasHip, opcoes);
  const ops = alinhar(ref.map((x) => x.t), hip.map((x) => x.t));
  const pares = ops
    .filter((o) => o.tipo === 'igual')
    .map((o) => ({ palavra: ref[o.ref].t, real: ref[o.ref].start, previsto: hip[o.hip].start, erro: hip[o.hip].start - ref[o.ref].start }));
  const abs = pares.map((p) => Math.abs(p.erro));
  const media = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  return {
    palavrasComparadas: pares.length,
    palavrasRef: ref.length,
    erroMedioAbs: media(abs),
    mediana: percentil(abs, 50),
    p90: percentil(abs, 90),
    maximo: abs.length ? Math.max(...abs) : null,
    viesMedio: media(pares.map((p) => p.erro)), // negativo = previsto adiantado
    dentroDoLimite: abs.length ? abs.filter((x) => x <= limite).length / abs.length : null,
    limite,
    pares,
  };
}

// Para cada momento em que a fala começa (ex.: depois de um silêncio longo),
// acha o início de trecho previsto mais próximo e mede a diferença.
function errosDeInicio(iniciosReais, iniciosPrevistos) {
  return iniciosReais.map((real) => {
    const previsto = iniciosPrevistos.length
      ? iniciosPrevistos.reduce((a, b) => (Math.abs(b - real) < Math.abs(a - real) ? b : a))
      : null;
    return { real, previsto, erro: previsto === null ? null : previsto - real };
  });
}

// Trechos perdidos: sequências de pelo menos "minimo" palavras da referência
// removidas em seguida (trocas no meio não interrompem; inserções sim não contam).
// Devolve o texto de cada trecho.
function trechosPerdidos(resultadoWer, minimo = 3) {
  const out = [];
  let atual = [];
  const fechar = () => { if (atual.length >= minimo) out.push(atual.join(' ')); atual = []; };
  for (const o of resultadoWer.ops) {
    if (o.tipo === 'remocao') atual.push(resultadoWer.ref[o.ref]);
    else if (o.tipo !== 'insercao') fechar();
  }
  fechar();
  return out;
}

// Frases perdidas: frases da referência com pelo menos "fracao" das palavras
// removidas (não reconhecidas de jeito nenhum, nem com erro).
function frasesPerdidas(frases, textoHip, { fracao = 0.5, ...opcoes } = {}) {
  const dono = [];
  const refTokens = [];
  frases.forEach((f, i) => { for (const t of tokens(f, opcoes)) { refTokens.push(t); dono.push(i); } });
  const hip = tokens(textoHip, opcoes);
  const ops = alinhar(refTokens, hip);
  const removidas = frases.map(() => 0);
  for (const o of ops) if (o.tipo === 'remocao') removidas[dono[o.ref]]++;
  return frases
    .map((f, i) => ({ frase: f, palavras: tokens(f, opcoes).length, removidas: removidas[i] }))
    .filter((x) => x.palavras && x.removidas / x.palavras >= fracao);
}

// Repetições a mais: sequências de 4 palavras que aparecem mais vezes na
// transcrição do que na referência (sinal de laço ou de trecho duplicado).
function repeticoes(resultadoWer, n = 4) {
  const conta = (t) => {
    const m = new Map();
    for (let i = 0; i + n <= t.length; i++) { const k = t.slice(i, i + n).join(' '); m.set(k, (m.get(k) || 0) + 1); }
    return m;
  };
  const r = conta(resultadoWer.ref);
  return [...conta(resultadoWer.hip)].filter(([k, v]) => v > Math.max(1, r.get(k) || 0)).map(([k, v]) => ({ texto: k, vezes: v }));
}

module.exports = { normalizar, tokens, alinhar, wer, errosDeTempo, errosDeInicio, percentil, trechosPerdidos, frasesPerdidas, repeticoes };
