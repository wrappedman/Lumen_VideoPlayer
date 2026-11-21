'use strict';
/* Static checks for the requested subtitle-settings change and async sidecar merge. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = function (p) { return fs.readFileSync(path.join(root, p), 'utf8'); };
const html = read('web/index.html');
const css = read('web/app.css');
const shell = read('web/shell.js');
const ui = read('web/ui.js');
const app = read('web/app.js');
const lumenCss = read('web/lumen.css');
const preload = read('preload.js');
const mainJs = read('main.js');
const store = read('host/store.js');
const installer = read('tools/build-installer.js');
const pack = read('tools/pack.js');
const zipfs = read('tools/zipfs.js');
const bat = read('build-windows-r9.bat');
const results = [];
function check(name, fn) {
  fn();
  results.push(name);
  console.log('PASS ' + name);
}

check('Settings contains no subtitle sample preview element or row', function () {
  assert.doesNotMatch(html, /id=["']subPreview["']/i);
  assert.doesNotMatch(html, /<span[^>]*>\s*Preview\s*</i);
  assert.doesNotMatch(css, /sub-preview/i);
  assert.doesNotMatch(shell, /subPreview|sub-preview/i);
});
check('Reset look remains bound to the style reset handler', function () {
  assert.match(html, /id=["']subResetBtn["']/);
  assert.match(ui, /subResetBtn[\s\S]{0,180}subStyleReset/);
  assert.match(shell, /L\.subStyleReset\s*=\s*function/);
});
check('real subtitle styling still renders on player cues', function () {
  assert.match(shell, /L\.subStyleApply\s*=\s*function\s*\(\)\s*\{\s*P\.renderSubs/);
  assert.match(app, /function subInlineStyle\(\)/);
  assert.match(app, /inline:\s*subInlineStyle/);
  assert.match(css, /\.sub-line/);
});
check('sidecar tracks survive a slower embedded-track probe', function () {
  assert.match(app, /var foundSidecars\s*=\s*self\.subTracks\.filter/);
  assert.match(app, /foundSidecars\.forEach/);
  assert.match(app, /self\.subTracks\s*=\s*\(info\.subs\s*\|\|\s*\[\]\)\.slice\(0\)/);
});
check('renderer sidecar merge is case-insensitive and idempotent', function () {
  assert.match(app, /function sidecarPathKey\(p\)/);
  assert.match(app, /var known = new Set\(self\.subTracks/);
  assert.match(app, /if \(!add\.length\) return/);
});
check('installer discovery checks where.exe/PATH and Program Files on Windows', function () {
  assert.match(installer, /process\.platform === 'win32'/);
  assert.match(installer, /where\.exe/);
  assert.match(installer, /ProgramFiles\(x86\)/);
  assert.doesNotMatch(installer, /spawnSync\('which'/);
});
check('R9 BAT build ID/output, Node/NSIS prerequisites, and revocation fallback are aligned', function () {
  assert.ok(bat.includes('build\\r9'));
  assert.ok(bat.includes('--build-id r9-2026-10-04'));
  assert.ok(bat.includes('--revision r9'));
  assert.ok(bat.includes('Node.js 22.12 or newer'));
  assert.ok(bat.includes('where.exe makensis.exe'));
  /* NSIS must be a late, optional step: a missing makensis used to abort the
     build before the portable app was even assembled */
  assert.ok(bat.indexOf('[5/5]') < bat.indexOf('node tools\\build-installer.js'));
  assert.ok(bat.indexOf('node tools\\build-windows.js') < bat.indexOf('call :find_nsis'));
  assert.doesNotMatch(bat, /NSIS 3\.x was not found on PATH or in its standard folders/);
  assert.equal((bat.match(/curl\.exe --ssl-no-revoke/g) || []).length, 2);
  assert.match(bat, /FFMPEG_SHA/);
  assert.match(bat, /ELECTRON_SHA/);
});


/* ---------------------------------------------------------------- host bridge
   The renderer reaches the desktop host through one whitelist (preload.js) that
   main.js checks again. When `transcode_start` was missing from the first list
   the whole FFmpeg fallback silently did nothing. */
function listBlock(src, start, end) {
  const a = src.indexOf(start);
  const b = src.indexOf(end, a);
  return a < 0 || b < 0 ? '' : src.slice(a, b);
}
function hostMethodNames() {
  const block = listBlock(preload, 'const METHODS = [', '];');
  return Array.from(block.matchAll(/'([a-z_]+)'/g), (m) => m[1]);
}
function mainHandlerNames() {
  const block = listBlock(mainJs, 'const handlers = {', '\n};');
  return Array.from(block.matchAll(/^  ([a-z_]+): function/gm), (m) => m[1]);
}
function rendererCalls() {
  const used = new Set();
  [app, ui, shell].forEach(function (src) {
    const re = /(?:Bridge|B)\.call\(\s*'([a-z_]+)'/g;
    let m;
    while ((m = re.exec(src))) used.add(m[1]);
  });
  return Array.from(used);
}

check('every host method is advertised, whitelisted and handled (bridge parity)', function () {
  const methods = hostMethodNames();
  const handlers = mainHandlerNames();
  assert.deepEqual(methods.slice().sort(), handlers.slice().sort());
  rendererCalls().forEach(function (name) {
    assert.ok(methods.includes(name), 'preload.js does not expose ' + name);
    assert.ok(handlers.includes(name), 'main.js does not handle ' + name);
  });
  assert.ok(methods.includes('transcode_start'), 'the FFmpeg bridge must be reachable');
  assert.ok(methods.includes('media_delete'), 'Delete must be able to reach the host');
});

check('PageDown/PageUp skip items and Delete trashes the current file', function () {
  assert.match(shell, /case 'PageDown': e\.preventDefault\(\); P\.next\(\); return;/);
  assert.match(shell, /case 'PageUp': e\.preventDefault\(\); P\.prev\(\); return;/);
  assert.match(shell, /case 'Delete': case 'Del': e\.preventDefault\(\); L\.deleteCurrent\(\);/);
  assert.match(shell, /L\.deleteCurrent\s*=\s*function/);
  /* it must never delete the file it would keep playing */
  assert.match(shell, /var next = PL\.next\(1, true\);/);
  assert.match(shell, /if \(!next \|\| next === it\)/);
  assert.match(shell, /B\.call\('media_delete', target\)/);
  assert.match(shell, /if \(!it\.path\)/);
  /* skipping wraps around instead of doing nothing on the last item */
  assert.match(app, /next: function \(step, wrap\)/);
  assert.match(app, /var n = Playlist\.next\(1, true\);/);
  assert.match(app, /var n = Playlist\.next\(-1, true\);/);
  /* a focused dropdown must keep its own PageDown / arrow behaviour */
  assert.match(shell, /t\.tagName === 'SELECT'/);
});

check('deleting a file goes to the recycle bin and purges host state', function () {
  assert.match(mainJs, /media_delete: function \(p\)/);
  assert.match(mainJs, /shell\.trashItem\(target\)/);
  assert.doesNotMatch(mainJs, /unlinkSync\(target\)/);   /* never a hard delete */
  assert.match(mainJs, /store\.forget\(target\)/);
  assert.match(store, /forget\(p\) \{/);
  assert.match(store, /delete data\.resume\[key\]/);
});

check('playlist painting is coalesced, cached and no longer O(n^2)', function () {
  assert.match(ui, /function schedulePlaylist\(\)/);
  assert.match(ui, /requestAnimationFrame\(function \(\) \{ plFrame = 0; renderPlaylist\(\); \}\)/);
  assert.match(ui, /if \(sig === plSig\) return;/);
  assert.match(ui, /var idxOf = new Map\(\);/);
  assert.match(ui, /Ev\.on\('playlist', schedulePlaylist\);/);
  assert.doesNotMatch(ui, /Ev\.on\('playstate', function \(\) \{ setPlayingChrome\(P\.playing\); renderPlaylist\(\);/);
  /* a folder must not spawn one ffprobe per file at startup */
  assert.doesNotMatch(app, /Player\.ensureToken\(it\)/);
});

check('invisible glass layers and idle animations stop costing frames', function () {
  assert.match(css, /\.chrome \.panel \{ pointer-events: none; visibility: hidden;/);
  assert.match(css, /\.zoom-badge\.show \{ opacity: 1; transform: none; visibility: visible; \}/);
  assert.match(css, /\.stack-busy \.loading i\.spinner \{ animation: spin/);
  assert.match(css, /html\.lores \.dock/);
  assert.match(lumenCss, /@keyframes eq \{ 0%,100%\{transform:scaleY\(\.3\)\} 50%\{transform:scaleY\(1\)\} \}/);
  /* the second idle poster is fetched only when it is shown */
  assert.match(html, /data-src="assets\/scene_dark\.jpg"/);
});

check('mute keeps the remembered level and the speed keys work', function () {
  /* one guarded writer for element volume: mute must not round-trip volume 0
     through volumechange and erase the slider value */
  assert.match(app, /applyVolume: function \(\) \{/);
  assert.match(app, /if \(self\._settingVolume\) return;/);
  assert.match(app, /Player\.applyVolume\(\);/);
  assert.match(ui, /if \(P\.applyVolume\) P\.applyVolume\(\);/);
  assert.doesNotMatch(ui, /P\.el\.volume = on \? 1 : \(S\.muted \? 0 : S\.volume\);/);
  /* [ and ] used to snap straight back to a preset and do nothing */
  assert.match(shell, /case '\[': case '\]': \{/);
  assert.doesNotMatch(shell, /P\.setSpeed\(Math\.(min|max)[^\n]*L\.UI\.cycleSpeed\(0\)/);
});


check('the build no longer depends on NSIS and the new icon is wired end to end', function () {
  /* build-installer: graceful skip (exit 3) + wide makensis discovery */
  assert.match(installer, /const EXIT_NO_NSIS = 3;/);
  assert.match(installer, /process\.exit\(EXIT_NO_NSIS\);/);
  assert.match(installer, /arg\('--makensis'\)/);
  assert.match(installer, /reg\.exe/);
  assert.match(installer, /NSIS_DIR/);
  /* the BAT maps that code to the "portable only" path instead of :fail */
  assert.match(bat, /if "%ERRORLEVEL%"=="3" goto :nsis_missing/);
  assert.match(bat, /^:no_nsis$/m);
  assert.match(bat, /Compress-Archive/);
  /* build-installer may only fail hard on a genuine error */
  assert.match(bat, /if errorlevel 1 goto :fail/);

  /* logo: vector source + rasters, all generated from the same mark */
  const mark = fs.readFileSync(path.join(root, 'assets', 'lumen-mark.svg'), 'utf8');
  assert.match(mark, /viewBox="0 0 512 512"/);
  assert.match(mark, /<g id="mark">/);
  const ico = fs.readFileSync(path.join(root, 'assets', 'icon.ico'));
  assert.equal(ico.readUInt16LE(2), 1, 'icon.ico is an icon file');
  assert.equal(ico.readUInt16LE(4), 7, 'icon.ico carries seven frames');
  const png = fs.readFileSync(path.join(root, 'assets', 'lumen-mark.png'));
  assert.equal(png.slice(1, 4).toString('ascii'), 'PNG');
  assert.ok(png.readUInt32BE(16) === 512 && png.readUInt32BE(20) === 512, '512×512 master');
  /* the renderer favicon must be the same artwork the window uses */
  assert.deepEqual(fs.readFileSync(path.join(root, 'web', 'assets', 'lumen-mark.png')), png);
  assert.deepEqual(fs.readFileSync(path.join(root, 'assets', 'icon.png')), png);
  /* and the .exe icon still comes from assets/icon.ico */
  assert.match(pack, /'assets', 'icon\.ico'/);
});


check('the build unpacks archives without needing unzip or 7-Zip', function () {
  /* one shared unpacker for the runtime archive and the FFmpeg entries */
  assert.match(pack, /const zipfs = require\('\.\/zipfs\.js'\);/);
  assert.match(pack, /zipfs\.extractAll\(/);
  assert.match(pack, /zipfs\.extractEntry\(/);
  assert.doesNotMatch(pack, /spawnSync\('unzip'/, 'pack.js must not call unzip directly');
  /* the fallback chain lives in zipfs.js, ending in a pure-Node reader */
  assert.match(zipfs, /inflateRawSync/);
  assert.match(zipfs, /0x06054b50/);
  assert.match(zipfs, /EncodedCommand/);
  assert.match(zipfs, /ZIP64 archives are not supported/);
  assert.match(zipfs, /refusing to write outside the output folder/);
  /* and the failure text points at the real cause instead of blaming tools */
  assert.match(bat, /unzip \/ 7-Zip are NOT required/);
});


console.log('\n' + results.length + '/' + results.length + ' UI/source/BAT static checks passed.');
