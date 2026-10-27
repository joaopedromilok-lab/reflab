#!/usr/bin/env node
// Base de testes da transcrição: roda a MESMA função de transcrição do app
// (src/main/transcribe.js, sem alterações) sobre cenários com gabarito e mede:
//  - erro de texto (WER, com e sem acento; trocas, palavras perdidas, inventadas)
//  - trechos perdidos (3+ palavras seguidas) e frases perdidas
//  - repetições a mais (laços do whisper, trechos duplicados)
//  - recuperação de falas omitidas: tentativas, aceitas e se cada uma melhorou o texto
//  - erro de tempo das palavras e do início dos trechos (só cenários sintéticos)
//
// Uso:
//   node test/transcricao/executar.js                      # cenários sintéticos, modelo padrão (turbo), VAD ligado (padrão do app)
//   node test/transcricao/executar.js --fleurs             # + fala humana real (FLEURS, baixada na 1ª vez; ver FLEURS.md)
//   node test/transcricao/executar.js --so-fleurs          # só a fala real
//   node test/transcricao/executar.js --so-fleurs --condicoes ruido-festa,sem-fala
//   node test/transcricao/executar.js --so-fleurs --fleurs-conjunto validacao-a   # outras frases (não usadas na calibração)
//   node test/transcricao/executar.js --so-coraa          # só fala espontânea real (CORAA, trechos baixados na 1ª vez; ver CORAA.md)
//   node test/transcricao/executar.js --modelo base        # outro modelo já baixado
//   node test/transcricao/executar.js --sem-vad            # compara com a detecção de voz desligada
//   node test/transcricao/executar.js --sem-recuperacao    # desliga a recuperação de falas omitidas
//   node test/transcricao/executar.js --recuperacao-forcada  # liga a recuperação (desligada por padrão; só experimentos)
//   node test/transcricao/executar.js --limiar 3           # lacuna mínima (s) para tentar recuperar
//   node test/transcricao/executar.js --cenarios pausas-longas,fala-limpa
//   node test/transcricao/executar.js --amostras           # inclui as amostras reais de amostras/arquivos (se existirem)
//   node test/transcricao/executar.js --bloco-max 8        # força blocos pequenos (testa os cortes dentro da fala)
//   node test/transcricao/executar.js --raiz ../outra-copia --rotulo anterior   # roda o código de outra cópia do projeto
//
// Usa as ferramentas e modelos já instalados pelo RefLab (pasta de dados do app).
// Para usar outra pasta: variável de ambiente REFLAB_DADOS.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { CENARIOS, montar } = require('./cenarios');
const fleurs = require('./fleurs');
const coraa = require('./coraa');
const { wer, errosDeTempo, errosDeInicio, trechosPerdidos, frasesPerdidas, repeticoes } = require('./metricas');

function argumentos() {
  const a = process.argv.slice(2);
  const valor = (nome) => { const i = a.indexOf(nome); return i >= 0 ? a[i + 1] : null; };
  const soFleurs = a.includes('--so-fleurs');
  const soCoraa = a.includes('--so-coraa');
  const lista = (v, padrao) => (v || padrao).split(',').map((s) => s.trim()).filter(Boolean);
  return {
    modelo: valor('--modelo') || 'turbo', // padrão de produção (settings.js)
    idioma: valor('--idioma') || 'pt',
    cenarios: (soFleurs || soCoraa) && !valor('--cenarios') ? [] : lista(valor('--cenarios'), Object.keys(CENARIOS).join(',')),
    fleurs: soFleurs || a.includes('--fleurs'),
    condicoes: lista(valor('--condicoes'), Object.keys(fleurs.CONDICOES).join(',')),
    fleursConjunto: valor('--fleurs-conjunto') || 'calibracao',
    coraa: soCoraa || a.includes('--coraa'),
    semVad: a.includes('--sem-vad'),
    semRecuperacao: a.includes('--sem-recuperacao'),
    recuperacaoForcada: a.includes('--recuperacao-forcada'),
    limiar: valor('--limiar') ? Number(valor('--limiar')) : null,
    amostras: a.includes('--amostras'),
    manter: a.includes('--manter-arquivos'),
    blocoMax: valor('--bloco-max') ? Number(valor('--bloco-max')) : null,
    raiz: path.resolve(valor('--raiz') || path.join(__dirname, '..', '..')),
    rotulo: valor('--rotulo') || '',
  };
}

const OP = argumentos();
const RAIZ = OP.raiz;
const tools = require(path.join(RAIZ, 'src/main/tools'));
const transcribe = require(path.join(RAIZ, 'src/main/transcribe'));
const captions = require(path.join(RAIZ, 'src/main/captions'));

function pastaDados() {
  if (process.env.REFLAB_DADOS) return process.env.REFLAB_DADOS;
  if (process.platform === 'win32') return path.join(process.env.APPDATA, 'RefLab');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'RefLab');
  return path.join(os.homedir(), '.config', 'RefLab');
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

// Avalia cada recuperação aceita contra o gabarito: o texto ficou melhor com ela?
function avaliarRecuperacoes(caso, segments, werFinal) {
  const rec = segments.some((s) => s.tentativa !== undefined);
  if (!rec) return [];
  const numeros = [...new Set(segments.map((s) => s.tentativa).filter((n) => n !== undefined))];
  return numeros.map((n) => {
    const sem = wer(caso.texto, segments.filter((s) => s.tentativa !== n).map((s) => s.text).join(' '));
    const ganho = sem.trocas + sem.remocoes + sem.insercoes - (werFinal.trocas + werFinal.remocoes + werFinal.insercoes);
    return {
      tentativa: n,
      texto: segments.filter((s) => s.tentativa === n).map((s) => s.text).join(' '),
      errosEvitados: ganho, // > 0: melhorou o texto; < 0: piorou
      veredito: ganho > 0 ? 'melhorou' : ganho < 0 ? 'piorou' : 'igual',
    };
  });
}

async function avaliar(caso, opcoes, pastaTmp) {
  // Copia para uma pasta só deste caso (a transcrição grava arquivos ao lado do áudio).
  const dir = fs.mkdtempSync(path.join(pastaTmp, 'caso-'));
  const arquivo = path.join(dir, path.basename(caso.arquivo));
  fs.copyFileSync(caso.arquivo, arquivo);

  const log = [];
  const t0 = performance.now();
  const r = await transcribe.transcribe(arquivo, {
    language: opcoes.idioma,
    model: opcoes.modelo,
    prompt: caso.prompt || '',
    vad: !opcoes.semVad,
    blocosOpcoes: opcoes.blocoMax ? { maximo: opcoes.blocoMax, minimo: Math.min(60, opcoes.blocoMax / 2) } : undefined,
    recuperacaoOpcoes: opcoes.semRecuperacao ? { ativa: false } : {
      ...(opcoes.recuperacaoForcada ? { ativa: true } : {}),
      ...(opcoes.limiar ? { limiar: opcoes.limiar } : {}),
    },
    onPhase: () => {},
    onLog: (m) => log.push(m),
  });
  const segundos = (performance.now() - t0) / 1000;

  const textoPrevisto = r.segments.map((s) => s.text).join(' ');
  const palavrasPrevistas = captions.allWords(r.segments); // o mesmo que a legenda Reels usa
  const w = wer(caso.texto, textoPrevisto);
  const wSemAcento = wer(caso.texto, textoPrevisto, { semAcento: true });
  const tempo = caso.palavras.length ? errosDeTempo(caso.palavras, palavrasPrevistas) : null;
  const inicios = caso.iniciosFala.length ? errosDeInicio(caso.iniciosFala, r.segments.map((s) => s.start)) : [];
  const inseridas = w.ops.filter((o) => o.tipo === 'insercao').map((o) => w.hip[o.hip]);
  const seg = r.segmentacao || {};
  const rec = seg.recuperacao && seg.recuperacao.ativa ? seg.recuperacao : null;

  return {
    caso: caso.nome,
    descricao: caso.descricao,
    duracaoAudio: r.info.duration,
    segundosProcessando: +segundos.toFixed(1),
    fonte: r.source,
    segmentacao: r.segmentacao ? { modo: seg.modo, blocos: seg.blocos, plano: seg.plano } : null,
    wer: w.wer,
    werSemAcento: wSemAcento.wer,
    contagem: { ref: w.palavrasRef, previstas: w.palavrasHip, trocas: w.trocas, remocoes: w.remocoes, insercoes: w.insercoes },
    palavrasInventadas: inseridas,
    trechosPerdidos: trechosPerdidos(w),
    frasesPerdidas: caso.frases ? frasesPerdidas(caso.frases, textoPrevisto).map((f) => f.frase) : null,
    repeticoes: repeticoes(w),
    repeticoesFiltro: seg.repeticoes || null, // o que o filtro do app removeu ou manteve
    recuperacao: rec && {
      lacunas: rec.lacunas,
      execucoes: rec.execucoes,
      aceitas: rec.aceitas,
      tentativas: rec.tentativas,
      avaliacao: avaliarRecuperacoes(caso, r.segments, w),
    },
    log,
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
    segmentos: r.segments.map((s) => ({ start: s.start, end: s.end, text: s.text, ...(s.recuperado ? { recuperado: true } : {}) })),
  };
}

async function main() {
  const op = OP;
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

  const raizPropria = path.resolve(__dirname, '..', '..');
  console.log(`Base de testes da transcrição · modelo ${op.modelo} · idioma ${op.idioma} · detecção de voz ${op.semVad ? 'DESLIGADA' : 'ligada (padrão do app)'} · recuperação ${op.semRecuperacao ? 'DESLIGADA' : op.recuperacaoForcada ? 'FORÇADA' : 'padrão do modelo'}`);
  if (RAIZ !== raizPropria) console.log(`Código testado: ${RAIZ}`);
  const casos = op.cenarios.map((n) => montar(n, pastaTmp, tools.toolPath('ffmpeg')));
  if (op.fleurs) {
    await fleurs.preparar({ log: (m) => console.log(m) });
    casos.push(...fleurs.montarCondicoes(tools.toolPath('ffmpeg'), { nomes: op.condicoes, conjunto: op.fleursConjunto, log: (m) => console.log(m) }));
  }
  if (op.coraa) {
    const passagens = await coraa.preparar({ log: (m) => console.log(m) });
    casos.push(...coraa.montarCondicoes(tools.toolPath('ffmpeg'), passagens));
  }
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

  console.log('\nTexto');
  console.table(resultados.map((r) => (r.erro ? { caso: r.caso, erro: r.erro } : {
    caso: r.caso,
    'WER': fmt(r.wer * 100, 1, '%'),
    's/ acento': fmt(r.werSemAcento * 100, 1, '%'),
    'trocas': r.contagem.trocas,
    'perdidas': r.contagem.remocoes,
    'inventadas': r.contagem.insercoes,
    'trechos perdidos': r.trechosPerdidos.length,
    'frases perdidas': r.frasesPerdidas ? r.frasesPerdidas.length : '-',
    'repetições': r.repeticoes.length,
    'recuperação': r.recuperacao ? `${r.recuperacao.aceitas}/${r.recuperacao.lacunas} (${r.recuperacao.avaliacao.map((a) => a.veredito).join(', ') || '-'})` : '-',
    'modo': r.segmentacao ? `${r.segmentacao.modo}${r.segmentacao.blocos > 1 ? ` x${r.segmentacao.blocos}` : ''}` : '-',
    'tempo proc.': `${r.segundosProcessando} s`,
  })));
  const comTempo = resultados.filter((r) => !r.erro && (r.tempoPalavras || r.inicioTrechos.length));
  if (comTempo.length) {
    console.log('Tempo (cenários com gabarito de tempo)');
    console.table(comTempo.map((r) => ({
      caso: r.caso,
      'erro tempo médio': r.tempoPalavras ? fmt(r.tempoPalavras.erroMedioAbs, 2, ' s') : '-',
      'viés': r.tempoPalavras ? fmt(r.tempoPalavras.viesMedio, 2, ' s') : '-',
      'até 0,3 s': r.tempoPalavras ? fmt(r.tempoPalavras.dentroDe300ms * 100, 0, '%') : '-',
      'início trechos': r.inicioTrechos.map((x) => fmt(x.erro, 2)).join(' / ') || '-',
    })));
  }

  const pastaRes = path.join(__dirname, 'resultados');
  fs.mkdirSync(pastaRes, { recursive: true });
  const carimbo = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const sufixo = [op.rotulo, op.modelo, op.semVad && 'sem-vad', op.semRecuperacao && 'sem-recuperacao', op.recuperacaoForcada && 'rec-forcada', op.blocoMax && `bloco${op.blocoMax}`, op.fleurs && op.fleursConjunto !== 'calibracao' && op.fleursConjunto, op.coraa && 'coraa'].filter(Boolean).join('-');
  const arquivoRes = path.join(pastaRes, `${carimbo}-${sufixo}.json`);
  fs.writeFileSync(arquivoRes, JSON.stringify({
    data: new Date().toISOString(), plataforma: `${process.platform} ${process.arch}`, opcoes: op, resultados,
  }, null, 2));
  console.log(`\nDetalhes: ${path.relative(raizPropria, arquivoRes)}`);

  if (!op.manter) fs.rmSync(pastaTmp, { recursive: true, force: true });
  else console.log(`Arquivos de áudio mantidos em: ${pastaTmp}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
