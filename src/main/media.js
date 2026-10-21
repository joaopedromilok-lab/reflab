// ffmpeg / ffprobe: leitura de informações, presets de edição, conversão e proxy.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { start, run } = require('./proc');
const tools = require('./tools');

const IS_MAC = process.platform === 'darwin';

const PRESETS = {
  original: { label: 'Original', ext: null },
  h264: { label: 'H.264', ext: 'mp4' },
  hevc: { label: 'HEVC', ext: 'mp4' },
  prores: { label: 'ProRes 422', ext: 'mov' },
  wav: { label: 'WAV', ext: 'wav', audioOnly: true },
  mp3: { label: 'MP3', ext: 'mp3', audioOnly: true },
};

let encoderCache = null;
async function encoders() {
  if (encoderCache) return encoderCache;
  const r = await run(tools.toolPath('ffmpeg'), ['-hide_banner', '-encoders']);
  const set = new Set();
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = line.match(/^\s*[VAS][\w.]{5}\s+(\S+)/);
    if (m) set.add(m[1]);
  }
  encoderCache = set;
  return set;
}

function parseRate(r) {
  if (!r || r === '0/0') return 0;
  const [a, b] = r.split('/').map(Number);
  return b ? a / b : a;
}

async function probe(file) {
  const r = await run(tools.toolPath('ffprobe'), [
    '-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file,
  ]);
  if (r.code !== 0) throw new Error(`Não foi possível ler o arquivo: ${r.stderr.trim()}`);
  const j = JSON.parse(r.stdout);
  const v = (j.streams || []).find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const a = (j.streams || []).find((s) => s.codec_type === 'audio');
  const fps = v ? parseRate(v.avg_frame_rate) || parseRate(v.r_frame_rate) || 30 : 0;
  return {
    duration: Number(j.format && j.format.duration) || Number(v && v.duration) || 0,
    width: v ? v.width : 0,
    height: v ? v.height : 0,
    fps,
    vcodec: v ? v.codec_name : null,
    acodec: a ? a.codec_name : null,
    sampleRate: a ? Number(a.sample_rate) : 48000,
    channels: a ? a.channels : 2,
    hasVideo: !!v,
    hasAudio: !!a,
    container: j.format ? j.format.format_name : '',
  };
}

// Roda o ffmpeg reportando o progresso (0..1) com base na duração.
function ffmpeg(args, { duration = 0, onProgress, onStart, onStderrLine } = {}) {
  const full = ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args];
  const p = start(tools.toolPath('ffmpeg'), full, {
    onLine: (line, src) => {
      if (src === 'out') {
        const m = line.match(/^out_time_(?:us|ms)=(\d+)/);
        if (m && duration > 0 && onProgress) onProgress(Math.min(1, Number(m[1]) / 1e6 / duration));
      } else if (onStderrLine) {
        onStderrLine(line);
      }
    },
  });
  if (onStart) onStart(p);
  return p.promise.then((r) => {
    if (r.code !== 0) {
      const lines = r.stderr.trim().split(/\r?\n/).filter((l) => !/^\s*(\[Parsed_showinfo|frame=)/.test(l));
      const err = new Error(`ffmpeg falhou: ${lines.slice(-4).join(' | ')}`);
      err.code = r.code;
      throw err;
    }
    return r;
  });
}

function bitrateFor(height) {
  if (height >= 2160) return '45M';
  if (height >= 1440) return '25M';
  if (height >= 1080) return '14M';
  return '8M';
}

// Monta os argumentos de codificação para um preset.
async function encodeArgs(preset, info, { normalize = false } = {}) {
  const enc = await encoders();
  const loud = normalize ? ['-af', 'loudnorm=I=-16:TP=-1.5:LRA=11'] : [];
  if (preset === 'wav') return { args: ['-vn', ...loud, '-c:a', 'pcm_s24le', '-ar', '48000'], ext: 'wav' };
  if (preset === 'mp3') return { args: ['-vn', ...loud, '-c:a', 'libmp3lame', '-b:a', '320k'], ext: 'mp3' };

  const map = ['-map', '0:v:0', '-map', '0:a:0?', '-map_metadata', '0'];
  const cfr = ['-fps_mode', 'cfr'];
  let video;
  let audio;
  let ext;
  let videoOk;
  let audioOk;

  if (preset === 'h264') {
    ext = 'mp4';
    videoOk = info.vcodec === 'h264';
    audioOk = !info.hasAudio || info.acodec === 'aac';
    if (enc.has('libx264')) video = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', ...cfr];
    else video = ['-c:v', 'h264_videotoolbox', '-b:v', bitrateFor(info.height), '-pix_fmt', 'yuv420p', ...cfr];
    audio = ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000'];
  } else if (preset === 'hevc') {
    ext = 'mp4';
    videoOk = info.vcodec === 'hevc';
    audioOk = !info.hasAudio || info.acodec === 'aac';
    if (IS_MAC && enc.has('hevc_videotoolbox')) {
      video = ['-c:v', 'hevc_videotoolbox', '-b:v', bitrateFor(info.height), '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', ...cfr];
    } else if (enc.has('libx265')) {
      video = ['-c:v', 'libx265', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1', ...cfr];
    } else {
      video = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', ...cfr];
    }
    audio = ['-c:a', 'aac', '-b:a', '320k', '-ar', '48000'];
  } else if (preset === 'prores') {
    ext = 'mov';
    videoOk = info.vcodec === 'prores';
    audioOk = !info.hasAudio || /^pcm_/.test(info.acodec || '');
    video = ['-c:v', 'prores_ks', '-profile:v', '2', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le', ...cfr];
    audio = ['-c:a', 'pcm_s24le', '-ar', '48000'];
  } else {
    throw new Error(`Preset desconhecido: ${preset}`);
  }

  if (videoOk) video = ['-c:v', 'copy', ...(preset === 'hevc' ? ['-tag:v', 'hvc1'] : [])];
  if (audioOk) audio = info.hasAudio ? ['-c:a', 'copy'] : [];
  const extra = ext === 'mp4' ? ['-movflags', '+faststart'] : [];
  return { args: [...map, ...video, ...audio, ...extra], ext, videoOk, audioOk };
}

// Converte um arquivo para um preset de edição. Retorna o caminho final.
async function convert(input, preset, { keepOriginal = false, normalize = false, onProgress, onStart } = {}) {
  const info = await probe(input);
  if (!PRESETS[preset].audioOnly && !info.hasVideo) throw new Error('O arquivo não tem vídeo.');
  const { args, ext, videoOk, audioOk } = await encodeArgs(preset, info, { normalize });
  const dir = path.dirname(input);
  const base = path.basename(input, path.extname(input));
  const inExt = path.extname(input).slice(1).toLowerCase();

  // Já está no formato certo: nada a fazer.
  if (videoOk && audioOk && inExt === ext) return { output: input, converted: false };

  let output = path.join(dir, `${base}.${ext}`);
  const sameFile = path.resolve(output) === path.resolve(input);
  if (keepOriginal && (sameFile || fs.existsSync(output))) {
    output = path.join(dir, `${base} - ${PRESETS[preset].label}.${ext}`);
  }
  const target = sameFile && !keepOriginal ? path.join(dir, `${base}.reflab-tmp.${ext}`) : output;

  await ffmpeg(['-i', input, ...args, target], { duration: info.duration, onProgress, onStart });

  if (!keepOriginal) {
    await fsp.unlink(input).catch(() => {});
    if (target !== output) await fsp.rename(target, output);
  }
  return { output, converted: true };
}

// Proxy ProRes leve, na subpasta "Proxy" com o mesmo nome do arquivo
// (o DaVinci Resolve liga automaticamente; no Premiere use "Anexar proxies").
async function makeProxy(input, { onProgress, onStart } = {}) {
  const info = await probe(input);
  if (!info.hasVideo) throw new Error('O arquivo não tem vídeo.');
  const dir = path.join(path.dirname(input), 'Proxy');
  await fsp.mkdir(dir, { recursive: true });
  const output = path.join(dir, `${path.basename(input, path.extname(input))}.mov`);
  await ffmpeg([
    '-i', input, '-map', '0:v:0', '-map', '0:a?',
    '-vf', "scale='min(1280,iw)':-2",
    '-c:v', 'prores_ks', '-profile:v', '0', '-vendor', 'apl0', '-pix_fmt', 'yuv422p10le',
    '-c:a', 'pcm_s16le', '-fps_mode', 'cfr', output,
  ], { duration: info.duration, onProgress, onStart });
  return output;
}

module.exports = { PRESETS, probe, ffmpeg, convert, makeProxy, encoders };
