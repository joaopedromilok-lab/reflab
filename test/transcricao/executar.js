#!/usr/bin/env node
// Base de testes da transcrição: roda a MESMA função de transcrição do app
// (src/main/transcribe.js, sem alterações) sobre cenários com gabarito e mede:
//  - erro de texto (WER, com e sem acento)
//  - erro de tempo das palavras (previsto - real)
//  - erro no início dos trechos depois de pausas
//  - palavras inventadas (inserções)
//
// Uso:
//   node test/transcricao/executar.js                      # cenários sintéticos, modelo padrão (turbo), VAD ligado (padrão do app)
//   node test/transcricao/executar.js --modelo base        # outro modelo já baixado
//   node test/transcricao/executar.js --sem-vad            # compara com a detecção de voz desligada
//   node test/transcricao/executar.js --cenarios pausas-longas,fala-limpa
//   node test/transcricao/executar.js --amostras           # inclui as amostras reais de amostras/arquivos (se existirem)
//
// Usa as ferramentas e modelos já instalados pelo RefLab (pasta de dados do app).
// Para usar outra pasta: variável de ambiente REFLAB_DADOS.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { CENARIOS, montar } = require('./cenarios');
const { wer, errosDeTempo, errosDeInicio } = require('./metricas');

const RAIZ = path.resolve(__dirname, '..', '..');
const tools = require(path.join(RAIZ, 'src/main/tools'));
const transcribe = require(path.join(RAIZ, 'src/main/transcribe'));
const captions = require(path.join(RAIZ, 'src/main/captions'));

function pastaDados() {
  if (process.env.REFLAB_DADOS) return process.env.REFLAB_DADOS;
  if (process.platform === 'win32') return path.join(process.env.APPDATA, 'RefLab');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'RefLab');
  return path.join(os.homedir(), '.config', 'RefLab');
}

function argumentos() {
  const a = process.argv.slice(2);
  const valor = (nome) => { const i = a.indexOf(nome); return i >= 0 ? a[i + 1] : null; };
  return {
    modelo: valor('--modelo') || 'turbo', // padrão de produção (settings.js)
    idioma: valor('--idioma') || 'pt',
    cenarios: (valor('--cenarios') || Object.keys(CENARIOS).join(',')).split(',').map((s) => s.trim()).filter(Boolean),
    semVad: a.includes('--sem-vad'),
    amostras: a.includes('--amostras'),
    manter: a.includes('--manter-arquivos'),
  };
}

// Amostras reais: amostras/manifesto.json lista o planejado; só entram as que
// têm áudio e texto de referência em amostras/arquivos/.
function amostrasReais() {
  const dir = path.join(__dirname, 'amostras');
  const manifesto = JSON.parse(fs.readFileSync(path.join(dir, 'manifesto.json'), 'utf8'));
  const prontas = [];
  for (const a of manifesto.amostras) {
    const base = path.join(dir, 'arquivos', a.id);
    const audio = ['.wav', '.mp3', '.m4a', '.mp4', '.mov', '.flac'].map((e) => base + e).find((f) => fs.existsSync(f));
    const refTxt = `${base}.txt`;
    if (!audio || !fs.existsSync(refTxt)) continue;
    const tempos = fs.existsSync(`${base}.tempos.json`) ? JSON.parse(fs.readFileSync(`${base}.tempos.json`, 'utf8')) : {};
    prontas.push({
      nome: `amostra:${a.id}`,
      descricao: a.descricao,
      arquivo: audio,
      texto: fs.readFileSync(refTxt, 'utf8'),
      palavras: tempos.palavras || [],
      iniciosFala: tempos.iniciosFala || [],
      prompt: a.nomesDificeis || '',
    });
  }
  return { prontas, total: manifesto.amostras.length };
}

function fmt(v, casas = 2, sufixo = '') {
  return v === null || v === undefined || Number.isNaN(v) ? '-' : `${v.toFixed(casas)}${sufixo}`;
}

async function avaliar(caso, opcoes, pastaTmp) {
  // Copia para uma pasta só deste caso (a transcrição grava arquivos ao lado do áudio).
  const dir = fs.mkdtempSync(path.join(pastaTmp, 'caso-'));
  const arquivo = path.join(dir, path.basename(caso.arquivo));
  fs.copyFileSync(caso.arquivo, arquivo);

  const t0 = performance.now();
  const r = await transcribe.transcribe(arquivo, {
    language: opcoes.idioma,
    model: opcoes.modelo,
    prompt: caso.prompt || '',
    vad: !opcoes.semVad,
    onPhase: () => {},
  });
  const segundos = (performance.now() - t0) / 1000;

  const textoPrevisto = r.segments.map((s) => s.text).join(' ');
  const palavrasPrevistas = captions.allWords(r.segments); // o mesmo que a legenda Reels usa
  const w = wer(caso.texto, textoPrevisto);
  const wSemAcento = wer(caso.texto, textoPrevisto, { semAcento: true });
  const tempo = caso.palavras.length ? errosDeTempo(caso.palavras, palavrasPrevistas) : null;
  const inicios = caso.iniciosFala.length ? errosDeInicio(caso.iniciosFala, r.segments.map((s) => s.start)) : [];
  const inseridas = w.ops.filter((o) => o.tipo === 'insercao').map((o) => w.hip[o.hip]);

  return {
    caso: caso.nome,
    descricao: caso.descricao,
    duracaoAudio: r.info.duration,
    segundosProcessando: +segundos.toFixed(1),
    fonte: r.source,
    wer: w.wer,
    werSemAcento: wSemAcento.wer,
    contagem: { ref: w.palavrasRef, previstas: w.palavrasHip, trocas: w.trocas, remocoes: w.remocoes, insercoes: w.insercoes },
    palavrasInventadas: inseridas,
    tempoPalavras: tempo && {
      comparadas: tempo.palavrasComparadas,
      erroMedioAbs: tempo.erroMedioAbs,
      mediana: tempo.mediana,
      p90: tempo.p90,
      maximo: tempo.maximo,
      viesMedio: tempo.viesMedio,
      dentroDe300ms: tempo.dentroDoLimite,
      piores: [...tempo.pares].sort((a, b) => Math.abs(b.erro) - Math.abs(a.erro)).slice(0, 5),
    },
    inicioTrechos: inicios,
    textoPrevisto,
    segmentos: r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text })),
  };
}

async function main() {
  const op = argumentos();
  const dados = pastaDados();
  tools.init(path.join(dados, 'bin'));
  const pastaTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflab-teste-transcricao-'));
  // Índice de busca separado, para não misturar com as transcrições reais do app.
  transcribe.init(path.join(dados, 'modelos'), pastaTmp);

  const modelo = transcribe.MODELS[op.modelo];
  if (!modelo) throw new Error(`Modelo desconhecido: ${op.modelo}. Opções: ${Object.keys(transcribe.MODELS).join(', ')}`);
  if (!fs.existsSync(path.join(dados, 'modelos', modelo.file))) {
    throw new Error(`O modelo "${op.modelo}" (${modelo.file}) não está baixado em ${path.join(dados, 'modelos')}. Baixe-o pelo app antes.`);
  }

  console.log(`Base de testes da transcrição · modelo ${op.modelo} · idioma ${op.idioma} · detecção de voz ${op.semVad ? 'DESLIGADA' : 'ligada (padrão do app)'}`);
  const casos = op.cenarios.map((n) => montar(n, pastaTmp, tools.toolPath('ffmpeg')));
  if (op.amostras) {
    const { prontas, total } = amostrasReais();
    console.log(`Amostras reais: ${prontas.length} de ${total} prontas (com áudio e referência).`);
    casos.push(...prontas);
  }

  const resultados = [];
  for (const caso of casos) {
    process.stdout.write(`  · ${caso.nome} (${fmt(caso.duracao || 0, 1)} s)... `);
    try {
      const r = await avaliar(caso, op, pastaTmp);
      resultados.push(r);
      console.log(`ok em ${r.segundosProcessando} s`);
    } catch (e) {
      resultados.push({ caso: caso.nome, erro: e.message });
      console.log(`ERRO: ${e.message}`);
    }
  }

  console.log('\nResultado');
  console.table(resultados.map((r) => (r.erro ? { caso: r.caso, erro: r.erro } : {
    caso: r.caso,
    'WER': fmt(r.wer * 100, 1, '%'),
    'WER s/ acento': fmt(r.werSemAcento * 100, 1, '%'),
    'inventadas': r.contagem.insercoes,
    'erro tempo médio': r.tempoPalavras ? fmt(r.tempoPalavras.erroMedioAbs, 2, ' s') : '-',
    'viés': r.tempoPalavras ? fmt(r.tempoPalavras.viesMedio, 2, ' s') : '-',
    'até 0,3 s': r.tempoPalavras ? fmt(r.tempoPalavras.dentroDe300ms * 100, 0, '%') : '-',
    'início trechos': r.inicioTrechos.map((x) => fmt(x.erro, 2)).join(' / ') || '-',
    'tempo proc.': `${r.segundosProcessando} s`,
  })));

  const pastaRes = path.join(__dirname, 'resultados');
  fs.mkdirSync(pastaRes, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const arquivoRes = path.join(pastaRes, `${carimbo}-${op.modelo}${op.semVad ? '-sem-vad' : ''}.json`);
  fs.writeFileSync(arquivoRes, JSON.stringify({
    data: new Date().toISOString(), plataforma: `${process.platform} ${process.arch}`, opcoes: op, resultados,
  }, null, 2));
  console.log(`\nDetalhes: ${path.relative(RAIZ, arquivoRes)}`);

  if (!op.manter) fs.rmSync(pastaTmp, { recursive: true, force: true });
  else console.log(`Arquivos de áudio mantidos em: ${pastaTmp}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
