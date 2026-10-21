// Fila de tarefas: downloads (yt-dlp + pós-processamento) e operações locais
// (análise, divisão em planos, conversão, proxy, frames).
const EventEmitter = require('events');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { start } = require('./proc');
const tools = require('./tools');
const media = require('./media');
const study = require('./study');
const history = require('./history');
const clips = require('./clips');
const audio = require('./audio');
const moments = require('./moments');
const transcribe = require('./transcribe');
const montage = require('./montage');
const captionsLib = require('./captions');
const decupagem = require('./decupagem');

const events = new EventEmitter();
const jobs = new Map();
let nextId = 1;
let concurrency = 2;

const KIND_LABEL = {
  download: 'Download',
  analyze: 'Análise de cortes',
  split: 'Dividir em planos',
  convert: 'Converter',
  proxy: 'Gerar proxy',
  frameAt: 'Extrair frame',
  framesEvery: 'Extrair frames',
  moments: 'Detector de momentos',
  clips: 'Recortar trechos',
  vertical: 'Versão vertical',
  transcribe: 'Transcrição',
  beats: 'Marcar batidas',
  montage: 'Gerar vídeo',
  linkTranscript: 'Transcrição do link',
  decupagem: 'Decupagem',
  silence: 'Remover silêncios',
};

function snapshot(job) {
  const { proc, ...rest } = job; // eslint-disable-line no-unused-vars
  return rest;
}

function emit(job) {
  events.emit('update', snapshot(job));
}

function patch(job, fields) {
  Object.assign(job, fields);
  emit(job);
}

function setConcurrency(n) {
  concurrency = Math.max(1, Math.min(4, Number(n) || 1));
  pump();
}

function add(kind, params) {
  const job = {
    id: nextId++,
    kind,
    kindLabel: KIND_LABEL[kind],
    params,
    status: 'queued',
    phase: 'Na fila',
    progress: 0,
    title: params.title || (params.file ? path.basename(params.file) : params.url) || '',
    thumbnail: null,
    files: [],
    log: [],
    notes: [],
    error: null,
    result: null,
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  emit(job);
  pump();
  return snapshot(job);
}

function list() {
  return [...jobs.values()].map(snapshot);
}

function cancel(id) {
  const job = jobs.get(id);
  if (!job) return;
  if (job.status === 'queued') {
    patch(job, { status: 'canceled', phase: 'Cancelado' });
  } else if (job.status === 'running') {
    job.canceled = true;
    if (job.proc) job.proc.kill();
    patch(job, { phase: 'Cancelando...' });
  }
}

function remove(id) {
  const job = jobs.get(id);
  if (!job || job.status === 'running') return;
  jobs.delete(id);
  events.emit('removed', id);
}

function clearFinished() {
  for (const job of jobs.values()) {
    if (['done', 'error', 'canceled'].includes(job.status)) {
      jobs.delete(job.id);
      events.emit('removed', job.id);
    }
  }
}

function retry(id) {
  const job = jobs.get(id);
  if (!job || job.status === 'running' || job.status === 'queued') return null;
  remove(id);
  return add(job.kind, job.params);
}

function cancelAll() {
  for (const job of jobs.values()) cancel(job.id);
}

function pump() {
  const running = [...jobs.values()].filter((j) => j.status === 'running').length;
  let slots = concurrency - running;
  for (const job of jobs.values()) {
    if (slots <= 0) break;
    if (job.status !== 'queued') continue;
    slots--;
    runJob(job);
  }
}

async function runJob(job) {
  patch(job, { status: 'running', phase: 'Iniciando...', startedAt: Date.now() });
  const ctx = {
    onStart: (p) => { job.proc = p; },
    onProgress: (p) => patch(job, { progress: p }),
  };
  try {
    const handler = HANDLERS[job.kind];
    const result = await handler(job, ctx);
    if (job.canceled) throw new Error('Cancelado');
    patch(job, { status: 'done', phase: 'Concluído', progress: 1, result: result || null, finishedAt: Date.now() });
  } catch (err) {
    if (job.canceled) patch(job, { status: 'canceled', phase: 'Cancelado' });
    else patch(job, { status: 'error', phase: 'Erro', error: friendlyError(err.message || String(err)) });
  } finally {
    job.proc = null;
    pump();
  }
}

function friendlyError(msg) {
  if (/Sign in to confirm/i.test(msg)) {
    return `${msg}\n\nDica: o YouTube pediu login. Em Ajustes, escolha um navegador em "Usar cookies do navegador" (um em que ele esteja logado no YouTube) e tente de novo.`;
  }
  if (/HTTP Error 403|Requested format is not available|nsig|signature/i.test(msg)) {
    return `${msg}\n\nDica: atualize o yt-dlp em Ajustes > Ferramentas e tente de novo.`;
  }
  if (/Unsupported URL/i.test(msg)) return `${msg}\n\nEsse link não é de um site suportado.`;
  return msg;
}

// ---------- download ----------

function cleanUrl(url) {
  try {
    const u = new URL(url.trim());
    // Mix automático do YouTube (list=RD...) não tem fim: baixa só o vídeo.
    const list = u.searchParams.get('list');
    if (list && /^RD/.test(list) && u.searchParams.get('v')) {
      u.searchParams.delete('list');
      u.searchParams.delete('index');
      u.searchParams.delete('start_radio');
      u.searchParams.delete('pp');
    }
    return u.toString();
  } catch {
    return url.trim();
  }
}

function isPlaylistUrl(url) {
  try {
    const u = new URL(url);
    return !!u.searchParams.get('list') || /\/playlist\b/.test(u.pathname);
  } catch {
    return false;
  }
}

function safeFolderName(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/%/g, '%%').trim().slice(0, 80);
}

function outputTemplate(o, playlist) {
  let folder = '';
  if (o.organize === 'date') folder = '%(epoch>%Y-%m-%d)s/';
  else if (o.organize === 'channel') folder = '%(uploader,channel|Desconhecido).80B/';
  else if (o.organize === 'project' && o.projectName) folder = `${safeFolderName(o.projectName)}/`;
  if (playlist) folder += '%(playlist_title,playlist_id|Playlist).80B/';
  let name;
  if (o.nameTemplate === 'title_id') name = '%(title).160B [%(id)s]';
  else if (o.nameTemplate === 'channel_title') name = '%(uploader,channel|Desconhecido).50B - %(title).140B';
  else name = '%(title).180B';
  if (playlist) name = `%(playlist_index|0)03d - ${name}`;
  if (o.sections) name += ' (trecho %(section_start)d-%(section_end)ds)';
  return `${folder}${name}.%(ext)s`;
}

function formatSelector(preset, maxHeight) {
  if (preset === 'wav' || preset === 'mp3') return 'ba/b';
  const h = maxHeight ? `[height<=${maxHeight}]` : '';
  const general = `bv*${h}[dynamic_range=SDR]+ba/bv*${h}+ba/b${h}/b`;
  if (preset === 'h264' && maxHeight && maxHeight <= 1080) {
    // O YouTube costuma ter H.264 (avc1) + AAC até 1080p: sem reconverter.
    return `bv*[vcodec^=avc1]${h}+ba[acodec^=mp4a]/bv*[vcodec^=avc1]${h}+ba/${general}`;
  }
  return general;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function ytdlpBaseArgs(o) {
  const args = [
    '--newline', '--no-colors', '--progress', '--no-mtime',
    '--ffmpeg-location', tools.binDir(),
    '--js-runtimes', `deno:${tools.toolPath('deno')}`,
  ];
  if (o.cookiesBrowser) args.push('--cookies-from-browser', o.cookiesBrowser);
  if (o.videoPassword) args.push('--video-password', o.videoPassword);
  return args;
}

async function handleDownload(job, ctx) {
  const o = job.params;
  const url = cleanUrl(o.url);
  const playlist = o.playlist && isPlaylistUrl(url);
  await fsp.mkdir(o.outputDir, { recursive: true });

  const args = [
    ...ytdlpBaseArgs(o),
    '--progress-template', 'download:RLP|%(progress.downloaded_bytes)s|%(progress.total_bytes)s|%(progress.total_bytes_estimate)s|%(progress.speed)s|%(progress.eta)s',
    '--print', 'before_dl:RLINFO|%(.{id,title,thumbnail,playlist_index,n_entries,playlist_count})j',
    '--print', 'after_move:RLDONE|%(.{filepath,id,title,uploader,channel,webpage_url,upload_date,duration,description,extractor_key})j',
    '-P', o.outputDir,
    '-o', outputTemplate(o, playlist),
    '-f', formatSelector(o.preset, o.maxHeight),
    '--merge-output-format', 'mp4/mkv',
    playlist ? '--yes-playlist' : '--no-playlist',
  ];
  if (playlist) args.push('--ignore-errors');
  if (o.sections) {
    for (const r of clips.parseRanges(o.sections, study.parseTime)) args.push('--download-sections', `*${r.start}-${r.end}`);
    args.push('--force-keyframes-at-cuts');
  }
  if (o.thumbnail) args.push('--write-thumbnail', '--convert-thumbnails', 'jpg');
  args.push('--', url);

  const downloaded = [];
  const errors = [];
  let lastBytes = 0;
  let part = 1;
  let current = { index: 1, count: 1 };

  patch(job, { phase: 'Verificando o link...' });
  const p = start(tools.toolPath('yt-dlp'), args, {
    onLine: (line) => {
      if (line.startsWith('RLP|')) {
        const [, d, t, te, sp, eta] = line.split('|');
        const done = num(d) || 0;
        const total = num(t) || num(te) || 0;
        if (done < lastBytes * 0.5) part++;
        lastBytes = done;
        const label = current.count > 1 ? ` (${current.index}/${current.count})` : '';
        patch(job, {
          phase: `Baixando${label}${part > 1 ? ` · parte ${part}` : ''}`,
          progress: total ? done / total : 0,
          speed: num(sp),
          eta: num(eta),
        });
      } else if (line.startsWith('RLINFO|')) {
        try {
          const info = JSON.parse(line.slice(7));
          current = { index: info.playlist_index || 1, count: info.n_entries || info.playlist_count || 1 };
          part = 1;
          lastBytes = 0;
          const fields = { phase: 'Baixando...' };
          if (!playlist || !job.thumbnail) {
            fields.thumbnail = info.thumbnail || job.thumbnail;
            if (!playlist) fields.title = info.title || job.title;
          }
          patch(job, fields);
        } catch { /* linha incompleta */ }
      } else if (line.startsWith('RLDONE|')) {
        try {
          downloaded.push(JSON.parse(line.slice(7)));
        } catch { /* ignora */ }
      } else if (/^ERROR:/.test(line)) {
        errors.push(line.replace(/^ERROR:\s*/, ''));
        job.log.push(line);
      } else if (/^WARNING:/.test(line)) {
        job.log.push(line);
      } else if (/^\[Merger\]|Merging formats/.test(line)) {
        patch(job, { phase: 'Juntando vídeo e áudio...' });
      }
    },
  });
  ctx.onStart(p);
  const r = await p.promise;
  if (job.canceled) return null;
  if (!downloaded.length) {
    const msg = errors[errors.length - 1] || r.stderr.trim().split(/\r?\n/).slice(-2).join(' ') || `yt-dlp terminou com código ${r.code}`;
    throw new Error(msg);
  }
  if (playlist && downloaded.length) patch(job, { title: `${downloaded.length} vídeo(s) da playlist` });

  // Pós-processamento de cada arquivo baixado.
  for (let i = 0; i < downloaded.length; i++) {
    if (job.canceled) return null;
    const item = downloaded[i];
    const n = downloaded.length > 1 ? ` (${i + 1}/${downloaded.length})` : '';
    let file = item.filepath;

    if (o.preset !== 'original') {
      patch(job, { phase: `Convertendo para ${media.PRESETS[o.preset].label}${n}...`, progress: 0 });
      const res = await media.convert(file, o.preset, {
        keepOriginal: o.keepOriginal, normalize: o.normalizeAudio, onProgress: ctx.onProgress, onStart: ctx.onStart,
      });
      file = res.output;
    }
    if (job.canceled) return null;

    if (o.proxy && !media.PRESETS[o.preset].audioOnly) {
      patch(job, { phase: `Gerando proxy${n}...`, progress: 0 });
      await media.makeProxy(file, { onProgress: ctx.onProgress, onStart: ctx.onStart });
    }

    if (o.subtitles && item.webpage_url) {
      patch(job, { phase: `Baixando legendas${n}...`, progress: 0 });
      await downloadSubtitles(item.webpage_url, file, o, ctx).catch((e) => {
        job.log.push(`Legendas: ${e.message}`);
        job.notes.push(/429|Too Many/.test(e.message)
          ? 'Legendas: o YouTube limitou os pedidos agora. O vídeo foi baixado normalmente.'
          : 'Legendas: nenhuma legenda disponível nesses idiomas.');
      });
    }

    if (o.infoTxt) await writeInfoTxt(item, file, o).catch(() => {});

    job.files.push(file);
    history.add({
      title: item.title,
      url: item.webpage_url || url,
      uploader: item.uploader || item.channel || '',
      site: item.extractor_key || '',
      file,
      preset: o.preset,
      thumbnail: job.thumbnail,
      duration: item.duration || null,
    });
    emit(job);
  }
  // Tarefas encadeadas: transcrever e/ou analisar depois de baixar.
  for (const [i, file] of job.files.entries()) {
    if (!/\.(mp4|mov|mkv|webm|m4v|wav|mp3|m4a)$/i.test(file)) continue;
    const item = downloaded[i] || {};
    if (o.afterTranscribe) {
      add('transcribe', { ...o.afterTranscribe, file, url: item.webpage_url || url, cookiesBrowser: o.cookiesBrowser });
    }
    if (o.afterAnalyze && !/\.(wav|mp3|m4a)$/i.test(file)) {
      add('analyze', { ...o.afterAnalyze, file });
    }
  }
  return { files: job.files };
}

async function downloadSubtitles(url, file, o, ctx) {
  const base = path.join(path.dirname(file), path.basename(file, path.extname(file))).replace(/%/g, '%%');
  const args = [
    ...ytdlpBaseArgs(o),
    '--skip-download', '--no-playlist',
    '--write-subs', '--write-auto-subs', '--sub-langs', o.subLangs || 'pt,pt-BR,en,en-US',
    '--convert-subs', 'srt',
    '-o', `${base}.%(ext)s`,
    '--', url,
  ];
  const p = start(tools.toolPath('yt-dlp'), args);
  ctx.onStart(p);
  const r = await p.promise;
  if (r.code !== 0) throw new Error(r.stderr.trim().split(/\r?\n/).pop());
}

// Informações do vídeo antes de baixar: título, duração e resoluções disponíveis.
async function fetchInfo(url, o = {}) {
  const clean = cleanUrl(url);
  const args = [...ytdlpBaseArgs(o), '-J', '--no-playlist', '--flat-playlist', '--', clean];
  const p = start(tools.toolPath('yt-dlp'), args, { keepAll: true });
  const r = await p.promise;
  if (r.code !== 0) {
    const err = r.stderr.split(/\r?\n/).filter((l) => /^ERROR:/.test(l)).pop() || r.stderr.trim().split(/\r?\n/).pop();
    throw new Error(friendlyError((err || 'Não foi possível ler o link').replace(/^ERROR:\s*/, '')));
  }
  const j = JSON.parse(r.stdout);
  if (j._type === 'playlist') {
    return { title: j.title, uploader: j.uploader || j.channel || '', isPlaylist: true, count: (j.entries || []).length };
  }
  const formats = j.formats || [];
  const size = (f) => f.filesize || f.filesize_approx || (f.tbr && j.duration ? (f.tbr * 1000 / 8) * j.duration : 0);
  const audio = formats.filter((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
    .sort((a, b) => (b.abr || b.tbr || 0) - (a.abr || a.tbr || 0))[0];
  const byHeight = new Map();
  for (const f of formats) {
    if (!f.height || !f.vcodec || f.vcodec === 'none') continue;
    const cur = byHeight.get(f.height);
    if (!cur || (f.tbr || 0) > (cur.tbr || 0)) byHeight.set(f.height, f);
  }
  const heights = [...byHeight.values()]
    .sort((a, b) => b.height - a.height)
    .map((f) => ({
      height: f.height,
      width: f.width,
      fps: f.fps || null,
      vcodec: String(f.vcodec).split('.')[0],
      dynamicRange: f.dynamic_range || 'SDR',
      size: size(f) + (f.acodec === 'none' && audio ? size(audio) : 0),
    }));
  return {
    title: j.title,
    uploader: j.uploader || j.channel || '',
    duration: j.duration || 0,
    thumbnail: j.thumbnail,
    site: j.extractor_key,
    isPlaylist: false,
    heights,
    audioSize: audio ? size(audio) : 0,
  };
}

async function writeInfoTxt(item, file, o) {
  const date = item.upload_date ? `${item.upload_date.slice(6, 8)}/${item.upload_date.slice(4, 6)}/${item.upload_date.slice(0, 4)}` : '-';
  const dur = item.duration ? `${Math.floor(item.duration / 60)}:${String(Math.round(item.duration % 60)).padStart(2, '0')}` : '-';
  const lines = [
    `Título: ${item.title || '-'}`,
    `Autor/canal: ${item.uploader || item.channel || '-'}`,
    `Link: ${item.webpage_url || '-'}`,
    `Site: ${item.extractor_key || '-'}`,
    `Publicado em: ${date}`,
    `Duração: ${dur}`,
    `Baixado em: ${new Date().toLocaleString('pt-BR')}`,
    `Formato: ${media.PRESETS[o.preset].label}`,
    '',
    'Descrição:',
    item.description || '-',
  ];
  const out = path.join(path.dirname(file), `${path.basename(file, path.extname(file))} - info.txt`);
  await fsp.writeFile(out, lines.join('\n'), 'utf8');
}

// ---------- operações locais ----------

const HANDLERS = {
  download: handleDownload,

  async analyze(job, ctx) {
    patch(job, { phase: 'Detectando cortes...' });
    const r = await study.analyze(job.params.file, { ...job.params, ...ctx });
    patch(job, { phase: 'Gerando arquivos...' });
    return r;
  },

  async split(job, ctx) {
    const analysis = await study.loadAnalysis(job.params.file);
    if (!analysis) throw new Error('Analise o vídeo antes de dividir em planos.');
    patch(job, { phase: `Dividindo em ${analysis.shots.length} planos...` });
    const dir = await study.splitShots(job.params.file, analysis.shots, ctx);
    job.files.push(dir);
    return { dir };
  },

  async convert(job, ctx) {
    patch(job, { phase: `Convertendo para ${media.PRESETS[job.params.preset].label}...` });
    const r = await media.convert(job.params.file, job.params.preset, { keepOriginal: true, normalize: job.params.normalizeAudio, ...ctx });
    job.files.push(r.output);
    if (!r.converted) patch(job, { phase: 'Já estava nesse formato' });
    return r;
  },

  async proxy(job, ctx) {
    patch(job, { phase: 'Gerando proxy ProRes...' });
    const out = await media.makeProxy(job.params.file, ctx);
    job.files.push(out);
    return { output: out };
  },

  async frameAt(job, ctx) {
    patch(job, { phase: `Extraindo frame em ${job.params.time}...` });
    const out = await study.frameAt(job.params.file, job.params.time, ctx);
    job.files.push(out);
    return { output: out };
  },

  async moments(job, ctx) {
    patch(job, { phase: 'Ouvindo o áudio e procurando momentos...' });
    const r = await moments.detect(job.params.file, { ...job.params, ...ctx });
    patch(job, { phase: `${r.moments.length} momento(s) encontrado(s)` });
    return r;
  },

  async clips(job, ctx) {
    const ranges = Array.isArray(job.params.ranges) ? job.params.ranges : clips.parseRanges(job.params.text, study.parseTime);
    patch(job, { phase: `Recortando ${ranges.length} trecho(s)...` });
    const r = await clips.cutClips(job.params.file, ranges, {
      mode: job.params.mode, vertical: job.params.vertical, ...ctx, onClip: (f) => job.files.push(f),
    });
    job.files = [r.outDir];
    return r;
  },

  async vertical(job, ctx) {
    patch(job, { phase: 'Gerando versão vertical 9:16...' });
    const out = await clips.makeVertical(job.params.file, { style: job.params.style, ...ctx });
    job.files.push(out);
    return { output: out };
  },

  async transcribe(job, ctx) {
    const o = job.params;
    const r = await transcribe.transcribe(o.file, {
      language: o.language, model: o.model, prompt: o.prompt, translate: o.translate, vad: o.vad !== false,
      url: o.url, useYoutubeSubs: o.useYoutubeSubs, ytdlpArgs: ytdlpBaseArgs(o), ...ctx,
      onPhase: (phase) => patch(job, { phase, progress: 0 }),
    });
    job.files.push(r.srt);
    const via = r.source === 'whisper' ? '' : ` (${r.source})`;
    patch(job, { phase: `${r.segments.length} trechos transcritos${via}` });
    return r;
  },

  async linkTranscript(job, ctx) {
    const o = job.params;
    patch(job, { phase: 'Lendo o link...' });
    const info = await fetchInfo(o.url, o);
    if (info.isPlaylist) throw new Error('Esse link é de uma playlist. Use o link de um vídeo só.');
    patch(job, { title: info.title, thumbnail: info.thumbnail || null });
    const r = await transcribe.transcribeLink(cleanUrl(o.url), info, {
      baseDir: o.outputDir, language: o.language, model: o.model, prompt: o.prompt, vad: o.vad !== false,
      useYoutubeSubs: o.useYoutubeSubs, ytdlpArgs: ytdlpBaseArgs(o), ...ctx,
      onPhase: (phase) => patch(job, { phase, progress: 0 }),
    });
    job.files.push(r.txt);
    const via = r.source === 'whisper' ? ' (áudio temporário apagado)' : ` (${r.source}, nada baixado)`;
    patch(job, { phase: `${r.segments.length} trechos transcritos${via}` });
    return r;
  },

  async montage(job, ctx) {
    const o = job.params;
    let words = [];
    if (o.withCaptions) {
      const t = await transcribe.load(o.file);
      if (!t) throw new Error('Transcreva o vídeo antes de gerar com legenda.');
      words = captionsLib.allWords(t.segments);
    }
    patch(job, { phase: o.withCaptions ? 'Montando o vídeo com legenda...' : 'Montando o vídeo...' });
    const r = await montage.render(o.file, o.ranges, {
      format: o.format || o.vertical, withCaptions: o.withCaptions, words, style: o.style, logo: o.logo,
      title: o.outputTitle, outDir: o.outDir, ...ctx,
    });
    job.files.push(r.output);
    return r;
  },

  async decupagem(job, ctx) {
    const o = job.params;
    if (!(await study.loadAnalysis(o.file))) {
      patch(job, { phase: 'Analisando os cortes (1/3)...' });
      await study.analyze(o.file, { threshold: o.threshold, minShot: o.minShot, ...ctx });
    }
    if (!(await transcribe.load(o.file))) {
      await transcribe.transcribe(o.file, {
        language: o.language, model: o.model, prompt: o.prompt, vad: o.vad !== false, ...ctx,
        onPhase: (phase) => patch(job, { phase: `${phase} (2/3)`, progress: 0 }),
      });
    }
    patch(job, { phase: 'Montando a decupagem (3/3)...' });
    const r = await decupagem.build(o.file);
    job.files.push(r.html);
    return r;
  },

  async silence(job, ctx) {
    const o = job.params;
    const r = await montage.removeSilence(o.file, {
      noise: o.noise, minSilence: o.minSilence, renderVideo: o.renderVideo, ...ctx,
      onPhase: (phase) => patch(job, { phase, progress: 0 }),
    });
    job.files.push(r.output || r.xml);
    patch(job, { phase: `${Math.round(r.removed)}s de silêncio removidos (${r.cuts} trechos)` });
    return r;
  },

  async beats(job, ctx) {
    patch(job, { phase: 'Ouvindo a música e marcando as batidas...' });
    const info = await media.probe(job.params.file);
    if (!info.hasAudio) throw new Error('O arquivo não tem áudio.');
    const b = await audio.detectBeats(job.params.file, { duration: info.duration, ...ctx });
    if (!b.beats.length || b.confidence < audio.MIN_BEAT_CONFIDENCE) {
      throw new Error('Não encontrei uma batida marcada nesse áudio (pode ser fala, trilha orquestral ou som ambiente).');
    }
    const name = path.basename(job.params.file, path.extname(job.params.file));
    const marks = b.beats.map((t, i) => ({ t, name: `Batida ${i + 1}` }));
    const dir = path.dirname(job.params.file);
    const xml = await study.writeMarkersXml(job.params.file, info, `${name} - ${b.bpm} BPM`, marks,
      path.join(dir, `${name} - Batidas ${Math.round(b.bpm)} BPM (Premiere e DaVinci).xml`));
    const edl = await study.writeMarkersEdl(name, info.fps, marks, path.join(dir, `${name} - Batidas (DaVinci).edl`), 'Green');
    job.files.push(xml);
    patch(job, { phase: `${b.bpm} BPM · ${b.beats.length} batidas marcadas` });
    return { bpm: b.bpm, count: b.beats.length, xml, edl };
  },

  async framesEvery(job, ctx) {
    patch(job, { phase: `Extraindo um frame a cada ${job.params.seconds}s...` });
    const dir = await study.framesEvery(job.params.file, job.params.seconds, ctx);
    job.files.push(dir);
    return { dir };
  },
};

module.exports = {
  events, add, list, cancel, remove, retry, clearFinished, cancelAll, setConcurrency, cleanUrl, fetchInfo,
};
