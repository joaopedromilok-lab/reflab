'use strict';
// Testes da transcrição em blocos (sem whisper): npm test
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const blocos = require('../../src/main/blocos');
const { parseWhisper } = require('../../src/main/transcribe');

const perto = (a, b, tol = 1e-6) => Math.abs(a - b) <= tol;

test('lê a saída do whisper-vad-speech-segments (centésimos de segundo)', () => {
  const saida = '\nDetected 2 speech segments:\nSpeech segment 0: start = 861.00, end = 1296.00\nSpeech segment 1: start = 3645.00, end = 4000.00\n';
  assert.deepEqual(blocos.lerSegmentosVad(saida), [{ start: 8.61, end: 12.96 }, { start: 36.45, end: 40 }]);
  assert.deepEqual(blocos.lerSegmentosVad(''), []);
});

test('pausa muito longa (música/silêncio >= 10 s) separa blocos e não é transcrita', () => {
  const plano = blocos.planejarBlocos([{ start: 8.6, end: 27 }, { start: 37.4, end: 55 }], 56);
  assert.equal(plano.length, 2);
  assert.ok(perto(plano[0].start, 8.1)); // margem de 0,5 s antes
  assert.ok(perto(plano[0].end, 27.5));
  assert.ok(perto(plano[1].start, 36.9));
  assert.ok(perto(plano[1].end, 55.5));
});

test('pausa média só separa quando o bloco já tem 1 minuto', () => {
  // bloco curto (18 s) + pausa de 8 s: continua no mesmo bloco (evita janela de 30 s quase vazia)
  assert.equal(blocos.planejarBlocos([{ start: 8, end: 26 }, { start: 34, end: 52 }], 60).length, 1);
  // bloco de 70 s + pausa de 5 s: separa
  const plano = blocos.planejarBlocos([{ start: 0, end: 70 }, { start: 75, end: 100 }], 100);
  assert.equal(plano.length, 2);
  assert.ok(plano[0].end <= plano[1].start);
});

test('pausas curtas ficam no mesmo bloco', () => {
  const plano = blocos.planejarBlocos([{ start: 1, end: 5 }, { start: 6.5, end: 9 }, { start: 10, end: 12 }], 20);
  assert.equal(plano.length, 1);
  assert.equal(plano[0].falas, 3);
});

test('margens nunca invadem o bloco vizinho', () => {
  // pausa de 3,2 s que separa (pausa muito longa = 3) com margens de 2 s: cada lado fica com a metade
  const plano = blocos.planejarBlocos([{ start: 0, end: 10 }, { start: 13.2, end: 20 }], 20, { margemAntes: 2, margemDepois: 2, pausaMuitoLonga: 3 });
  assert.equal(plano.length, 2);
  assert.ok(plano[0].end <= plano[1].start);
  assert.ok(perto(plano[0].end, 11.6));
  assert.ok(perto(plano[1].start, 11.6));
});

test('trecho longo é dividido na maior pausa, com blocos de até 10 min', () => {
  // 25 min de fala com pausas de 1 s a cada 31 s e uma pausa maior (2 s) por volta dos 7 min
  const falas = [];
  for (let t = 0; t < 1500; t += 31) falas.push({ start: t, end: t + 30 });
  const k = falas.findIndex((f) => f.start === 403);
  falas[k].end = 432; // pausa de 2 s até 434
  falas[k + 1].start = 434;
  const plano = blocos.planejarBlocos(falas, 1520);
  assert.ok(plano.length >= 3, `${plano.length} blocos`);
  for (const b of plano) assert.ok(b.end - b.start <= 601, `bloco de ${b.end - b.start}s`);
  for (let i = 1; i < plano.length; i++) assert.ok(plano[i - 1].end <= plano[i].start);
  assert.ok(plano[0].start <= 0.001);
  assert.ok(plano[plano.length - 1].end >= falas[falas.length - 1].end);
  // o primeiro corte cai na pausa maior (entre 432 e 434)
  assert.ok(plano[0].end > 432 && plano[0].end < 434, `corte em ${plano[0].end}`);
});

test('sem fala, nenhum bloco', () => {
  assert.deepEqual(blocos.planejarBlocos([], 60), []);
});

test('recorta o WAV no ponto exato, sem recodificar', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reflab-wav-'));
  try {
    const taxa = 16000;
    const n = taxa * 3; // 3 s
    const dados = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i++) dados.writeInt16LE(i % 32000, i * 2); // amostra = posição
    const cab = Buffer.alloc(44);
    cab.write('RIFF', 0); cab.writeUInt32LE(36 + dados.length, 4); cab.write('WAVE', 8); cab.write('fmt ', 12);
    cab.writeUInt32LE(16, 16); cab.writeUInt16LE(1, 20); cab.writeUInt16LE(1, 22); cab.writeUInt32LE(taxa, 24);
    cab.writeUInt32LE(taxa * 2, 28); cab.writeUInt16LE(2, 32); cab.writeUInt16LE(16, 34); cab.write('data', 36); cab.writeUInt32LE(dados.length, 40);
    const origem = path.join(dir, 'a.wav');
    fs.writeFileSync(origem, Buffer.concat([cab, dados]));
    const info = blocos.lerWav(origem);
    assert.equal(info.taxa, taxa);
    assert.ok(perto(blocos.duracaoWav(info), 3));
    const destino = path.join(dir, 'b.wav');
    const dur = blocos.recortarWav(origem, destino, 1.25, 2.0, info);
    assert.ok(perto(dur, 0.75));
    const b = blocos.lerWav(destino);
    assert.ok(perto(blocos.duracaoWav(b), 0.75));
    const buf = fs.readFileSync(destino);
    assert.equal(buf.readInt16LE(b.inicioDados), (1.25 * taxa) % 32000); // 1ª amostra é a da posição 1,25 s
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('tempos de trechos e palavras recebem o início do bloco', () => {
  const raw = {
    transcription: [{
      text: ' Ana Beatriz',
      offsets: { from: 300, to: 1500 },
      tokens: [
        { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
        { text: ' Ana', offsets: { from: 300, to: 700 } },
        { text: ' Bea', offsets: { from: 700, to: 1000 } },
        { text: 'triz', offsets: { from: 1000, to: 1500 } },
      ],
    }],
  };
  const [seg] = parseWhisper(raw, 35.9, 20);
  assert.ok(perto(seg.start, 36.2));
  assert.ok(perto(seg.end, 37.4));
  assert.deepEqual(seg.words.map((w) => w.w), ['Ana', 'Beatriz']);
  assert.ok(perto(seg.words[0].start, 36.2));
  assert.ok(perto(seg.words[1].start, 36.6));
  assert.ok(perto(seg.words[1].end, 37.4));
  // sem deslocamento, o resultado é o mesmo de antes
  assert.ok(perto(parseWhisper(raw)[0].words[0].start, 0.3));
});
