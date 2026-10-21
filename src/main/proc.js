// Execução de processos externos (yt-dlp, ffmpeg, deno) com leitura linha a linha
// e cancelamento da árvore inteira de processos.
const { spawn } = require('child_process');

const IS_WIN = process.platform === 'win32';
const KEEP_CHARS = 200000;

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (IS_WIN) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      process.kill(-child.pid, 'SIGTERM');
    }
  } catch {
    try { child.kill('SIGKILL'); } catch { /* já terminou */ }
  }
}

function lineSplitter(cb) {
  let buf = '';
  return (data) => {
    buf += data.toString('utf8');
    let i;
    while ((i = buf.search(/[\r\n]/)) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim()) cb(line);
    }
  };
}

// Inicia um processo. Retorna { child, promise, kill }.
// promise resolve com { code, stdout, stderr } (as saídas guardam só o final).
function start(cmd, args, opts = {}) {
  const child = spawn(cmd, args, {
    windowsHide: true,
    detached: !IS_WIN,
    cwd: opts.cwd,
    env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...(opts.env || {}) },
  });
  let stdout = '';
  let stderr = '';
  const keep = (acc, d) => {
    acc += d.toString('utf8');
    return acc.length > KEEP_CHARS ? acc.slice(-KEEP_CHARS) : acc;
  };
  child.stdout.on('data', (d) => { stdout = keep(stdout, d); });
  child.stderr.on('data', (d) => { stderr = keep(stderr, d); });
  if (opts.onLine) {
    child.stdout.on('data', lineSplitter((l) => opts.onLine(l, 'out')));
    child.stderr.on('data', lineSplitter((l) => opts.onLine(l, 'err')));
  }
  const promise = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return { child, promise, kill: () => killTree(child) };
}

async function run(cmd, args, opts) {
  return start(cmd, args, opts).promise;
}

module.exports = { start, run, killTree, IS_WIN };
