'use strict';
// Testes da recuperação de falas omitidas e do filtro de repetições (sem whisper): npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const rec = require('../../src/main/recuperacao');

// Monta um trecho a partir de "palavra@início-fim" separados por espaço.
function trecho(spec, extra = {}) {
  const words = spec.split(' ').map((x) => {
    const [w, t] = x.split('@');
    const [start, end] = t.split('-').map(Number);
    return { w, start, end, ...extra };
  });
  return { start: words[0].start, end: words[words.length - 1].end, text: words.map((w) => w.w).join(' '), words };
}
// Palavras seguidas a partir de "t", 0,4 s cada.
function fala(texto, t, extra) {
  return trecho(texto.split(' ').map((w, i) => `${w}@${(t + i * 0.4).toFixed(2)}-${(t + i * 0.4 + 0.35).toFixed(2)}`).join(' '), extra);
}
const texto = (segs) => segs.map((s) => s.text).join(' ');

// ---------- lacunas ----------

test('fala coberta por palavras não gera lacuna; pausa entre falas do detector também não', () => {
  const segs = [fala('um dois três quatro', 0), fala('cinco seis sete oito', 10)];
  assert.deepEqual(rec.lacunas([{ start: 0, end: 1.6 }, { start: 10, end: 11.6 }], segs), []);
});

test('fala sem palavras gera lacuna; abaixo do limiar não', () => {
  const segs = [fala('um dois três', 0), fala('quatro cinco seis', 8)];
  const l = rec.lacunas([{ start: 0, end: 9 }], segs);
  assert.equal(l.length, 1);
  assert.ok(l[0].start > 1 && l[0].start < 1.5, `início ${l[0].start}`);
  assert.ok(l[0].end > 7.5 && l[0].end <= 8, `fim ${l[0].end}`);
  assert.equal(l[0].motivo, 'fala sem texto');
  // limiar configurável
  assert.equal(rec.lacunas([{ start: 0, end: 9 }], segs, { limiar: 8 }).length, 0);
});

test('palavras com tempo esticado não contam como cobertura (frase pulada pelo whisper)', () => {
  // caso real: "Suas longas mandíbulas" esticadas por cima de uma frase de 20 s que sumiu
  const segs = [
    trecho('novo@62.58-62.89 projeto.@62.89-63.74'),
    trecho('Suas@63.74-68.06 longas@68.40-75.27 mandíbulas@75.27-86.76 eram@86.83-87.11 cravejadas@87.27-87.89'),
  ];
  const l = rec.lacunas([{ start: 62.5, end: 88 }], segs);
  assert.equal(l.length, 1);
  assert.ok(l[0].start < 64.1 && l[0].end > 86.5, JSON.stringify(l[0]));
  assert.match(l[0].motivo, /esticado/);
});

test('lacunas próximas viram uma tentativa só; janela tem margem e respeita o arquivo', () => {
  const segs = [fala('a b', 0), fala('c', 3.5), fala('d e', 7)];
  const l = rec.lacunas([{ start: 0, end: 8 }], segs, { limiar: 2, juntar: 1 });
  assert.equal(l.length, 1);
  const j = rec.janela({ start: 0.5, end: 7.9 }, 8, { margem: 1 });
  assert.deepEqual(j, { start: 0, end: 8 });
});

// ---------- incorporar ----------

test('insere só o texto novo, na ordem, sem duplicar as palavras das margens', () => {
  const segs = [fala('o carro saiu da pista', 0), fala('e a corrida acabou', 10)];
  const lac = { start: 2.3, end: 9.7, motivo: 'fala sem texto' };
  // nova tentativa (janela 1,3-10,7): repete a última palavra antes e a primeira depois
  const cand = [fala('pista o piloto ficou bem e', 1.6, { p: 0.9 })];
  cand[0].words[0].start = 1.6; cand[0].words[0].end = 1.95; // "pista" (já transcrita)
  cand[0].words[5].start = 10.0; cand[0].words[5].end = 10.2; // "e" (já transcrita)
  for (const [i, t] of [[1, 3], [2, 4], [3, 5], [4, 6]]) { cand[0].words[i].start = t; cand[0].words[i].end = t + 0.4; }
  const r = rec.incorporar(segs, lac, cand);
  assert.equal(r.decisao, 'aceita', r.motivo);
  assert.equal(r.inserido, 'o piloto ficou bem');
  assert.equal(texto(r.segments), 'o carro saiu da pista o piloto ficou bem e a corrida acabou');
  // os trechos originais continuam idênticos
  assert.equal(r.segments[0], segs[0]);
  assert.equal(r.segments[2], segs[1]);
  assert.equal(r.segments[1].recuperado, true);
});

test('frase pulada: insere antes das palavras esticadas e corrige o tempo delas', () => {
  const segs = [
    trecho('novo@62.58-62.89 projeto.@62.89-63.74'),
    trecho('Suas@63.74-68.06 longas@68.40-75.27 mandíbulas@75.27-86.76 eram@86.83-87.11 cravejadas@87.27-87.89'),
  ];
  const lac = rec.lacunas([{ start: 62.5, end: 88 }], segs)[0];
  const nova = 'A parte central da meditação tibetana é o Deity Yoga e a consciência é criada.'.split(' ');
  const ws = [{ w: 'projeto.', start: 63.1, end: 63.6, p: 0.9 }];
  nova.forEach((w, i) => ws.push({ w, start: 64.7 + i * 1.1, end: 64.7 + i * 1.1 + 0.6, p: 0.8 }));
  ws.push({ w: 'Suas', start: 84.4, end: 84.8, p: 0.9 }, { w: 'longas', start: 84.9, end: 85.4, p: 0.9 },
    { w: 'mandíbulas', start: 85.5, end: 86.4, p: 0.9 }, { w: 'eram', start: 86.8, end: 87.1, p: 0.9 });
  const cand = [{ start: 63.1, end: 87.1, text: ws.map((w) => w.w).join(' '), words: ws }];
  const r = rec.incorporar(segs, lac, cand);
  assert.equal(r.decisao, 'aceita', r.motivo);
  assert.equal(r.inserido, nova.join(' '));
  assert.equal(r.retimed, 3);
  assert.equal(texto(r.segments), `novo projeto. ${nova.join(' ')} Suas longas mandíbulas eram cravejadas`);
  // ordem do texto = ordem do tempo
  for (let i = 1; i < r.segments.length; i++) assert.ok(r.segments[i].start >= r.segments[i - 1].start, 'fora de ordem');
  // o texto do trecho original não muda, só o tempo
  assert.equal(r.segments[2].text, segs[1].text);
  assert.ok(Math.abs(r.segments[2].start - 84.4) < 1e-9);
});

test('texto novo no meio de um trecho: divide o trecho sem perder nem trocar palavras', () => {
  const segs = [trecho('ele@0-0.3 disse@0.4-0.7 que@0.8-1 obrigado@5.2-5.6 a@5.7-5.8 todos@5.9-6.3')];
  const lac = { start: 1.25, end: 4.95 };
  const ws = [['que', 0.8, 1], ['estava', 1.5, 1.9], ['muito', 2, 2.4], ['feliz', 2.5, 3], ['obrigado', 5.2, 5.6]].map(([w, start, end]) => ({ w, start, end, p: 0.9 }));
  const r = rec.incorporar(segs, lac, [{ start: 0.8, end: 5.6, text: '', words: ws }]);
  assert.equal(r.decisao, 'aceita', r.motivo);
  assert.equal(texto(r.segments), 'ele disse que estava muito feliz obrigado a todos');
  assert.equal(r.segments.length, 3);
});

test('recuperação que não melhora: só repete o texto vizinho -> rejeitada, original intacto', () => {
  const segs = [fala('na alegria e na tristeza na saúde e na doença', 0), fala('o padre abençoa a união', 15)];
  const lac = { start: 4.5, end: 14.7 };
  const cand = [fala('na alegria e na tristeza na saúde', 6, { p: 0.95 })]; // tempo diferente: não casa como mesma fala
  const r = rec.incorporar(segs, lac, cand);
  assert.equal(r.decisao, 'rejeitada');
  assert.match(r.motivo, /repete o texto vizinho/);
  assert.equal(r.segments, segs);
});

test('recuperação que gera repetição anormal ou duvidosa -> rejeitada', () => {
  const segs = [fala('bom dia', 0), fala('boa noite', 20)];
  const lac = { start: 1.2, end: 19.7 };
  const laco = [fala(Array(9).fill('os negros e').join(' '), 2, { p: 0.9 })];
  const r1 = rec.incorporar(segs, lac, laco);
  assert.equal(r1.decisao, 'rejeitada');
  assert.match(r1.motivo, /repetição anormal/);
  const duvida = [fala('nem o que se sabe nem o que se sabe nem o que se sabe', 2, { p: 0.9 })];
  const r2 = rec.incorporar(segs, lac, duvida);
  assert.equal(r2.decisao, 'rejeitada');
  assert.match(r2.motivo, /repetição/);
  assert.equal(r2.segments, segs);
});

test('áudio sem fala, alucinação típica e baixa confiança -> rejeitadas', () => {
  const segs = [fala('bom dia', 0)];
  const lac = { start: 1, end: 9 };
  assert.match(rec.incorporar(segs, lac, []).motivo, /nada reconhecido/);
  assert.match(rec.incorporar(segs, lac, [fala('Legendas pela comunidade Amara.org', 3, { p: 0.9 })]).motivo, /alucinação/);
  assert.match(rec.incorporar(segs, lac, [fala('uma frase qualquer aqui', 3, { p: 0.2 })]).motivo, /confiança baixa/);
  const curta = { start: 2.5, end: 4 }; // (numa lacuna longa, uma palavra só é fragmento: ver os testes de cobertura)
  assert.match(rec.incorporar(segs, curta, [fala('sim', 3, { p: 0.5 })]).motivo, /confiança baixa/); // curta exige mais
  assert.equal(rec.incorporar(segs, curta, [fala('sim', 3, { p: 0.8 })]).decisao, 'aceita');
});

test('outra leitura de uma palavra esticada não entra como texto novo (evita duplicar)', () => {
  const segs = [trecho('escritores@40.5-41 como@41.1-41.3 Goethe@41.4-41.9 e@42-42.1 Skellegeal.@42.2-50.2'), fala('O scaffolding não é', 52)];
  const lac = rec.lacunas([{ start: 40.5, end: 53.5 }], segs)[0];
  const cand = [trecho('e@42-42.1 Skellige.@42.2-42.9 O@52-52.3', { p: 0.9 })];
  const r = rec.incorporar(segs, lac, cand);
  assert.equal(r.decisao, 'rejeitada');
  assert.match(r.motivo, /outra leitura/);
  assert.equal(r.segments, segs);
});

test('sem nenhuma transcrição original, o texto recuperado entra sozinho', () => {
  const r = rec.incorporar([], { start: 0, end: 5 }, [fala('olá a todos', 1, { p: 0.9 })]);
  assert.equal(r.decisao, 'aceita');
  assert.equal(texto(r.segments), 'olá a todos');
});

// ---------- critério de aceitação (casos reais dos testes com fala do FLEURS) ----------

// Palavras com tempos dados: [[palavra, início, fim], ...], todas com confiança p.
const palavrasEm = (lista, p = 0.95) => lista.map(([w, start, end]) => ({ w, start, end, p }));
const candidatoDe = (ws) => [{ start: ws[0].start, end: ws[ws.length - 1].end, text: ws.map((w) => w.w).join(' '), words: ws }];

test('alucinação com confiança alta: laço que começa na margem -> rejeitada, original intacto', () => {
  // base, ruído de vozes: "- O Homem de Deus. - O Homem de Deus." com p ~0,99
  const segs = [fala('acabou a corrida logo após a largada.', 34.4), fala('O romantismo tinha um grande', 41.3)];
  const lac = { start: 37.9, end: 41 };
  const ws = 'O Homem de Deus. O Homem de Deus.'.split(' ').map((w, i) => [w, 37 + i * 0.25, 37.2 + i * 0.25]);
  const r = rec.incorporar(segs, lac, candidatoDe(palavrasEm(ws, 0.99)));
  assert.equal(r.decisao, 'rejeitada');
  assert.match(r.motivo, /repetição .*margem/);
  assert.equal(r.segments, segs);
});

test('fragmento incompleto: poucas palavras numa lacuna longa -> rejeitado; a mesma fala numa lacuna curta entra', () => {
  // small, ruído: "Só as não" numa lacuna de 21,6 s
  const segs = [fala('ou começar um novo projeto.', 61.5), fala('com mais de 70 dentes', 88.1)];
  const cand = candidatoDe(palavrasEm([['Só', 85.5, 85.6], ['as', 85.6, 85.65], ['não', 85.9, 86]]));
  const longa = rec.incorporar(segs, { start: 64.1, end: 85.7 }, cand);
  assert.equal(longa.decisao, 'rejeitada');
  assert.match(longa.motivo, /cobre só \d+% da lacuna/);
  assert.equal(longa.segments, segs);
  const curta = rec.incorporar(segs, { start: 84.4, end: 87 }, cand);
  assert.equal(curta.decisao, 'aceita', curta.motivo);
});

test('recuperação que piora: releitura de palavras vizinhas com outro tempo e outra grafia -> rejeitada', () => {
  // base, ruído: "longas mandíbulas eram cravejadas com" inserido logo depois de "... crevejadas com"
  const segs = [
    trecho('Suas@63.9-65.7 longas@65.7-68.3 mandíbulas@68.3-72.6 eram@72.6-74.3 crevejadas@74.3-78.7 com@78.7-80 mais@80-81.7 de@81.7-82.6'),
    fala('junto com o conjunto extra', 91),
  ];
  const lac = { start: 82.8, end: 90.7 };
  const ws = [['Suas', 81.8, 82.4], ['longas', 82.4, 83.2], ['mandíbulas', 83.2, 84.5], ['eram', 84.5, 85.1],
    ['cravejadas', 85.1, 86.4], ['com', 86.4, 86.8], ['de', 87.4, 87.7]];
  const r = rec.incorporar(segs, lac, candidatoDe(palavrasEm(ws)));
  assert.equal(r.decisao, 'rejeitada');
  assert.match(r.motivo, /releitura de palavras vizinhas/);
  assert.equal(r.segments, segs);
});

test('outra leitura dentro do tempo de uma palavra esticada ("Esquela de Oeste" x "Skeletal") -> rejeitada', () => {
  const segs = [trecho('como@46.5-47.1 Goat,@47.1-48.1 Fist@48.1-48.8 e@48.8-48.9 Skeletal.@48.9-51.5'), fala('O scaffolding não é', 51.5)];
  const lac = { start: 49.2, end: 51.2 };
  const r = rec.incorporar(segs, lac, candidatoDe(palavrasEm([['Esquela', 48.2, 49], ['de', 49, 49.2], ['Oeste.', 49.3, 50.1]], 0.85)));
  assert.equal(r.decisao, 'rejeitada');
  assert.match(r.motivo, /outra leitura/);
});

test('sem palavra em comum com a transcrição, o texto novo entra na posição do tempo (não depois da última vizinha)', () => {
  const segs = [fala('com a família da vítima.', 14.5), fala('O romantismo tinha um grande elemento de determinismo cultural', 41.3)];
  const lac = { start: 17, end: 41 };
  const frase = 'Construída pelos egípcios no século XIII antes de Cristo a Grande Pirâmide é uma das muitas estruturas construídas para homenagear faraós mortos e o piloto perdeu o controle do carro logo após a largada'.split(' ');
  const ws = frase.map((w, i) => [w, 18 + i * 0.6, 18.45 + i * 0.6]);
  const r = rec.incorporar(segs, lac, candidatoDe(palavrasEm(ws, 0.9)));
  assert.equal(r.decisao, 'aceita', r.motivo);
  assert.equal(texto(r.segments), `com a família da vítima. ${frase.join(' ')} O romantismo tinha um grande elemento de determinismo cultural`);
});

test('palavra curta esticada ("O" de "O romantismo") não casa com um "o" qualquer no meio da lacuna', () => {
  const segs = [fala('com a família da vítima.', 14.5), trecho('O@30-41.6 romantismo@41.6-42.2 tinha@42.2-42.5 um@42.5-42.6')];
  const lac = rec.lacunas([{ start: 14.5, end: 42.6 }], segs)[0];
  const frase = 'a grande pirâmide foi construída para os faraós e o piloto perdeu o controle do carro e acabou a corrida logo após a largada'.split(' ');
  const ws = frase.map((w, i) => [w, 18 + i * 0.7, 18.5 + i * 0.7]);
  const r = rec.incorporar(segs, lac, candidatoDe(palavrasEm(ws, 0.9)));
  assert.equal(r.decisao, 'aceita', r.motivo);
  assert.equal(texto(r.segments), `com a família da vítima. ${frase.join(' ')} O romantismo tinha um`);
});

test('nova tentativa que pula a fala de novo (palavras esticadas) -> rejeitada e marcada para tentar em pedaços', () => {
  const segs = [fala('e Skellegeal.', 48.7), fala('O scaffolding', 52.3)];
  const lac = { start: 49.5, end: 52 };
  const r = rec.incorporar(segs, lac, candidatoDe(palavrasEm([['Fichte', 48, 48.5], ['e', 48.5, 49], ['Skellige.', 49.2, 53]], 0.6)));
  assert.equal(r.decisao, 'rejeitada');
  assert.equal(r.candidatoEsticado, true);
  assert.equal(r.segments, segs);
});

test('recuperação desligada por padrão em todos os modelos; disponível com ativa: true', () => {
  assert.deepEqual(rec.MODELOS_ATIVA, []);
  for (const m of ['turbo', 'base', 'small', 'large']) {
    const o = rec.opcoesDoModelo(m);
    assert.equal(o.ativa, false, m);
    assert.ok(o.desligadaPorque.includes(`desligada por padrão (modelo "${m}"`), o.desligadaPorque);
    assert.equal(rec.opcoesDoModelo(m, { ativa: true }).ativa, true);
  }
  assert.equal(rec.opcoesDoModelo('turbo', { ativa: false }).ativa, false);
  assert.equal(rec.opcoesDoModelo('turbo', { limiar: 3 }).limiar, 3);
});

test('concordância entre duas leituras do mesmo trecho', () => {
  const a = 'os chakras são ativados e a consciência'.split(' ');
  assert.equal(rec.concordancia(a, a), 1);
  assert.equal(rec.concordancia(a, 'Os chacras são ativados, E a consciência da iluminação'.split(' ')), 1);
  assert.equal(rec.concordancia('Ainda não é da vinte'.split(' '), 'Tá largado o que'.split(' ')), 0);
  assert.ok(Math.abs(rec.concordancia(['a', 'b', 'c', 'd'], ['a', 'x', 'c']) - 0.5) < 1e-9);
  assert.equal(rec.concordancia([], ['a']), 0);
});

// ---------- repetições ----------

test('repetições legítimas curtas ficam e não são registradas', () => {
  const segs = [fala('não não não eu não aceito', 0), fala('muito muito obrigado', 5)];
  const r = rec.filtrarRepeticoes(segs);
  assert.equal(r.segments, segs);
  assert.deepEqual(r.casos, []);
});

test('repetição duvidosa (grito de torcida, frase dita duas vezes) fica e é registrada', () => {
  const segs = [fala('é campeão é campeão é campeão', 0),
    fala('o romantismo tinha um grande elemento de determinismo o romantismo tinha um grande elemento de determinismo', 10)];
  const r = rec.filtrarRepeticoes(segs);
  assert.equal(texto(r.segments), texto(segs));
  assert.equal(r.casos.length, 2);
  assert.ok(r.casos.every((c) => c.nivel === 'duvida' && /mantido/.test(c.decisao)));
});

test('laço do whisper (mesmo trecho 9 vezes) é reduzido a uma ocorrência', () => {
  const segs = [fala('e ele disse', 0), fala(Array(9).fill('os negros e').join(' '), 2), fala('fim da frase', 20)];
  const r = rec.filtrarRepeticoes(segs);
  assert.equal(texto(r.segments), 'e ele disse os negros e fim da frase');
  assert.equal(r.casos.length, 1);
  assert.equal(r.casos[0].nivel, 'certa');
  assert.equal(r.casos[0].vezes, 9);
  assert.equal(r.segments[0], segs[0]); // trechos sem repetição ficam idênticos
});

test('laço espalhado em vários trechos idênticos também é detectado', () => {
  const segs = [fala('bom dia', 0), ...Array.from({ length: 6 }, (_, i) => fala('obrigado pela atenção', 2 + i * 2))];
  const r = rec.filtrarRepeticoes(segs);
  assert.equal(texto(r.segments), 'bom dia obrigado pela atenção');
});

// ---------- encaixe no tempo (casos reais da validação) ----------

const captions = require('../../src/main/captions');
const study = require('../../src/main/study');
const casosReais = require('./fixtures/recuperacao-casos-reais.json').casos;

// Saídas que o app gera a partir dos trechos (writeOutputs em transcribe.js e
// marcadores de busca em moments.js). O projeto não gera DOCX.
function saidas(segs) {
  const info = { fps: 25, duration: 200, hasAudio: true, hasVideo: false };
  return {
    txt: segs.map((s) => s.text).join('\n'),
    srt: captions.segmentsSrt(segs),
    youtube: captions.youtubeSrt(segs),
    reels: captions.reelsSrt(segs),
    xml: study.buildXmeml({ file: 'video.mp4', info, name: 'busca', clips: [{ start: 0, end: 200, name: 'video.mp4' }], markers: segs.map((s) => ({ t: s.start, name: s.text.slice(0, 60), comment: s.text })) }),
  };
}
const segundos = (t) => { const [h, m, s] = t.replace(',', '.').split(':').map(Number); return h * 3600 + m * 60 + s; };
function conferirOrdem(segs, rotulo) {
  const out = saidas(segs);
  for (const nome of ['srt', 'youtube', 'reels']) {
    const cues = [...out[nome].matchAll(/(\d\d:\d\d:\d\d,\d\d\d) --> (\d\d:\d\d:\d\d,\d\d\d)/g)].map((m) => [segundos(m[1]), segundos(m[2])]);
    assert.ok(cues.length > 0, `${rotulo}: ${nome} vazio`);
    cues.forEach(([a, b], i) => {
      assert.ok(b >= a, `${rotulo}: ${nome} legenda ${i + 1} termina antes de começar`);
      if (i) assert.ok(a >= cues[i - 1][0], `${rotulo}: ${nome} legenda ${i + 1} (${a}) começa antes da anterior (${cues[i - 1][0]})`);
    });
  }
  const marcas = [...out.xml.matchAll(/<marker>.*?<in>(\d+)<\/in>/g)].map((m) => Number(m[1]));
  assert.equal(marcas.length, segs.length, `${rotulo}: marcadores no XML`);
  marcas.forEach((f, i) => { if (i) assert.ok(f >= marcas[i - 1], `${rotulo}: marcador ${i + 1} do XML fora de ordem`); });
  return out;
}
// palavras iguais lado a lado no TXT ("pelos pelos")
const duplicadasLadoALado = (txt) => {
  const ks = txt.split(/\s+/).map(rec.chave).filter(Boolean);
  return ks.filter((k, i) => i && k === ks[i - 1]).length;
};

for (const [nome, c] of Object.entries(casosReais)) {
  test(`caso real "${nome}": a versão anterior aceitava; agora é rejeitado, com motivo, e as saídas ficam iguais às originais`, () => {
    assert.equal(c.decisaoAntiga, 'aceita');
    const copia = JSON.parse(JSON.stringify(c.segments));
    const r = rec.incorporar(c.segments, c.lacuna, c.candidato, { ativa: true });
    assert.equal(r.decisao, 'rejeitada');
    assert.ok(r.motivo && r.motivo.length > 10, 'motivo registrado');
    assert.equal(r.segments, c.segments, 'devolve os trechos originais');
    assert.deepEqual(c.segments, copia, 'não altera a entrada (nem os tempos das palavras)');
    assert.deepEqual(saidas(r.segments), saidas(copia));
  });
}

test('"governado pelos pelos franceses": palavra nova igual à vizinha onde entraria -> rejeitada', () => {
  const c = casosReais.pelosPelos;
  const r = rec.incorporar(c.segments, c.lacuna, c.candidato);
  assert.match(r.motivo, /repetiria a palavra vizinha \("pelos"\)/);
  assert.match(texto(r.segments), /governado pelos franceses/);
  assert.doesNotMatch(texto(r.segments), /pelos pelos/);
});

test('"mudanças [frase recuperada] significativas": texto novo encostado em palavra esticada sem par, sem caber antes ou depois -> rejeitada', () => {
  const c = casosReais.mudancasSignificativas;
  const r = rec.incorporar(c.segments, c.lacuna, c.candidato);
  assert.match(r.motivo, /palavra esticada "mudanças"/);
  assert.match(texto(r.segments), /mudanças significativas/);
});

test('"Suas longas mandíbulas": recuperação que deixaria trechos fora da ordem do tempo -> rejeitada', () => {
  const c = casosReais.suasLongasMandibulas;
  const r = rec.incorporar(c.segments, c.lacuna, c.candidato);
  assert.match(r.motivo, /fora da ordem do tempo/);
});

test('palavra nova igual a uma palavra esticada sem par no mesmo tempo -> rejeitada (pode ser a mesma palavra)', () => {
  const segs = [fala('ele saiu cedo', 0), trecho('a@2-11.6 escola@11.6-12.1 fechou@12.1-12.5')];
  const lac = { start: 1.3, end: 11 };
  const frase = 'e depois foi para a casa da avó comer bolo de milho com café quente'.split(' ');
  const ws = frase.map((w, i) => [w, 2 + i * 0.6, 2.5 + i * 0.6]);
  const r = rec.incorporar(segs, lac, candidatoDe(palavrasEm(ws, 0.95)));
  assert.equal(r.decisao, 'rejeitada');
  assert.match(r.motivo, /palavra nova "a" .* já está na transcrição ali perto \("a" 2\.0-11\.6 s\)/);
  assert.equal(r.segments, segs);
});

test('texto novo picado entre palavras da transcrição que a nova tentativa não reconheceu -> rejeitada', () => {
  const segs = [fala('começo da frase', 0), trecho('talvez@5-5.3'), fala('fim da história', 10)];
  const lac = { start: 1.2, end: 9.9 };
  const ws = [['primeira', 2, 2.5], ['parte', 2.6, 3], ['nova', 3.1, 3.5], ['segunda', 6, 6.5], ['parte', 6.6, 7], ['nova', 7.1, 7.5]];
  const r = rec.incorporar(segs, lac, candidatoDe(palavrasEm(ws, 0.95)));
  assert.equal(r.decisao, 'rejeitada');
  assert.match(r.motivo, /intercalado com palavras da transcrição .*"talvez"/);
});

test('recuperação aceita: TXT, SRT (normal, YouTube, Reels) e XML em ordem e sem palavra duplicada', () => {
  const casos = [];
  {
    const segs = [fala('o carro saiu da pista', 0), fala('e a corrida acabou', 10)];
    const ws = 'o carro saiu da pista o piloto perdeu o controle e bateu no muro e a corrida'.split(' ').map((w, i) => [w, i * 0.6, i * 0.6 + 0.5]);
    ws.forEach((w, i) => { if (i >= 5 && i < 14) { w[1] = 2.5 + (i - 5) * 0.75; w[2] = w[1] + 0.6; } if (i >= 14) { w[1] = 10 + (i - 14) * 0.4; w[2] = w[1] + 0.35; } });
    casos.push(['margens', segs, { start: 2.3, end: 9.7 }, ws]);
  }
  {
    const segs = [fala('com a família da vítima.', 14.5), trecho('O@30-41.6 romantismo@41.6-42.2 tinha@42.2-42.5 um@42.5-42.6')];
    const frase = 'a grande pirâmide foi construída para os faraós e o piloto perdeu o controle do carro e acabou a corrida logo após a largada'.split(' ');
    casos.push(['palavra esticada depois', segs, rec.lacunas([{ start: 14.5, end: 42.6 }], segs)[0], frase.map((w, i) => [w, 18 + i * 0.7, 18.5 + i * 0.7])]);
  }
  for (const [rotulo, segs, lac, ws] of casos) {
    const r = rec.incorporar(segs, lac, candidatoDe(palavrasEm(ws, 0.95)));
    assert.equal(r.decisao, 'aceita', `${rotulo}: ${r.motivo}`);
    const antes = saidas(segs);
    const depois = conferirOrdem(r.segments, rotulo);
    assert.equal(duplicadasLadoALado(depois.txt), duplicadasLadoALado(antes.txt), `${rotulo}: palavra duplicada no TXT`);
    // palavra esticada vale pelo fim (o começo é o que o whisper esticou)
    const inicio = (w) => (w.end - w.start <= 1.5 ? w.start : w.end - 1.5);
    const ws2 = r.segments.flatMap((s) => s.words || []);
    ws2.forEach((w, i) => { if (i) assert.ok(inicio(w) >= inicio(ws2[i - 1]) - 0.05, `${rotulo}: palavra "${w.w}" fora de ordem`); });
  }
});

test('o app não passa opções: a recuperação fica desligada (nenhuma inserção possível)', () => {
  const o = rec.opcoesDoModelo('turbo', undefined);
  assert.equal(o.ativa, false);
  assert.equal(rec.opcoes(o).ativa, false);
});
