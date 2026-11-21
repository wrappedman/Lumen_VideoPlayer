'use strict';
/* Lumen — build a portable Windows build:  node tools/build-windows.js [--zip <electron zip>] [--out <dir>] */
const path = require('path');
const fs = require('fs');
const { pack } = require('./pack');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const os = require('os');
const root = path.join(__dirname, '..');
const outRoot = path.resolve(arg('--out') || path.join(root, '..', 'build'));
const zip = arg('--zip') || path.join(root, '..', '.electron', 'electron-v44.5.1-win32-x64.zip');
const ffmpegZip = arg('--ffmpeg-zip') || process.env.LUMEN_FFMPEG_ZIP ||
  path.join(os.homedir(), '.cache', 'lumen-build', 'ffmpeg-9.0.2-essentials_build.zip');
const version = arg('--version') || require(path.join(root, 'package.json')).version;
const buildId = arg('--build-id') || 'r9-2026-10-04';

console.log('Lumen — Windows build');
console.log('  electron : v44.5.1 (x64)');
console.log('  build ID : ' + buildId);
console.log('  runtime  : ' + zip);
console.log('  FFmpeg   : ' + ffmpegZip);
console.log('  output   : ' + outRoot);

pack({ srcDir: root, out: outRoot, platform: 'windows', zip: zip, ffmpegZip: ffmpegZip, version: version, buildId: buildId })
  .then(function (res) {
    const exe = path.join(res.outDir, 'Lumen.exe');
    const size = fs.existsSync(exe) ? fs.statSync(exe).size : 0;
    console.log('[pack] launcher: Lumen.exe (' + size + ' bytes)');
    console.log('[pack] app.asar: ' + res.asarSize + ' bytes · ' + res.files + ' files in the folder');
    console.log('[pack] done → ' + res.outDir);
    console.log('\nPortable build ready:\n  ' + exe + '  [ok]\n  double-click it, or run it from a shell with a file name:\n  Lumen.exe "D:\\Movies\\movie.mkv"');
  })
  .catch(function (e) {
    console.error('[pack] FAILED: ' + (e && e.stack || e));
    process.exit(1);
  });
