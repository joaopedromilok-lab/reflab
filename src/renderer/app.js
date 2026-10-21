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
  history: [],
};

const PRESETS = [
  { id: 'h264', name: 'Edição leve', codec: 'H.264 + AAC · .mp4', desc: 'Abre em qualquer editor e no QuickTime.', tag: 'recomendado' },
  { id: 'hevc', name: 'Edição 4K', codec: 'HEVC + AAC · .mp4', desc: '4K em arquivo menor, usando o chip do Mac.' },
  { id: 'prores', name: 'Profissional', codec: 'ProRes 422 · .mov', desc: 'O mais fluido na timeline. Arquivo grande.' },
  { id: 'original', name: 'Original', codec: 'sem conversão', desc: 'Como o site entrega (pode ser AV1/VP9).' },
  { id: 'wav', name: 'Só áudio WAV', codec: 'PCM 24-bit · .wav', desc: 'Para trilha e referência sonora.' },
  { id: 'mp3', name: 'Só áudio MP3', codec: 'MP3 320k · .mp3', desc: 'Arquivo pequeno.' },
];

// ---------- navegação ----------

function showView(name) {
  $$('.nav').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') loadHistory();
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
  let hint = '';
  if (s.preset === 'h264' && (!s.maxHeight || s.maxHeight > 1080)) {
    hint = 'O YouTube só oferece H.264 até 1080p. Acima disso o vídeo será reconvertido para H.264 (mais lento). Para 4K, prefira "Edição 4K".';
  } else if (s.preset === 'prores') {
    hint = 'ProRes ocupa bastante espaço: cerca de 1 GB por minuto em 1080p e 4 GB por minuto em 4K.';
  } else if (s.preset === 'original') {
    hint = 'Sem conversão: vídeos do YouTube em 4K vêm em AV1/VP9, que o Premiere e o QuickTime não abrem bem no M1.';
  } else if (s.preset === 'hevc') {
    hint = 'HEVC abre no Premiere e no DaVinci e usa o chip do Mac para decodificar.';
  }
  $('#presetHint').textContent = hint;
  $('#outputDir').textContent = s.outputDir;
  $('#outputDir').title = s.outputDir;
  $('#projectName').classList.toggle('hidden', s.organize !== 'project');
  $('#thrLabel').textContent = `(${Math.round(((0.6 - s.sceneThreshold) / 0.5) * 100)}%)`;
  $('#minLabel').textContent = `(${Number(s.minShot).toFixed(2)}s)`;
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
  const trimStart = $('#trimStart').value.trim();
  const trimEnd = $('#trimEnd').value.trim();
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
      proxy: s.proxy,
      subtitles: s.subtitles,
      subLangs: s.subLangs,
      thumbnail: s.thumbnail,
      infoTxt: s.infoTxt,
      playlist: s.playlist,
      normalizeAudio: s.normalizeAudio,
      cookiesBrowser: s.cookiesBrowser,
      trimStart,
      trimEnd,
    });
  }
  $('#urls').value = '';
  $('#trimStart').value = '';
  $('#trimEnd').value = '';
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
    } else if (firstFile) {
      btns.push(el('button', { class: 'btn small', onclick: () => api.shell.open(firstFile) }, 'Abrir'));
      btns.push(el('button', { class: 'btn small', onclick: () => api.shell.reveal(firstFile) }, 'Mostrar na pasta'));
      if (isVideoFile(firstFile)) {
        btns.push(el('button', { class: 'btn small', onclick: () => { setStudyFile(firstFile); showView('study'); } }, 'Estudar cortes'));
      }
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
}

api.jobs.onUpdate((job) => {
  const prev = state.jobs.get(job.id);
  state.jobs.set(job.id, job);
  renderJob(job);
  if (job.status === 'done' && (!prev || prev.status !== 'done')) {
    if (job.kind === 'analyze') {
      if (state.studyFile === job.params.file) renderAnalysis(job.result);
      toast('Análise concluída.');
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
  return el('div', { class: 'chart' }, svg,
    el('div', { class: 'axis' }, el('span', {}, '0:00'), el('span', {}, 'barras baixas = cortes rápidos'), el('span', {}, fmtSecs(dur))));
}

function renderAnalysis(r) {
  if (!r) return;
  if (r.file !== state.studyFile) {
    state.studyFile = r.file;
    $('#studyFile').textContent = r.file;
    $('#studyRun').disabled = false;
  }
  const s = r.stats;
  const stat = (v, label) => el('div', { class: 'stat' }, el('b', {}, v), el('span', {}, label));
  const ex = r.exports || {};
  const box = el('div', { class: 'result' },
    el('h3', {}, `Resultado: ${basename(r.file)}`),
    el('div', { class: 'stats' },
      stat(s.shots, 'planos'),
      stat(`${s.average.toFixed(2)}s`, 'duração média do plano'),
      stat(s.cutsPerMinute.toFixed(1), 'cortes por minuto'),
      stat(`${s.median.toFixed(2)}s`, 'mediana'),
      stat(`${s.shortest.toFixed(2)}s`, 'plano mais curto'),
      stat(`${s.longest.toFixed(2)}s`, 'plano mais longo')),
    pacingChart(r),
    el('div', { class: 'export-row' },
      ex.html ? el('button', { class: 'btn primary', onclick: () => api.shell.open(ex.html) }, 'Abrir folha de contato') : null,
      ex.xml ? el('button', { class: 'btn', onclick: () => api.shell.reveal(ex.xml) }, 'XML (Premiere / DaVinci)') : null,
      ex.edl ? el('button', { class: 'btn', onclick: () => api.shell.reveal(ex.edl) }, 'EDL de marcadores (DaVinci)') : null,
      ex.csv ? el('button', { class: 'btn', onclick: () => api.shell.open(ex.csv) }, 'Lista de cortes (CSV)') : null,
      el('button', { class: 'btn', onclick: () => api.jobs.add('split', { file: r.file, title: basename(r.file) }) }, 'Dividir em planos'),
      el('button', { class: 'btn', onclick: () => api.shell.open(r.outDir) }, 'Abrir pasta da análise')),
    el('div', { class: 'howto' },
      el('p', {}, el('b', {}, 'Premiere: '), 'Arquivo > Importar > escolha o XML. Abre uma sequência já cortada em cada plano, com marcadores nos cortes.'),
      el('p', {}, el('b', {}, 'DaVinci Resolve: '), 'Arquivo > Importar > Timeline > escolha o XML. Ou, numa timeline sua com o vídeo começando em 01:00:00:00, clique com o botão direito na timeline > Importar > Marcadores da timeline de EDL.'),
      el('p', {}, el('b', {}, 'Dividir em planos: '), 'cria um arquivo .mp4 por plano na pasta "Planos", para remontar como exercício.')),
    el('div', { class: 'shots' }, r.shots.map((sh) => el('div', { class: 'shot', title: `Plano ${sh.index}` },
      sh.thumb ? el('img', { src: fileUrl(sh.thumb), loading: 'lazy', alt: '' }) : el('img', { alt: '' }),
      el('div', {}, el('b', {}, `#${sh.index}`), el('span', {}, `${clock(sh.start)} · ${sh.duration.toFixed(2)}s`))))));
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

function renderHistory() {
  const q = $('#historySearch').value.trim().toLowerCase();
  const items = state.history.filter((h) => !q || [h.title, h.uploader, h.site, h.file].join(' ').toLowerCase().includes(q));
  const list = $('#historyList');
  if (!items.length) {
    list.replaceChildren(el('p', { class: 'empty' }, q ? 'Nada encontrado.' : 'Nenhum download ainda.'));
    return;
  }
  list.replaceChildren(...items.slice(0, 300).map((h) => {
    const sub = el('div', { class: 'sub' },
      [h.uploader, h.site, new Date(h.date).toLocaleString('pt-BR'), (PRESETS.find((p) => p.id === h.preset) || {}).name].filter(Boolean).join(' · '));
    const row = el('div', { class: 'hitem' },
      h.thumbnail ? el('img', { src: h.thumbnail, alt: '', loading: 'lazy' }) : el('div', { class: 'ph' }),
      el('div', { class: 'meta' }, el('div', { class: 'title', title: h.title }, h.title || basename(h.file)), sub),
      el('div', { class: 'btns' },
        el('button', { class: 'btn small', onclick: () => api.shell.open(h.file) }, 'Abrir'),
        el('button', { class: 'btn small', onclick: () => api.shell.reveal(h.file) }, 'Pasta'),
        isVideoFile(h.file) ? el('button', { class: 'btn small', onclick: () => { setStudyFile(h.file); showView('study'); } }, 'Estudar') : null,
        h.url ? el('button', { class: 'btn small', onclick: () => api.shell.external(h.url) }, 'Link') : null,
        el('button', { class: 'btn small', onclick: async () => { await api.history.remove(h.id); loadHistory(); } }, 'Remover')));
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
  ensureTools();
})();
