// Cenários sintéticos: montam áudios com a fala de referência (fixtures/fala-ptbr)
// em posições conhecidas, junto com silêncio e música sintética. Como a posição
// de cada pedaço é conhecida, o tempo real de cada palavra também é.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const FALA = require('./fixtures/fala-ptbr.json');
const FALA_WAV = path.join(__dirname, 'fixtures', 'fala-ptbr.wav');
const TAXA = 16000;

// Música sintética: acordes sustentados + batida grave a 120 BPM.
// Não é música de verdade, mas tem harmonia e ritmo constantes, o suficiente
// para checar se o modelo "inventa" texto em trechos sem fala.
const MUSICA = "0.12*sin(2*PI*220*t)+0.09*sin(2*PI*277.18*t)+0.09*sin(2*PI*329.63*t)+0.25*sin(2*PI*55*t)*lt(mod(t,0.5),0.08)";

// Cada cenário é uma lista de pedaços em sequência.
//  { tipo: 'silencio', dur }  silêncio
//  { tipo: 'musica', dur }    só música
//  { tipo: 'fala' }           a fala de referência
//  { tipo: 'fala+musica' }    a fala com música por baixo (volume da música relativo)
const CENARIOS = {
  'fala-limpa': {
    descricao: 'Só a fala de referência, sem nada antes ou depois.',
    pedacos: [{ tipo: 'fala' }],
  },
  'pausas-longas': {
    descricao: 'Mesmo teste do diagnóstico: 8 s de silêncio, fala, 8 s de silêncio, fala.',
    pedacos: [{ tipo: 'silencio', dur: 8 }, { tipo: 'fala' }, { tipo: 'silencio', dur: 8 }, { tipo: 'fala' }],
  },
  'musica-no-inicio': {
    descricao: '10 s só de música (como a entrada de um casamento) e depois a fala.',
    pedacos: [{ tipo: 'musica', dur: 10 }, { tipo: 'fala' }],
  },
  'fala-sobre-musica': {
    descricao: 'Fala com música por baixo do começo ao fim, mais 4 s só de música no final.',
    pedacos: [{ tipo: 'fala+musica', volume: 0.35 }, { tipo: 'musica', dur: 4 }],
  },
};

function duracaoFala() {
  // 16 bits mono: (bytes - cabeçalho 44) / 2 / taxa
  return (fs.statSync(FALA_WAV).size - 44) / 2 / TAXA;
}

// Monta o WAV do cenário e devolve o gabarito (texto, palavras com tempo e
// momentos em que a fala começa depois de uma pausa).
function montar(nome, pastaSaida, ffmpeg) {
  const cen = CENARIOS[nome];
  if (!cen) throw new Error(`Cenário desconhecido: ${nome}`);
  const dFala = duracaoFala();
  const entradas = [];
  const filtros = [];
  const rotulos = [];
  const palavras = [];
  const iniciosFala = [];
  let t = 0;

  cen.pedacos.forEach((p, i) => {
    if (p.tipo === 'silencio') {
      entradas.push('-f', 'lavfi', '-t', String(p.dur), '-i', `anullsrc=r=${TAXA}:cl=mono`);
      filtros.push(`[${entradas.filter((x) => x === '-i').length - 1}:a]aformat=sample_rates=${TAXA}:channel_layouts=mono[p${i}]`);
      t += p.dur;
    } else if (p.tipo === 'musica') {
      entradas.push('-f', 'lavfi', '-t', String(p.dur), '-i', `aevalsrc='${MUSICA}':s=${TAXA}`);
      filtros.push(`[${entradas.filter((x) => x === '-i').length - 1}:a]aformat=sample_rates=${TAXA}:channel_layouts=mono[p${i}]`);
      t += p.dur;
    } else if (p.tipo === 'fala' || p.tipo === 'fala+musica') {
      entradas.push('-i', FALA_WAV);
      const iFala = entradas.filter((x) => x === '-i').length - 1;
      if (p.tipo === 'fala') {
        filtros.push(`[${iFala}:a]aformat=sample_rates=${TAXA}:channel_layouts=mono[p${i}]`);
      } else {
        entradas.push('-f', 'lavfi', '-t', dFala.toFixed(3), '-i', `aevalsrc='${MUSICA}':s=${TAXA}`);
        const iMus = iFala + 1;
        filtros.push(`[${iMus}:a]volume=${p.volume}[m${i}]`);
        filtros.push(`[${iFala}:a][m${i}]amix=inputs=2:duration=first:normalize=0,aformat=sample_rates=${TAXA}:channel_layouts=mono[p${i}]`);
      }
      for (const w of FALA.palavras) palavras.push({ w: w.w, start: +(t + w.start).toFixed(3) });
      iniciosFala.push(+(t + FALA.palavras[0].start).toFixed(3));
      t += dFala;
    }
    rotulos.push(`[p${i}]`);
  });

  const saida = path.join(pastaSaida, `${nome}.wav`);
  const grafo = `${filtros.join(';')};${rotulos.join('')}concat=n=${rotulos.length}:v=0:a=1[out]`;
  execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...entradas,
    '-filter_complex', grafo, '-map', '[out]', '-c:a', 'pcm_s16le', saida], { windowsHide: true });

  const blocos = cen.pedacos.filter((p) => p.tipo.startsWith('fala')).length;
  return {
    nome,
    descricao: cen.descricao,
    arquivo: saida,
    duracao: +t.toFixed(3),
    texto: Array(blocos).fill(FALA.texto).join(' '),
    palavras,
    iniciosFala,
  };
}

module.exports = { CENARIOS, montar, FALA };
