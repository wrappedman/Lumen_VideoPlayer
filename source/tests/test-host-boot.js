'use strict';
/* ==========================================================================
   Lumen — tests/test-host-boot.js
   Boot-path regression test for the desktop host (main.js). It fakes the
   `electron` module, runs the *real* main.js and checks the launch contract:

     1. the window is created and shown immediately — the engine scan
        (`ffmpeg -version` / `ffprobe -version`, and on Windows the registry
        PATH lookup) must no longer hold the launch hostage;
     2. boot_state answers only once that background scan has finished, so the
        renderer still gets the correct engine state, the saved playlist and
        the command-line files;
     3. the ffmpeg handlers (status / rescan) answer asynchronously.

   No dependencies: the fake engine binaries are small scripts written into a
   temp folder (POSIX). On Windows only the contract is checked, not the
   timing, because a fake .exe cannot be produced without a compiler.
   ========================================================================== */
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const Module = require('node:module');
const EventEmitter = require('node:events');

const ROOT = path.join(__dirname, '..');
const POSIX = process.platform !== 'win32';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-boot-'));
const userData = path.join(tmp, 'userdata');
const engineDir = path.join(tmp, 'ffmpeg-bin');
fs.mkdirSync(userData, { recursive: true });
fs.mkdirSync(engineDir, { recursive: true });

/* a deliberately slow engine: 150 ms per `-version` answers, exactly the kind
   of latency a real Windows ffmpeg + Defender scan produces */
const SLEEP = 0.15;
function fakeBin(name, version) {
  const file = path.join(engineDir, name);
  fs.writeFileSync(file, '#!/bin/sh\n' +
    'if [ "$2" = "-filters" ]; then echo " T.. zscale  V->V  zscale"; echo " T.. tonemap V->V tonemap"; exit 0; fi\n' +
    'sleep ' + SLEEP + '\n' +
    'echo "' + name + ' version ' + version + ' Copyright (c) the FFmpeg developers"\n', 'utf8');
  fs.chmodSync(file, 0o755);
}
fakeBin('ffmpeg', '9.0.2-test');
fakeBin('ffprobe', '9.0.2-test');

/* ------------------------------------------------------------ fake electron */
const ipcHandlers = new Map();
const windows = [];
const t0 = Date.now();
const marks = [];

class FakeWebContents extends EventEmitter {
  setWindowOpenHandler() { }
  openDevTools() { }
  executeJavaScript() { return Promise.resolve(null); }
  isLoading() { return false; }
}
class FakeWindow extends EventEmitter {
  constructor(opts) {
    super();
    this.options = opts || {};
    this.webContents = new FakeWebContents();
    this.bounds = { x: 60, y: 60, width: (opts && opts.width) || 1220, height: (opts && opts.height) || 720 };
    this.shown = false;
    this.destroyed = false;
    this.maximized = false;
    this.fullscreen = false;
    this.alwaysOnTop = false;
    this.loadedUrl = '';
  }
  show() { if (!this.shown) marks.push(['window shown', Date.now() - t0]); this.shown = true; }
  loadURL(url) { this.loadedUrl = url; setTimeout(() => this.emit('ready-to-show'), 5); return Promise.resolve(); }
  isDestroyed() { return this.destroyed; }
  getBounds() { return Object.assign({}, this.bounds); }
  getNormalBounds() { return Object.assign({}, this.bounds); }
  setBounds(b) { this.bounds = Object.assign({}, b); }
  getMinimumSize() { return [480, 300]; }
  setMinimumSize() { }
  maximize() { this.maximized = true; }
  unmaximize() { this.maximized = false; }
  isMaximized() { return this.maximized; }
  setFullScreen(on) { this.fullscreen = !!on; }
  isFullScreen() { return this.fullscreen; }
  setAlwaysOnTop(on) { this.alwaysOnTop = !!on; }
  isAlwaysOnTop() { return this.alwaysOnTop; }
  isMinimized() { return false; }
  restore() { }
  focus() { }
  close() { }
  destroy() { this.destroyed = true; this.emit('closed'); }
}
class FakeApp extends EventEmitter {
  constructor() {
    super();
    this.isPackaged = true;
    this.commandLine = { appendSwitch() { }, hasSwitch() { return false; } };
  }
  setAppUserModelId() { }
  getPath(name) { return name === 'userData' ? userData : tmp; }
  getGPUFeatureStatus() { return { gpu_compositing: 'enabled' }; }
  whenReady() { return Promise.resolve(); }
  requestSingleInstanceLock() { return true; }
  quit() { }
  disableHardwareAcceleration() { }
}
const app = new FakeApp();
const electron = {
  app,
  BrowserWindow: class extends FakeWindow {
    constructor(opts) { super(opts); windows.push(this); }
    static getAllWindows() { return windows.filter(function (w) { return !w.destroyed; }); }
  },
  ipcMain: { handle(channel, fn) { ipcHandlers.set(channel, fn); }, on() { } },
  dialog: {
    showErrorBox() { },
    showOpenDialog() { return Promise.resolve({ canceled: true, filePaths: [] }); },
    showSaveDialog() { return Promise.resolve({ canceled: true }); }
  },
  shell: { openExternal() { }, showItemInFolder() { }, trashItem() { return Promise.resolve(); } },
  Menu: { setApplicationMenu() { } },
  screen: {
    getAllDisplays() { return [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }]; },
    getDisplayMatching() { return { workArea: { x: 0, y: 0, width: 1920, height: 1080 } }; }
  },
  globalShortcut: { register() { return true; }, unregister() { } },
  clipboard: { readText() { return ''; }, writeText() { } }
};
const originalLoad = Module._load;
Module._load = function (request) {
  if (request === 'electron') return electron;
  return originalLoad.apply(this, arguments);
};

/* --------------------------------------------------------------- run main.js */
fs.writeFileSync(path.join(userData, 'config.json'), JSON.stringify({
  settings: { volume: 0.42 },
  playlist: { index: -1, items: [] },
  window: { x: 60, y: 60, width: 1220, height: 720 }
}), 'utf8');

process.env.LUMEN_FFMPEG = engineDir;
require(path.join(ROOT, 'main.js'));
marks.push(['main.js loaded', Date.now() - t0]);

function call(name) {
  const args = Array.prototype.slice.call(arguments, 1);
  return ipcHandlers.get('lumen:call')({}, name, args);
}

function finish(code) {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { }
  process.exit(code);
}

function fail(e) {
  console.error('FAIL ' + ((e && e.message) || e));
  if (e && e.stack) console.error(e.stack);
  finish(1);
}

setTimeout(function () {
  try {
    run();
  } catch (e) { fail(e); }
}, 60);

function run() {
  const win = windows[0];
  assert.ok(win, 'main.js must create a BrowserWindow');
  assert.ok(win.shown, 'the window must be shown immediately, not gated behind ready-to-show');
  assert.match(win.loadedUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/, 'the window loads the local server origin');
  assert.equal(win.options.backgroundColor, '#0b0d13', 'an opaque background avoids a white flash while the page loads');

  Promise.resolve().then(function () {
    return call('boot_state');
  }).then(function (state) {
    marks.push(['boot_state answered', Date.now() - t0]);
    assert.ok(state && typeof state === 'object', 'boot_state must answer with an object');
    assert.equal(!!state.ffmpeg, true, 'the fake engine must be detected before boot_state answers');
    assert.match(String(state.ffmpegInfo || ''), /ffmpeg 9\.0\.2-test/, 'the version comes from the detection scan');
    assert.deepEqual(state.args, [], 'no command-line files in this run');
    assert.equal(state.settings.volume, 0.42, 'settings come from config.json');
    assert.ok(Array.isArray(state.playlist.items), 'the saved playlist travels with boot_state');

    if (POSIX) {
      const shown = marks.find(function (m) { return m[0] === 'window shown'; });
      const boot = marks.find(function (m) { return m[0] === 'boot_state answered'; });
      assert.ok(shown && boot, 'both marks are recorded');
      /* the engine answers after 150 ms of child-process time: the window must
         already be up long before that, and boot_state must be the one that
         waited */
      assert.ok(shown[1] < 120, 'the window must appear before the engine scan finishes (was ' + shown[1] + ' ms)');
      assert.ok(boot[1] - shown[1] >= 100,
        'boot_state waits for the engine scan (shown ' + shown[1] + ' ms, boot ' + boot[1] + ' ms)');
    }
    return call('ffmpeg_status');
  }).then(function (status) {
    assert.equal(status && status.available, true, 'ffmpeg_status reports the detected engine');
    assert.match(String(status.version || ''), /9\.0\.2-test/, 'the version is reported without another spawn');
    assert.ok(Array.isArray(status.dirs), 'search dirs stay exposed for the Settings panel');
    return call('probe', path.join(tmp, 'not-a-file.mkv'));
  }).then(function (probed) {
    assert.equal(probed, null, 'probing a missing file answers null instead of throwing');
    return call('ffmpeg_rescan');
  }).then(function (rescan) {
    assert.equal(rescan && rescan.available, true, 'ffmpeg_rescan is asynchronous and reports availability');
    /* the local server prefers one stable port (Chromium cache reuse) and must
       fall back to an ephemeral one when it is taken — twice, never crashing */
    const other = require(path.join(ROOT, 'host', 'server.js')).createServer({ webDir: path.join(ROOT, 'web') });
    return other.listen().then(function (info) {
      assert.ok(info && info.port > 0, 'a second server still starts when the preferred port is taken');
      assert.notEqual(info.origin, win.loadedUrl, 'the second server picks a different port');
      try { other.close(); } catch (e) { }
      console.log('PASS the window is shown before the background engine scan finishes');
      console.log('PASS boot_state waits for the engine scan instead of shipping half a state');
      console.log('PASS ffmpeg status / rescan / probe work over the asynchronous engine');
      console.log('PASS the local server falls back to another port when its preferred one is busy');
      console.log('\n4/4 host boot checks passed.');
      finish(0);
    });
  }).catch(fail);
}
