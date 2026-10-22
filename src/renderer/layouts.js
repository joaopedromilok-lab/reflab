/* global api, $, $$, el, state, showView, saveSetting, toast, basename, fileUrl, fmtSecs, clock,
   setStudyFile, setMomentsFile, setTranscriptFile, setToolsFile, jobCard, renderHistory, loadHistory,
   ensureTools, transcribeOptions, PRESETS, isVideoFile */
'use strict';

// Layouts em teste (só nesta versão):
//  classic = o atual
//  a       = arrumação: opções resumidas, avançado escondido, dicas em ⓘ, atividades em gaveta
//  b       = centrado no vídeo: Início + página do vídeo com abas (inclui tudo da A)

const VIDEO_VIEWS = ['video', 'study', 'moments', 'transcript', 'tools'];
const VIDEO_TABS = [
  ['video', 'Resumo'],
  ['study', 'Cortes'],
  ['moments', 'Momentos'],
  ['transcript', 'Transcrição'],
  ['tools', 'Ferramentas'],
];

function layoutMode() {
  return ['a', 'b'].includes(state.settings.layout) ? state.settings.layout : 'classic';
}

// ---------- preparação do HTML (uma vez) ----------

// Explicações viram um ⓘ com a dica ao passar o mouse.
function prepareHints() {
  const hints = [...$$('.view .hint'), ...$$('#view-tools .card > p'), ...$$('#view-moments .card > p')];
  for (const h of hints) {
    if (h.classList.contains('static-hint') || !h.textContent.trim()) continue;
    h.classList.add('static-hint');
    const field = h.closest('.field');
    const target = (field && field.querySelector('label')) || h.previousElementSibling;
    if (!target) continue;
    const tip = el('span', { class: 'info-tip', title: h.textContent.trim(), tabindex: '0' }, 'i');
    target.append(' ', tip);
  }
}

// Ajustes finos ficam dentro de "Ajustes avançados".
function wrapAdvanced(container, label) {
  if (!container || container.parentElement.classList.contains('advanced')) return;
  const det = el('details', { class: 'advanced' }, el('summary', {}, label));
  container.replaceWith(det);
  det.append(container);
}

function prepareAdvanced() {
  wrapAdvanced($('#view-study .grid2'), 'Ajustes avançados da detecção');
  wrapAdvanced($('#view-moments .grid2'), 'Ajustes avançados do detector');
  // Opções da transcrição (idioma, qualidade, nomes, música) num bloco só.
  const v = $('#view-transcript');
  const first = v.querySelector(':scope > .grid2');
  const last = $('#transcriptRun').closest('.actions');
  if (first && last && !first.closest('.tr-options')) {
    const det = el('details', { class: 'advanced tr-options' }, el('summary', {}, 'Opções de transcrição'));
    first.before(det);
    let n = first;
    while (n) {
      const next = n.nextElementSibling;
      det.append(n);
      if (n === last) break;
      n = next;
    }
  }
}

// Quando já existe resultado, ele fica em primeiro plano e as opções recolhidas.
function refreshResultState() {
  const pairs = [['#view-study', '#studyResult'], ['#view-moments', '#momentsResult'], ['#view-transcript', '#transcriptResult']];
  for (const [view, result] of pairs) {
    const has = !!$(`${result} .result`) && !!$(`${result} .result h3`);
    $(view).classList.toggle('has-result', has);
  }
  const tr = $('.tr-options');
  if (tr && layoutMode() !== 'classic') tr.open = !$('#view-transcript').classList.contains('has-result');
}

// ---------- aplicar o layout ----------

function applyLayout() {
  const mode = layoutMode();
  const body = document.body;
  body.classList.toggle('compact', mode !== 'classic');
  body.classList.toggle('layout-a', mode === 'a');
  body.classList.toggle('layout-b', mode === 'b');
  body.classList.remove('dl-expanded');
  for (const d of $$('details.advanced')) d.open = mode === 'classic';
  if (mode === 'classic') closeActivity();
  updateDownloadSummary();
  updateActivityToggle();
  const current = ($('.view.active') || {}).id || '';
  if (mode === 'b' && !['view-home', 'view-history', 'view-compare', 'view-settings'].includes(current) && !state.currentVideo) {
    showView('home');
  } else if (mode !== 'b' && ['view-home', 'view-video'].includes(current)) {
    showView('download');
  } else {
    updateVideoMode(current.replace('view-', ''));
  }
}

$('#layoutMode').addEventListener('change', async (e) => {
  await saveSetting({ layout: e.target.value });
  applyLayout();
  toast(e.target.value === 'classic' ? 'Layout atual.' : `Layout ${e.target.value.toUpperCase()} ativado.`);
});

// ---------- gaveta de atividades ----------

function openActivity() {
  if (layoutMode() !== 'classic') document.body.classList.add('activity-open');
}
function closeActivity() {
  document.body.classList.remove('activity-open');
}
$('#activityToggle').addEventListener('click', () => document.body.classList.toggle('activity-open'));
$('#activityClose').addEventListener('click', closeActivity);

function updateActivityToggle() {
  const jobs = [...state.jobs.values()];
  const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued').length;
  const done = jobs.filter((j) => j.status === 'done').length;
  $('#activityToggleText').textContent = active ? `${active} em andamento` : done ? `Atividades (${done} prontas)` : 'Atividades';
  $('#activityDot').classList.toggle('busy', active > 0);
}

const seenJobs = new Set();
api.jobs.onUpdate((job) => {
  if (!seenJobs.has(job.id)) {
    seenJobs.add(job.id);
    if (job.status === 'queued' || job.status === 'running') openActivity();
  }
  updateActivityToggle();
  if (job.status === 'done') setTimeout(refreshResultState, 400);
  if (state.currentVideo && job.params && job.params.file === state.currentVideo && job.status === 'done') {
    if ($('#view-video').classList.contains('active')) renderVideoSummary();
  }
});
api.jobs.onRemoved(() => updateActivityToggle());

// ---------- resumo das opções de download ----------

function downloadSummaryText() {
  const s = state.settings;
  const preset = (PRESETS.find((p) => p.id === s.preset) || {}).name || s.preset;
  const audio = ['wav', 'mp3'].includes(s.preset);
  const res = audio ? '' : s.maxHeight ? `${s.maxHeight}p` : 'resolução máxima';
  const folder = basename(s.outputDir) || s.outputDir;
  const extras = [s.afterTranscribe && 'transcrever depois', s.afterAnalyze && 'analisar cortes depois', s.proxy && !audio && 'proxy']
    .filter(Boolean);
  return [preset, res, `pasta ${folder}`, ...extras].filter(Boolean).join(' · ');
}

function updateDownloadSummary() {
  const box = $('#dlSummary');
  if (!box) return;
  const expanded = document.body.classList.contains('dl-expanded');
  box.replaceChildren(
    el('div', { class: 'dl-summary-text' }, el('span', { class: 'muted' }, 'Vai baixar como '), el('b', {}, downloadSummaryText())),
    el('button', {
      class: 'btn small',
      type: 'button',
      onclick: () => { document.body.classList.toggle('dl-expanded'); updateDownloadSummary(); },
    }, expanded ? 'Esconder opções' : 'Alterar'));
}
for (const id of ['maxHeight', 'organize', 'afterTranscribe', 'afterAnalyze', 'proxy']) {
  const n = $(`#${id}`);
  if (n) n.addEventListener('change', () => setTimeout(updateDownloadSummary, 50));
}
$('#presets').addEventListener('click', () => setTimeout(updateDownloadSummary, 80));
$('#pickOutput').addEventListener('click', () => setTimeout(updateDownloadSummary, 1500));

// ---------- página do vídeo (layout B) ----------

async function videoMeta(file) {
  const hist = (await api.history.list()).find((h) => h.file === file);
  const analysis = await api.study.load(file);
  const transcript = await api.transcript.load(file);
  const moments = await api.moments.load(file);
  const thumb = (hist && hist.thumbnail) || (analysis && analysis.shots[0] && analysis.shots[0].thumb && fileUrl(analysis.shots[0].thumb)) || null;
  return { hist, analysis, transcript, moments, thumb, title: (hist && hist.title) || basename(file).replace(/\.[^.]+$/, '') };
}

async function openVideo(file, view = 'video') {
  state.currentVideo = file;
  await Promise.all([setStudyFile(file), setMomentsFile(file), setTranscriptFile(file)]);
  setToolsFile(file);
  showView(view);
}

// Aba que combina com o que foi pedido no download.
function viewForJob(job) {
  const p = job.params || {};
  if (p.afterTranscribe) return 'transcript';
  if (p.afterAnalyze) return 'study';
  if (p.afterMoments) return 'moments';
  return 'video';
}

async function renderVideoBar(active) {
  const bar = $('#videoBar');
  const file = state.currentVideo;
  if (!file) { bar.replaceChildren(); return; }
  const meta = await videoMeta(file);
  if (state.currentVideo !== file) return;
  bar.replaceChildren(
    el('div', { class: 'vb-top' },
      el('button', { class: 'link vb-back', type: 'button', onclick: () => showView('home') }, '← Início'),
      meta.thumb ? el('img', { src: meta.thumb, alt: '' }) : el('div', { class: 'vb-ph' }),
      el('div', { class: 'vb-title' }, el('b', { title: meta.title }, meta.title), el('span', { class: 'muted', title: file }, file)),
      el('div', { class: 'vb-actions' },
        el('button', { class: 'btn small', type: 'button', onclick: () => api.shell.open(file) }, 'Abrir'),
        el('button', { class: 'btn small', type: 'button', onclick: () => api.shell.reveal(file) }, 'Pasta'))),
    el('div', { class: 'vb-tabs' }, VIDEO_TABS.map(([view, label]) => el('button', {
      class: `vb-tab${view === active ? ' on' : ''}`,
      type: 'button',
      onclick: () => showView(view),
    }, label))));
}

async function renderVideoSummary() {
  const file = state.currentVideo;
  const box = $('#videoSummary');
  if (!file) { box.replaceChildren(); return; }
  const m = await videoMeta(file);
  const isVideo = isVideoFile(file);
  const card = (title, status, done, primary, secondary) => el('div', { class: `vcard${done ? ' done' : ''}` },
    el('div', { class: 'vcard-head' }, el('span', { class: 'vcard-dot' }), el('h3', {}, title)),
    el('p', {}, status),
    el('div', { class: 'row' }, primary, secondary));
  const go = (view, label, onShown) => el('button', {
    class: 'btn small', type: 'button', onclick: () => { showView(view); if (onShown) setTimeout(onShown, 80); },
  }, label);
  const run = (label, fn) => el('button', { class: 'btn small primary', type: 'button', onclick: async () => { if (await ensureTools()) fn(); } }, label);

  const a = m.analysis;
  const t = m.transcript;
  const mo = m.moments;
  box.replaceChildren(
    el('div', { class: 'vcards' },
      card('Cortes da edição',
        a ? `${a.stats.shots} planos · ${a.stats.average.toFixed(1)}s em média · ${a.stats.cutsPerMinute.toFixed(1)} cortes/min${a.stats.bpm ? ` · ${a.stats.bpm} BPM` : ''}` : 'Ainda não analisado. Detecta cada corte, o ritmo e a música.',
        !!a,
        a ? go('study', 'Ver cortes') : (isVideo ? run('Analisar cortes', () => { showView('study'); $('#studyRun').click(); }) : null),
        null),
      card('Transcrição e roteiro',
        t ? `${t.metrics ? Math.round(t.metrics.wpm) : '-'} palavras/min · ${t.metrics ? Math.round(t.metrics.speechRatio * 100) : '-'}% com fala · ${t.segments.length} trechos` : 'Ainda não transcrito. Texto, busca, capítulos e montagem pelo texto.',
        !!t,
        t ? go('transcript', 'Ver transcrição') : run('Transcrever', () => { showView('transcript'); $('#transcriptRun').click(); }),
        null),
      card('Reels e legenda',
        t ? 'Legenda estilo Reels, formatos 9:16, 4:5 e 1:1, logo e prévia.' : 'Precisa da transcrição primeiro.',
        false,
        t && isVideo ? go('transcript', 'Abrir Reels', () => {
          const tab = [...$$('#transcriptResult .tab')].find((x) => x.textContent === 'Legenda e Reels');
          if (tab) tab.click();
        }) : null,
        null),
      card('Momentos',
        mo ? `${mo.moments.length} momento(s) encontrados pelo áudio` : 'Acha os picos de áudio: torcida, narração, aplausos.',
        !!mo,
        mo ? go('moments', 'Ver momentos') : run('Detectar momentos', () => { showView('moments'); $('#momentsRun').click(); }),
        null),
      card('Ferramentas',
        'Converter, proxy, vertical, remover silêncios, batidas e frames.',
        false,
        go('tools', 'Abrir ferramentas'),
        null)));
}

function updateVideoMode(name) {
  const inVideo = layoutMode() === 'b' && !!state.currentVideo && VIDEO_VIEWS.includes(name);
  document.body.classList.toggle('video-mode', inVideo);
  if (inVideo) renderVideoBar(name);
  else $('#videoBar').replaceChildren();
  if (name === 'video') renderVideoSummary();
  if (name === 'home') renderHome();
  // Na página do vídeo, o item "vídeo aberto" fica marcado no menu.
  document.body.classList.toggle('has-video', layoutMode() === 'b' && !!state.currentVideo);
  if (state.currentVideo) $('#navVideoText').textContent = basename(state.currentVideo).replace(/\.[^.]+$/, '');
  if (inVideo) {
    for (const b of $$('.nav')) b.classList.toggle('active', b.id === 'navVideo');
  }
  setTimeout(refreshResultState, 300);
}

// Mostra a barra do vídeo quando a tela é parte da página do vídeo.
const baseShowView = showView;
// eslint-disable-next-line no-global-assign
showView = function showViewWithLayout(name) {
  baseShowView(name);
  updateVideoMode(name);
  if (layoutMode() !== 'classic') closeActivity();
};

// Cartões de atividade: atalho para abrir a página do vídeo.
const baseJobCard = jobCard;
// eslint-disable-next-line no-global-assign
jobCard = function jobCardWithLayout(job) {
  const card = baseJobCard(job);
  const file = job.files && job.files[0];
  if (layoutMode() === 'b' && job.status === 'done' && file && isVideoFile(file) && job.kind === 'download') {
    const btns = card.querySelector('.btns');
    if (btns) btns.prepend(el('button', { class: 'btn small primary', onclick: () => openVideo(file, viewForJob(job)) }, 'Abrir no RefLab'));
  }
  return card;
};

// Biblioteca: clicar no vídeo abre a página dele (layout B).
$('#historyList').addEventListener('click', (e) => {
  if (layoutMode() !== 'b') return;
  if (e.target.closest('button, input, textarea')) return;
  const row = e.target.closest('.hitem');
  if (row && row.dataset.file && isVideoFile(row.dataset.file)) openVideo(row.dataset.file);
});

// ---------- Início (layout B) ----------

const INTENTS = [
  ['download', 'Baixar para editar', 'Formato pronto para o Premiere e o DaVinci'],
  ['transcribe', 'Transcrever', 'Texto, busca, roteiro e legenda'],
  ['study', 'Estudar a edição', 'Cortes, ritmo, música e paleta'],
  ['moments', 'Achar momentos', 'Picos de torcida, narração e aplausos'],
];
let homeIntent = 'download';
let homeFile = null;

function renderIntents() {
  $('#homeIntents').replaceChildren(...INTENTS.map(([id, label, desc]) => el('button', {
    class: `intent${homeIntent === id ? ' on' : ''}`,
    type: 'button',
    onclick: () => { homeIntent = id; renderIntents(); renderHomeSummary(); },
  }, el('b', {}, label), el('span', {}, desc))));
}

function renderHomeSummary() {
  const s = state.settings;
  $('#homeTr').classList.toggle('hidden', homeIntent !== 'transcribe');
  $('#homeTrLang').value = $('#transcribeLanguage').value || s.transcribeLanguage || 'pt';
  if (document.activeElement !== $('#homeTrPrompt')) $('#homeTrPrompt').value = s.transcribePrompt || '';
  let text = '';
  if (homeFile) text = `Arquivo: ${basename(homeFile)}`;
  else if (homeIntent === 'transcribe') {
    text = { text: 'Só a transcrição (não guarda o vídeo)', video: 'Baixa o vídeo e transcreve', audio: 'Baixa só o áudio e transcreve' }[s.transcribeUrlMode] || '';
  } else text = `Baixa como ${downloadSummaryText()}`;
  $('#homeSummary').replaceChildren(text, ' · ',
    el('button', { class: 'link', type: 'button', onclick: () => showView(homeIntent === 'transcribe' ? 'transcript' : 'download') }, 'opções'));
}

async function renderHome() {
  renderIntents();
  renderHomeSummary();
  const hist = (await api.history.list()).filter((h) => isVideoFile(h.file)).slice(0, 8);
  const grid = $('#homeRecent');
  if (!hist.length) {
    grid.replaceChildren(el('p', { class: 'empty' }, 'Os vídeos que você baixar ou abrir aparecem aqui.'));
    return;
  }
  grid.replaceChildren(...hist.map((h) => el('button', { class: 'recent', type: 'button', onclick: () => openVideo(h.file) },
    h.thumbnail ? el('img', { src: h.thumbnail, alt: '', loading: 'lazy' }) : el('div', { class: 'ph' }),
    el('b', { title: h.title }, h.title || basename(h.file)),
    el('span', { class: 'muted' }, [h.uploader, h.duration ? fmtSecs(h.duration) : ''].filter(Boolean).join(' · ')))));
}

function setHomeFile(file) {
  homeFile = file;
  $('#homeInput').value = '';
  renderHomeSummary();
  if (homeIntent === 'download') homeIntent = 'study';
  renderIntents();
  $('#homeGo').click();
}

$('#homePick').addEventListener('click', async () => {
  const f = await api.dialog.video();
  if (f) setHomeFile(f);
});
const homeDrop = $('#homeDrop');
homeDrop.addEventListener('dragover', (e) => { e.preventDefault(); homeDrop.classList.add('over'); });
homeDrop.addEventListener('dragleave', () => homeDrop.classList.remove('over'));
homeDrop.addEventListener('drop', (e) => {
  e.preventDefault();
  homeDrop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) setHomeFile(api.pathForFile(f));
});
$('#homeInput').addEventListener('input', () => { homeFile = null; renderHomeSummary(); });
$('#homeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) $('#homeGo').click(); });
$('#homeTrLang').addEventListener('change', (e) => {
  $('#transcribeLanguage').value = e.target.value;
  saveSetting({ transcribeLanguage: e.target.value });
});
$('#homeTrPrompt').addEventListener('change', (e) => {
  $('#transcribePrompt').value = e.target.value;
  saveSetting({ transcribePrompt: e.target.value });
});

async function transcribeLink(url) {
  const s = state.settings;
  const opts = { ...transcribeOptions(), language: $('#homeTrLang').value, prompt: $('#homeTrPrompt').value };
  if (s.transcribeUrlMode === 'text') {
    await api.jobs.add('linkTranscript', { url, title: url, outputDir: s.outputDir, cookiesBrowser: s.cookiesBrowser, ...opts, useYoutubeSubs: s.useYoutubeSubs });
  } else {
    await api.jobs.add('download', downloadParams(url, {
      preset: s.transcribeUrlMode === 'audio' ? 'mp3' : 'h264', maxHeight: 1080, infoTxt: true, normalizeAudio: false,
      afterTranscribe: { ...opts, useYoutubeSubs: s.useYoutubeSubs },
    }));
  }
}

function downloadParams(url, extra = {}) {
  const s = state.settings;
  const audioOnly = ['wav', 'mp3'].includes(s.preset);
  return {
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
    ...extra,
  };
}

$('#homeGo').addEventListener('click', async () => {
  const urls = $('#homeInput').value.split(/\s+/).map((u) => u.trim()).filter(Boolean);
  const url = urls[0] || '';
  if (homeFile) {
    const file = homeFile;
    homeFile = null;
    await openVideo(file);
    if (homeIntent === 'transcribe') {
      $('#transcribeLanguage').value = $('#homeTrLang').value;
      showView('transcript');
      $('#transcriptRun').click();
    }
    if (homeIntent === 'study') { showView('study'); $('#studyRun').click(); }
    if (homeIntent === 'moments') { showView('moments'); $('#momentsRun').click(); }
    return;
  }
  const links = urls.filter((u) => /^https?:\/\//i.test(u));
  if (!links.length) { toast('Cole um link (começando com http) ou escolha um vídeo do computador.', true); return; }
  if (!(await ensureTools())) return;
  const s = state.settings;
  const videoPreset = ['wav', 'mp3', 'original'].includes(s.preset) ? 'h264' : s.preset;
  for (const link of links) {
    if (homeIntent === 'transcribe') await transcribeLink(link);
    else if (homeIntent === 'download') await api.jobs.add('download', downloadParams(link));
    else if (homeIntent === 'study') {
      await api.jobs.add('download', downloadParams(link, {
        preset: videoPreset, afterAnalyze: { threshold: s.sceneThreshold, minShot: s.minShot },
      }));
    } else if (homeIntent === 'moments') {
      await api.jobs.add('download', downloadParams(link, {
        preset: videoPreset,
        afterMoments: { sensitivity: s.momentSensitivity, before: s.momentBefore, after: s.momentAfter, max: s.momentMax },
      }));
    }
  }
  const n = links.length > 1 ? `${links.length} links` : 'O link';
  toast({
    download: `${n} na fila. Quando terminar, clique em "Abrir no RefLab" em Atividades.`,
    transcribe: `${n} na fila para transcrever.`,
    study: `${n}: baixando e depois analisando os cortes.`,
    moments: `${n}: baixando e depois procurando os momentos.`,
  }[homeIntent]);
  $('#homeInput').value = '';
  $('#homeClip').classList.add('hidden');
});
$('#homeAll').addEventListener('click', () => showView('history'));

new MutationObserver(() => {
  const visible = !$('#clipBanner').classList.contains('hidden');
  $('#homeClip').classList.toggle('hidden', !visible);
  if (visible) $('#homeClipUrl').textContent = $('#clipUrl').textContent;
}).observe($('#clipBanner'), { attributes: true, attributeFilter: ['class'] });
$('#homeClipUse').addEventListener('click', () => {
  const cur = $('#homeInput').value.trim();
  $('#homeInput').value = cur ? `${cur}\n${lastClip}` : lastClip;
  $('#clipBanner').classList.add('hidden');
  homeFile = null;
  renderHomeSummary();
});
$('#homeClipIgnore').addEventListener('click', () => $('#clipBanner').classList.add('hidden'));

// ---------- Biblioteca em grade com status (layout B) ----------

const statusCache = new Map();
async function videoStatus(file) {
  if (statusCache.has(file)) return statusCache.get(file);
  const [a, t, m] = await Promise.all([api.study.load(file), api.transcript.load(file), api.moments.load(file)]);
  const st = { cuts: !!a, transcript: !!t, moments: !!m };
  statusCache.set(file, st);
  return st;
}
api.jobs.onUpdate((job) => { if (job.status === 'done' && job.params && job.params.file) statusCache.delete(job.params.file); });

const baseRenderHistory = renderHistory;
// eslint-disable-next-line no-global-assign
renderHistory = function renderHistoryWithLayout() {
  if (layoutMode() !== 'b' || $('#historyMode').value === 'speech') { baseRenderHistory(); return; }
  baseRenderHistory(); // filtro de etiquetas e estado vazio
  const list = $('#historyList');
  const rows = [...list.querySelectorAll('.hitem')];
  if (!rows.length) return;
  const q = $('#historySearch').value.trim().toLowerCase();
  const items = state.history.filter((h) =>
    (!state.tagFilter || (h.tags || []).includes(state.tagFilter))
    && (!q || [h.title, h.uploader, h.site, h.file, (h.tags || []).join(' '), h.notes].join(' ').toLowerCase().includes(q)));
  const grid = el('div', { class: 'lib-grid' }, items.slice(0, 300).map((h) => {
    const pills = el('div', { class: 'lib-pills' });
    if (isVideoFile(h.file)) {
      videoStatus(h.file).then((st) => {
        pills.replaceChildren(
          el('span', { class: `pill${st.cuts ? ' on' : ''}` }, 'Cortes'),
          el('span', { class: `pill${st.transcript ? ' on' : ''}` }, 'Transcrição'),
          el('span', { class: `pill${st.moments ? ' on' : ''}` }, 'Momentos'));
      });
    }
    return el('div', { class: 'lib-card', 'data-file': h.file },
      el('button', { class: 'lib-open', type: 'button', onclick: () => (isVideoFile(h.file) ? openVideo(h.file) : api.shell.open(h.file)) },
        h.thumbnail ? el('img', { src: h.thumbnail, alt: '', loading: 'lazy' }) : el('div', { class: 'ph' }),
        el('b', { title: h.title }, h.title || basename(h.file)),
        el('span', { class: 'muted' }, [h.uploader, new Date(h.date).toLocaleDateString('pt-BR')].filter(Boolean).join(' · '))),
      pills,
      (h.tags || []).length ? el('div', { class: 'tags' }, h.tags.map((t) => el('span', { class: 'tag-chip small' }, t))) : null,
      el('div', { class: 'lib-actions' },
        el('button', { class: 'btn small', type: 'button', onclick: () => api.shell.reveal(h.file) }, 'Pasta'),
        h.url ? el('button', { class: 'btn small', type: 'button', onclick: () => api.shell.external(h.url) }, 'Link') : null,
        el('button', { class: 'btn small', type: 'button', onclick: () => { state.editingId = h.id; baseRenderHistory(); } }, 'Etiquetas')));
  }));
  list.replaceChildren(grid);
};

// ---------- início ----------

(async function initLayouts() {
  // espera os ajustes carregarem (app.js)
  for (let i = 0; i < 50 && !state.settings.outputDir; i++) await new Promise((r) => setTimeout(r, 50));
  prepareHints();
  prepareAdvanced();
  const launches = Number(state.settings.layoutLaunches || 0);
  document.body.classList.toggle('learning', launches < 3);
  saveSetting({ layoutLaunches: launches + 1 });
  $('#layoutMode').value = layoutMode();
  applyLayout();
})();

// A busca da Biblioteca foi ligada antes da troca de layout: refaz a grade.
$('#historySearch').addEventListener('input', () => { if (layoutMode() === 'b') renderHistory(); });
