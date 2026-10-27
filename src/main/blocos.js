// Transcrição em blocos guiada pela detecção de voz.
//
// Por que existe: com "--vad", o whisper-cli junta só os trechos com fala e
// devolve o tempo de cada palavra no áudio "comprimido" (sem os silêncios),
// o que adianta as palavras pelo tempo de silêncio/música removido.
// Aqui a detecção de voz roda à parte (whisper-vad-speech-segments), o áudio é
// dividido em blocos contínuos do arquivo original e cada bloco é transcrito
// sem VAD; depois soma-se o início do bloco a todos os tempos.

'use strict';

const fs = require('fs');

// O whisper processa sempre janelas de 30 s: um bloco curto custa quase o
// mesmo que um de 30 s. Por isso só se separa em pausas médias quando o bloco
// já tem pelo menos "minimo" segundos.
const PADRAO = {
  margemAntes: 0.5, // a detecção costuma marcar o início da fala um pouco tarde
  margemDepois: 0.5,
  pausaMuitoLonga: 10, // sempre separa e não transcreve (música/silêncio longo)
  pausaLonga: 3, // separa só se o bloco já tiver "minimo" segundos
  minimo: 60,
  maximo: 600, // blocos de até 10 min
};

// Lê a saída do whisper-vad-speech-segments (tempos em centésimos de segundo).
function lerSegmentosVad(texto) {
  const out = [];
  const re = /Speech segment \d+: start = ([\d.]+), end = ([\d.]+)/g;
  let m;
  while ((m = re.exec(String(texto || '')))) {
    const start = Number(m[1]) / 100;
    const end = Number(m[2]) / 100;
    if (end > start) out.push({ start, end });
  }
  return out.sort((a, b) => a.start - b.start);
}

// Agrupa os intervalos de fala em blocos contínuos do áudio original.
// - Pausas >= pausaMuitoLonga sempre separam blocos (não são transcritas).
// - Pausas >= pausaLonga separam quando o bloco já tem "minimo" segundos.
// - Blocos maiores que "maximo" são divididos na maior pausa disponível,
//   respeitando "minimo" sempre que possível.
// - As margens nunca passam da metade da pausa vizinha (blocos não se sobrepõem).
function planejarBlocos(intervalos, duracao, opcoes = {}) {
  const o = { ...PADRAO, ...opcoes };
  const fala = intervalos
    .map((i) => ({ start: Math.max(0, i.start), end: Math.min(duracao, i.end) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  if (!fala.length) return [];

  // 1) Grupos separados por pausas longas.
  const grupos = [[fala[0]]];
  for (let k = 1; k < fala.length; k++) {
    const atual = grupos[grupos.length - 1];
    const pausa = fala[k].start - atual[atual.length - 1].end;
    const tamanho = atual[atual.length - 1].end - atual[0].start;
    if (pausa >= o.pausaMuitoLonga || (pausa >= o.pausaLonga && tamanho >= o.minimo)) grupos.push([fala[k]]);
    else atual.push(fala[k]);
  }

  // 2) Divide grupos longos na maior pausa interna.
  const dividir = (lista) => {
    const ini = lista[0].start;
    const fim = lista[lista.length - 1].end;
    if (fim - ini <= o.maximo || lista.length < 2) return [lista];
    let melhor = -1;
    let melhorPausa = -1;
    let melhorSemMinimo = -1;
    let melhorPausaSemMinimo = -1;
    for (let k = 0; k < lista.length - 1; k++) {
      const corte = lista[k].end;
      const pausa = lista[k + 1].start - corte;
      const okMin = corte - ini >= Math.min(o.minimo, (fim - ini) / 2) && fim - lista[k + 1].start >= Math.min(o.minimo, (fim - ini) / 2);
      const okMax = corte - ini <= o.maximo;
      if (okMax && okMin && pausa > melhorPausa) { melhorPausa = pausa; melhor = k; }
      if (pausa > melhorPausaSemMinimo) { melhorPausaSemMinimo = pausa; melhorSemMinimo = k; }
    }
    const k = melhor >= 0 ? melhor : melhorSemMinimo;
    return [...dividir(lista.slice(0, k + 1)), ...dividir(lista.slice(k + 1))];
  };
  const listas = grupos.flatMap(dividir);

  // 3) Margens limitadas à metade da pausa até o bloco vizinho.
  return listas.map((lista, i) => {
    const anterior = i > 0 ? listas[i - 1][listas[i - 1].length - 1].end : 0;
    const proximo = i + 1 < listas.length ? listas[i + 1][0].start : duracao;
    const primeiro = lista[0].start;
    const ultimo = lista[lista.length - 1].end;
    const start = Math.max(0, primeiro - o.margemAntes, i > 0 ? (anterior + primeiro) / 2 : 0);
    const end = Math.min(duracao, ultimo + o.margemDepois, i + 1 < listas.length ? (ultimo + proximo) / 2 : duracao);
    return { start: +start.toFixed(3), end: +end.toFixed(3), falas: lista.length };
  });
}

// ---------- WAV (PCM 16 bits mono) ----------

// Lê o cabeçalho e devolve onde estão as amostras.
function lerWav(arquivo) {
  const fd = fs.openSync(arquivo, 'r');
  try {
    const cab = Buffer.alloc(4096);
    const lidos = fs.readSync(fd, cab, 0, cab.length, 0);
    if (cab.toString('ascii', 0, 4) !== 'RIFF' || cab.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Não é um arquivo WAV.');
    let p = 12;
    let fmt = null;
    while (p + 8 <= lidos) {
      const id = cab.toString('ascii', p, p + 4);
      const tam = cab.readUInt32LE(p + 4);
      if (id === 'fmt ') {
        fmt = { canais: cab.readUInt16LE(p + 10), taxa: cab.readUInt32LE(p + 12), bits: cab.readUInt16LE(p + 22) };
      } else if (id === 'data') {
        if (!fmt) throw new Error('WAV sem bloco de formato.');
        const total = fs.fstatSync(fd).size - (p + 8);
        return { ...fmt, inicioDados: p + 8, bytesDados: Math.min(tam || total, total) };
      }
      p += 8 + tam + (tam % 2);
    }
    throw new Error('WAV sem bloco de dados.');
  } finally {
    fs.closeSync(fd);
  }
}

function cabecalhoWav(bytes, taxa, canais, bits) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii');
  h.writeUInt32LE(36 + bytes, 4);
  h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii');
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(canais, 22);
  h.writeUInt32LE(taxa, 24);
  h.writeUInt32LE(taxa * canais * (bits / 8), 28);
  h.writeUInt16LE(canais * (bits / 8), 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36, 'ascii');
  h.writeUInt32LE(bytes, 40);
  return h;
}

// Copia o trecho [start, end) (segundos) do WAV para outro arquivo, sem recodificar.
function recortarWav(origem, destino, start, end, info = lerWav(origem)) {
  const porAmostra = info.canais * (info.bits / 8);
  const a = Math.max(0, Math.round(start * info.taxa)) * porAmostra;
  const b = Math.min(info.bytesDados, Math.round(end * info.taxa) * porAmostra);
  const bytes = Math.max(0, b - a);
  const fdIn = fs.openSync(origem, 'r');
  const fdOut = fs.openSync(destino, 'w');
  try {
    fs.writeSync(fdOut, cabecalhoWav(bytes, info.taxa, info.canais, info.bits));
    const buf = Buffer.alloc(1 << 20);
    let feito = 0;
    while (feito < bytes) {
      const n = fs.readSync(fdIn, buf, 0, Math.min(buf.length, bytes - feito), info.inicioDados + a + feito);
      if (n <= 0) break;
      fs.writeSync(fdOut, buf, 0, n);
      feito += n;
    }
  } finally {
    fs.closeSync(fdIn);
    fs.closeSync(fdOut);
  }
  return bytes / porAmostra / info.taxa;
}

function duracaoWav(info) {
  return info.bytesDados / (info.canais * (info.bits / 8)) / info.taxa;
}

module.exports = { PADRAO, lerSegmentosVad, planejarBlocos, lerWav, recortarWav, duracaoWav };
