// Fala humana real para a base de testes: frases do FLEURS (português do Brasil).
//
// FLEURS: Google, licença CC BY 4.0 - https://huggingface.co/datasets/google/fleurs
// Conneau et al., "FLEURS: Few-shot Learning Evaluation of Universal Representations
// of Speech" (2022). Os áudios NÃO vão para o Git: são baixados para fleurs/ na
// primeira vez (só os primeiros clipes do arquivo de teste, ~35 MB) e as
// condições de teste são montadas a partir deles. Ver FLEURS.md.
//
// Limites: é fala lida (não espontânea), de poucos falantes, e a música e o
// ruído são sintéticos. Serve para medir texto com gabarito confiável; não
// substitui as amostras reais de casamento/futebol/publicidade (amostras/).

'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const zlib = require('zlib');
const { execFileSync } = require('child_process');
const blocos = require('../../src/main/blocos');

const BASE = 'https://huggingface.co/datasets/google/fleurs/resolve/main/data/pt_br/';
const PASTA = path.join(__dirname, 'fleurs');
const CLIPES = 40;

// Música sintética (a mesma de cenarios.js).
const MUSICA = "0.12*sin(2*PI*220*t)+0.09*sin(2*PI*277.18*t)+0.09*sin(2*PI*329.63*t)+0.25*sin(2*PI*55*t)*lt(mod(t,0.5),0.08)";

// ---------- download ----------

function baixar(url, aoResponder) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'RefLab-testes' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        baixar(new URL(res.headers.location, url).toString(), aoResponder).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`HTTP ${res.statusCode} em ${url}`)); return; }
      aoResponder(res, req, resolve, reject);
    });
    req.on('error', reject);
  });
}

function baixarTexto(url) {
  return baixar(url, (res, req, resolve, reject) => {
    const partes = [];
    res.on('data', (d) => partes.push(d));
    res.on('end', () => resolve(Buffer.concat(partes).toString('utf8')));
    res.on('error', reject);
  });
}

// Lê o .tar.gz em fluxo e entrega cada arquivo; para quando "aoArquivo" devolve true.
function lerTarGz(url, aoArquivo) {
  return baixar(url, (res, req, resolve, reject) => {
    const gunzip = zlib.createGunzip();
    let buf = Buffer.alloc(0);
    let atual = null; // { nome, tipo, tamanho }
    let fim = false;
    const terminar = () => { if (!fim) { fim = true; req.destroy(); resolve(); } };
    gunzip.on('data', (d) => {
      if (fim) return;
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (!atual) {
          if (buf.length < 512) return;
          const cab = buf.subarray(0, 512);
          buf = buf.subarray(512);
          if (cab.every((b) => b === 0)) continue;
          const txt = (a, b) => cab.toString('utf8', a, b).replace(/\0.*$/s, '');
          const tamanho = parseInt(txt(124, 136).trim() || '0', 8);
          const prefixo = txt(345, 500);
          atual = { nome: prefixo ? `${prefixo}/${txt(0, 100)}` : txt(0, 100), tipo: txt(156, 157), tamanho };
        }
        const bloco = Math.ceil(atual.tamanho / 512) * 512;
        if (buf.length < bloco) return;
        const dados = buf.subarray(0, atual.tamanho);
        buf = buf.subarray(bloco);
        const a = atual;
        atual = null;
        if ((a.tipo === '0' || a.tipo === '') && aoArquivo(a.nome, Buffer.from(dados))) { terminar(); return; }
      }
    });
    gunzip.on('end', terminar);
    gunzip.on('error', (e) => { if (!fim) reject(e); });
    res.on('error', (e) => { if (!fim) reject(e); });
    res.pipe(gunzip);
  });
}

// Baixa (se ainda não houver) os primeiros clipes do conjunto de teste pt_br e o gabarito.
async function preparar({ clipes = CLIPES, log = () => {} } = {}) {
  const refArq = path.join(PASTA, 'referencias.json');
  if (fs.existsSync(refArq)) {
    const refs = JSON.parse(fs.readFileSync(refArq, 'utf8'));
    if (Object.keys(refs).length >= clipes && Object.keys(refs).every((f) => fs.existsSync(path.join(PASTA, f)))) return refs;
  }
  fs.mkdirSync(PASTA, { recursive: true });
  log('Baixando o gabarito do FLEURS (pt_br/test.tsv)...');
  const tsv = await baixarTexto(`${BASE}test.tsv`);
  const gabarito = {};
  for (const linha of tsv.split(/\r?\n/)) {
    const c = linha.split('\t');
    // id, arquivo, transcrição original, normalizada, fonemas, amostras, gênero
    if (c.length >= 3 && !gabarito[c[1]]) gabarito[c[1]] = { id: c[0], texto: c[2], genero: c[6] || '' };
  }
  log(`Baixando os ${clipes} primeiros clipes de pt_br/audio/test.tar.gz (para no meio do arquivo)...`);
  const refs = {};
  const ids = new Set();
  await lerTarGz(`${BASE}audio/test.tar.gz`, (nome, dados) => {
    const base = path.basename(nome);
    const g = gabarito[base];
    if (!g || ids.has(g.id)) return false;
    fs.writeFileSync(path.join(PASTA, base), dados);
    refs[base] = g;
    ids.add(g.id);
    return Object.keys(refs).length >= clipes;
  });
  fs.writeFileSync(refArq, JSON.stringify(refs, null, 1));
  return refs;
}

// ---------- condições ----------

const CONDICOES = {
  'limpo-continuo': 'Fala contínua (7 frases, 0,3 s entre elas).',
  'musica-moderada': 'Fala com música sintética por baixo (SNR 10 dB).',
  'musica-forte': 'Fala com música sintética forte (SNR 3 dB).',
  'ruido-festa': 'Fala com vozes ao fundo (frases de outros falantes ao contrário, SNR 6 dB).',
  'fala-baixa': 'Fala muito baixa (cerca de -40 dBFS) com chiado.',
  'pausas-variadas': 'Pausas de 1, 4, 12 (música), 2, 6 e 15 s entre as frases.',
  'sem-fala': 'Só música, silêncio e chiado (nenhuma fala: nada deve ser transcrito).',
};

// Clipes usados como fala em cada conjunto. "calibracao" é o que serviu para
// ajustar os filtros da recuperação; os de validação têm outros falantes e
// outros textos e não podem ser usados para ajustar nada antes de medir.
// As vozes do fundo (clipes 20 a 39, ao contrário) são as mesmas em todos.
const CONJUNTOS = { calibracao: [0, 7], 'validacao-a': [7, 14], 'validacao-b': [14, 20] };

function montarCondicoes(ffmpeg, { nomes = Object.keys(CONDICOES), log = () => {}, conjunto = 'calibracao' } = {}) {
  if (!CONJUNTOS[conjunto]) throw new Error(`Conjunto FLEURS desconhecido: ${conjunto} (use ${Object.keys(CONJUNTOS).join(', ')})`);
  const refs = JSON.parse(fs.readFileSync(path.join(PASTA, 'referencias.json'), 'utf8'));
  const arquivos = Object.keys(refs).sort();
  const base = arquivos.slice(...CONJUNTOS[conjunto]);
  const vozes = arquivos.slice(20, 40);
  const frases = base.map((f) => refs[f].texto);
  const texto = frases.join(' ');
  const out = path.join(PASTA, conjunto === 'calibracao' ? 'condicoes' : `condicoes-${conjunto}`);
  fs.mkdirSync(out, { recursive: true });
  const ff = (args) => execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { windowsHide: true });
  const dur = (f) => blocos.duracaoWav(blocos.lerWav(f));
  const arq = (n) => path.join(out, `${n}.wav`);

  function concatenar(lista, pausas, saida) {
    const entradas = [];
    const partes = [];
    let n = 0;
    lista.forEach((f, i) => {
      entradas.push('-i', path.join(PASTA, f));
      partes.push(`[${n++}:a]aformat=sample_rates=16000:channel_layouts=mono[a${i}]`);
      const p = pausas[i];
      if (p && p.dur > 0) {
        const src = p.tipo === 'musica' ? `aevalsrc='${MUSICA}':s=16000` : 'anullsrc=r=16000:cl=mono';
        entradas.push('-f', 'lavfi', '-t', String(p.dur), '-i', src);
        partes.push(`[${n++}:a]aformat=sample_rates=16000:channel_layouts=mono,volume=${p.tipo === 'musica' ? 0.5 : 1}[p${i}]`);
      }
    });
    const rot = lista.map((_, i) => `[a${i}]${pausas[i] && pausas[i].dur > 0 ? `[p${i}]` : ''}`).join('');
    const k = lista.length + pausas.filter((p) => p && p.dur > 0).length;
    ff([...entradas, '-filter_complex', `${partes.join(';')};${rot}concat=n=${k}:v=0:a=1[o]`, '-map', '[o]', '-c:a', 'pcm_s16le', saida]);
  }
  function misturar(fala, fundo, snrDb, saida) {
    const g = Math.pow(10, -snrDb / 20);
    ff(['-i', fala, '-i', fundo, '-filter_complex',
      `[0:a]loudnorm=I=-20:TP=-2:LRA=11,volume=1[f];[1:a]loudnorm=I=-20:TP=-2:LRA=11,volume=${g}[b];[f][b]amix=inputs=2:duration=first:normalize=0,aformat=sample_rates=16000:channel_layouts=mono[o]`,
      '-map', '[o]', '-c:a', 'pcm_s16le', saida]);
  }

  const precisa = (n) => nomes.includes(n) && !fs.existsSync(arq(n));
  const limpo = arq('limpo-continuo');
  if (!fs.existsSync(limpo)) { log('Montando as condições com fala real...'); concatenar(base, base.map(() => ({ dur: 0.3, tipo: 'silencio' })), limpo); }
  const d = dur(limpo);
  const musica = path.join(out, '_musica.wav');
  if (!fs.existsSync(musica)) ff(['-f', 'lavfi', '-t', String(d), '-i', `aevalsrc='${MUSICA}':s=16000`, '-c:a', 'pcm_s16le', musica]);
  if (precisa('musica-moderada')) misturar(limpo, musica, 10, arq('musica-moderada'));
  if (precisa('musica-forte')) misturar(limpo, musica, 3, arq('musica-forte'));
  if (precisa('ruido-festa')) {
    const cru = path.join(out, '_vozes.wav');
    concatenar(vozes, [], cru);
    const fundo = path.join(out, '_vozes-ao-contrario.wav');
    ff(['-i', cru, '-i', cru, '-i', cru, '-filter_complex',
      `[0:a]areverse[x];[1:a]areverse,atrim=start=7,asetpts=PTS-STARTPTS[y];[2:a]areverse,atrim=start=19,asetpts=PTS-STARTPTS[z];[x][y][z]amix=inputs=3:duration=shortest,atrim=end=${d.toFixed(2)}[o]`,
      '-map', '[o]', '-c:a', 'pcm_s16le', fundo]);
    misturar(limpo, fundo, 6, arq('ruido-festa'));
  }
  const chiado = path.join(out, '_chiado.wav');
  if ((precisa('fala-baixa') || precisa('sem-fala')) && !fs.existsSync(chiado)) {
    ff(['-f', 'lavfi', '-t', String(d), '-i', 'anoisesrc=color=pink:amplitude=0.004:r=16000:seed=1', '-c:a', 'pcm_s16le', chiado]);
  }
  if (precisa('fala-baixa')) {
    ff(['-i', limpo, '-i', chiado, '-filter_complex', '[0:a]loudnorm=I=-20:TP=-2:LRA=11,volume=0.1[f];[f][1:a]amix=inputs=2:duration=first:normalize=0,aformat=sample_rates=16000:channel_layouts=mono[o]', '-map', '[o]', '-c:a', 'pcm_s16le', arq('fala-baixa')]);
  }
  if (precisa('pausas-variadas')) {
    concatenar(base, [{ dur: 1, tipo: 'silencio' }, { dur: 4, tipo: 'silencio' }, { dur: 12, tipo: 'musica' }, { dur: 2, tipo: 'silencio' }, { dur: 6, tipo: 'silencio' }, { dur: 15, tipo: 'silencio' }], arq('pausas-variadas'));
  }
  if (precisa('sem-fala')) {
    // 20 s de música, 15 s de silêncio, 15 s de chiado
    ff(['-f', 'lavfi', '-t', '20', '-i', `aevalsrc='${MUSICA}':s=16000`, '-f', 'lavfi', '-t', '15', '-i', 'anullsrc=r=16000:cl=mono', '-i', chiado,
      '-filter_complex', '[0:a]aformat=sample_rates=16000:channel_layouts=mono,volume=0.5[a];[1:a]aformat=sample_rates=16000:channel_layouts=mono[b];[2:a]atrim=end=15,asetpts=PTS-STARTPTS,aformat=sample_rates=16000:channel_layouts=mono[c];[a][b][c]concat=n=3:v=0:a=1[o]',
      '-map', '[o]', '-c:a', 'pcm_s16le', arq('sem-fala')]);
  }

  return nomes.map((n) => ({
    nome: conjunto === 'calibracao' ? `fleurs:${n}` : `fleurs-${conjunto}:${n}`,
    descricao: CONDICOES[n],
    arquivo: arq(n),
    duracao: +dur(arq(n)).toFixed(2),
    texto: n === 'sem-fala' ? '' : texto,
    frases: n === 'sem-fala' ? [] : frases,
    palavras: [],
    iniciosFala: [],
  }));
}

module.exports = { CONDICOES, CONJUNTOS, PASTA, preparar, montarCondicoes };
