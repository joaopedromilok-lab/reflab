// Fala espontânea real para a base de testes: trechos do CORAA v1.1 (português do Brasil).
//
// CORAA: Candido Junior et al., "CORAA: a large corpus of spontaneous and prepared
// speech manually validated for speech recognition in Brazilian Portuguese" (2021).
// Licença CC BY-NC-ND 4.0 - https://huggingface.co/datasets/gabrielrstan/CORAA-v1.1
// Os áudios NÃO vão para o Git: só os segmentos escolhidos são lidos de dentro do
// test.zip (2,4 GB) por requisições de intervalo HTTP e ficam em coraa/. Ver CORAA.md.
//
// Cada passagem junta segmentos seguidos de uma mesma gravação espontânea
// (diálogo, entrevista ou conversa). Os segmentos do conjunto de teste têm
// buracos na numeração (partes que ficaram em treino/validação), então a
// passagem pode pular um pedaço da conversa entre dois segmentos.

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const blocos = require('../../src/main/blocos');
const fleurs = require('./fleurs');

const BASE = 'https://huggingface.co/datasets/gabrielrstan/CORAA-v1.1/resolve/main/';
const PASTA = path.join(__dirname, 'coraa');
const PALAVRAS_POR_PASSAGEM = 200;

// Um acervo por passagem, todos marcados como fala espontânea no CORAA.
const ACERVOS = {
  'nurc-dialogo': { dataset: 'NURC-Recife', estilo: 'Spontaneous Speech', descricao: 'NURC-Recife: diálogo entre dois informantes (gravação antiga, anos 1970)' },
  'alip-entrevista': { dataset: 'ALIP', estilo: 'Spontaneous Speech', descricao: 'ALIP (interior de SP): entrevista' },
  'coral-conversa': { dataset: 'C-ORAL-BRASIL I', estilo: 'Spontaneous Speech', descricao: 'C-ORAL-BRASIL (Minas Gerais): conversa ou monólogo informal' },
  'sp2010-entrevista': { dataset: 'SP2010', estilo: null, descricao: 'SP2010 (capital): entrevista sociolinguística' },
};

const CONDICOES = {
  original: 'Áudio como foi gravado (segmentos seguidos, 0,3 s entre eles).',
  'ruido-festa': 'O mesmo com vozes ao fundo (as do FLEURS ao contrário, SNR 6 dB).',
};

// ---------- download (intervalos de um zip remoto) ----------

function pedir(url, inicio, fim) {
  return new Promise((resolve, reject) => {
    const headers = { 'User-Agent': 'RefLab-testes' };
    if (inicio !== undefined) headers.Range = `bytes=${inicio}-${fim}`;
    const req = https.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        pedir(new URL(res.headers.location, url).toString(), inicio, fim).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) { res.resume(); reject(new Error(`HTTP ${res.statusCode} em ${url}`)); return; }
      const partes = [];
      res.on('data', (d) => partes.push(d));
      res.on('end', () => resolve({ dados: Buffer.concat(partes), total: Number((res.headers['content-range'] || '').split('/')[1]) || null }));
      res.on('error', reject);
    });
    req.on('error', reject);
  });
}

// Lê o diretório central do zip e devolve { nome -> { offset, comprimido, metodo } }.
async function indiceDoZip(url) {
  const { total } = await pedir(url, 0, 0);
  const cauda = (await pedir(url, total - 65557, total - 1)).dados;
  const e = cauda.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (e < 0) throw new Error('fim do zip não encontrado');
  let tamanho = cauda.readUInt32LE(e + 12);
  let inicio = cauda.readUInt32LE(e + 16);
  if (inicio === 0xffffffff) { // zip64
    const l = cauda.lastIndexOf(Buffer.from([0x50, 0x4b, 0x06, 0x06]));
    tamanho = Number(cauda.readBigUInt64LE(l + 40));
    inicio = Number(cauda.readBigUInt64LE(l + 48));
  }
  const cd = (await pedir(url, inicio, inicio + tamanho - 1)).dados;
  const indice = {};
  for (let p = 0; p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50;) {
    const metodo = cd.readUInt16LE(p + 10);
    let comprimido = cd.readUInt32LE(p + 20);
    const nl = cd.readUInt16LE(p + 28);
    const xl = cd.readUInt16LE(p + 30);
    const cl = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const nome = cd.toString('utf8', p + 46, p + 46 + nl);
    if (offset === 0xffffffff || comprimido === 0xffffffff) { // campos zip64 no extra
      let x = p + 46 + nl;
      const fimX = x + xl;
      while (x + 4 <= fimX) {
        const id = cd.readUInt16LE(x);
        const sz = cd.readUInt16LE(x + 2);
        if (id === 0x0001) {
          let k = x + 4;
          if (cd.readUInt32LE(p + 24) === 0xffffffff) k += 8;
          if (comprimido === 0xffffffff) { comprimido = Number(cd.readBigUInt64LE(k)); k += 8; }
          if (offset === 0xffffffff) offset = Number(cd.readBigUInt64LE(k));
        }
        x += 4 + sz;
      }
    }
    indice[nome] = { offset, comprimido, metodo };
    p += 46 + nl + xl + cl;
  }
  return indice;
}

async function extrair(url, entrada) {
  const cab = (await pedir(url, entrada.offset, entrada.offset + 29)).dados;
  const ini = entrada.offset + 30 + cab.readUInt16LE(26) + cab.readUInt16LE(28);
  const dados = (await pedir(url, ini, ini + entrada.comprimido - 1)).dados;
  if (entrada.metodo === 0) return dados;
  if (entrada.metodo === 8) return zlib.inflateRawSync(dados);
  throw new Error(`método de compressão ${entrada.metodo} não suportado`);
}

// ---------- escolha das passagens ----------

function lerCsv(texto) {
  const linhas = [];
  let campo = '';
  let linha = [];
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas) {
      if (c === '"' && texto[i + 1] === '"') { campo += '"'; i++; } else if (c === '"') aspas = false; else campo += c;
    } else if (c === '"') aspas = true;
    else if (c === ',') { linha.push(campo); campo = ''; } else if (c === '\n' || c === '\r') {
      if (c === '\r' && texto[i + 1] === '\n') i++;
      linha.push(campo); campo = '';
      if (linha.some((x) => x !== '')) linhas.push(linha);
      linha = [];
    } else campo += c;
  }
  if (campo || linha.length) { linha.push(campo); linhas.push(linha); }
  const [cab, ...resto] = linhas;
  return resto.map((l) => Object.fromEntries(cab.map((k, i) => [k, l[i]])));
}

// Gravação de origem de cada segmento: a pasta no NURC, o sufixo no C-ORAL;
// no ALIP e no SP2010 só há o número, então segmentos com números próximos
// (até 3 de distância) contam como a mesma gravação.
function gravacao(seg) {
  const p = seg.file_path;
  if (seg.dataset === 'NURC-Recife') return path.posix.dirname(p);
  const m = p.match(/_CO_([^.]+)\.wav$/);
  if (m) return m[1];
  return null;
}
const numero = (seg) => Number((seg.file_path.match(/\/(\d+)_/) || [])[1]);

// Escolha determinística: a primeira gravação (na ordem dos nomes) com
// segmentos seguidos suficientes para PALAVRAS_POR_PASSAGEM palavras.
function escolher(meta) {
  const passagens = {};
  for (const [id, a] of Object.entries(ACERVOS)) {
    const segs = meta
      .filter((s) => s.dataset === a.dataset && (!a.estilo || s.speech_style === a.estilo) && s.text && s.text.trim())
      .sort((x, y) => numero(x) - numero(y));
    const grupos = [];
    for (const s of segs) {
      const g = grupos[grupos.length - 1];
      const chave = gravacao(s);
      const mesma = g && (chave !== null ? g.chave === chave : numero(s) - numero(g.segs[g.segs.length - 1]) <= 3);
      if (mesma) g.segs.push(s); else grupos.push({ chave, segs: [s] });
    }
    // no NURC e no C-ORAL a mesma gravação pode aparecer em vários grupos: junta
    const porChave = new Map();
    for (const g of grupos) {
      const k = g.chave !== null ? g.chave : `#${numero(g.segs[0])}`;
      if (!porChave.has(k)) porChave.set(k, []);
      porChave.get(k).push(...g.segs);
    }
    const ordem = [...porChave.keys()].sort();
    for (const k of ordem) {
      const lista = porChave.get(k).sort((x, y) => numero(x) - numero(y));
      const escolhidos = [];
      let palavras = 0;
      for (const s of lista) {
        escolhidos.push(s);
        palavras += s.text.trim().split(/\s+/).length;
        if (palavras >= PALAVRAS_POR_PASSAGEM) break;
      }
      if (palavras >= PALAVRAS_POR_PASSAGEM) { passagens[id] = { gravacao: k, segmentos: escolhidos.map((s) => ({ arquivo: s.file_path, texto: s.text.trim() })) }; break; }
    }
    if (!passagens[id]) throw new Error(`nenhuma gravação de ${a.dataset} com ${PALAVRAS_POR_PASSAGEM} palavras`);
  }
  return passagens;
}

// Baixa (se ainda não houver) o índice do conjunto de teste e os segmentos escolhidos.
async function preparar({ log = () => {} } = {}) {
  fs.mkdirSync(path.join(PASTA, 'segmentos'), { recursive: true });
  const arqMeta = path.join(PASTA, 'metadata_test_final.csv');
  if (!fs.existsSync(arqMeta)) {
    log('Baixando o índice do conjunto de teste do CORAA (2,6 MB)...');
    fs.writeFileSync(arqMeta, (await pedir(`${BASE}metadata_test_final.csv`)).dados);
  }
  const arqEscolha = path.join(PASTA, 'passagens.json');
  const passagens = fs.existsSync(arqEscolha)
    ? JSON.parse(fs.readFileSync(arqEscolha, 'utf8'))
    : escolher(lerCsv(fs.readFileSync(arqMeta, 'utf8')));
  fs.writeFileSync(arqEscolha, JSON.stringify(passagens, null, 1));
  const local = (a) => path.join(PASTA, 'segmentos', a.replace(/\//g, '__'));
  const faltam = Object.values(passagens).flatMap((p) => p.segmentos).filter((s) => !fs.existsSync(local(s.arquivo)));
  if (faltam.length) {
    log(`Lendo ${faltam.length} segmentos de dentro do test.zip do CORAA (só os trechos escolhidos)...`);
    const url = `${BASE}test.zip`;
    const indice = await indiceDoZip(url);
    for (const s of faltam) {
      const e = indice[s.arquivo] || indice[s.arquivo.replace(/^test\//, '')];
      if (!e) throw new Error(`${s.arquivo} não está no test.zip`);
      fs.writeFileSync(local(s.arquivo), await extrair(url, e));
    }
  }
  for (const p of Object.values(passagens)) for (const s of p.segmentos) s.local = local(s.arquivo);
  return passagens;
}

// ---------- condições ----------

function montarCondicoes(ffmpeg, passagens, { nomes = Object.keys(CONDICOES) } = {}) {
  const out = path.join(PASTA, 'condicoes');
  fs.mkdirSync(out, { recursive: true });
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  const dur = (f) => blocos.duracaoWav(blocos.lerWav(f));
  const concatenar = (lista, pausa, saida) => {
    const entradas = [];
    const partes = [];
    let n = 0;
    const rot = [];
    lista.forEach((f, i) => {
      entradas.push('-i', f);
      partes.push(`[${n++}:a]aformat=sample_rates=16000:channel_layouts=mono[a${i}]`);
      rot.push(`[a${i}]`);
      if (pausa > 0 && i < lista.length - 1) {
        entradas.push('-f', 'lavfi', '-t', String(pausa), '-i', 'anullsrc=r=16000:cl=mono');
        partes.push(`[${n++}:a]aformat=sample_rates=16000:channel_layouts=mono[p${i}]`);
        rot.push(`[p${i}]`);
      }
    });
    ff([...entradas, '-filter_complex', `${partes.join(';')};${rot.join('')}concat=n=${rot.length}:v=0:a=1[o]`, '-map', '[o]', '-c:a', 'pcm_s16le', saida]);
  };

  // vozes do fundo: as mesmas do FLEURS (clipes 20 a 39), ao contrário
  const refs = JSON.parse(fs.readFileSync(path.join(fleurs.PASTA, 'referencias.json'), 'utf8'));
  const vozes = Object.keys(refs).sort().slice(20, 40).map((f) => path.join(fleurs.PASTA, f));
  const cru = path.join(out, '_vozes.wav');
  if (nomes.includes('ruido-festa') && !fs.existsSync(cru)) concatenar(vozes, 0, cru);

  const casos = [];
  for (const [id, p] of Object.entries(passagens)) {
    const arq = (n) => path.join(out, `${id}-${n}.wav`);
    const original = arq('original');
    if (!fs.existsSync(original)) concatenar(p.segmentos.map((s) => s.local), 0.3, original);
    const d = dur(original);
    if (nomes.includes('ruido-festa') && !fs.existsSync(arq('ruido-festa'))) {
      const fundo = path.join(out, `_fundo-${id}.wav`);
      ff(['-i', cru, '-i', cru, '-i', cru, '-filter_complex',
        `[0:a]areverse[x];[1:a]areverse,atrim=start=7,asetpts=PTS-STARTPTS[y];[2:a]areverse,atrim=start=19,asetpts=PTS-STARTPTS[z];[x][y][z]amix=inputs=3:duration=shortest,atrim=end=${d.toFixed(2)}[o]`,
        '-map', '[o]', '-c:a', 'pcm_s16le', fundo]);
      ff(['-i', original, '-i', fundo, '-filter_complex',
        `[0:a]loudnorm=I=-20:TP=-2:LRA=11,volume=1[f];[1:a]loudnorm=I=-20:TP=-2:LRA=11,volume=${Math.pow(10, -6 / 20)}[b];[f][b]amix=inputs=2:duration=first:normalize=0,aformat=sample_rates=16000:channel_layouts=mono[o]`,
        '-map', '[o]', '-c:a', 'pcm_s16le', arq('ruido-festa')]);
    }
    const frases = p.segmentos.map((s) => s.texto);
    for (const n of nomes) {
      casos.push({
        nome: `coraa:${id}:${n}`,
        descricao: `${ACERVOS[id].descricao}. ${CONDICOES[n]}`,
        arquivo: arq(n),
        duracao: +dur(arq(n)).toFixed(2),
        texto: frases.join(' '),
        frases,
        palavras: [],
        iniciosFala: [],
      });
    }
  }
  return casos;
}

module.exports = { ACERVOS, CONDICOES, PASTA, preparar, montarCondicoes };
