// Caminho dos arquivos que vão dentro do app (fontes, modelo de detecção de voz).
const fs = require('fs');
const path = require('path');

function assetPath(...parts) {
  const packaged = process.resourcesPath && path.join(process.resourcesPath, 'assets', ...parts);
  if (packaged && fs.existsSync(packaged)) return packaged;
  return path.join(__dirname, '..', '..', 'assets', ...parts);
}

module.exports = { assetPath };
