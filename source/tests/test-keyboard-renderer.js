'use strict';
/* ==========================================================================
   Lumen — tests/test-keyboard-renderer.js
   Headless renderer checks for the behaviours that are hard to see in a static
   test: PageDown / PageUp, Delete (trash + continue) and the two playlist
   performance guarantees (batched paints, no per-file probing on hydrate).

   It runs the *real* web/index.html together with the real app.js / ui.js /
   shell.js inside jsdom. jsdom is an optional dev dependency — the rest of the
   suite stays dependency-free:

       npm install --no-save jsdom
       node tests/test-keyboard-renderer.js
   ========================================================================== */
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

let JSDOM, VirtualConsole;
try {
  ({ JSDOM, VirtualConsole } = require('jsdom'));
} catch (e) {
  console.log('SKIP test-keyboard-renderer.js — jsdom is not installed.');
  console.log('     npm install --no-save jsdom');
  process.exit(0);
}

const root = path.join(__dirname, '..');
const web = path.join(root, 'web');
const html = fs.readFileSync(path.join(web, 'index.html'), 'utf8');

let deleted = [];
let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function makeDom(stats) {
  const vc = new VirtualConsole();
  vc.on('jsdomError', () => { });      /* HTMLMediaElement.play is "not implemented" */
  vc.on('error', () => { });
  const dom = new JSDOM(html, {
    url: 'http://127.0.0.1:1234/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    virtualConsole: vc
  });
  const w = dom.window;
  const ok = () => Promise.resolve(true);
  const api = {
    boot_state: () => Promise.resolve({
      version: '1.0.0', buildId: 'test', platform: 'win32', ffmpeg: true,
      ffmpegInfo: 'ffmpeg test', settings: {}, playlist: { index: -1, items: [] },
      resume: {}, subs: {}, lastFile: '', args: [], gpu: '', audio: '', dataDir: ''
    }),
    set_context_menu_enabled: ok,
    set_always_on_top: ok,
    settings_set: ok,
    save_playlist_silent: ok,
    resume_set: ok,
    remember_subs: ok,
    set_fullscreen: ok,
    set_mini: ok,
    set_hwaccel: () => Promise.resolve(null),
    set_hdr: ok,
    window_action: ok,
    probe: () => Promise.resolve(null),
    sidecar_subtitles: () => Promise.resolve([]),
    transcode_start: () => Promise.resolve({ url: '/transcode?t=x', start: 0 }),
    register_path: (p) => { stats.registered++; return Promise.resolve({ token: 'tok-' + p }); },
    register_url: () => Promise.resolve({ token: 'tok-url' }),
    media_delete: (p) => { deleted.push(p); return Promise.resolve({ ok: true }); }
  };
  w.pywebview = { api: api, version: '1.0.0', platform: 'electron', _jsApiCallback: () => Promise.resolve(null) };
  w.lumenNative = { host: 'test', pathForFile: () => '' };

  ['_icons.js', 'app-icons.js', 'app.js', 'ui.js', 'shell.js'].forEach((f) => {
    w.eval(fs.readFileSync(path.join(web, f), 'utf8') + '\n//# sourceURL=' + f);
  });
  return w;
}

function press(w, key) {
  w.dispatchEvent(new w.KeyboardEvent('keydown', { key: key, bubbles: true, cancelable: true }));
}

function countPlaylistPaints(w) {
  const stats = { paints: 0 };
  const desc = Object.getOwnPropertyDescriptor(w.Element.prototype, 'innerHTML');
  Object.defineProperty(w.Element.prototype, 'innerHTML', {
    configurable: true,
    get: desc.get,
    set: function (v) {
      if (this.id === 'plBody') stats.paints++;
      desc.set.call(this, v);
    }
  });
  return stats;
}

(async function () {
  const stats = { registered: 0 };
  const w = makeDom(stats);
  await wait(60);                       /* bridge handshake */
  const L = w.Lumen;
  assert.ok(L, 'Lumen must be on the window');
  assert.equal(L.Bridge.ready, true, 'the fake host bridge must be connected');

  ['A.mkv', 'B.mkv', 'C.mkv'].forEach((n) => L.Playlist.add({ name: n, demo: true, dur: 120, ext: 'mkv' }));
  L.loadItem(L.Playlist.items[0]);
  await wait(30);
  assert.equal(L.Player.item.name, 'A.mkv');

  press(w, 'PageDown'); await wait(20);
  check('PageDown plays the next item', function () {
    assert.equal(L.Player.item.name, 'B.mkv');
    assert.equal(L.Playlist.index, 1);
  });

  press(w, 'PageDown'); await wait(20);
  press(w, 'PageDown'); await wait(20);
  check('PageDown wraps to the first item at the end', function () {
    assert.equal(L.Player.item.name, 'A.mkv');
  });

  press(w, 'PageUp'); await wait(20);
  check('PageUp wraps back to the last item', function () {
    assert.equal(L.Player.item.name, 'C.mkv');
  });

  /* real paths: Delete must trash the file that was playing and move on */
  L.Playlist.items.forEach(function (it) { it.demo = false; it.path = 'C:\\videos\\' + it.name; it.token = 'tok'; });
  L.Playlist.index = 0;
  L.Player.item = L.Playlist.items[0];
  deleted = [];
  press(w, 'Delete');
  await wait(80);
  check('Delete plays the next file and trashes the previous one', function () {
    assert.deepEqual(deleted, ['C:\\videos\\A.mkv']);
    assert.equal(L.Playlist.items.some(function (it) { return it.name === 'A.mkv'; }), false);
    assert.notEqual(L.Player.item && L.Player.item.name, 'A.mkv');
  });

  const only = L.Playlist.items[0];
  L.Playlist.items = [only];
  L.Playlist.index = 0;
  L.Player.item = only;
  deleted = [];
  press(w, 'Delete');
  await wait(40);
  check('Delete never removes the only item in the playlist', function () {
    assert.deepEqual(deleted, []);
    assert.equal(L.Playlist.items.length, 1);
  });

  const paint = countPlaylistPaints(w);
  const bulk = [];
  for (let i = 0; i < 300; i++) bulk.push({ name: 'clip' + i + '.mkv', demo: true, dur: 60, ext: 'mkv' });
  L.Playlist.addMany(bulk);             /* one `playlist` event per item */
  await wait(60);
  check('adding 300 files repaints the playlist at most twice', function () {
    assert.ok(paint.paints <= 2, 'expected ≤2 paints, got ' + paint.paints);
  });

  stats.registered = 0;
  L.Playlist.hydrate({ index: 0, items: bulk.slice(0, 120) });
  await wait(60);
  check('hydrating a saved playlist does not probe every file', function () {
    assert.equal(stats.registered, 0);
    assert.equal(L.Playlist.items.length, 120);
  });

  check('the playlist panel is still rendered', function () {
    assert.ok(w.document.querySelector('#plBody').children.length >= 1);
  });

  console.log('\n' + passed + '/' + passed + ' headless renderer checks passed.');
  w.close();
  process.exit(0);
})().catch(function (e) {
  console.error('FAIL', e && (e.stack || e.message));
  process.exit(1);
});
