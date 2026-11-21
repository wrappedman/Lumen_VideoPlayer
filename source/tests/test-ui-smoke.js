'use strict';
/* ==========================================================================
   Lumen — tests/test-ui-smoke.js
   One broad pass over the real interface inside jsdom: transport, panels,
   settings widgets, low-resource mode, volume, playlist search, shortcut
   sheet, context menu, zoom and mode switches. The test fails on any
   uncaught error or rejected promise thrown by the renderer.

       npm install --no-save jsdom
       node tests/test-ui-smoke.js
   ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.log('SKIP test-ui-smoke.js — jsdom is not installed.');
  console.log('     npm install --no-save jsdom');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const web = path.join(root, 'web');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');

const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => {
  if (!/not implemented/i.test(String(e && e.message))) errors.push(String(e && e.message));
});
vc.on('error', (m) => errors.push(String(m)));

const dom = new JSDOM(html, {
  url: 'http://127.0.0.1:1234/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
  virtualConsole: vc
});
const w = dom.window;
w.addEventListener('error', (e) => errors.push('window error: ' + (e.message || e.error)));
w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason && e.reason.message)));

const ok = () => Promise.resolve(true);
const api = {
  boot_state: () => Promise.resolve({
    version: '1.0.0', buildId: 'test', settings: {},
    playlist: { index: -1, items: [] }, resume: {}, subs: {}, args: [],
    ffmpeg: true, ffmpegInfo: 'ffmpeg test', gpu: '', audio: '', dataDir: ''
  }),
  set_context_menu_enabled: ok, set_always_on_top: ok, settings_set: ok, save_playlist_silent: ok,
  resume_set: ok, remember_subs: ok, set_fullscreen: ok, set_mini: ok, set_hdr: ok, window_action: ok,
  set_hwaccel: () => Promise.resolve(null),
  probe: () => Promise.resolve(null),
  sidecar_subtitles: () => Promise.resolve([]),
  register_path: (p) => Promise.resolve({ token: 't-' + p }),
  register_url: () => Promise.resolve({ token: 'u' }),
  transcode_start: () => Promise.resolve({ url: '/transcode?t=x', start: 0 }),
  media_delete: () => Promise.resolve({ ok: true }),
  ffmpeg_status: () => Promise.resolve({ available: true, version: '9.0.2', bundled: true }),
  open_files: () => Promise.resolve([]),
  open_subtitles: () => Promise.resolve([])
};
w.pywebview = { api: api, version: '1.0.0', platform: 'electron', _jsApiCallback: () => Promise.resolve(null) };
w.lumenNative = { host: 'test', pathForFile: () => '' };

['_icons.js', 'app-icons.js', 'app.js', 'ui.js', 'shell.js'].forEach((f) => {
  w.eval(fs.readFileSync(path.join(web, f), 'utf8') + '\n//# sourceURL=' + f);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const $ = (sel) => w.document.querySelector(sel);
function click(el) {
  assert.ok(el, 'missing element');
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true, cancelable: true }));
}
function press(key) {
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
}

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('PASS ' + name); }

(async function () {
  await wait(80);
  const L = w.Lumen;

  ['one.mkv', 'two.mkv', 'three.mkv'].forEach(function (n) {
    L.Playlist.add({ name: n, demo: true, dur: 90, ext: 'mkv' });
  });
  L.loadItem(L.Playlist.items[0]);
  await wait(30);

  click($('#btnPlay')); await wait(20);
  press('ArrowRight'); await wait(20);
  press('PageDown'); await wait(20);
  check('transport: play, seek and PageDown', function () {
    assert.equal(L.Player.item.name, 'two.mkv');
  });

  press('p'); await wait(20);
  const openedPlaylist = $('#panelPlaylist').classList.contains('open');
  press('i'); await wait(20);
  const openedSettings = $('#panelSettings').classList.contains('open');
  const closedPlaylist = !$('#panelPlaylist').classList.contains('open');
  press('Escape'); await wait(20);
  check('playlist/settings panels swap and close with Escape', function () {
    assert.ok(openedPlaylist && openedSettings && closedPlaylist);
    assert.ok(!$('#panelSettings').classList.contains('open'));
  });

  const lores = $('.switch[data-set="lores"]');
  click(lores); await wait(20);
  const blurOff = w.document.documentElement.style.getPropertyValue('--glass-blur').trim();
  const loresOn = L.S.lores && w.document.documentElement.classList.contains('lores');
  click(lores); await wait(20);
  const blurBack = w.document.documentElement.style.getPropertyValue('--glass-blur').trim();
  check('low-resource mode really removes the blur', function () {
    assert.equal(loresOn, true);
    assert.equal(blurOff, '0px');
    assert.equal(blurBack, '22px');
  });

  click($('.seg[data-set="seekstep"] button[data-v="30"]')); await wait(20);
  click($('.seg[data-set="theme"] button[data-v="light"]')); await wait(20);
  check('settings widgets write through to the state', function () {
    assert.equal(L.S.seekstep, 30);
    assert.equal(L.S.theme, 'light');
  });

  L.setVolume(0.4); await wait(10);
  click($('#btnMute')); await wait(10);
  const muted = L.S.muted;
  click($('#btnMute')); await wait(10);
  check('volume rail and mute', function () {
    assert.equal(L.S.volume, 0.4);
    assert.equal(muted, true);
    assert.equal(L.S.muted, false);
  });

  const search = $('#plSearch');
  search.value = 'two';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  await wait(30);
  const filtered = $('#plBody').textContent;
  search.value = '';
  search.dispatchEvent(new w.Event('input', { bubbles: true }));
  await wait(20);
  check('playlist search filters and clears', function () {
    assert.ok(filtered.includes('two.mkv'));
    assert.ok(!filtered.includes('one.mkv'));
  });

  press('F1'); await wait(20);
  const sheetOpen = $('#modalBd').classList.contains('open');
  press('Escape'); await wait(20);
  const sheetClosed = !$('#modalBd').classList.contains('open');
  check('F1 shortcut sheet opens and closes', function () {
    assert.ok(sheetOpen && sheetClosed);
  });

  press(']'); await wait(10);
  const fast = L.S.speed;
  press('['); await wait(10);
  const normal = L.S.speed;
  press('+'); await wait(10);
  const zoomed = L.Zoom.z;
  press('Escape'); await wait(20);
  check('speed keys and zoom work', function () {
    assert.equal(fast, 1.25);
    assert.equal(normal, 1);
    assert.ok(zoomed > 1);
    assert.equal(L.Zoom.z, 1);
  });

  $('#stack').dispatchEvent(new w.MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 200, clientY: 200 }));
  await wait(30);
  const menu = !!$('.ctx');
  press('Escape'); await wait(20);
  check('right-click menu opens and closes', function () { assert.ok(menu); });

  click($('#plClear')); await wait(30);
  press('PageDown'); await wait(20);
  press('Delete'); await wait(20);
  check('an empty playlist survives PageDown/Delete', function () {
    assert.equal(L.Playlist.items.length, 0);
  });

  w.dispatchEvent(new w.Event('resize'));
  L.UI.setMode('full'); await wait(20);
  L.UI.setMode('mini'); await wait(20);
  L.UI.setMode('window'); await wait(40);
  check('resize and mode switches throw nothing', function () { assert.ok(true); });

  check('no uncaught renderer errors', function () {
    assert.deepEqual(errors, []);
  });

  console.log('\n' + passed + '/' + passed + ' interaction smoke checks passed.');
  w.close();
  process.exit(0);
})().catch(function (e) {
  console.error('FAIL', e && (e.stack || e.message));
  if (errors.length) console.error('renderer errors:', errors);
  process.exit(1);
});
