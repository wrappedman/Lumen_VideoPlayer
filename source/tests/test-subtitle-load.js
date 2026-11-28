'use strict';
/* ==========================================================================
   Lumen — tests/test-subtitle-load.js
   Regression tests for the subtitle pipeline that silently broke when
   _load() lost its `var self = this` (the embedded-track probe bailed out at
   `self.item !== item`, where `self` resolved to window.self):

     · the embedded tracks reported by the probe must reach subTracks
     · the auto-load picks an embedded track when no sidecar exists
     · sidecar + embedded tracks survive the probe merge
     · a manual "Off" is not undone by a late probe merge
     · windows-1256 / UTF-16 sidecar bytes decode to readable Persian

   The renderer runs inside jsdom exactly like test-ui-smoke.js; probe timing
   is fully controlled by the test. Host-side decoding needs no browser.

       npm install --no-save jsdom
       node tests/test-subtitle-load.js
   ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

/* ---------- host-side: legacy sidecar encodings decode correctly ---------- */
const util = require('../host/util');
const VTT = 'WEBVTT\n\n00:00:01.000 --> 00:00:04.000\nسلام دنیا\n\n';
assert.equal(util.decodeSubtitleBuffer(Buffer.from('1\n00:00:01,000 --> 00:00:04,000\nسلام دنیا\n', 'utf8')).includes('سلام'), true, 'utf8 decodes');
assert.equal(util.decodeSubtitleBuffer(Buffer.from('1\n00:00:01,000 --> 00:00:04,000\nسلام دنیا\n', 'utf16le')).includes('سلام'), true, 'utf16le without BOM decodes');
assert.equal(util.decodeSubtitleBuffer(Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from('1\n00:00:01,000 --> 00:00:04,000\nسلام دنیا\n', 'utf16le')])).includes('سلام'), true, 'utf16le with BOM decodes');
const cp1256 = Buffer.from([0x31, 0x0A, 0x30, 0x30, 0x3A, 0x30, 0x30, 0x3A, 0x30, 0x31, 0x2C, 0x30, 0x30, 0x30, 0x20, 0x2D, 0x2D, 0x3E, 0x20, 0x30, 0x30, 0x3A, 0x30, 0x30, 0x3A, 0x30, 0x34, 0x2C, 0x30, 0x30, 0x30, 0x0A, 0xD3, 0xE1, 0xC7, 0xE3, 0x0A]); /* "سلام" in cp1256 */
assert.equal(util.decodeSubtitleBuffer(cp1256).includes('سلام'), true, 'windows-1256 decodes');
console.log('PASS host decoder handles UTF-8/UTF-16/Windows-1256 sidecar bytes');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.log('SKIP renderer checks — jsdom is not installed.');
  console.log('     npm install --no-save jsdom');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const web = path.join(root, 'web');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function deferred() {
  let resolve, reject;
  const p = new Promise(function (res, rej) { resolve = res; reject = rej; });
  p.resolve = resolve; p.reject = reject;
  return p;
}

/* one fresh page per scenario: probe/sidecar bridge answers on our schedule */
function freshApp(opts) {
  opts = opts || {};
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => { if (!/not implemented/i.test(String(e && e.message))) errors.push(String(e && e.message)); });
  vc.on('error', (m) => errors.push(String(m)));
  const dom = new JSDOM(html, { url: 'http://127.0.0.1:1234/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window;
  w.addEventListener('unhandledrejection', (e) => errors.push('rejection: ' + (e.reason && (e.reason.stack || e.reason.message))));

  const probeGate = deferred();
  const api = {
    boot_state: () => Promise.resolve({
      version: '1.0.0', settings: {}, playlist: { index: -1, items: [] },
      resume: {}, subs: {}, args: [], ffmpeg: true, ffmpegInfo: 'ffmpeg test', gpu: '', audio: '', dataDir: ''
    }),
    set_context_menu_enabled: () => Promise.resolve(true), set_always_on_top: () => Promise.resolve(true),
    settings_set: () => Promise.resolve(true), save_playlist_silent: () => Promise.resolve(true),
    resume_set: () => Promise.resolve(true), remember_subs: () => Promise.resolve(true),
    set_fullscreen: () => Promise.resolve(true), set_mini: () => Promise.resolve(true),
    set_hdr: () => Promise.resolve(true), window_action: () => Promise.resolve(true),
    set_hwaccel: () => Promise.resolve(null),
    register_path: (p) => Promise.resolve({ token: 'tok-' + p }),
    register_url: () => Promise.resolve({ token: 'u' }),
    sidecar_subtitles: () => Promise.resolve(opts.sidecars || []),
    /* the probe answers only when the test releases the gate */
    probe: () => probeGate.then(() => opts.probe === undefined
      ? { subs: [{ id: 's:2', index: 2, order: 0, label: 'FAS · Persian · SUBRIP', kind: 'embedded', lang: 'fas', codec: 'subrip' }], audio: [], duration: 600, video: null }
      : opts.probe),
    transcode_start: () => Promise.resolve(null),
    open_files: () => Promise.resolve([]), open_subtitles: () => Promise.resolve([])
  };
  w.pywebview = { api: api, version: '1.0.0', platform: 'electron', _jsApiCallback: () => Promise.resolve(null) };
  w.lumenNative = { host: 'test', pathForFile: () => '' };
  w.fetch = (url) => {
    w.__lastFetch = String(url);
    return Promise.resolve({ ok: true, body: null, text: () => Promise.resolve(VTT) });
  };
  ['_icons.js', 'app-icons.js', 'app.js', 'ui.js', 'shell.js'].forEach((f) => {
    w.eval(fs.readFileSync(path.join(web, f), 'utf8') + '\n//# sourceURL=' + f);
  });
  return { w: w, L: w.Lumen, errors: errors, probeGate: probeGate };
}

(async function () {
  /* 1 — embedded track arrives with the probe and auto-loads (no sidecar) */
  {
    const env = freshApp({});
    await wait(120);
    const item = { name: 'film.mkv', path: '/movs/film.mkv', ext: 'mkv', dur: 600 };
    env.L.loadItem(item);
    await wait(60);                       /* sidecar lookup resolved; probe pending */
    assert.equal(env.L.Player.subTracks.length, 0, 'no tracks before the probe answers');
    env.probeGate.resolve();
    await wait(120);
    assert.deepEqual(env.L.Player.subTracks.map(function (t) { return t.id; }), ['s:2'],
      'the embedded track from the probe reached the track list');
    assert.ok(env.L.Player.subActive, 'the embedded track auto-loaded');
    assert.equal(env.L.Player.subActive.id, 's:2');
    assert.ok(env.L.Player.subCues.length > 0, 'cues parsed from the fetched track');
    assert.match(env.w.__lastFetch || '', /\/subtitle\?t=tok/);
    assert.deepEqual(env.errors, []);
    console.log('PASS embedded tracks from the probe reach the list and auto-load');
  }

  /* 2 — sidecar and embedded tracks merge; the sidecar keeps priority */
  {
    const env = freshApp({ sidecars: [{ path: '/movs/film.srt', label: 'SRT · film.srt' }] });
    await wait(120);
    const item = { name: 'film.mkv', path: '/movs/film.mkv', ext: 'mkv', dur: 600 };
    env.L.loadItem(item);
    await wait(80);                       /* sidecar resolved first, auto-picked */
    assert.equal(env.L.Player.subActive && env.L.Player.subActive.kind, 'external', 'sidecar picked first');
    env.probeGate.resolve();
    await wait(120);
    const ids = env.L.Player.subTracks.map(function (t) { return t.id; });
    assert.ok(ids.indexOf('ext:/movs/film.srt') >= 0, 'sidecar survives the probe merge');
    assert.ok(ids.indexOf('s:2') >= 0, 'embedded track merged in');
    assert.equal(env.L.Player.subActive.kind, 'external', 'the sidecar choice is not overridden');
    assert.deepEqual(env.errors, []);
    console.log('PASS sidecar + embedded tracks survive the probe merge');
  }

  /* 3 — a manual "Off" is never undone by the late probe merge */
  {
    const env = freshApp({ sidecars: [] });
    await wait(120);
    const item = { name: 'film.mkv', path: '/movs/film.mkv', ext: 'mkv', dur: 600 };
    env.L.loadItem(item);
    await wait(60);
    env.L.Player.setSubtitle(null);       /* the user switches subtitles off */
    env.probeGate.resolve();
    await wait(120);
    assert.equal(env.L.Player.subActive, null, 'the manual Off survives the probe merge');
    assert.ok(env.L.Player.subTracks.length >= 1, 'the embedded track still shows up as selectable');
    assert.deepEqual(env.errors, []);
    console.log('PASS a manual Off is not undone by the probe merge');
  }

  console.log('\nsubtitle load regression tests passed.');
  process.exit(0);
})().catch(function (e) {
  console.error('FAIL', e && (e.stack || e.message));
  process.exit(1);
});
