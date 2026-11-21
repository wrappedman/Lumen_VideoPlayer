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

/* ------------------------------------------------------------------ makensis
   NSIS is only needed to *pack* the installer; the player itself never needs
   it. So a missing makensis must never look like a broken build: every place
   NSIS realistically lands is searched, and if none of them hit, this script
   exits with code 3 (= "installer skipped, the portable app is fine") instead
   of 1 (= "something failed"). */
const EXIT_NO_NSIS = 3;

function findMakensis() {
  const windows = process.platform === 'win32';
  const exe = windows ? 'makensis.exe' : 'makensis';
  const explicit = arg('--makensis');
  if (explicit) {
    if (fs.existsSync(explicit)) return explicit;
    console.warn('[installer] --makensis points at something that does not exist: ' + explicit);
  }
  const seen = new Set();
  const hit = (p) => {
    if (!p || seen.has(p)) return '';
    seen.add(p);
    try { return fs.statSync(p).isFile() ? p : ''; } catch (e) { return ''; }
  };

  /* 1) PATH */
  const found = spawnSync(windows ? 'where.exe' : 'which', [exe], { encoding: 'utf8', windowsHide: true });
  if (found.status === 0 && found.stdout) {
    const first = hit(String(found.stdout).split(/\r?\n/)[0].trim());
    if (first) return first;
  }
  if (!windows) return '';

  /* 2) explicit folder in the environment (NSIS_DIR / NSIS_HOME) */
  for (const env of ['NSIS_DIR', 'NSIS_HOME', 'NSIS_PATH']) {
    const r = hit(path.join(process.env[env] || '', 'makensis.exe'));
    if (r) return r;
  }

  /* 3) where winget / chocolatey / scoop / the classic installer put it */
  const roots = [
    process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.ProgramW6432,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
    process.env.LOCALAPPDATA, process.env.APPDATA,
    process.env.ProgramData && path.join(process.env.ProgramData, 'chocolatey', 'bin'),
    process.env.USERPROFILE && path.join(process.env.USERPROFILE, 'scoop', 'shims'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'),
    'C:\\Program Files (x86)', 'C:\\Program Files', 'C:\\NSIS', 'D:\\Program Files (x86)', 'D:\\Program Files'
  ];
  for (const root of roots) {
    if (!root) continue;
    for (const sub of ['NSIS', 'nsis', '']) {
      const r = hit(path.join(root, sub, 'makensis.exe'));
      if (r) return r;
    }
  }

  /* 4) the uninstall registry key written by the official installer */
  for (const key of [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NSIS',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NSIS',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\NSIS'
  ]) {
    const q = spawnSync('reg.exe', ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8', windowsHide: true });
    if (q.status !== 0 || !q.stdout) continue;
    const m = /InstallLocation\s+REG_\w+\s+(.+)/i.exec(q.stdout);
    if (!m) continue;
    const r = hit(path.join(m[1].trim(), 'makensis.exe'));
    if (r) return r;
  }
  return '';
}

const makensis = findMakensis();
if (!makensis) {
  console.warn('');
  console.warn('[installer] NSIS (makensis) was not found — skipping the installer.');
  console.warn('[installer] This is not a build failure: the portable app in');
  console.warn('[installer]   ' + appDir);
  console.warn('[installer] runs on its own (Lumen.exe).');
  console.warn('');
  console.warn('[installer] Install NSIS 3.x and run the installer step again:');
  console.warn('[installer]   winget install --id NSIS.NSIS -e');
  console.warn('[installer]   choco install nsis -y');
  console.warn('[installer]   https://nsis.sourceforge.io/Download  (then add its folder to PATH)');
  console.warn('[installer] Already installed somewhere unusual? Pass --makensis "C:\\path\\makensis.exe"');
  console.warn('');
  process.exit(EXIT_NO_NSIS);
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
