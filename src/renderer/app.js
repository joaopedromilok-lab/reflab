/* global api */
'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// Cria elementos sem innerHTML (títulos vêm da internet).
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function fileUrl(p) {
  if (!p) return '';
  let s = p.replace(/\\/g, '/');
  if (!s.startsWith('/')) s = `/${s}`;
  return `file://${encodeURI(s).replace(/#/g, '%23').replace(/\?/g, '%3F')}`;
}

function basename(p) {
  return String(p || '').split(/[\\/]/).pop();
}

function fmtSecs(s) {
  if (s === null || s === undefined || !Number.isFinite(s)) return '';
  s = Math.round(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function clock(t) {
  const m = Math.floor(t / 60);
  return `${m}:${(t - m * 60).toFixed(2).padStart(5, '0')}`;
}

function fmtSpeed(b) {
  if (!b) return '';
  if (b > 1048576) return `${(b / 1048576).toFixed(1)} MB/s`;
  return `${(b / 1024).toFixed(0)} KB/s`;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${isErr ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 4000);
}

const state = {
  settings: {},
  jobs: new Map(),
  studyFile: null,
  toolsFile: null,
  momentsFile: null,
  transcriptFile: null,
  transcript: null,
  moments: null,
  history: [],
  tagFilter: null,
  editingId: null,
  editors: [],
};

const PRESETS = [
  { id: 'h264', name: 'H.264', codec: 'MP4 · mais compatível', desc: 'Boa escolha para a maioria dos editores.', tag: 'recomendado' },
  { id: 'hevc', name: 'HEVC / H.265', codec: 'MP4 · arquivo menor', desc: 'Bom para 4K em Macs recentes.' },
  { id: 'prores', name: 'ProRes 422', codec: 'MOV · edição fluida', desc: 'Mais fácil de editar; ocupa mais espaço.' },
  { id: 'original', name: 'Original', codec: 'sem conversão', desc: 'Mais rápido, mas pode não abrir no editor.' },
  { id: 'wav', name: 'Áudio WAV', codec: 'sem perda · arquivo maior', desc: 'Para editar música e voz com qualidade.' },
  { id: 'mp3', name: 'Áudio MP3', codec: 'arquivo menor', desc: 'Para ouvir ou compartilhar.' },
];

// ---------- navegação ----------

function showView(name) {
  $$('.nav').forEach((b) => {
    const active = b.dataset.view === name;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') loadHistory();
  if (name === 'transcript') loadModels();
  if (name === 'settings') loadVersions();
}
$$('.nav').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

// ---------- ajustes ligados aos campos ----------

async function saveSetting(partial) {
  state.settings = await api.settings.set(partial);
}

function bindField(id, key, { type = 'value', transform = (v) => v } = {}) {
  const node = $(`#${id}`);
  const value = state.settings[key];
  if (type === 'checked') node.checked = !!value;
  else node.value = value ?? '';
  node.addEventListener('change', () => {
    const v = type === 'checked' ? node.checked : transform(node.value);
    saveSetting({ [key]: v }).then(updateHints);
  });
}

function renderPresets() {
  const box = $('#presets');
  box.replaceChildren(...PRESETS.map((p) => el('button', {
    class: `preset${state.settings.preset === p.id ? ' active' : ''}`,
    type: 'button',
    'aria-pressed': state.settings.preset === p.id,
    onclick: async () => {
      const patch = { preset: p.id };
      if (p.id === 'h264' && (!state.settings.maxHeight || state.settings.maxHeight > 1080)) patch.maxHeight = 1080;
      if ((p.id === 'hevc' || p.id === 'prores') && state.settings.maxHeight === 1080) patch.maxHeight = 2160;
      await saveSetting(patch);
      $('#maxHeight').value = String(state.settings.maxHeight || 0);
      renderPresets();
      updateHints();
    },
  }, el('b', {}, p.name, p.tag ? el('span', { class: 'tag' }, p.tag) : null), el('span', {}, p.codec), el('br'), el('span', {}, p.desc))));
}

function updateHints() {
  const s = state.settings;
  const isAudio = ['wav', 'mp3'].includes(s.preset);
  const hints = {
    h264: 'Mais compatível. Se escolher 4K, a conversão pode levar mais tempo.',
    hevc: 'Gera arquivos menores em 4K. Se o editor não abrir, tente H.264.',
    prores: 'Bom para timelines pesadas. Os arquivos ocupam bastante espaço.',
    original: 'Sem conversão. Mais rápido, mas o editor pode não aceitar o formato de origem.',
    wav: 'Áudio sem perda, indicado para editar música e voz.',
    mp3: 'Áudio menor para ouvir ou compartilhar.',
  };
  const hint = hints[s.preset] || '';
  $('#presetHint').textContent = hint;
  $('#presetHint').classList.toggle('hidden', !hint);
  $('#resolutionField').classList.toggle('hidden', isAudio);
  $('#audioPresetNote').classList.toggle('hidden', !isAudio);
  $('#sectionsHint').textContent = isAudio
    ? 'Os tempos são aplicados à música ou ao áudio do vídeo.'
    : 'Separe vários trechos por vírgula. Cada um vira um arquivo.';
  for (const id of ['proxyOption', 'subtitlesOption', 'thumbnailOption']) {
    $(`#${id}`).classList.toggle('hidden', isAudio);
  }
  $('#normalizeAudioOption').classList.toggle('hidden', !isAudio);
  $('#outputDir').textContent = s.outputDir;
  $('#outputDir').title = s.outputDir;
  $('#outputFolderName').textContent = basename(s.outputDir) || 'Pasta de downloads';
  $('#outputFolderName').title = s.outputDir;
  $('#projectName').classList.toggle('hidden', s.organize !== 'project');
  $('#thrLabel').textContent = `(${Math.round(((0.6 - s.sceneThreshold) / 0.5) * 100)}%)`;
  $('#minLabel').textContent = `(${Number(s.minShot).toFixed(2)}s)`;
  $('#momSensLabel').textContent = `(${Math.round(((16 - s.momentSensitivity) / 12) * 100)}%)`;
}

function updateActivitySummary() {
  const jobs = [...state.jobs.values()];
  const active = jobs.filter((job) => job.status === 'running' || job.status === 'queued');
  const downloads = active.filter((job) => job.kind === 'download');
  $('#activityCount').textContent = `${active.length} ${active.length === 1 ? 'ativa' : 'ativas'}`;
  $('#activityCount').classList.toggle('busy', active.length > 0);
  $('#downloadQueueDot').classList.toggle('busy', downloads.length > 0);
  const running = downloads.filter((job) => job.status === 'running').length;
  const queued = downloads.length - running;
  if (downloads.length) {
    const parts = [];
    if (running) parts.push(`${running} baixando`);
    if (queued) parts.push(`${queued} aguardando`);
    $('#downloadQueueCount').textContent = `Na fila: ${parts.join(' · ')}.`;
  } else if (jobs.some((job) => job.kind === 'download' && job.status === 'done')) {
    $('#downloadQueueCount').textContent = 'Downloads concluídos. Não há itens aguardando.';
  } else {
    $('#downloadQueueCount').textContent = 'Sua fila está vazia. Os downloads aparecerão aqui.';
  }
}

async function initSettings() {
  state.settings = await api.settings.get();
  renderPresets();
  bindField('maxHeight', 'maxHeight', { transform: Number });
  bindField('organize', 'organize');
  bindField('projectName', 'projectName');
  bindField('nameTemplate', 'nameTemplate');
  for (const k of ['proxy', 'subtitles', 'thumbnail', 'infoTxt', 'playlist', 'keepOriginal', 'normalizeAudio', 'autoUpdate']) {
    bindField(k, k, { type: 'checked' });
  }
  bindField('concurrency', 'concurrency', { transform: Number });
  bindField('cookiesBrowser', 'cookiesBrowser');
  bindField('subLangs', 'subLangs', { transform: (v) => v.trim() || 'pt,pt-BR,en,en-US' });
  bindField('momentMax', 'momentMax', { transform: Number });
  bindField('momentBefore', 'momentBefore', { transform: (v) => Math.max(0, Number(v) || 0) });
  bindField('momentAfter', 'momentAfter', { transform: (v) => Math.max(0, Number(v) || 0) });
  bindField('clipMode', 'clipMode');
  bindField('transcribeLanguage', 'transcribeLanguage');
  const sens = $('#momentSensitivity');
  sens.value = String(20 - state.settings.momentSensitivity);
  sens.addEventListener('input', () => { state.settings.momentSensitivity = 20 - Number(sens.value); updateHints(); });
  sens.addEventListener('change', () => saveSetting({ momentSensitivity: state.settings.momentSensitivity }));
  // Sensibilidade: o slider mostra "mais sensível" à direita (limiar menor).
  const thr = $('#sceneThreshold');
  thr.value = String(0.7 - state.settings.sceneThreshold);
  thr.addEventListener('input', () => { state.settings.sceneThreshold = Number((0.7 - thr.value).toFixed(2)); updateHints(); });
  thr.addEventListener('change', () => saveSetting({ sceneThreshold: state.settings.sceneThreshold }));
  const min = $('#minShot');
  min.value = String(state.settings.minShot);
  min.addEventListener('input', () => { state.settings.minShot = Number(min.value); updateHints(); });
  min.addEventListener('change', () => saveSetting({ minShot: state.settings.minShot }));
  updateHints();

  $('#pickOutput').addEventListener('click', async () => {
    const dir = await api.dialog.folder(state.settings.outputDir);
    if (dir) { await saveSetting({ outputDir: dir }); updateHints(); }
  });
  $('#openOutput').addEventListener('click', async () => {
    const error = await api.shell.open(state.settings.outputDir);
    if (error) toast(`Não foi possível abrir a pasta: ${error}`, true);
  });
}

// ---------- ferramentas (primeira execução) ----------

async function ensureTools() {
  const st = await api.tools.status();
  updateToolsBadge(st);
  if (st.ready) return true;
  $('#setup').classList.remove('hidden');
  $('#setupRetry').classList.add('hidden');
  try {
    const after = await api.tools.install(false);
    updateToolsBadge(after);
    $('#setup').classList.add('hidden');
    toast('Ferramentas prontas!');
    return true;
  } catch (err) {
    $('#setupMsg').textContent = `Erro: ${err.message}. Verifique a internet e tente de novo.`;
    $('#setupRetry').classList.remove('hidden');
    return false;
  }
}

function updateToolsBadge(st) {
  const b = $('#toolsBadge');
  b.textContent = st.ready ? 'Ferramentas prontas' : 'Ferramentas pendentes';
  b.className = `sidebar-foot ${st.ready ? 'ok' : 'bad'}`;
}

api.tools.onProgress((p) => {
  $('#setupMsg').textContent = p.message || '';
  if (p.done) { $('#setupBar').style.width = '100%'; return; }
  const overall = ((p.index || 0) + (p.progress || 0)) / (p.count || 1);
  $('#setupBar').style.width = `${Math.round(overall * 100)}%`;
});
api.tools.onAutoUpdated((r) => {
  if (r.ok && /Updated yt-dlp to/i.test(r.output)) toast('yt-dlp atualizado automaticamente.');
});
$('#setupRetry').addEventListener('click', ensureTools);

async function loadVersions() {
  const v = await api.tools.versions();
  $('#toolVersions').textContent = Object.entries(v).map(([k, val]) => `${k}: ${val}`).join('\n');
  const info = await api.appInfo();
  if (!updateChecked) $('#updateStatus').textContent = `Versão instalada: ${info.version}`;
  $('#aboutLine').textContent = `RefLab ${info.version} · ${info.platform} ${info.arch}`;
}

$('#updateYtdlp').addEventListener('click', async (e) => {
  e.target.disabled = true;
  const out = $('#toolOutput');
  out.classList.remove('hidden');
  out.textContent = 'Atualizando...';
  const r = await api.tools.updateYtDlp();
  out.textContent = r.output || (r.ok ? 'OK' : 'Falhou');
  e.target.disabled = false;
  loadVersions();
});

$('#reinstallTools').addEventListener('click', async (e) => {
  e.target.disabled = true;
  $('#setup').classList.remove('hidden');
  try {
    await api.tools.install(true);
    toast('Ferramentas reinstaladas.');
  } catch (err) {
    toast(`Erro: ${err.message}`, true);
  }
  $('#setup').classList.add('hidden');
  e.target.disabled = false;
  loadVersions();
});

// ---------- downloads ----------

$('#startDownload').addEventListener('click', async () => {
  const urls = $('#urls').value.split(/\s+/).map((u) => u.trim()).filter((u) => /^https?:\/\//i.test(u));
  if (!urls.length) { toast('Cole pelo menos um link (começando com http).', true); return; }
  if (!(await ensureTools())) return;
  const s = state.settings;
  if (s.organize === 'project' && !s.projectName.trim()) { toast('Digite o nome do projeto.', true); return; }
  const sections = $('#sections').value.trim();
  const videoPassword = $('#videoPassword').value;
  const audioOnly = ['wav', 'mp3'].includes(s.preset);
  if (sections && !/^[\d:.,\s;\-–a]+$/i.test(sections)) { toast('Trechos inválidos. Use o formato 1:20-1:45, 3:00-3:30', true); return; }
  for (const url of urls) {
    await api.jobs.add('download', {
      url,
      preset: s.preset,
      maxHeight: s.maxHeight || 0,
      outputDir: s.outputDir,
      organize: s.organize,
      projectName: s.projectName,
      nameTemplate: s.nameTemplate,
      keepOriginal: s.keepOriginal,
      proxy: audioOnly ? false : s.proxy,
      subtitles: audioOnly ? false : s.subtitles,
      subLangs: s.subLangs,
      thumbnail: audioOnly ? false : s.thumbnail,
      infoTxt: s.infoTxt,
      playlist: s.playlist,
      normalizeAudio: audioOnly ? s.normalizeAudio : false,
      cookiesBrowser: s.cookiesBrowser,
      sections,
      videoPassword,
    });
  }
  $('#urls').value = '';
  $('#sections').value = '';
  $('#videoPassword').value = '';
  $('#urlInfo').replaceChildren();
  toast(urls.length > 1 ? `${urls.length} links adicionados à fila.` : 'Adicionado à fila.');
});

// ---------- atividades ----------

function isVideoFile(p) {
  return /\.(mp4|mov|mkv|webm|m4v|avi)$/i.test(p || '');
}

function jobCard(job) {
  const pct = Math.round((job.progress || 0) * 100);
  const extra = job.status === 'running'
    ? [job.speed ? fmtSpeed(job.speed) : '', job.eta ? `faltam ${fmtSecs(job.eta)}` : '', pct ? `${pct}%` : ''].filter(Boolean).join(' · ')
    : '';
  const firstFile = job.files && job.files[0];
  const btns = [];
  if (job.status === 'running' || job.status === 'queued') {
    btns.push(el('button', { class: 'btn small', onclick: () => api.jobs.cancel(job.id) }, 'Cancelar'));
  }
  if (job.status === 'done') {
    if (job.kind === 'analyze') {
      btns.push(el('button', { class: 'btn small', onclick: () => { showView('study'); renderAnalysis(job.result); } }, 'Ver análise'));
    } else if (job.kind === 'moments') {
      btns.push(el('button', { class: 'btn small', onclick: () => { showView('moments'); renderMoments(job.result); } }, 'Ver momentos'));
    } else if (job.kind === 'transcribe') {
      btns.push(el('button', { class: 'btn small', onclick: () => { showView('transcript'); renderTranscript(job.result); } }, 'Ver transcrição'));
    } else if (firstFile) {
      btns.push(el('button', { class: 'btn small', onclick: () => api.shell.open(firstFile) }, 'Abrir'));
      btns.push(el('button', { class: 'btn small', onclick: () => api.shell.reveal(firstFile) }, 'Mostrar na pasta'));
      if (isVideoFile(firstFile)) {
        btns.push(el('button', { class: 'btn small', onclick: () => { setStudyFile(firstFile); showView('study'); } }, 'Estudar cortes'));
        if (job.kind === 'download') {
          btns.push(el('button', { class: 'btn small', onclick: () => { setMomentsFile(firstFile); showView('moments'); } }, 'Momentos'));
        }
      }
      if (/\.(mp4|mov|xml)$/i.test(firstFile)) btns.push(...editorButtons(firstFile, true));
    }
  }
  if (job.status === 'error' || job.status === 'canceled') {
    btns.push(el('button', { class: 'btn small', onclick: () => api.jobs.retry(job.id) }, 'Tentar de novo'));
  }
  if (job.status !== 'running') {
    btns.push(el('button', { class: 'btn small', onclick: () => api.jobs.remove(job.id) }, 'Remover'));
  }
  return el('div', { class: `job ${job.status}`, 'data-id': job.id },
    el('div', { class: `job-top${job.thumbnail ? '' : ' nothumb'}` },
      job.thumbnail ? el('img', { src: job.thumbnail, alt: '' }) : null,
      el('div', {},
        el('div', { class: 'kind' }, job.kindLabel),
        el('div', { class: 'title', title: job.title }, job.title || job.params.url || ''))),
    el('div', { class: 'phase' }, el('span', {}, job.phase), el('span', {}, extra)),
    job.status === 'running' || job.status === 'queued' || job.status === 'done'
      ? el('div', { class: 'bar' }, el('div', { style: `width:${job.status === 'done' ? 100 : pct}%` }))
      : null,
    job.error ? el('div', { class: 'err' }, job.error) : null,
    (job.notes || []).map((n) => el('div', { class: 'note' }, n)),
    btns.length ? el('div', { class: 'btns' }, btns) : null);
}

function renderJob(job) {
  const list = $('#jobList');
  const empty = list.querySelector('.empty');
  if (empty) empty.remove();
  const old = list.querySelector(`.job[data-id="${job.id}"]`);
  const card = jobCard(job);
  if (old) old.replaceWith(card);
  else list.prepend(card);
  updateActivitySummary();
}

api.jobs.onUpdate((job) => {
  const prev = state.jobs.get(job.id);
  state.jobs.set(job.id, job);
  renderJob(job);
  if (job.status === 'done' && (!prev || prev.status !== 'done')) {
    if (job.kind === 'analyze') {
      if (state.studyFile === job.params.file) renderAnalysis(job.result);
      toast('Análise concluída.');
    } else if (job.kind === 'moments') {
      if (state.momentsFile === job.params.file) renderMoments(job.result);
      toast('Momentos encontrados.');
    } else if (job.kind === 'transcribe') {
      if (state.transcriptFile === job.params.file) renderTranscript(job.result);
      loadModels();
      toast('Transcrição concluída.');
    } else if (job.kind === 'download') {
      toast(`Concluído: ${job.title}`);
    } else {
      toast(`${job.kindLabel}: concluído.`);
    }
  }
  if (job.status === 'error' && (!prev || prev.status !== 'error')) toast(`${job.kindLabel}: erro.`, true);
});

api.jobs.onRemoved((id) => {
  state.jobs.delete(id);
  const node = $(`#jobList .job[data-id="${id}"]`);
  if (node) node.remove();
  if (!state.jobs.size) $('#jobList').replaceChildren(el('p', { class: 'empty' }, 'Nada por aqui ainda.'));
  updateActivitySummary();
});

$('#clearFinished').addEventListener('click', () => api.jobs.clearFinished());

// ---------- arrastar e soltar ----------

function setupDrop(zoneId, onFile) {
  const zone = $(`#${zoneId}`);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const f = e.dataTransfer.files[0];
    if (f) onFile(api.pathForFile(f));
  });
}
// Impede que soltar um arquivo fora da área abra o arquivo na janela.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- estudar ----------

async function setStudyFile(file) {
  state.studyFile = file;
  $('#studyFile').textContent = file;
  $('#studyRun').disabled = false;
  $('#studyResult').replaceChildren();
  const existing = await api.study.load(file);
  if (existing) renderAnalysis(existing);
}

setupDrop('studyDrop', setStudyFile);
$('#studyPick').addEventListener('click', async () => {
  const f = await api.dialog.video();
  if (f) setStudyFile(f);
});

$('#studyRun').addEventListener('click', async () => {
  if (!state.studyFile || !(await ensureTools())) return;
  await api.jobs.add('analyze', {
    file: state.studyFile,
    threshold: state.settings.sceneThreshold,
    minShot: state.settings.minShot,
  });
  $('#studyResult').replaceChildren(el('p', { class: 'muted result' }, 'Analisando... acompanhe em Atividades, à direita.'));
});

function pacingChart(r) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 1000;
  const H = 130;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const max = Math.max(...r.shots.map((s) => s.duration), 1);
  const dur = r.info.duration || 1;
  r.shots.forEach((s, i) => {
    const rect = document.createElementNS(NS, 'rect');
    const bh = Math.max(2, (Math.sqrt(s.duration) / Math.sqrt(max)) * (H - 6));
    rect.setAttribute('x', ((s.start / dur) * W).toFixed(2));
    rect.setAttribute('width', Math.max(1, (s.duration / dur) * W - 1).toFixed(2));
    rect.setAttribute('y', (H - bh).toFixed(2));
    rect.setAttribute('height', bh.toFixed(2));
    rect.setAttribute('fill', i % 2 ? '#e5484d' : '#ff7a59');
    const title = document.createElementNS(NS, 'title');
    title.textContent = `Plano ${s.index} · ${clock(s.start)} · ${s.duration.toFixed(2)}s`;
    rect.append(title);
    svg.append(rect);
  });
  if (r.beats && r.beats.beats) {
    for (const b of r.beats.beats) {
      const line = document.createElementNS(NS, 'rect');
      line.setAttribute('x', ((b / dur) * W).toFixed(2));
      line.setAttribute('y', '0');
      line.setAttribute('width', '0.8');
      line.setAttribute('height', '8');
      line.setAttribute('fill', '#3ecf8e');
      svg.append(line);
    }
  }
  return el('div', { class: 'chart' }, svg,
    el('div', { class: 'axis' }, el('span', {}, '0:00'),
      el('span', {}, r.beats && r.beats.beats && r.beats.beats.length ? 'barras baixas = cortes rápidos · traços verdes = batidas' : 'barras baixas = cortes rápidos'),
      el('span', {}, fmtSecs(dur))));
}

function swatches(colors, cls = 'swatches') {
  return el('div', { class: cls }, (colors || []).map((c) => {
    const color = typeof c === 'string' ? c : c.color;
    return el('span', { style: `background:${color}`, title: color });
  }));
}

function renderAnalysis(r) {
  if (!r) return;
  if (r.file !== state.studyFile) {
    state.studyFile = r.file;
    $('#studyFile').textContent = r.file;
    $('#studyRun').disabled = false;
  }
  state.analysis = r;
  const s = r.stats;
  const stat = (v, label) => el('div', { class: 'stat' }, el('b', {}, v), el('span', {}, label));
  const ex = r.exports || {};
  const favs = new Set(r.favorites || []);
  // Um salvamento por vez, sempre com a lista mais recente.
  let saving = Promise.resolve();
  const saveFavs = () => {
    saving = saving.then(() => api.study.update(r.file, { favorites: [...favs] })).then((u) => { r.favorites = u.favorites; }).catch(() => {});
  };
  const favButton = () => el('button', {
    class: 'btn',
    onclick: () => {
      const shots = r.shots.filter((sh) => favs.has(sh.index));
      if (!shots.length) { toast('Marque planos com ★ primeiro.', true); return; }
      api.jobs.add('clips', {
        file: r.file, title: `${shots.length} plano(s) favorito(s)`, mode: state.settings.clipMode,
        ranges: shots.map((sh) => ({ start: sh.start, end: sh.end, name: `plano ${sh.index}` })),
      });
      toast('Recortando os favoritos...');
    },
  }, 'Recortar favoritos ★');

  const box = el('div', { class: 'result' },
    el('h3', {}, `Resultado: ${basename(r.file)}`),
    el('div', { class: 'stats' },
      stat(s.shots, 'planos'),
      stat(`${s.average.toFixed(2)}s`, 'duração média do plano'),
      stat(s.cutsPerMinute.toFixed(1), 'cortes por minuto'),
      stat(`${s.median.toFixed(2)}s`, 'mediana'),
      stat(`${s.shortest.toFixed(2)}s`, 'plano mais curto'),
      stat(`${s.longest.toFixed(2)}s`, 'plano mais longo'),
      s.bpm ? stat(`${s.bpm}`, 'BPM da música') : null,
      s.bpm && s.cuts ? stat(`${Math.round((s.cutsOnBeatRatio || 0) * 100)}%`, `dos cortes na batida (${s.cutsOnBeat} de ${s.cuts})`) : null),
    pacingChart(r),
    r.palette && r.palette.length ? el('div', { class: 'palette-row' }, el('span', { class: 'muted' }, 'Paleta geral'), swatches(r.palette, 'swatches big')) : null,
    el('div', { class: 'export-row' },
      ex.html ? el('button', { class: 'btn primary', onclick: () => api.shell.open(ex.html) }, 'Abrir folha de contato') : null,
      ex.xml ? el('button', { class: 'btn', onclick: () => api.shell.reveal(ex.xml) }, 'XML (Premiere / DaVinci)') : null,
      ...(ex.xml ? editorButtons(ex.xml, false) : []),
      ex.edl ? el('button', { class: 'btn', onclick: () => api.shell.reveal(ex.edl) }, 'EDL de marcadores (DaVinci)') : null,
      ex.beatsXml ? el('button', { class: 'btn', onclick: () => api.shell.reveal(ex.beatsXml) }, 'Marcadores das batidas') : null,
      ex.csv ? el('button', { class: 'btn', onclick: () => api.shell.open(ex.csv) }, 'Lista de cortes (CSV)') : null,
      el('button', { class: 'btn', onclick: () => api.jobs.add('split', { file: r.file, title: basename(r.file) }) }, 'Dividir em planos'),
      favButton(),
      el('button', { class: 'btn', onclick: () => api.shell.open(r.outDir) }, 'Abrir pasta da análise')),
    el('div', { class: 'howto' },
      el('p', {}, el('b', {}, 'Premiere: '), 'Arquivo > Importar > escolha o XML. Abre uma sequência já cortada em cada plano, com marcadores nos cortes.'),
      el('p', {}, el('b', {}, 'DaVinci Resolve: '), 'Arquivo > Importar > Timeline > escolha o XML. Ou, numa timeline sua com o vídeo começando em 01:00:00:00, clique com o botão direito na timeline > Importar > Marcadores da timeline de EDL.'),
      el('p', {}, el('b', {}, 'Favoritos: '), 'clique na ★ dos planos que você quer guardar e use "Recortar favoritos" para gerar um clipe de cada.')),
    el('div', { class: 'shots' }, r.shots.map((sh) => {
      const star = el('button', {
        class: `star${favs.has(sh.index) ? ' on' : ''}`,
        title: 'Favorito',
        onclick: () => {
          if (favs.has(sh.index)) favs.delete(sh.index); else favs.add(sh.index);
          star.classList.toggle('on', favs.has(sh.index));
          saveFavs();
        },
      }, '★');
      return el('div', { class: 'shot', title: `Plano ${sh.index}` },
        el('div', { class: 'thumb' }, sh.thumb ? el('img', { src: fileUrl(sh.thumb), loading: 'lazy', alt: '' }) : el('img', { alt: '' }), star),
        sh.palette ? swatches(sh.palette) : null,
        el('div', { class: 'cap' }, el('b', {}, `#${sh.index}`), el('span', {}, `${clock(sh.start)} · ${sh.duration.toFixed(2)}s`)));
    })));
  $('#studyResult').replaceChildren(box);
}

// ---------- ferramentas locais ----------

function setToolsFile(file) {
  state.toolsFile = file;
  $('#toolsFile').textContent = file;
}
setupDrop('toolsDrop', setToolsFile);
$('#toolsPick').addEventListener('click', async () => {
  const f = await api.dialog.video();
  if (f) setToolsFile(f);
});

async function toolJob(kind, params) {
  if (!state.toolsFile) { toast('Escolha um vídeo primeiro.', true); return; }
  if (!(await ensureTools())) return;
  await api.jobs.add(kind, { file: state.toolsFile, title: basename(state.toolsFile), ...params });
  toast('Adicionado às atividades.');
}

$('#convertRun').addEventListener('click', () => toolJob('convert', { preset: $('#convertPreset').value, normalizeAudio: state.settings.normalizeAudio }));
$('#proxyRun').addEventListener('click', () => toolJob('proxy', {}));
$('#frameRun').addEventListener('click', () => {
  const t = $('#frameTime').value.trim();
  if (!t) { toast('Digite o tempo do frame (ex.: 1:23).', true); return; }
  toolJob('frameAt', { time: t });
});
$('#framesRun').addEventListener('click', () => {
  const n = $('#frameEvery').value.trim();
  if (!(Number(n.replace(',', '.')) > 0)) { toast('Digite um intervalo em segundos (ex.: 2).', true); return; }
  toolJob('framesEvery', { seconds: n });
});

// ---------- histórico ----------

async function loadHistory() {
  state.history = await api.history.list();
  renderHistory();
}

function renderTagFilter() {
  const tags = [...new Set(state.history.flatMap((h) => h.tags || []))].sort((a, b) => a.localeCompare(b));
  const box = $('#tagFilter');
  if (!tags.length) { box.replaceChildren(); return; }
  box.replaceChildren(
    el('button', { class: `tag-chip${state.tagFilter ? '' : ' on'}`, onclick: () => { state.tagFilter = null; renderHistory(); } }, 'Todas'),
    ...tags.map((t) => el('button', {
      class: `tag-chip${state.tagFilter === t ? ' on' : ''}`,
      onclick: () => { state.tagFilter = state.tagFilter === t ? null : t; renderHistory(); },
    }, t)));
}

function historyEditor(h) {
  const tags = el('input', { value: (h.tags || []).join(', '), placeholder: 'etiquetas separadas por vírgula (ex.: entrada da noiva, drone, gol)' });
  const notes = el('textarea', { rows: '3', placeholder: 'anotações: o que chamou atenção nessa referência?' });
  notes.value = h.notes || '';
  return el('div', { class: 'heditor' }, tags, notes,
    el('div', { class: 'row' },
      el('button', {
        class: 'btn primary small',
        onclick: async () => {
          await api.history.update(h.id, { tags: tags.value.split(',').map((t) => t.trim()).filter(Boolean), notes: notes.value });
          state.editingId = null;
          loadHistory();
        },
      }, 'Salvar'),
      el('button', { class: 'btn small', onclick: () => { state.editingId = null; renderHistory(); } }, 'Cancelar')));
}

function renderHistory() {
  renderTagFilter();
  const q = $('#historySearch').value.trim().toLowerCase();
  const items = state.history.filter((h) =>
    (!state.tagFilter || (h.tags || []).includes(state.tagFilter))
    && (!q || [h.title, h.uploader, h.site, h.file, (h.tags || []).join(' '), h.notes].join(' ').toLowerCase().includes(q)));
  const list = $('#historyList');
  if (!items.length) {
    list.replaceChildren(el('p', { class: 'empty' }, q || state.tagFilter ? 'Nada encontrado.' : 'Nenhum download ainda.'));
    return;
  }
  list.replaceChildren(...items.slice(0, 300).map((h) => {
    const sub = el('div', { class: 'sub' },
      [h.uploader, h.site, new Date(h.date).toLocaleString('pt-BR'), (PRESETS.find((p) => p.id === h.preset) || {}).name].filter(Boolean).join(' · '));
    const row = el('div', { class: 'hitem' },
      h.thumbnail ? el('img', { src: h.thumbnail, alt: '', loading: 'lazy' }) : el('div', { class: 'ph' }),
      el('div', { class: 'meta' },
        el('div', { class: 'title', title: h.title }, h.title || basename(h.file)),
        sub,
        (h.tags || []).length ? el('div', { class: 'tags' }, h.tags.map((t) => el('span', { class: 'tag-chip small' }, t))) : null,
        h.notes ? el('div', { class: 'note-text' }, h.notes) : null),
      el('div', { class: 'btns' },
        el('button', { class: 'btn small', onclick: () => api.shell.open(h.file) }, 'Abrir'),
        el('button', { class: 'btn small', onclick: () => api.shell.reveal(h.file) }, 'Pasta'),
        isVideoFile(h.file) ? el('button', { class: 'btn small', onclick: () => { setStudyFile(h.file); showView('study'); } }, 'Estudar') : null,
        el('button', { class: 'btn small', onclick: () => { state.editingId = state.editingId === h.id ? null : h.id; renderHistory(); } }, 'Etiquetas e notas'),
        h.url ? el('button', { class: 'btn small', onclick: () => api.shell.external(h.url) }, 'Link') : null,
        el('button', { class: 'btn small', onclick: async () => { await api.history.remove(h.id); loadHistory(); } }, 'Remover')),
      state.editingId === h.id ? historyEditor(h) : null);
    api.fs.exists(h.file).then((ok) => {
      if (!ok) sub.prepend(el('span', { class: 'missing' }, 'arquivo não encontrado · '));
    });
    return row;
  }));
}

$('#historySearch').addEventListener('input', renderHistory);
$('#historyClear').addEventListener('click', async () => {
  if (!confirm('Limpar todo o histórico? Os arquivos baixados não serão apagados.')) return;
  await api.history.clear();
  loadHistory();
});

// ---------- editores (Premiere / DaVinci) ----------

function editorButtons(file, small) {
  const cls = small ? 'btn small' : 'btn';
  return state.editors.map((ed) => el('button', {
    class: cls,
    title: ed.id === 'resolve' ? 'O DaVinci abre, e você importa o arquivo por dentro dele (Arquivo > Importar).' : '',
    onclick: async () => {
      try {
        await api.editors.open(ed.id, file);
        if (ed.id === 'resolve') { api.shell.reveal(file); toast('Abrindo o DaVinci. Importe o arquivo por Arquivo > Importar.'); }
      } catch (err) { toast(err.message, true); }
    },
  }, ed.id === 'premiere' ? 'Abrir no Premiere' : 'Abrir DaVinci'));
}

// ---------- link copiado ----------

let lastClip = '';
async function checkClipboard() {
  let text = '';
  try { text = (await api.clipboard.read()).trim(); } catch { return; }
  if (!/^https?:\/\/\S+$/i.test(text) || text === lastClip) return;
  if ($('#urls').value.includes(text)) return;
  lastClip = text;
  $('#clipUrl').textContent = text.length > 70 ? `${text.slice(0, 70)}...` : text;
  $('#clipBanner').classList.remove('hidden');
}
$('#clipUse').addEventListener('click', () => {
  const cur = $('#urls').value.trim();
  $('#urls').value = cur ? `${cur}\n${lastClip}` : lastClip;
  $('#clipBanner').classList.add('hidden');
  showView('download');
});
$('#clipIgnore').addEventListener('click', () => $('#clipBanner').classList.add('hidden'));
window.addEventListener('focus', checkClipboard);

// ---------- informações antes de baixar ----------

const MBPS = {
  h264: { 2160: 45, 1440: 24, 1080: 12, 720: 6, 480: 3, 360: 1.5, 240: 0.8, 144: 0.4 },
  hevc: { 2160: 45, 1440: 25, 1080: 14, 720: 8, 480: 8, 360: 8, 240: 8, 144: 8 },
};
function estimateMB(preset, row, duration) {
  if (!duration) return null;
  const h = row.height;
  const key = [2160, 1440, 1080, 720, 480, 360, 240, 144].find((k) => h >= k) || 144;
  // Quando o vídeo já vem no codec certo, o RefLab não reconverte.
  const copied = preset === 'original'
    || (preset === 'h264' && /^avc/.test(row.vcodec))
    || (preset === 'hevc' && /^(hev|hvc)/.test(row.vcodec));
  if (copied) return row.size ? row.size / 1048576 : null;
  let mbps;
  if (preset === 'prores') mbps = 147 * ((h * (h * 16 / 9)) / (1920 * 1080)) * ((row.fps || 30) / 30) + 2.3;
  else if (preset === 'wav') mbps = 2.3;
  else if (preset === 'mp3') mbps = 0.32;
  else mbps = MBPS[preset][key] + 0.32;
  return (mbps * duration) / 8;
}

function fmtMB(mb) {
  if (mb === null || mb === undefined || !Number.isFinite(mb)) return '?';
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.max(1, Math.round(mb))} MB`;
}

$('#infoBtn').addEventListener('click', async () => {
  const url = $('#urls').value.split(/\s+/).find((u) => /^https?:\/\//i.test(u));
  if (!url) { toast('Cole um link primeiro.', true); return; }
  if (!(await ensureTools())) return;
  const box = $('#urlInfo');
  box.replaceChildren(el('p', { class: 'muted info-box' }, 'Lendo informações do vídeo...'));
  try {
    const info = await api.urlInfo(url);
    if (info.isPlaylist) {
      box.replaceChildren(el('div', { class: 'info-box' }, el('b', {}, info.title), el('p', { class: 'muted' }, `Playlist com ${info.count} vídeos. Marque "baixar a playlist inteira" em Extras.`)));
      return;
    }
    const preset = state.settings.preset;
    const label = (PRESETS.find((p) => p.id === preset) || {}).name;
    const rows = info.heights.filter((x, i, a) => a.findIndex((y) => y.height === x.height) === i).map((x) => el('tr', {},
      el('td', {}, `${x.height}p`),
      el('td', {}, x.fps ? `${x.fps} fps` : '-'),
      el('td', {}, `${x.vcodec}${x.dynamicRange && x.dynamicRange !== 'SDR' ? ` · ${x.dynamicRange}` : ''}`),
      el('td', {}, x.size ? fmtMB(x.size / 1048576) : '?'),
      el('td', {}, fmtMB(estimateMB(preset, x, info.duration)))));
    box.replaceChildren(el('div', { class: 'info-box' },
      el('div', { class: 'info-head' },
        info.thumbnail ? el('img', { src: info.thumbnail, alt: '' }) : null,
        el('div', {}, el('b', {}, info.title), el('div', { class: 'muted' }, [info.uploader, info.site, fmtSecs(info.duration)].filter(Boolean).join(' · ')))),
      el('table', { class: 'info-table' },
        el('tr', {}, el('th', {}, 'Resolução'), el('th', {}, 'Quadros'), el('th', {}, 'Codec no site'), el('th', {}, 'Download'), el('th', {}, `Arquivo final (${label})`)),
        rows),
      el('p', { class: 'hint' }, 'Tamanho final é uma estimativa. Codec no site: avc1 = H.264, vp9/vp09 = VP9, av01 = AV1. Mude o formato acima e clique de novo para ver outra estimativa.')));
  } catch (err) {
    box.replaceChildren(el('p', { class: 'err-text info-box' }, err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')));
  }
});

// ---------- momentos e clipes ----------

async function setMomentsFile(file) {
  state.momentsFile = file;
  $('#momentsFile').textContent = file;
  $('#momentsResult').replaceChildren();
  const existing = await api.moments.load(file);
  if (existing) renderMoments(existing);
}
setupDrop('momentsDrop', setMomentsFile);
$('#momentsPick').addEventListener('click', async () => {
  const f = await api.dialog.video();
  if (f) setMomentsFile(f);
});

$('#momentsRun').addEventListener('click', async () => {
  if (!state.momentsFile) { toast('Escolha um vídeo primeiro.', true); return; }
  if (!(await ensureTools())) return;
  const s = state.settings;
  await api.jobs.add('moments', {
    file: state.momentsFile, title: basename(state.momentsFile),
    sensitivity: s.momentSensitivity, before: s.momentBefore, after: s.momentAfter, max: s.momentMax,
  });
  $('#momentsResult').replaceChildren(el('p', { class: 'muted result' }, 'Ouvindo o áudio... acompanhe em Atividades, à direita.'));
});

$('#clipsRun').addEventListener('click', async () => {
  if (!state.momentsFile) { toast('Escolha um vídeo primeiro.', true); return; }
  const text = $('#clipRanges').value.trim();
  if (!text) { toast('Digite pelo menos um trecho (ex.: 12:30-12:50).', true); return; }
  if (!(await ensureTools())) return;
  await api.jobs.add('clips', {
    file: state.momentsFile, title: basename(state.momentsFile), text,
    mode: $('#clipMode').value, vertical: $('#clipVertical').value,
  });
  toast('Recortando... acompanhe em Atividades.');
});

function loudnessChart(r) {
  const NS = 'http://www.w3.org/2000/svg';
  const W = 1000;
  const H = 120;
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  const curve = r.curve || [];
  const min = Math.min(...curve);
  const max = Math.max(...curve);
  const y = (v) => H - ((v - min) / (max - min || 1)) * (H - 10) - 2;
  const pts = curve.map((v, i) => `${((i / Math.max(1, curve.length - 1)) * W).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const poly = document.createElementNS(NS, 'polyline');
  poly.setAttribute('points', pts);
  poly.setAttribute('fill', 'none');
  poly.setAttribute('stroke', '#6b6b75');
  poly.setAttribute('stroke-width', '1.2');
  svg.append(poly);
  for (const m of r.moments) {
    const rect = document.createElementNS(NS, 'rect');
    rect.setAttribute('x', ((m.start / r.duration) * W).toFixed(1));
    rect.setAttribute('width', Math.max(2, ((m.end - m.start) / r.duration) * W).toFixed(1));
    rect.setAttribute('y', '0');
    rect.setAttribute('height', String(H));
    rect.setAttribute('fill', 'rgba(255,90,78,0.25)');
    const t = document.createElementNS(NS, 'title');
    t.textContent = `Momento ${m.index} · ${clock(m.peak)}`;
    rect.append(t);
    svg.append(rect);
  }
  return el('div', { class: 'chart' }, svg,
    el('div', { class: 'axis' }, el('span', {}, '0:00'), el('span', {}, 'linha = volume · faixas vermelhas = momentos (com o tempo antes/depois)'), el('span', {}, fmtSecs(r.duration))));
}

function renderMoments(r) {
  if (!r) return;
  state.moments = r;
  if (r.file !== state.momentsFile) {
    state.momentsFile = r.file;
    $('#momentsFile').textContent = r.file;
  }
  const ex = r.exports || {};
  const checks = new Map();
  const list = r.moments.map((m) => {
    const cb = el('input', { type: 'checkbox', checked: true });
    checks.set(m.index, cb);
    return el('label', { class: 'moment' }, cb,
      el('b', {}, `#${m.index}`),
      el('span', { class: 'mono' }, clock(m.peak)),
      el('span', { class: 'muted' }, `clipe ${clock(m.start)} → ${clock(m.end)}`),
      el('span', { class: 'meter' }, el('span', { style: `width:${Math.round(m.intensity * 100)}%` })));
  });
  const selected = () => r.moments.filter((m) => checks.get(m.index).checked);
  const vertical = el('select', { style: 'width:auto' },
    el('option', { value: '' }, 'Formato original'),
    el('option', { value: 'blur' }, 'Vertical com fundo desfocado'),
    el('option', { value: 'crop' }, 'Vertical cortando o centro'));
  const box = el('div', { class: 'result' },
    el('h3', {}, r.moments.length ? `${r.moments.length} momento(s) em ${basename(r.file)}` : 'Nenhum momento encontrado. Tente aumentar a sensibilidade.'),
    loudnessChart(r),
    r.moments.length ? el('div', { class: 'moments' }, list) : null,
    r.moments.length ? el('div', { class: 'export-row' },
      el('button', {
        class: 'btn primary',
        onclick: () => {
          const sel = selected();
          if (!sel.length) { toast('Selecione pelo menos um momento.', true); return; }
          api.jobs.add('clips', {
            file: r.file, title: `${sel.length} momento(s) de ${basename(r.file)}`, mode: state.settings.clipMode, vertical: vertical.value,
            ranges: sel.map((m) => ({ start: m.start, end: m.end, name: `momento ${m.index}` })),
          });
          toast('Recortando os momentos...');
        },
      }, 'Recortar selecionados'),
      vertical,
      ex.xml ? el('button', { class: 'btn', onclick: () => api.shell.reveal(ex.xml) }, 'Marcadores XML (Premiere / DaVinci)') : null,
      ...(ex.xml ? editorButtons(ex.xml, false) : []),
      ex.edl ? el('button', { class: 'btn', onclick: () => api.shell.reveal(ex.edl) }, 'EDL (DaVinci)') : null,
      ex.csv ? el('button', { class: 'btn', onclick: () => api.shell.open(ex.csv) }, 'Lista (CSV)') : null,
      el('button', {
        class: 'btn',
        onclick: () => {
          $('#clipRanges').value = selected().map((m) => `${clock(m.start)}-${clock(m.end)}`).join('\n');
          toast('Trechos copiados para "Recortar trechos", abaixo. Ajuste e clique em Recortar.');
        },
      }, 'Editar trechos manualmente')) : null);
  $('#momentsResult').replaceChildren(box);
}

// ---------- transcrição ----------

async function loadModels() {
  const models = await api.transcript.models();
  const sel = $('#transcribeModel');
  sel.replaceChildren(...models.map((m) => el('option', { value: m.id }, `${m.label}${m.installed ? ' · baixado' : ''}`)));
  sel.value = state.settings.transcribeModel;
}
$('#transcribeModel').addEventListener('change', (e) => saveSetting({ transcribeModel: e.target.value }));

async function setTranscriptFile(file) {
  state.transcriptFile = file;
  $('#transcriptFile').textContent = file;
  $('#transcriptRun').disabled = false;
  $('#transcriptResult').replaceChildren();
  const existing = await api.transcript.load(file);
  if (existing) renderTranscript(existing);
}
setupDrop('transcriptDrop', setTranscriptFile);
$('#transcriptPick').addEventListener('click', async () => {
  const f = await api.dialog.video();
  if (f) setTranscriptFile(f);
});

$('#transcriptRun').addEventListener('click', async () => {
  if (!state.transcriptFile || !(await ensureTools())) return;
  await api.jobs.add('transcribe', {
    file: state.transcriptFile, title: basename(state.transcriptFile),
    language: $('#transcribeLanguage').value, model: $('#transcribeModel').value,
  });
  $('#transcriptResult').replaceChildren(el('p', { class: 'muted result' }, 'Transcrevendo... acompanhe em Atividades. Na primeira vez o modelo é baixado.'));
});

function normalize(t) {
  return t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function renderTranscript(r) {
  if (!r) return;
  state.transcript = r;
  if (r.file !== state.transcriptFile) {
    state.transcriptFile = r.file;
    $('#transcriptFile').textContent = r.file;
    $('#transcriptRun').disabled = false;
  }
  const search = el('input', { placeholder: 'Buscar uma palavra ou frase (ex.: prometo, gol, obrigado)' });
  const count = el('span', { class: 'muted' });
  const list = el('div', { class: 'segments' });
  let hits = r.segments;

  const highlight = (text, q) => {
    if (!q) return [text];
    const nt = normalize(text);
    const out = [];
    let i = 0;
    let j;
    while ((j = nt.indexOf(q, i)) >= 0) {
      out.push(text.slice(i, j), el('mark', {}, text.slice(j, j + q.length)));
      i = j + q.length;
    }
    out.push(text.slice(i));
    return out;
  };
  const draw = () => {
    const q = normalize(search.value.trim());
    hits = q ? r.segments.filter((sg) => normalize(sg.text).includes(q)) : r.segments;
    count.textContent = q ? `${hits.length} trecho(s) encontrado(s)` : `${r.segments.length} trechos`;
    list.replaceChildren(...hits.slice(0, 1000).map((sg) => el('div', { class: 'segment' },
      el('span', { class: 'mono' }, clock(sg.start)),
      el('span', {}, highlight(sg.text, q)))));
  };
  search.addEventListener('input', draw);

  const box = el('div', { class: 'result' },
    el('h3', {}, `Transcrição: ${basename(r.file)}`),
    el('div', { class: 'row' }, search),
    el('div', { class: 'export-row' },
      count,
      el('button', {
        class: 'btn',
        onclick: async () => {
          const q = search.value.trim();
          if (!q) { toast('Busque uma palavra primeiro.', true); return; }
          if (!hits.length) { toast('Nada encontrado para exportar.', true); return; }
          try {
            const res = await api.transcript.exportHits(r.file, q, hits.map((h) => ({ start: h.start, end: h.end, text: h.text })));
            api.shell.reveal(res.xml);
            toast('Marcadores da busca exportados (XML e EDL).');
          } catch (err) {
            toast(`Erro ao exportar: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`, true);
          }
        },
      }, 'Exportar marcadores da busca'),
      el('button', {
        class: 'btn',
        onclick: () => {
          if (!search.value.trim() || !hits.length) { toast('Busque algo primeiro: os trechos encontrados viram clipes.', true); return; }
          api.jobs.add('clips', {
            file: r.file, title: `"${search.value.trim()}" em ${basename(r.file)}`, mode: state.settings.clipMode,
            ranges: hits.map((h, i) => ({ start: Math.max(0, h.start - 1), end: h.end + 1, name: `fala ${i + 1}` })),
          });
          toast('Recortando os trechos encontrados...');
        },
      }, 'Recortar trechos encontrados'),
      el('button', { class: 'btn', onclick: () => api.shell.open(r.txt) }, 'Texto completo'),
      el('button', { class: 'btn', onclick: () => api.shell.reveal(r.srt) }, 'Legenda .srt')),
    list);
  draw();
  $('#transcriptResult').replaceChildren(box);
}

// ---------- ferramentas novas ----------

$('#verticalRun').addEventListener('click', () => toolJob('vertical', { style: $('#verticalStyle').value }));
$('#beatsRun').addEventListener('click', () => toolJob('beats', {}));

// ---------- atualização do RefLab ----------

let updateInfo = null;
let updateChecked = false;

function showUpdate(info) {
  updateInfo = info;
  updateChecked = true;
  $('#updateBox').classList.remove('hidden');
  $('#updateBoxVersion').textContent = `Versão ${info.latest} (você tem a ${info.current})`;
  $('#updateStatus').textContent = `Nova versão ${info.latest} disponível. Você tem a ${info.current}.`;
  $('#updateInstall').classList.remove('hidden');
  if (info.notes) {
    $('#updateNotes').textContent = info.notes;
    $('#updateNotes').classList.remove('hidden');
  }
}

async function checkUpdate() {
  updateChecked = true;
  $('#updateStatus').textContent = 'Buscando atualização...';
  try {
    const info = await api.update.check();
    if (info.available) showUpdate(info);
    else $('#updateStatus').textContent = info.message || `Você já está na versão mais recente (${info.current}).`;
  } catch (err) {
    $('#updateStatus').textContent = `Não foi possível verificar: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
  }
}

async function installUpdate() {
  const running = [...state.jobs.values()].some((j) => j.status === 'running' || j.status === 'queued');
  if (running && !confirm('Há tarefas em andamento. Elas serão canceladas para atualizar. Continuar?')) return;
  showView('settings');
  $('#updateInstall').disabled = true;
  $('#updateBoxBtn').disabled = true;
  $('#updateBarWrap').classList.remove('hidden');
  $('#updateStatus').textContent = 'Baixando a nova versão... o RefLab vai fechar e reabrir sozinho.';
  try {
    await api.update.install();
    $('#updateStatus').textContent = 'Instalando... o RefLab vai reabrir em alguns segundos.';
  } catch (err) {
    $('#updateStatus').textContent = `Erro ao atualizar: ${err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}`;
    $('#updateInstall').disabled = false;
    $('#updateBoxBtn').disabled = false;
  }
}

api.update.onAvailable(showUpdate);
api.update.onProgress((p) => { $('#updateBar').style.width = `${Math.round(p * 100)}%`; });
$('#updateCheck').addEventListener('click', checkUpdate);
$('#updateInstall').addEventListener('click', installUpdate);
$('#updateBoxBtn').addEventListener('click', installUpdate);

// ---------- início ----------

(async function init() {
  await initSettings();
  for (const job of await api.jobs.list()) {
    state.jobs.set(job.id, job);
    renderJob(job);
  }
  updateActivitySummary();
  ensureTools();
  state.editors = await api.editors.list().catch(() => []);
  checkClipboard();
})();
