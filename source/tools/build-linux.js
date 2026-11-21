'use strict';
/* Lumen — build a portable Linux build:  node tools/build-linux.js [--zip <electron zip>] [--out <dir>] */
const path = require('path');
const fs = require('fs');
const { pack } = require('./pack');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const root = path.join(__dirname, '..');
const outRoot = path.resolve(arg('--out') || path.join(root, '..', 'build'));
const zip = arg('--zip') || path.join(root, '..', '.electron', 'electron-v44.5.1-linux-x64.zip');

console.log('Lumen — Linux build');
console.log('  electron : v44.5.1 (x64)');
console.log('  runtime  : ' + zip);
console.log('  output   : ' + outRoot);

pack({ srcDir: root, out: outRoot, platform: 'linux', zip: zip, version: '1.0.0' })
  .then(function (res) {
    console.log('[pack] launcher: ' + path.join(res.outDir, 'lumen'));
    console.log('[pack] app.asar: ' + res.asarSize + ' bytes · ' + res.files + ' files in the folder');
    console.log('[pack] done → ' + res.outDir);
    console.log('\nRun it with:\n  ' + path.join(res.outDir, 'lumen') + ' [--no-sandbox] video.mp4');
  })
  .catch(function (e) {
    console.error('[pack] FAILED: ' + (e && e.stack || e));
    process.exit(1);
  });
