'use strict';
// Testes das métricas (rodam sem whisper): node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizar, wer, errosDeTempo, errosDeInicio, percentil, trechosPerdidos, frasesPerdidas, repeticoes } = require('./metricas');

test('normaliza pontuação, caixa e espaços', () => {
  assert.equal(normalizar('  Olá, MUNDO!  Tudo bem?'), 'olá mundo tudo bem');
  assert.equal(normalizar('Saúde e doença', { semAcento: true }), 'saude e doenca');
  assert.equal(normalizar("d'água — e 'aspas'"), "d'água e aspas");
});

test('WER zero para textos iguais (ignorando pontuação)', () => {
  const r = wer('Na alegria e na tristeza.', 'na alegria, e na tristeza');
  assert.equal(r.wer, 0);
  assert.equal(r.acertos, 5);
});

test('WER conta troca, remoção e inserção', () => {
  // ref: a b c d (4) | hip: a x c d e -> 1 troca + 1 inserção = 2/4
  const r = wer('a b c d', 'a x c d e');
  assert.equal(r.trocas, 1);
  assert.equal(r.insercoes, 1);
  assert.equal(r.remocoes, 0);
  assert.equal(r.wer, 0.5);
  const r2 = wer('a b c d', 'a d');
  assert.equal(r2.remocoes, 2);
  assert.equal(r2.wer, 0.5);
});

test('WER sem acento separa erro de grafia', () => {
  assert.equal(wer('Antônio', 'Antonio').wer, 1);
  assert.equal(wer('Antônio', 'Antonio', { semAcento: true }).wer, 0);
});

test('erro de tempo usa só palavras iguais e mede previsto - real', () => {
  const ref = [{ w: 'Ana', start: 1.0 }, { w: 'Beatriz', start: 1.3 }, { w: 'Rafael', start: 2.0 }];
  const hip = [{ w: 'Ana', start: 1.1 }, { w: 'Beatris', start: 1.4 }, { w: 'Rafael,', start: 1.5 }];
  const r = errosDeTempo(ref, hip, { limite: 0.3 });
  assert.equal(r.palavrasComparadas, 2); // "Beatris" não conta
  assert.ok(Math.abs(r.erroMedioAbs - 0.3) < 1e-9); // (0.1 + 0.5) / 2
  assert.ok(Math.abs(r.viesMedio - (-0.2)) < 1e-9); // (+0.1 - 0.5) / 2
  assert.equal(r.dentroDoLimite, 0.5);
  assert.ok(Math.abs(r.maximo - 0.5) < 1e-9);
});

test('erro de tempo detecta deslocamento constante (bug de VAD)', () => {
  const ref = [{ w: 'um', start: 8.4 }, { w: 'dois', start: 9.0 }, { w: 'três', start: 9.5 }];
  const hip = ref.map((p) => ({ w: p.w, start: p.start - 8 }));
  const r = errosDeTempo(ref, hip);
  assert.ok(Math.abs(r.viesMedio + 8) < 1e-9);
  assert.equal(r.dentroDoLimite, 0);
});

test('erro de início pega o trecho previsto mais próximo', () => {
  const r = errosDeInicio([8.07, 35.1], [8.41, 12.69, 25.46, 36.3]);
  assert.ok(Math.abs(r[0].erro - 0.34) < 1e-9);
  assert.ok(Math.abs(r[1].erro - 1.2) < 1e-9);
});

test('percentil', () => {
  assert.equal(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentil([], 50), null);
});

test('trechos perdidos: só sequências de 3+ palavras removidas', () => {
  const r = wer('a b c d e f g h', 'a b h');
  assert.deepEqual(trechosPerdidos(r), ['c d e f g']);
  assert.deepEqual(trechosPerdidos(wer('a b c d', 'a c d')), []); // 1 palavra só não é trecho
});

test('frases perdidas: frase com metade ou mais das palavras removidas', () => {
  const frases = ['O carro saiu da pista.', 'A parte central da meditação é o yoga.', 'Fim da corrida.'];
  const hip = 'o carro saiu da pista fim da corrida';
  const perdidas = frasesPerdidas(frases, hip);
  assert.equal(perdidas.length, 1);
  assert.match(perdidas[0].frase, /meditação/);
  // frase com erros de reconhecimento (trocas) não conta como perdida
  assert.equal(frasesPerdidas(frases, 'o carro saiu da pista a arte central da medicação é o ioga fim da corrida').length, 0);
});

test('repetições: 4 palavras repetidas além do que a referência tem', () => {
  const r = wer('os negros e brancos', 'os negros e os negros e os negros e brancos');
  assert.ok(repeticoes(r).some((x) => x.texto === 'os negros e os'));
  // repetição que existe na referência não conta
  assert.deepEqual(repeticoes(wer('é campeão é campeão é campeão', 'é campeão é campeão é campeão')), []);
});
