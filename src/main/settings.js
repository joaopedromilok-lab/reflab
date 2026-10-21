// Ajustes do usuário com valores padrão.
const path = require('path');
const { jsonStore } = require('./store');

let store = null;
let defaults = {};

function init(dir, downloadsDir) {
  defaults = {
    outputDir: path.join(downloadsDir, 'RefLab'),
    preset: 'h264',
    maxHeight: 1080,
    organize: 'none',
    projectName: '',
    nameTemplate: 'title',
    keepOriginal: false,
    proxy: false,
    infoTxt: true,
    thumbnail: false,
    subtitles: false,
    subLangs: 'pt,pt-BR,en,en-US',
    normalizeAudio: true,
    playlist: false,
    concurrency: 2,
    cookiesBrowser: '',
    autoUpdate: true,
    lastUpdateCheck: 0,
    sceneThreshold: 0.3,
    minShot: 0.3,
    momentSensitivity: 8,
    momentBefore: 10,
    momentAfter: 5,
    momentMax: 30,
    clipMode: 'precise',
    transcribeLanguage: 'pt',
    transcribeModel: 'turbo',
    transcribeVad: true,
    transcribePrompt: '',
    useYoutubeSubs: true,
    transcribeAudioOnly: false,
    transcribeUrlMode: 'text',
    reelsFormat: '9x16-blur',
    captionStyle: {
      preset: 'amarelo', font: 'Anton', textColor: '#FFFFFF', highlight: '#FFD23F', keywordColor: '#FF5A4E',
      keywords: '', uppercase: true, size: 'm', position: 'low', maxWords: 3, box: false, boxColor: '#111111',
    },
    logo: { path: '', position: 'tr', size: 15, opacity: 90 },
    afterTranscribe: false,
    afterAnalyze: false,
    silenceNoise: -35,
    silenceMin: 0.5,
  };
  store = jsonStore(path.join(dir, 'ajustes.json'), {});
}

function get() {
  return { ...defaults, ...store.get() };
}

function set(partial) {
  const next = { ...store.get(), ...partial };
  store.set(next);
  return { ...defaults, ...next };
}

module.exports = { init, get, set, flush: () => store && store.flush() };
