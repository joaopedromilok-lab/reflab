// Recuperação de falas omitidas e filtro de repetições anormais.
//
// Por que existe: às vezes o whisper pula uma frase inteira sem avisar. Ele não
// deixa um buraco nos tempos: "estica" as palavras seguintes por cima da frase
// perdida (ex.: uma palavra de 11 s). Aqui:
//  1. compara os intervalos de fala do detector com o que as palavras de
//     duração plausível cobrem e acha lacunas suspeitas;
//  2. (em transcribe.js) transcreve de novo só a lacuna, com margem;
//  3. incorpora apenas o texto novo, na ordem certa, sem repetir palavras que já
//     estavam na transcrição, e só quando o resultado passa nas verificações.
// O texto original nunca é trocado: a recuperação só acrescenta trechos.
//
// Só regras (sem whisper), para poder testar à parte.

'use strict';

const PADRAO = {
  ativa: true,
  limiar: 2, // segundos de fala sem palavras para tentar recuperar
  palavraMaxima: 1.5, // palavra mais longa que isso tem o tempo "esticado" e não conta como cobertura
  folgaPalavra: 0.25, // cada palavra cobre também um pouco antes e depois (respiração, fim de sílaba)
  margem: 1, // segundos de áudio antes e depois da lacuna na nova tentativa
  juntar: 1, // lacunas mais próximas que isso viram uma tentativa só
  maxTentativas: 20,
  probMinima: 0.45, // confiança média mínima das palavras recuperadas
  probMinimaCurta: 0.6, // idem, para recuperações de 1 ou 2 palavras
  maxPalavrasPorSegundo: 7,
  vizinhanca: 60, // segundos ao redor da lacuna para checar se o texto recuperado só repete o vizinho
  toleranciaTempo: 1.5, // distância máxima (s) para considerar que duas palavras iguais são a mesma fala
  passo: 8, // se a lacuna inteira falhar, tenta de novo em pedaços deste tamanho (s)
  margemCurta: 0.3, // margem da última tentativa num pedaço que ainda falhou
  vizinhancaCopia: 15, // segundos ao redor da lacuna em que o texto novo não pode ser releitura de palavras vizinhas
  folgaPosicao: 1, // quanto (s) o texto novo pode invadir o tempo das palavras entre as quais ele entra
  lacunaLonga: 4, // a partir disso (s), o texto novo tem que cobrir uma parte razoável da lacuna...
  coberturaMinima: 0.3, // ...esta fração dela
  confirmar: true, // transcreve de novo só o trecho do texto aceito, com recorte justo, e confere
  margemConfirmacao: 0.5, // margem (s) desse recorte
  concordanciaMinima: 0.5, // fração das palavras novas que a segunda leitura tem que repetir
  separarConfirmacao: 2, // pausa (s) entre palavras novas que separa recortes de confirmação
};

// Repetições: (n palavras repetidas "vezes" seguidas).
// "certa": quase sempre é o whisper preso num laço -> remove as cópias, fica a primeira.
// "duvida": pode ser fala real ("não, não, não", grito de torcida) -> mantém e registra.
const REPETICAO = {
  nMaximo: 12,
  certa: [{ n: 1, vezes: 8 }, { n: 2, vezes: 5 }, { n: 6, vezes: 3 }],
  duvida: [{ n: 1, vezes: 4 }, { n: 2, vezes: 3 }, { n: 6, vezes: 2 }],
};

// No texto recuperado o critério é mais rígido: qualquer repetição suspeita
// reprova (rejeitar só mantém o texto original).
const REPETICAO_RECUPERADA = {
  nMaximo: 12,
  certa: REPETICAO.certa,
  duvida: [{ n: 1, vezes: 3 }, { n: 2, vezes: 2 }],
};

// Frases que o whisper costuma inventar em silêncio/música.
const ALUCINACOES = /amara\.org|legendas? (pela|por|da)|inscreva-se|obrigad[oa] por assistir|subt[ií]tulos|www\.|♪/i;

// Modelos em que a recuperação liga sozinha: nenhum, por enquanto. Nos testes
// com fala real (test/transcricao/FLEURS.md e CORAA.md), em frases que não
// serviram para calibrar os filtros, as recuperações aceitas no turbo pioraram
// o texto; no base, no small e no large-v3 a maioria também piorou.
// Continua disponível para experimentos com { ativa: true }.
const MODELOS_ATIVA = [];

function opcoes(o = {}) {
  return { ...PADRAO, ...o };
}

// Opções da recuperação para um modelo: "ativa" explícito nas opções vale
// mais que o padrão do modelo.
function opcoesDoModelo(model, o = {}) {
  if (o.ativa !== undefined) return { ...o, ...(o.ativa ? {} : { desligadaPorque: 'desligada nas opções' }) };
  if (MODELOS_ATIVA.includes(model)) return { ...o, ativa: true };
  return { ...o, ativa: false, desligadaPorque: `desligada por padrão (modelo "${model}"; só com ativa: true)` };
}

// Chave de comparação de uma palavra: minúsculas, sem acento e sem pontuação.
function chave(w) {
  return String(w || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}]/gu, '');
}

function parecidas(a, b) {
  if (a === b) return true;
  if (!a || !b || Math.min(a.length, b.length) < 4) return false;
  // distância de edição pequena (ex.: "chakras" x "chacras")
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 2) return false;
  let ant = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(ant[j] + 1, cur[j - 1] + 1, ant[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    ant = cur;
  }
  return ant[n] <= Math.max(1, Math.floor(Math.max(m, n) / 4));
}

function unir(intervalos) {
  const v = intervalos.filter((i) => i.end > i.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const i of v) {
    const u = out[out.length - 1];
    if (u && i.start <= u.end) u.end = Math.max(u.end, i.end);
    else out.push({ start: i.start, end: i.end });
  }
  return out;
}

const palavras = (segments) => segments.flatMap((s) => s.words || []);
const plausivel = (w, o) => w.end - w.start <= o.palavraMaxima;

// ---------- 1. lacunas ----------

// Trechos que o detector marcou como fala e que nenhuma palavra de duração
// plausível cobre, com pelo menos "limiar" segundos.
function lacunas(fala, segments, op) {
  const o = opcoes(op);
  const todas = palavras(segments);
  const cobertura = unir(todas.filter((w) => plausivel(w, o)).map((w) => ({ start: w.start - o.folgaPalavra, end: w.end + o.folgaPalavra })));
  const pedacos = [];
  for (const f of fala) {
    let ini = f.start;
    for (const c of cobertura) {
      if (c.end <= ini) continue;
      if (c.start >= f.end) break;
      if (c.start > ini) pedacos.push({ start: ini, end: c.start });
      ini = Math.max(ini, c.end);
    }
    if (ini < f.end) pedacos.push({ start: ini, end: f.end });
  }
  const grandes = pedacos.filter((p) => p.end - p.start >= o.limiar);
  const juntas = [];
  for (const p of grandes) {
    const u = juntas[juntas.length - 1];
    if (u && p.start - u.end < o.juntar) u.end = p.end;
    else juntas.push({ ...p });
  }
  return juntas.map((l) => {
    const esticadas = todas.filter((w) => !plausivel(w, o) && w.start < l.end && w.end > l.start);
    return {
      start: +l.start.toFixed(3),
      end: +l.end.toFixed(3),
      motivo: esticadas.length
        ? `fala sem texto confiável (palavras com tempo esticado: ${esticadas.map((w) => w.w).join(' ')})`
        : 'fala sem texto',
    };
  });
}

// Divide uma lacuna longa em pedaços (para a segunda tentativa).
function dividir(lacuna, op) {
  const o = opcoes(op);
  const dur = lacuna.end - lacuna.start;
  const n = Math.max(1, Math.round(dur / o.passo));
  const passo = dur / n;
  return Array.from({ length: n }, (_, k) => ({
    start: +(lacuna.start + k * passo).toFixed(3),
    end: +(k === n - 1 ? lacuna.end : lacuna.start + (k + 1) * passo).toFixed(3),
    motivo: `${lacuna.motivo || 'lacuna'} (parte ${k + 1} de ${n})`,
  }));
}

// A tentativa num trecho "pulou" a fala de novo? (nenhuma palavra no trecho,
// ou palavras com tempo esticado dentro dele)
function pulouTrecho(candidato, trecho, op) {
  const o = opcoes(op);
  const dentro = palavras(candidato).filter((w) => {
    const meio = (w.start + w.end) / 2;
    return meio >= trecho.start && meio <= trecho.end;
  });
  return !dentro.length || dentro.some((w) => !plausivel(w, o));
}

// Junta as tentativas dos pedaços de uma lacuna num candidato só: cada pedaço
// entra só com as palavras do próprio trecho (as margens se sobrepõem); o
// primeiro e o último também com as da margem de fora da lacuna.
function juntarPedacos(pedacos, lacuna) {
  return pedacos.map(({ trecho, candidato }, k) => {
    const ini = k === 0 ? -Infinity : trecho.start;
    const fim = k === pedacos.length - 1 ? Infinity : trecho.end;
    const words = palavras(candidato).filter((w) => {
      const meio = (w.start + w.end) / 2;
      return meio >= ini && meio < fim;
    });
    if (!words.length) return null;
    return { start: words[0].start, end: words[words.length - 1].end, text: words.map((w) => w.w).join(' '), words };
  }).filter(Boolean);
}

// Trecho de áudio a transcrever de novo: a lacuna com margem.
function janela(lacuna, duracao, op) {
  const o = opcoes(op);
  return { start: +Math.max(0, lacuna.start - o.margem).toFixed(3), end: +Math.min(duracao, lacuna.end + o.margem).toFixed(3) };
}

// ---------- 2. repetições ----------

function classificar(n, vezes, r = REPETICAO) {
  const bate = (lista) => lista.some((x) => n >= x.n && vezes >= x.vezes);
  if (bate(r.certa)) return 'certa';
  if (bate(r.duvida)) return 'duvida';
  return null;
}

// Procura blocos de n palavras repetidos em sequência numa lista de chaves.
function acharRepeticoes(chaves, r = REPETICAO) {
  const casos = [];
  const iguais = (a, b, n) => { for (let k = 0; k < n; k++) if (chaves[a + k] !== chaves[b + k]) return false; return true; };
  let i = 0;
  while (i < chaves.length) {
    let melhor = null;
    for (let n = 1; n <= r.nMaximo && i + 2 * n <= chaves.length; n++) {
      let vezes = 1;
      while (i + (vezes + 1) * n <= chaves.length && iguais(i, i + vezes * n, n)) vezes++;
      if (vezes < 2) continue;
      const nivel = classificar(n, vezes, r);
      if (nivel && (!melhor || n * vezes > melhor.n * melhor.vezes)) melhor = { inicio: i, n, vezes, nivel };
    }
    if (melhor) { casos.push(melhor); i += melhor.n * melhor.vezes; } else i++;
  }
  return casos;
}

// Refaz os trechos a partir de uma lista de palavras marcada com o trecho de
// origem. Trechos sem mudança mantêm o texto original exato.
function montarTrechos(itens, segments) {
  const out = [];
  let atual = null;
  for (const it of itens) {
    if (it.novo) {
      atual = null;
      out.push(it.novo);
      continue;
    }
    if (!atual || atual.origem !== it.seg) {
      atual = { origem: it.seg, words: [] };
      out.push(atual);
    }
    atual.words.push(it.w);
  }
  const contagem = new Map();
  for (const t of out) if (t.origem !== undefined) contagem.set(t.origem, (contagem.get(t.origem) || 0) + 1);
  return out.map((t) => {
    if (t.origem === undefined) return t;
    const s = segments[t.origem];
    const inteiro = contagem.get(t.origem) === 1 && t.words.length === (s.words || []).length;
    const mudouTempo = t.words.some((w) => w.retimed);
    const words = t.words.map(({ retimed, ...w }) => w);
    if (inteiro && !mudouTempo) return s;
    return {
      ...s,
      start: inteiro && !mudouTempo ? s.start : Math.min(...words.map((w) => w.start)),
      end: inteiro && !mudouTempo ? s.end : Math.max(...words.map((w) => w.end)),
      text: inteiro ? s.text : words.map((w) => w.w).join(' '),
      words,
    };
  });
}

function itensDe(segments) {
  const itens = [];
  segments.forEach((s, si) => {
    if (!(s.words || []).length) itens.push({ novo: s }); // trecho sem palavras: fica como está
    else for (const w of s.words) itens.push({ seg: si, w: { ...w } });
  });
  return itens;
}

// Remove só as repetições "certas" (fica a primeira ocorrência). As duvidosas
// ficam no texto e são devolvidas em "casos" para avaliação.
function filtrarRepeticoes(segments, r = REPETICAO) {
  const itens = itensDe(segments);
  const comPalavra = itens.map((it, k) => ({ it, k })).filter((x) => !x.it.novo && chave(x.it.w.w));
  const chaves = comPalavra.map((x) => chave(x.it.w.w));
  const casos = acharRepeticoes(chaves, r);
  const remover = new Set();
  const relato = casos.map((c) => {
    const primeira = comPalavra.slice(c.inicio, c.inicio + c.n).map((x) => x.it.w.w).join(' ');
    if (c.nivel === 'certa') {
      for (let k = c.inicio + c.n; k < c.inicio + c.n * c.vezes; k++) remover.add(comPalavra[k].k);
    }
    return {
      nivel: c.nivel,
      texto: primeira,
      vezes: c.vezes,
      inicio: comPalavra[c.inicio].it.w.start,
      decisao: c.nivel === 'certa' ? `removidas ${c.vezes - 1} cópias` : 'mantido (pode ser fala real)',
    };
  });
  if (!remover.size) return { segments, casos: relato };
  return { segments: montarTrechos(itens.filter((_, k) => !remover.has(k)), segments), casos: relato };
}

// ---------- 3. incorporar o texto recuperado ----------

// Alinha palavras originais e recuperadas. Só casa palavras iguais/parecidas e
// próximas no tempo. Uma palavra "esticada" pode estar em qualquer ponto dela
// ou da lacuna (o whisper a colocou no lugar errado).
// Onde a ordem entre uma palavra nova e uma original não é decidida pelo texto
// (nenhuma casa), decide o tempo: a nova vai depois da original se começa
// depois dela (no fim, se a original estiver esticada).
function alinharPalavras(orig, cand, lacuna, o) {
  const n = orig.length;
  const m = cand.length;
  const casa = (a, b) => {
    // Palavra curta ("o", "a", "de") aparece em todo lugar: esticada, só casa
    // perto do fim do próprio tempo (onde o whisper a deixou), não na lacuna toda.
    const esticada = !plausivel(a.w, o) && a.k.length >= 4;
    const meio = (b.w.start + b.w.end) / 2;
    if (!plausivel(a.w, o) && !esticada) {
      const perto = meio >= a.w.end - o.palavraMaxima - o.toleranciaTempo && meio <= a.w.end + o.toleranciaTempo;
      if (!perto || a.k !== b.k) return Infinity;
      return 0;
    }
    const ini = esticada ? Math.min(a.w.start, lacuna.start) : a.w.start;
    const fim = esticada ? Math.max(a.w.end, lacuna.end) : a.w.end;
    const perto = meio >= ini - o.toleranciaTempo && meio <= fim + o.toleranciaTempo;
    if (!perto || !parecidas(a.k, b.k)) return Infinity;
    return a.k === b.k ? 0 : 0.5;
  };
  const d = Array.from({ length: n + 1 }, () => new Float64Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + casa(orig[i - 1], cand[j - 1]));
    }
  }
  const ops = [];
  const meio = (w) => (w.start + w.end) / 2;
  const depoisDa = (b, a) => meio(b.w) >= (plausivel(a.w, o) ? meio(a.w) : a.w.end);
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const podeNova = j > 0 && d[i][j] === d[i][j - 1] + 1;
    const podeOriginal = i > 0 && d[i][j] === d[i - 1][j] + 1;
    if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + casa(orig[i - 1], cand[j - 1])) {
      ops.push({ tipo: 'casa', o: i - 1, c: j - 1 }); i--; j--;
    } else if (podeNova && (!podeOriginal || depoisDa(cand[j - 1], orig[i - 1]))) {
      ops.push({ tipo: 'nova', o: i - 1, c: j - 1 }); j--; // "o" = última original antes
    } else {
      ops.push({ tipo: 'so-original', o: i - 1, c: -1 }); i--;
    }
  }
  return ops.reverse();
}

// Quanto de uma lista de palavras outra leitura do mesmo áudio confirma:
// fração das palavras que aparecem, na mesma ordem, na outra leitura
// (iguais ou parecidas).
function concordancia(palavrasA, palavrasB) {
  const a = palavrasA.map(chave).filter(Boolean);
  const b = palavrasB.map(chave).filter(Boolean);
  if (!a.length) return 0;
  let ant = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = [0];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = parecidas(a[i - 1], b[j - 1]) ? ant[j - 1] + 1 : Math.max(ant[j], cur[j - 1]);
    }
    ant = cur;
  }
  return ant[b.length] / a.length;
}

function trigramas(chaves) {
  const s = new Set();
  for (let i = 0; i + 3 <= chaves.length; i++) s.add(chaves.slice(i, i + 3).join(' '));
  return s;
}

// Decide se o texto recuperado entra e devolve os trechos já com ele.
// candidato: trechos da nova tentativa (tempos no áudio original, palavras com "p").
function incorporar(segments, lacuna, candidato, op) {
  const o = opcoes(op);
  const itens = itensDe(segments);
  const comPalavra = itens.map((it, k) => ({ it, k })).filter((x) => !x.it.novo);
  const ini = lacuna.start - o.margem - o.toleranciaTempo;
  const fim = lacuna.end + o.margem + o.toleranciaTempo;
  const perto = comPalavra.filter((x) => x.it.w.end >= ini && x.it.w.start <= fim);
  const orig = perto.map((x) => ({ k: chave(x.it.w.w), w: x.it.w, item: x.k }));
  const cand = palavras(candidato).filter((w) => chave(w.w)).map((w) => ({ k: chave(w.w), w }));
  const base = { textoCandidato: candidato.map((s) => s.text).join(' ').trim() };
  let esticadas = 0; // palavras esticadas na própria nova tentativa (o whisper pulou de novo)
  const rejeitar = (motivo, extra = {}) => ({ decisao: 'rejeitada', motivo, ...base, candidatoEsticado: esticadas > 0, ...extra, segments });

  if (!cand.length) return rejeitar('nada reconhecido no trecho');

  const ops = alinharPalavras(orig, cand, lacuna, o);
  // palavras novas: não casam com a transcrição, estão dentro da lacuna e têm duração plausível
  const dentro = (w) => { const meio = (w.start + w.end) / 2; return meio >= lacuna.start - 0.3 && meio <= lacuna.end + 0.3; };
  const grupos = [];
  let grupo = null;
  for (const op2 of ops) {
    const w = op2.c >= 0 ? cand[op2.c].w : null;
    if (op2.tipo === 'nova' && dentro(w) && !plausivel(w, o)) esticadas++;
    if (op2.tipo === 'nova' && dentro(w) && plausivel(w, o)) {
      if (!grupo) { grupo = { depoisDe: op2.o, palavras: [], indices: [] }; grupos.push(grupo); }
      grupo.palavras.push(w);
      grupo.indices.push(op2.c);
    } else {
      grupo = null;
    }
  }
  const novas = grupos.flatMap((g) => g.palavras);
  const texto = novas.map((w) => w.w).join(' ');
  if (!novas.length) {
    return rejeitar(esticadas ? 'a nova tentativa também pulou a fala (palavras esticadas)' : 'o trecho só repetiu palavras que já estavam na transcrição');
  }

  // Poucas palavras novas no lugar de palavras esticadas que a nova tentativa
  // não reconheceu: é outra leitura da mesma fala ("Skellige" x "Skellegeal"), não fala nova.
  // Também quando todas as palavras novas caem dentro do tempo dessas palavras
  // esticadas e não passam do dobro delas ("Esquela de Oeste" x "Skeletal").
  const parDe = new Map(ops.filter((x) => x.tipo === 'casa').map((x) => [x.o, cand[x.c].w]));
  const semPar = orig.filter((x, i) => !parDe.has(i) && !plausivel(x.w, o) && x.w.start < lacuna.end && x.w.end > lacuna.start);
  const dentroDeSemPar = novas.filter((w) => {
    const meio = (w.start + w.end) / 2;
    return semPar.some((x) => meio >= x.w.start && meio <= x.w.end);
  }).length;
  if (semPar.length && (novas.length <= semPar.length || (dentroDeSemPar === novas.length && novas.length <= 2 * semPar.length))) {
    return rejeitar('parece outra leitura das palavras esticadas, não fala nova', { inserido: texto });
  }

  if (ALUCINACOES.test(texto)) return rejeitar('frase típica de alucinação', { inserido: texto });
  // Repetição: confere a nova tentativa inteira, não só as palavras novas
  // (um laço pode começar na margem: "O Homem de Deus. O Homem de Deus.").
  const temRepeticao = (ks) => {
    const reps = acharRepeticoes(ks, REPETICAO_RECUPERADA);
    const tri = ks.slice(0, -2).map((_, i) => ks.slice(i, i + 3).join(' '));
    if (!reps.length && !tri.some((t, i) => tri.indexOf(t) !== i)) return null;
    return reps.some((r) => r.nivel === 'certa') ? 'anormal' : 'duvidosa';
  };
  const repNovas = temRepeticao(novas.map((w) => chave(w.w)));
  if (repNovas) return rejeitar(`repetição ${repNovas} no texto recuperado`, { inserido: texto });
  const repCand = temRepeticao(cand.map((x) => x.k));
  if (repCand) return rejeitar(`a nova tentativa entrou em repetição ${repCand} (inclusive na margem)`, { inserido: texto });
  const probs = novas.map((w) => w.p).filter((p) => typeof p === 'number');
  const pMedia = probs.length ? probs.reduce((a, b) => a + b, 0) / probs.length : null;
  const minimo = novas.length <= 2 ? o.probMinimaCurta : o.probMinima;
  if (pMedia !== null && pMedia < minimo) return rejeitar(`confiança baixa (${pMedia.toFixed(2)})`, { inserido: texto, pMedia });
  const dur = Math.max(0.5, lacuna.end - lacuna.start);
  if (novas.length / dur > o.maxPalavrasPorSegundo) return rejeitar('palavras demais para o tempo da lacuna', { inserido: texto, pMedia });
  if (novas.length >= 3) {
    const viz = comPalavra
      .filter((x) => x.it.w.end >= lacuna.start - o.vizinhanca && x.it.w.start <= lacuna.end + o.vizinhanca)
      .map((x) => chave(x.it.w.w));
    const tv = trigramas(viz);
    const tn = [...trigramas(novas.map((w) => chave(w.w)))];
    const repetidos = tn.filter((t) => tv.has(t)).length;
    if (tn.length && repetidos / tn.length >= 0.5) return rejeitar('o texto recuperado repete o texto vizinho', { inserido: texto, pMedia });
  }

  // Releitura de palavras vizinhas com o tempo deslocado: palavras novas que,
  // junto com as do lado na nova tentativa, formam sequências de 2+ palavras
  // iguais ou parecidas a sequências da transcrição perto da lacuna
  // ("longas mandíbulas eram cravejadas" logo depois de "longas mandíbulas eram crevejadas").
  const viz = comPalavra
    .filter((x) => x.it.w.end >= lacuna.start - o.vizinhancaCopia && x.it.w.start <= lacuna.end + o.vizinhancaCopia)
    .map((x) => chave(x.it.w.w));
  const copiada = new Array(cand.length).fill(false);
  for (let i = 0; i < cand.length; i++) {
    for (let j = 0; j < viz.length; j++) {
      let L = 0;
      while (i + L < cand.length && j + L < viz.length && parecidas(cand[i + L].k, viz[j + L])) L++;
      if (L >= 2) for (let t = 0; t < L; t++) copiada[i + t] = true;
    }
  }
  const indices = grupos.flatMap((g) => g.indices);
  const copiadas = indices.filter((c) => copiada[c]).length;
  if (novas.length >= 2 && copiadas / novas.length >= 0.5) {
    return rejeitar(`o texto novo é releitura de palavras vizinhas (${copiadas} de ${novas.length})`, { inserido: texto, pMedia });
  }

  // Posição: cada grupo novo entra entre duas palavras da transcrição e o
  // tempo dele tem que caber entre elas. Se a vizinha também foi reconhecida
  // na nova tentativa, vale o tempo de lá (a mesma leitura, sem diferença de
  // relógio entre as duas transcrições). Palavras esticadas sem par não têm
  // tempo confiável e não contam.
  const tempoConfiavel = (i) => {
    if (i < 0 || i >= orig.length) return null;
    const par = parDe.get(i);
    if (par && plausivel(par, o)) return par;
    return plausivel(orig[i].w, o) ? orig[i].w : null;
  };
  for (const g of grupos) {
    const ini = g.palavras[0].start;
    const fim = g.palavras[g.palavras.length - 1].end;
    const antes = tempoConfiavel(g.depoisDe);
    const depois = tempoConfiavel(g.depoisDe + 1);
    if ((antes && ini < antes.end - o.folgaPosicao) || (depois && fim > depois.start + o.folgaPosicao)) {
      const vizinhas = [antes, depois].filter(Boolean).map((w) => `"${w.w}" ${w.start.toFixed(1)}-${w.end.toFixed(1)} s`).join(' e ');
      return rejeitar(`o tempo do texto novo (${ini.toFixed(1)}-${fim.toFixed(1)} s) não cabe entre as palavras onde ele entraria (${vizinhas})`, { inserido: texto, pMedia });
    }
  }

  // Encaixe no tempo. O texto só entra onde dá para provar que ele está no
  // lugar certo; na dúvida, fica o original. (A segunda leitura, em
  // transcribe.js, confirma as palavras, não a posição delas.)
  const fmtW = (w) => `"${w.w}" ${w.start.toFixed(1)}-${w.end.toFixed(1)} s`;
  // a) Palavra nova igual (ou parecida) a uma palavra da transcrição que a nova
  //    tentativa não reconheceu e que está no mesmo tempo dela (até
  //    toleranciaTempo, ou esticada por cima dela): pode ser a mesma palavra,
  //    e entraria duplicada.
  const mesmoTempo = (x, w) => {
    const m = (w.start + w.end) / 2;
    if (!plausivel(x, o)) return m >= x.start && m <= x.end;
    return Math.abs(m - (x.start + x.end) / 2) <= o.toleranciaTempo;
  };
  for (const w of novas) {
    const k = chave(w.w);
    const igual = orig.find((x, i) => !parDe.has(i) && mesmoTempo(x.w, w) && parecidas(x.k, k));
    if (igual) {
      return rejeitar(`a palavra nova "${w.w}" (${w.start.toFixed(1)} s) já está na transcrição ali perto (${fmtW(igual.w)}) e a nova tentativa não a reconheceu: pode ser a mesma palavra com outro tempo`, { inserido: texto, pMedia });
    }
  }
  // b) Palavra nova igual à vizinha onde ela entraria: ficaria repetida lado a
  //    lado, qualquer que seja o tempo ("governado pelos pelos franceses": o
  //    "pelos" original tinha o tempo deslocado pelas palavras esticadas).
  for (const g of grupos) {
    const antes = g.depoisDe >= 0 ? orig[g.depoisDe] : null;
    const depois = g.depoisDe + 1 < orig.length ? orig[g.depoisDe + 1] : null;
    const primeira = chave(g.palavras[0].w);
    const ultima = chave(g.palavras[g.palavras.length - 1].w);
    if ((antes && antes.k === primeira) || (depois && depois.k === ultima)) {
      return rejeitar(`o texto novo repetiria a palavra vizinha ("${(antes && antes.k === primeira ? antes : depois).w.w}") lado a lado`, { inserido: texto, pMedia });
    }
  }
  // c) Texto novo encostado numa palavra esticada que a nova tentativa não
  //    reconheceu. O whisper estica o começo dela para trás, sobre a fala que
  //    pulou; o fim é confiável, então a palavra está em algum ponto entre
  //    fim - palavraMaxima e fim. Só entra texto que fica inteiro de um lado
  //    desse intervalo, do lado em que o alinhamento o colocou
  //    ("mudanças [texto novo] significativas": o texto novo começava antes
  //    do fim de "mudanças" e entraria depois dela). Numa sequência de palavras
  //    esticadas só o fim da última é confiável ("Suas longas mandíbulas"):
  //    encostar numa das outras também é rejeitado.
  const esticadaSemPar = (i) => i >= 0 && i < orig.length && !plausivel(orig[i].w, o) && !parDe.has(i);
  const fimConfiavel = (i) => i + 1 >= orig.length || plausivel(orig[i + 1].w, o) || parDe.has(i + 1);
  for (const g of grupos) {
    const ini = g.palavras[0].start;
    const fim = g.palavras[g.palavras.length - 1].end;
    const ant = g.depoisDe;
    const prox = g.depoisDe + 1;
    const problema = esticadaSemPar(ant) && (!fimConfiavel(ant) || ini < orig[ant].w.end) ? orig[ant].w
      : esticadaSemPar(prox) && (!fimConfiavel(prox) || fim > orig[prox].w.end - o.palavraMaxima) ? orig[prox].w : null;
    if (problema) {
      return rejeitar(`o texto novo (${ini.toFixed(1)}-${fim.toFixed(1)} s) encostaria na palavra esticada ${fmtW(problema)}, que a nova tentativa não reconheceu, sem caber inteiro antes ou depois dela`, { inserido: texto, pMedia });
    }
  }
  // d) Texto novo picado entre palavras da transcrição que a nova tentativa não
  //    reconheceu: a fala recuperada ficaria intercalada com outra frase.
  let abriu = false;
  let originalNoMeio = null;
  for (const op2 of ops) {
    if (op2.tipo === 'casa') { abriu = false; originalNoMeio = null; continue; }
    const w = op2.c >= 0 ? cand[op2.c].w : null;
    const ehNova = op2.tipo === 'nova' && dentro(w) && plausivel(w, o);
    if (ehNova && abriu && originalNoMeio) {
      return rejeitar(`o texto novo ficaria intercalado com palavras da transcrição que a nova tentativa não reconheceu (${fmtW(originalNoMeio)})`, { inserido: texto, pMedia });
    }
    if (ehNova) abriu = true;
    else if (op2.tipo === 'so-original' && abriu) originalNoMeio = orig[op2.o].w;
  }

  // Cobertura: numa lacuna longa, o texto novo (e as palavras esticadas que a
  // nova tentativa reposicionou) tem que explicar uma parte razoável da fala.
  // Poucas palavras soltas numa lacuna longa são fragmento duvidoso.
  const durLacuna = lacuna.end - lacuna.start;
  if (durLacuna >= o.lacunaLonga) {
    const reposicionadas = [...parDe.entries()].filter(([i, c]) => !plausivel(orig[i].w, o) && plausivel(c, o)).map(([, c]) => c);
    const cobertos = unir([...novas, ...reposicionadas].map((w) => ({
      start: Math.max(lacuna.start, w.start - o.folgaPalavra),
      end: Math.min(lacuna.end, w.end + o.folgaPalavra),
    })));
    const cobertura = cobertos.reduce((acc, c) => acc + (c.end - c.start), 0) / durLacuna;
    if (cobertura < o.coberturaMinima) {
      return rejeitar(`o texto novo cobre só ${Math.round(cobertura * 100)}% da lacuna de ${durLacuna.toFixed(1)} s (provável fragmento)`, { inserido: texto, pMedia });
    }
  }

  // Aceita: corrige o tempo das palavras esticadas que a nova tentativa reconheceu
  // e insere os grupos novos na posição do alinhamento.
  let retimed = 0;
  for (const op2 of ops) {
    if (op2.tipo !== 'casa') continue;
    const a = orig[op2.o].w;
    const b = cand[op2.c].w;
    if (!plausivel(a, o) && plausivel(b, o) && parecidas(orig[op2.o].k, cand[op2.c].k)) {
      a.start = b.start; a.end = b.end; a.retimed = true; retimed++;
    }
  }
  // Palavra esticada sem par logo depois de um grupo novo (a regra "c" já
  // garantiu que ela fica depois dele): o começo esticado passaria por cima do
  // texto novo e as legendas sairiam fora de ordem. Começa onde o texto novo acaba.
  for (const g of grupos) {
    const prox = g.depoisDe + 1;
    const fimGrupo = g.palavras[g.palavras.length - 1].end;
    if (esticadaSemPar(prox) && orig[prox].w.start < fimGrupo) {
      orig[prox].w.start = Math.min(fimGrupo, orig[prox].w.end);
      orig[prox].w.retimed = true;
      retimed++;
    }
  }
  const novoTrecho = (g) => ({
    start: g.palavras[0].start,
    end: g.palavras[g.palavras.length - 1].end,
    text: g.palavras.map((w) => w.w).join(' '),
    words: g.palavras.map(({ p, ...w }) => w),
    recuperado: true,
  });
  const resultado = [];
  const porItem = new Map(); // índice do item original -> grupos que entram depois dele
  const antes = [];
  for (const g of grupos) {
    if (g.depoisDe < 0) antes.push(g);
    else {
      const k = orig[g.depoisDe].item;
      if (!porItem.has(k)) porItem.set(k, []);
      porItem.get(k).push(g);
    }
  }
  const primeiro = orig.length ? orig[0].item : itens.length;
  itens.forEach((it, k) => {
    if (k === primeiro) for (const g of antes) resultado.push({ novo: novoTrecho(g) });
    resultado.push(it);
    for (const g of porItem.get(k) || []) resultado.push({ novo: novoTrecho(g) });
  });
  if (primeiro >= itens.length) for (const g of antes) resultado.push({ novo: novoTrecho(g) });

  // Ordem do tempo: palavras novas ou com tempo corrigido não podem ficar antes
  // de uma palavra que vem antes delas no texto, nem os trechos fora de ordem.
  const segmentsNovos = montarTrechos(resultado, segments);
  const desordem = foraDeOrdem(resultado, segmentsNovos, segments);
  if (desordem) return rejeitar(`a recuperação deixaria o texto fora da ordem do tempo (${desordem})`, { inserido: texto, pMedia });

  return {
    decisao: 'aceita',
    palavrasNovas: novas.map(({ w, start, end }) => ({ w, start, end })),
    motivo: retimed ? `texto novo; ${retimed} palavra(s) esticada(s) receberam o tempo da nova tentativa` : 'texto novo',
    inserido: texto,
    pMedia,
    retimed,
    candidatoEsticado: esticadas > 0,
    ...base,
    segments: segmentsNovos,
  };
}

// Confere a ordem do tempo depois de incorporar. Só olha pares em que pelo
// menos um lado mudou (palavra recuperada ou com tempo corrigido, trecho novo
// ou refeito): desordem que já vinha do whisper não é motivo para rejeitar.
// Devolve a descrição do primeiro problema, ou null.
function foraDeOrdem(itens, novos, originais, tolerancia = 0.05) {
  const lista = [];
  for (const it of itens) {
    if (it.novo) {
      const ws = it.novo.words || [];
      if (ws.length) for (const w of ws) lista.push({ w, mudou: !!it.novo.recuperado });
      else lista.push({ w: { w: it.novo.text, start: it.novo.start, end: it.novo.end }, mudou: !!it.novo.recuperado });
    } else lista.push({ w: it.w, mudou: !!it.w.retimed });
  }
  for (let i = 1; i < lista.length; i++) {
    const a = lista[i - 1];
    const b = lista[i];
    if ((a.mudou || b.mudou) && b.w.start < a.w.start - tolerancia) {
      return `"${b.w.w}" em ${b.w.start.toFixed(2)} s vem depois de "${a.w.w}" em ${a.w.start.toFixed(2)} s`;
    }
  }
  const mantido = new Set(originais);
  for (let i = 1; i < novos.length; i++) {
    const a = novos[i - 1];
    const b = novos[i];
    if ((!mantido.has(a) || !mantido.has(b)) && b.start < a.start - tolerancia) {
      return `trecho "${String(b.text).trim().slice(0, 40)}" em ${b.start.toFixed(2)} s vem depois de um trecho em ${a.start.toFixed(2)} s`;
    }
  }
  return null;
}

module.exports = {
  PADRAO, REPETICAO, MODELOS_ATIVA, opcoes, opcoesDoModelo, chave, concordancia, lacunas, dividir, pulouTrecho, juntarPedacos, janela, acharRepeticoes, filtrarRepeticoes, incorporar,
};
