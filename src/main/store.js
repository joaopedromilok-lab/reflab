// Arquivo JSON simples na pasta de dados do app (ajustes e histórico).
const fs = require('fs');
const path = require('path');

function jsonStore(file, fallback) {
  let data = null;
  let timer = null;
  const load = () => {
    if (data !== null) return data;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      data = typeof fallback === 'function' ? fallback() : fallback;
    }
    return data;
  };
  const save = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify(data, null, 2));
      fs.renameSync(`${file}.tmp`, file);
    }, 200);
  };
  return {
    get: load,
    set(value) { data = value; save(); },
    flush() {
      if (timer) { clearTimeout(timer); timer = null; fs.writeFileSync(file, JSON.stringify(data, null, 2)); }
    },
  };
}

module.exports = { jsonStore };
