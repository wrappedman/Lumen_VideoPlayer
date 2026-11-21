'use strict';
/* ==========================================================================
   Lumen — tools/build-installer.js
   Builds Lumen-Setup-<version>.exe from the portable folder that
   tools/build-windows.js produced (must run after it).
   Needs makensis (NSIS 3.x) on PATH.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

const root = path.join(__dirname, '..');
const outRoot = path.resolve(arg('--out') || path.join(root, '..', 'build'));
const appDir = path.join(outRoot, 'windows');
const version = arg('--version') || require(path.join(root, 'package.json')).version;
const revision = arg('--revision') || 'r9';
const icon = path.join(root, 'assets', 'icon.ico');
const buildIdFile = path.join(appDir, 'BUILD-ID.txt');
const template = path.join(__dirname, 'installer.nsi');
const outFile = path.join(appDir, 'Lumen-Setup-' + version + '-' + revision + '.exe');

if (!fs.existsSync(path.join(appDir, 'Lumen.exe'))) {
  console.error('[installer] ' + appDir + ' has no Lumen.exe — run tools/build-windows.js first.');
  process.exit(1);
}
if (!fs.existsSync(buildIdFile)) {
  console.error('[installer] BUILD-ID.txt missing from the Windows payload. Rebuild with tools/build-windows.js first.');
  process.exit(1);
}
if (!fs.existsSync(template)) {
  console.error('[installer] template missing: ' + template);
  process.exit(1);
}

const makensis = (function () {
  const windows = process.platform === 'win32';
  const command = windows ? 'where.exe' : 'which';
  const executable = windows ? 'makensis.exe' : 'makensis';
  const found = spawnSync(command, [executable], { encoding: 'utf8', windowsHide: true });
  if (found.status === 0 && found.stdout) return String(found.stdout).split(/\r?\n/)[0].trim();
  if (windows) {
    const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, 'C:\\Program Files (x86)', 'C:\\Program Files'];
    for (const root of roots) {
      if (!root) continue;
      const candidate = path.join(root, 'NSIS', 'makensis.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return '';
})();
if (!makensis) {
  console.error('[installer] makensis not found — install NSIS (apt install nsis / nsis.sourceforge.io).');
  process.exit(1);
}

const script = fs.readFileSync(template, 'utf8')
  .replace(/@@OUTFILE@@/g, outFile.replace(/\\/g, '\\\\'))
  .replace(/@@PAYLOAD@@/g, appDir.replace(/\\/g, '\\\\'))
  .replace(/@@ICON@@/g, icon.replace(/\\/g, '\\\\'));

const scriptFile = path.join(appDir, 'installer.generated.nsi');
fs.writeFileSync(scriptFile, script);

console.log('[installer] ' + 'Lumen ' + version + ' (' + revision + ')');
console.log('[installer] build ID: ' + buildIdFile);
console.log('[installer] payload : ' + appDir);
console.log('[installer] output  : ' + outFile);
console.log('[installer] makensis: ' + makensis);
console.log('[installer] compressing the portable app (this takes a few minutes)…');

try {
  const t0 = Date.now();
  execFileSync(makensis, ['-V3', scriptFile], { stdio: 'inherit' });
  const secs = Math.round((Date.now() - t0) / 1000);
  const size = fs.statSync(outFile).size;
  console.log('[installer] done in ' + secs + ' s → ' + outFile + ' (' + (size / 1048576).toFixed(1) + ' MB)');
  console.log('\nThe installer is a per-user install (no admin prompt):');
  console.log('  Lumen-Setup-' + version + '-' + revision + '.exe              → install + Start-Menu shortcut');
  console.log('  Lumen-Setup-' + version + '-' + revision + '.exe /desktop     → …and a desktop shortcut');
  console.log('  Lumen-Setup-' + version + '-' + revision + '.exe /PORTABLE /D=D:\\Apps\\Lumen  → extract only');
} catch (e) {
  console.error('[installer] makensis failed:', e && e.message);
  process.exit(1);
}
