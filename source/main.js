'use strict';
/* ==========================================================================
   Lumen — main.js · Electron desktop host
   --------------------------------------------------------------------------
   The whole player (liquid glass UI, gestures, zoom/pan, subtitles, playlist,
   settings, animations) is plain HTML/CSS/JS and lives untouched in ./web.
   This file only provides what a browser cannot:

     · a frameless, always-on-top capable desktop window with custom chrome
     · a local media server (/media, /transcode, /thumb, /subtitle) so big
       files stream with byte ranges instead of being copied around
     · ffmpeg hooks for exotic containers (MKV/HEVC/DTS …)
     · native file dialogs, drag & drop paths, config storage
   ========================================================================== */
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, screen, globalShortcut, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const util = require('./host/util');
const { createStore } = require('./host/store');
const { createFfmpeg } = require('./host/ffmpeg');
const { createServer } = require('./host/server');

const WEB_DIR = path.join(__dirname, 'web');
const IS_DEV = process.argv.indexOf('--dev') >= 0 || !app.isPackaged;
const VERBOSE = process.argv.indexOf('--verbose') >= 0;
const VERSION = '1.0.0';
const BUILD_ID = 'r9-2026-10-04';

function log() {
  if (VERBOSE || IS_DEV) console.log.apply(console, ['[lumen]'].concat(Array.prototype.slice.call(arguments)));
}

/* --------------------------------------------------------------------------
   early settings — hardware acceleration has to be decided before `ready`
   -------------------------------------------------------------------------- */
function userDataDir() {
  try { return app.getPath('userData'); } catch (e) { return path.join(process.cwd(), 'userdata'); }
}

function earlyReadConfig() {
  try {
    const f = path.join(userDataDir(), 'config.json');
    if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, 'utf8')) || {};
  } catch (e) { }
  return {};
}

const earlyCfg = earlyReadConfig();
const earlySettings = (earlyCfg && earlyCfg.settings) || {};
if (earlySettings.hw === false) {
  try { app.disableHardwareAcceleration(); } catch (e) { }
}
/* the player starts playing right away when a file is on the command line */
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (earlySettings.hw === false) app.commandLine.appendSwitch('disable-gpu-compositing');

/* --------------------------------------------------------------------------
   single instance: a second launch just hands its files to the running app
   -------------------------------------------------------------------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let win = null;
let srv = null;
let ff = null;
let store = null;
let origin = '';
let isMini = false;
let prevBounds = null;
let miniPlacedAt = 0;        /* when the mini window was placed by us */
let miniUserMoved = false;   /* the user dragged it since then */
let quitting = false;
let closing = false;
let bootArgs = [];
const uploads = new Map();          /* drop id -> { file, stream, received } */
const probeWarm = new Map();        /* path -> probe info (token hand-out warm-up) */
const PROBE_WARM_MAX = 40;          /* a folder can hold thousands of files */

/* keep the metadata cache bounded: an unbounded Map kept every probe result
   (and every stream's metadata) alive for the whole session */
function rememberProbe(p, info) {
  if (!p || !info) return;
  if (probeWarm.has(p)) probeWarm.delete(p);   /* refresh insertion order */
  probeWarm.set(p, info);
  while (probeWarm.size > PROBE_WARM_MAX) {
    probeWarm.delete(probeWarm.keys().next().value);
  }
}

/* ============================================================== argv/plumbing */
function collectPaths(argv) {
  const out = [];
  (argv || []).forEach(function (a) {
    if (!a || a.charAt(0) === '-') return;
    try {
      if (util.isFile(a) && (util.isMediaExt(util.extName(a)) || util.isSubExt(util.extName(a)))) out.push(path.resolve(a));
      else if (util.isDir(a)) util.listFolderFiles(path.resolve(a)).forEach(function (f) { out.push(f); });
    } catch (e) { }
  });
  return out;
}

/* ============================================================== window */
function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

function saneBounds(b) {
  if (!b || typeof b !== 'object') return null;
  const width = clamp(Math.round(Number(b.width) || 0), 480, 20000);
  const height = clamp(Math.round(Number(b.height) || 0), 300, 20000);
  if (!width || !height) return null;
  let x = Number(b.x), y = Number(b.y);
  /* keep the window on a screen that still exists */
  try {
    const displays = screen.getAllDisplays();
    const visible = displays.some(function (d) {
      const a = d.workArea;
      return x + width > a.x - 40 && x < a.x + a.width + 40 && y + height > a.y - 40 && y < a.y + a.height + 40;
    });
    if (!visible) { x = undefined; y = undefined; }
  } catch (e) { }
  const out = { width: width, height: height };
  if (isFinite(x)) out.x = Math.round(x);
  if (isFinite(y)) out.y = Math.round(y);
  return out;
}

function rememberMiniPos() {
  if (!win || !isMini || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    const st = store.windowState() || {};
    store.setWindowState(Object.assign({}, st, {
      mini: { x: b.x, y: b.y, width: b.width, height: b.height }
    }));
  } catch (e) { }
}

function rememberBounds() {
  if (!win || isMini || win.isDestroyed()) return;
  try {
    const b = win.getBounds();
    const prev = store.windowState() || {};
    store.setWindowState({
      x: b.x, y: b.y, width: b.width, height: b.height,
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
      mini: prev.mini                       /* keep where the mini player was parked */
    });
  } catch (e) { }
}

function createWindow() {
  const saved = saneBounds(store.windowState());
  const options = {
    width: saved ? saved.width : 1220,
    height: saved ? saved.height : 720,
    minWidth: 480,
    minHeight: 300,
    show: false,
    frame: false,
    transparent: false,                 /* opaque = rock solid video playback */
    backgroundColor: '#0b0d13',
    autoHideMenuBar: true,
    title: 'Lumen',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,          /* the bridge mirrors pywebview's API */
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      enableWebSQL: false,
      defaultEncoding: 'utf-8'
    }
  };
  if (saved && isFinite(saved.x)) { options.x = saved.x; options.y = saved.y; }

  win = new BrowserWindow(options);
  Menu.setApplicationMenu(null);

  win.once('ready-to-show', function () {
    win.show();
    const st = store.windowState() || {};
    if (st.maximized) win.maximize();
    if (IS_DEV && !app.isPackaged && process.argv.indexOf('--devtools') >= 0) {
      win.webContents.openDevTools({ mode: 'detach' });
    }
  });

  win.loadURL(origin + '/');

  /* the app is a single page: never navigate away, never open new windows */
  win.webContents.on('will-navigate', function (e, url) {
    if (url.indexOf(origin) !== 0) {
      e.preventDefault();
      if (/^https?:/i.test(url)) shell.openExternal(url);
    }
  });
  win.webContents.setWindowOpenHandler(function (details) {
    if (/^https?:/i.test(details.url)) shell.openExternal(details.url);
    return { action: 'deny' };
  });
  win.webContents.on('render-process-gone', function (e, details) {
    log('renderer gone:', details && details.reason);
  });

  /* dev conveniences (F12 = devtools) */
  win.webContents.on('before-input-event', function (e, input) {
    if (input.type !== 'keyDown') return;
    if (input.key === 'F12') { win.webContents.toggleDevTools(); e.preventDefault(); }
    if (IS_DEV && (input.control || input.meta) && input.key.toLowerCase() === 'r') {
      win.webContents.reloadIgnoringCache(); e.preventDefault();
    }
  });

  let rt = null;
  const scheduleBounds = function () {
    clearTimeout(rt);
    rt = setTimeout(rememberBounds, 400);
  };
  win.on('resize', scheduleBounds);
  win.on('move', function () {
    /* in the mini player the window itself is the whole UI: remember where the
       user parked it (the first move after entering is our own placement) */
    if (isMini) {
      if (!miniUserMoved && Date.now() - miniPlacedAt > 650) miniUserMoved = true;
      if (miniUserMoved) rememberMiniPos();
    }
    scheduleBounds();
  });
  win.on('maximize', scheduleBounds);
  win.on('unmaximize', scheduleBounds);

  win.on('enter-full-screen', function () { notifyUi("Lumen.UI.setMode('full')"); });
  win.on('leave-full-screen', function () {
    if (isMini) return;
    notifyUi("if(Lumen.UI.el.body.dataset.mode==='full'){Lumen.UI.setMode('window');}");
  });

  win.on('focus', registerMediaKeys);
  win.on('blur', releaseMediaKeys);

  /* clean shutdown: let the renderer push its last settings/playlist first */
  win.on('close', function (e) {
    if (quitting || closing) return;
    e.preventDefault();
    closing = true;
    let settled = false;
    const finish = function () {
      if (settled) return;
      settled = true;
      rememberBounds();
      try { store.flush(); } catch (er) { }
      try { win.destroy(); } catch (er) { }
    };
    const js = '(function(){try{' +
      'if(window.Lumen){' +
      'if(Lumen.saveSettingsNow)Lumen.saveSettingsNow();' +
      'if(Lumen.Bridge&&Lumen.Bridge.call)Lumen.Bridge.call("save_playlist_silent",JSON.stringify(Lumen.Playlist.serialize()));' +
      '}}catch(e){}})()';
    try {
      Promise.resolve(win.webContents.executeJavaScript(js, true))
        .then(function () { setTimeout(finish, 150); })
        .catch(finish);
    } catch (er) { finish(); }
    setTimeout(finish, 1500);
  });

  win.on('closed', function () { win = null; });
}

function notifyUi(js) {
  try { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(js, true); } catch (e) { }
}

function sendCommand(cmd) {
  notifyUi('window.lumenHost && window.lumenHost.command(' + JSON.stringify(cmd) + ')');
}

/* -------- media keys only while Lumen is focused (never steal them) ------- */
function registerMediaKeys() {
  try {
    globalShortcut.register('MediaPlayPause', function () { sendCommand('play-pause'); });
    globalShortcut.register('MediaNextTrack', function () { sendCommand('next'); });
    globalShortcut.register('MediaPreviousTrack', function () { sendCommand('prev'); });
    globalShortcut.register('MediaStop', function () { sendCommand('stop'); });
  } catch (e) { }
}
function releaseMediaKeys() {
  ['MediaPlayPause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop'].forEach(function (k) {
    try { globalShortcut.unregister(k); } catch (e) { }
  });
}

/* =============================================================== ffmpeg (manual)
   There is deliberately NO automatic downloader any more: the user picks
   ffmpeg.exe (or the folder that holds it) once and Lumen remembers it. The
   path is handed to host/ffmpeg.js through LUMEN_FFMPEG, which is the module's
   own "explicit override" search step. */
function manualFfmpeg() {
  try { return String(store.get('ffmpegManual') || ''); } catch (e) { return ''; }
}
function setManualFfmpeg(p) {
  try { store.set('ffmpegManual', p || ''); store.flush(); } catch (e) { }
}
function applyManualFfmpeg() {
  try {
    const p = manualFfmpeg();
    if (p) process.env.LUMEN_FFMPEG = p;
  } catch (e) { }
}
/* the folder that really holds the binaries, whatever the user clicked */
function ffmpegDirFrom(p) {
  try {
    if (!p) return '';
    let st = null;
    try { st = fs.statSync(p); } catch (e) { st = null; }
    let dir = (st && st.isDirectory()) ? p : path.dirname(p);
    if (fs.existsSync(path.join(dir, 'ffmpeg.exe'))) return dir;
    if (fs.existsSync(path.join(dir, 'bin', 'ffmpeg.exe'))) return path.join(dir, 'bin');
    return dir;
  } catch (e) { return ''; }
}
function isBundledFfmpeg() {
  try {
    if (!ff || !ff.path || !process.resourcesPath) return false;
    const root = path.resolve(process.resourcesPath, 'ffmpeg');
    const rel = path.relative(root, path.resolve(ff.path));
    return !!rel && rel !== '..' && rel.indexOf('..' + path.sep) !== 0 && !path.isAbsolute(rel);
  } catch (e) { return false; }
}

/* ============================================================== mini player */
function setMini(on, square) {
  if (!win || win.isDestroyed()) return;
  if (on && !isMini) {
    if (win.isFullScreen()) win.setFullScreen(false);
    if (win.isMaximized()) win.unmaximize();
    const b = win.getBounds();
    prevBounds = { x: b.x, y: b.y, width: b.width, height: b.height };
    const area = screen.getDisplayMatching(b).workArea;
    let w, h;
    if (square) {
      /* video in the mini player: a real little picture window, with the bar
         underneath — square-ish, so the frame is not squeezed into a strip */
      w = clamp(Math.round(Math.min(b.width, b.height) * 0.62), 320, 560);
      h = w + 46;
    } else {
      /* audio: the slim bar is the right shape */
      w = clamp(Math.round(b.width * 0.42), 420, 620);
      h = 128;
    }
    const x = clamp(b.x + Math.round((b.width - w) / 2), area.x, area.x + area.width - w);
    const y = clamp(b.y + b.height - h - 40, area.y, area.y + area.height - h);
    /* where the *user* left the mini player last time wins over the guess */
    const st = store.windowState() || {};
    const saved = st.mini;
    let mx = x, my = y;
    if (saved && isFinite(saved.x) && isFinite(saved.y)) {
      mx = clamp(saved.x, area.x - w + 90, area.x + area.width - 90);
      my = clamp(saved.y, area.y, area.y + area.height - 40);
    }
    isMini = true;
    miniPlacedAt = Date.now();
    miniUserMoved = false;
    win.setMinimumSize(square ? 300 : 380, square ? 300 : 110);
    win.setBounds({ x: mx, y: my, width: w, height: h }, true);
    win.setAlwaysOnTop(!!store.settings().ontop || true, 'floating');
  } else if (!on && isMini) {
    isMini = false;
    win.setMinimumSize(480, 300);
    if (prevBounds) win.setBounds(prevBounds, true);
    win.setAlwaysOnTop(!!store.settings().ontop, 'floating');
  }
}

/* ============================================================== bridge */
const MEDIA_EXT = ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'mpg', 'mpeg', 'ts', 'm2ts', 'wmv',
  'flv', 'ogv', '3gp', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'mka',
  'm3u8', 'm3u'];
const SUB_EXT = ['srt', 'vtt', 'ass', 'ssa', 'sub', 'txt', 'ttml', 'dfxp'];

/* --------------------------------------------------------------------------
   online subtitle discovery — used by "Open URL / stream…".
   Two sources are checked:
     1. subtitle files sitting next to the stream on the same server
        (movie.mkv → movie.srt, movie.fa.srt, movie.en.vtt, …)
     2. subtitle *streams* inside the remote container, read with ffprobe
   -------------------------------------------------------------------------- */
const SUB_URL_LANGS = ['', 'fa', 'per', 'fas', 'persian', 'farsi', 'en', 'eng', 'english', 'forced', 'sdh'];

function subtitleCandidates(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch (e) { return []; }
  const pathname = u.pathname;
  if (/[.](m3u8|mpd)$/i.test(pathname)) return [];              /* playlists carry their own tracks */
  const dot = pathname.lastIndexOf('.');
  const stem = dot > pathname.lastIndexOf('/') ? pathname.slice(0, dot) : pathname;
  const out = [];
  SUB_URL_LANGS.forEach(function (lang) {
    ['srt', 'vtt'].forEach(function (ext) {
      const candidate = stem + (lang ? '.' + lang : '') + '.' + ext;
      if (out.indexOf(candidate) < 0) out.push(candidate);
    });
  });
  return out.slice(0, 24).map(function (p) { return u.origin + p; });
}

function probeSubtitleUrl(url, depth) {
  return new Promise(function (resolve) {
    depth = depth || 0;
    if (depth > 3) { resolve(false); return; }
    let target;
    try { target = new URL(url); } catch (e) { resolve(false); return; }
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.get(target, {
      headers: { 'User-Agent': 'Lumen/' + VERSION, 'Range': 'bytes=0-2047', 'Accept': '*/*' }
    }, function (res) {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        probeSubtitleUrl(new URL(res.headers.location, target).toString(), depth + 1).then(resolve);
        return;
      }
      if (code !== 200 && code !== 206) { res.resume(); resolve(false); return; }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (d) { body += d; if (body.length > 4096) { try { req.destroy(); } catch (e) { } } });
      res.on('end', function () { resolve(/-->/.test(body) || /^WEBVTT/i.test(body.trim()) || /^\uFEFF?WEBVTT/i.test(body)); });
      res.on('error', function () { resolve(false); });
    });
    req.setTimeout(9000, function () { try { req.destroy(); } catch (e) { } resolve(false); });
    req.on('error', function () { resolve(false); });
  });
}

async function remoteProbe(url) {
  const out = { ok: false, url: url, subs: [], audio: [], needsFfmpeg: false, duration: 0, error: '' };
  if (!/^https?:/i.test(String(url || ''))) { out.error = 'not an http(s) link'; return out; }
  out.ok = true;

  /* 1) sidecar subtitle files next to the stream */
  const candidates = subtitleCandidates(url);
  for (let i = 0; i < candidates.length; i++) {
    const hit = await probeSubtitleUrl(candidates[i]);
    if (hit) {
      const name = decodeURIComponent((candidates[i].split('?')[0].split('/').pop() || 'subtitle'));
      out.subs.push({ id: 'netfile:' + candidates[i], label: name + ' · online', kind: 'remote', url: candidates[i] });
    }
  }

  /* 2) tracks muxed into the stream itself (needs ffmpeg) */
  if (ff && ff.available() && typeof ff.probeUrl === 'function') {
    try {
      const info = await ff.probeUrl(url);
      if (info) {
        (info.subs || []).forEach(function (t) {
          out.subs.push({ id: 'netstream:' + t.index, label: (t.label || 'Subtitle') + ' · in the stream',
            kind: 'embedded', index: t.index });
        });
        out.audio = (info.audio || []).map(function (a) {
          return { id: 'a:' + a.order, order: a.order, index: a.index, label: (a.label || 'Audio') + ' · online',
            codec: a.codec, lang: a.lang, channels: a.channels, default: !!a.default };
        });
        out.duration = info.duration || 0;
        out.width = info.width || 0;
        out.height = info.height || 0;
        out.vcodec = info.vcodec || '';
        out.acodec = info.acodec || '';
        out.profile = info.profile || '';
        out.pixfmt = info.pixfmt || '';
        out.hdr = !!info.hdr;
        out.video = info.video ? {
          codec_name: info.video.codec_name || '', profile: info.video.profile || '',
          pix_fmt: info.video.pix_fmt || '', width: info.video.width || 0, height: info.video.height || 0
        } : null;
        out.probed = true;
      } else out.probeFailed = true;
    } catch (e) { out.probeFailed = true; }
  } else {
    out.needsFfmpeg = true;
  }
  log('[lumen] remote_probe ' + url + ' → ' + out.subs.length + ' subtitle track(s), ' +
    out.audio.length + ' audio track(s)' + (out.needsFfmpeg ? ' (ffmpeg missing)' : ''));
  return out;
}

const handlers = {
  /* ---------------------------------------------------------- window shell */
  window_action: function (action) {
    if (!win || win.isDestroyed()) return false;
    switch (action) {
      case 'minimize': win.minimize(); break;
      case 'maximize': if (isMini) setMini(false); win.maximize(); break;
      case 'restore': if (win.isFullScreen()) win.setFullScreen(false); if (win.isMaximized()) win.unmaximize(); break;
      case 'close': win.close(); break;
      case 'toggle-max': if (win.isMaximized()) win.unmaximize(); else win.maximize(); break;
      default: return false;
    }
    return true;
  },
  set_fullscreen: function (on) {
    if (!win || win.isDestroyed()) return false;
    if (on && isMini) setMini(false);
    win.setFullScreen(!!on);
    return true;
  },
  set_mini: function (on, square) { setMini(!!on, !!square); return true; },
  set_always_on_top: function (on) {
    if (!win || win.isDestroyed()) return false;
    win.setAlwaysOnTop(!!on, on ? 'floating' : 'normal');
    return true;
  },
  set_context_menu_enabled: function () { return true; },
  clipboard_read_text: function () {
    try { return clipboard.readText(); } catch (e) { return ''; }
  },
  clipboard_write_text: function (text) {
    try { clipboard.writeText(String(text == null ? '' : text)); return true; } catch (e) { return false; }
  },
  set_hwaccel: function (on) {
    const s = store.settings();
    const changed = (s.hw !== undefined ? !!s.hw : true) !== !!on;
    s.hw = !!on;              /* applied on the next start (Chromium limit) */
    store.setSettings(s);
    store.flush();
    return changed;
  },
  ffmpeg_status: function () {
    return {
      available: !!(ff && ff.available()),
      probe: !!(ff && ff.canProbe()),
      bundled: isBundledFfmpeg(),
      version: (ff && ff.version) ? ff.version() : '',
      path: (ff && ff.path) || '',
      dirs: (ff && ff.searchDirs) ? ff.searchDirs() : []
    };
  },
  /* Settings → Media engine → "Choose ffmpeg.exe…".
     An explicit path argument skips the dialog (used by the tests, and by
     dropping ffmpeg.exe onto the window). */
  ffmpeg_pick: function (forced) {
    const finish = function (chosen) {
      if (!chosen) return { ok: false, cancelled: true };
      const dir = ffmpegDirFrom(chosen);
      if (!dir) return { ok: false, error: 'that folder does not contain ffmpeg.exe' };
      const prevEnv = process.env.LUMEN_FFMPEG || '';
      process.env.LUMEN_FFMPEG = dir;
      const r = ff ? ff.rescan() : null;
      /* the engine must come from *this* folder — otherwise the user mis-clicked
         and some other ffmpeg on the system answered */
      const fromHere = !!(r && r.path && path.resolve(path.dirname(r.path)) === path.resolve(dir));
      if (!r || !r.available || !fromHere) {
        process.env.LUMEN_FFMPEG = prevEnv;
        try { if (ff) ff.rescan(); } catch (e) { }
        return { ok: false, error: dir + ' does not contain a working ffmpeg (expected ffmpeg.exe next to ffprobe.exe)' };
      }
      setManualFfmpeg(dir);
      probeWarm.clear();
      log('ffmpeg set by hand →', dir, ff.describe());
      return { ok: true, dir: dir, path: ff.path, version: ff.version() };
    };
    if (typeof forced === 'string' && forced) return finish(forced);
    return new Promise(function (resolve) {
      let start = manualFfmpeg() || '';
      try { if (!start) start = app.getPath('downloads'); } catch (e) { start = ''; }
      dialog.showOpenDialog(win, {
        title: 'Select ffmpeg.exe (the one next to ffprobe.exe)',
        defaultPath: start || undefined,
        buttonLabel: 'Use this',
        properties: ['openFile'],
        filters: [{ name: 'ffmpeg for Windows', extensions: ['exe'] }, { name: 'All files', extensions: ['*'] }]
      }).then(function (r) {
        if (!r || r.canceled || !r.filePaths || !r.filePaths.length) { resolve({ ok: false, cancelled: true }); return; }
        resolve(finish(r.filePaths[0]));
      }).catch(function (e) { resolve({ ok: false, error: (e && e.message) || 'dialog failed' }); });
    });
  },
  ffmpeg_rescan: function () {
    if (!ff) return null;
    const r = ff.rescan();
    log('ffmpeg rescan:', r, ff.describe());
    return { available: !!(ff && ff.available()), path: ff.path || '' };
  },
  /* subtitle tracks of an online stream: sidecar files + ffprobe over http */
  remote_probe: function (url) {
    return remoteProbe(url);
  },
  open_external: function (url) {
    const u = String(url || '');
    if (/^https?:\/\//i.test(u) || /^mailto:[^@\s]+@[^@\s]+$/i.test(u)) shell.openExternal(u);
    return true;
  },
  set_hdr: function (on) {
    const s = store.settings();
    s.hdr = !!on;
    store.setSettings(s);
    return true;
  },
  move_window: function (dx, dy) {
    if (!win || win.isDestroyed()) return false;
    if (win.isMaximized() || win.isFullScreen()) return false;
    const b = win.getBounds();
    win.setBounds({
      x: Math.round(b.x + (Number(dx) || 0)),
      y: Math.round(b.y + (Number(dy) || 0)),
      width: b.width, height: b.height
    });
    return true;
  },
  resize_window: function (dx, dy, dir) {
    if (!win || win.isDestroyed() || isMini) return false;
    if (win.isMaximized() || win.isFullScreen()) return false;
    const d = String(dir || 'se');
    dx = Number(dx) || 0; dy = Number(dy) || 0;
    const b = win.getBounds();
    const min = win.getMinimumSize();
    let x = b.x, y = b.y, w = b.width, h = b.height;
    if (d.indexOf('e') >= 0) w = b.width + dx;
    if (d.indexOf('s') >= 0) h = b.height + dy;
    if (d.indexOf('w') >= 0) { w = b.width - dx; x = b.x + dx; }
    if (d.indexOf('n') >= 0) { h = b.height - dy; y = b.y + dy; }
    const minW = Math.max(480, min[0] || 0), minH = Math.max(300, min[1] || 0);
    if (w < minW) { if (d.indexOf('w') >= 0) x -= (minW - w); w = minW; }
    if (h < minH) { if (d.indexOf('n') >= 0) y -= (minH - h); h = minH; }
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(w), height: Math.round(h) });
    return true;
  },

  /* -------------------------------------------------------------- config */
  boot_state: function () {
    const s = store.settings();
    let gpu = '';
    try {
      const status = app.getGPUFeatureStatus && app.getGPUFeatureStatus();
      gpu = status && status.gpu_compositing ? 'gpu compositing: ' + status.gpu_compositing : '';
      if (s.hw === false) gpu = 'hardware acceleration disabled in settings';
    } catch (e) { }
    return {
      version: VERSION,
      buildId: BUILD_ID,
      platform: process.platform,
      ffmpeg: !!(ff && ff.available()),
      ffmpegBundled: isBundledFfmpeg(),
      ffmpegInfo: ff ? ff.describe() : '',
      settings: s,
      playlist: store.playlist(),
      resume: store.resume(),
      subs: store.all.subs || {},
      lastFile: store.all.lastFile || '',
      args: bootArgs.slice(0),
      gpu: gpu,
      audio: '',
      dataDir: userDataDir()
    };
  },
  settings_set: function (json) {
    try {
      const obj = typeof json === 'string' ? JSON.parse(json) : json;
      if (obj && typeof obj === 'object') {
        /* store.setSettings() already schedules a debounced write. Flushing on
           every settings push meant a synchronous rewrite of config.json (the
           whole playlist included) while the user dragged the volume slider. */
        store.setSettings(obj);
        if (win && !win.isDestroyed()) {
          const wants = !!obj.ontop;
          if (win.isAlwaysOnTop() !== wants && !isMini) win.setAlwaysOnTop(wants, wants ? 'floating' : 'normal');
        }
      }
    } catch (e) { }
    return true;
  },
  save_playlist_silent: function (json) {
    try {
      const obj = typeof json === 'string' ? JSON.parse(json) : json;
      store.setPlaylist(obj);
      /* the last item played is what the next start resumes */
      const items = (obj && obj.items) || [];
      const idx = obj && typeof obj.index === 'number' ? obj.index : -1;
      const cur = items[idx];
      if (cur && (cur.path || cur.url)) store.pushRecent(cur.path || cur.url);
      store.flush();
    } catch (e) { }
    return true;
  },
  save_playlist: function (json) {
    return new Promise(function (resolve) {
      if (!win) { resolve(''); return; }
      dialog.showSaveDialog(win, {
        title: 'Save playlist',
        defaultPath: path.join(app.getPath('videos') || userDataDir(), 'lumen-playlist.m3u8'),
        filters: [{ name: 'Playlist', extensions: ['m3u8'] }, { name: 'Lumen playlist', extensions: ['json'] }]
      }).then(function (r) {
        if (r.canceled || !r.filePath) { resolve(''); return; }
        try {
          let text;
          if (/\.json$/i.test(r.filePath)) {
            text = JSON.stringify(JSON.parse(json), null, 2);
          } else {
            const data = JSON.parse(json);
            text = '#EXTM3U\n' + (data.items || []).map(function (i) {
              return '#EXTINF:' + Math.round(i.dur || 0) + ',' + (i.name || '') + '\n' + (i.path || i.url || '');
            }).join('\n') + '\n';
          }
          fs.writeFileSync(r.filePath, text, 'utf8');
          resolve(r.filePath);
        } catch (e) { resolve(''); }
      }).catch(function () { resolve(''); });
    });
  },
  load_playlist: function () {
    return new Promise(function (resolve) {
      if (!win) { resolve(''); return; }
      dialog.showOpenDialog(win, {
        title: 'Load playlist',
        properties: ['openFile'],
        filters: [{ name: 'Playlist', extensions: ['json', 'm3u8', 'm3u'] }]
      }).then(function (r) {
        if (r.canceled || !r.filePaths.length) { resolve(''); return; }
        const file = r.filePaths[0];
        try {
          const text = fs.readFileSync(file, 'utf8');
          if (/\.json$/i.test(file)) { resolve(text); return; }
          /* M3U / M3U8 → the same shape the player stores */
          const items = [];
          text.split(/\r?\n/).forEach(function (line) {
            line = line.trim();
            if (!line || line.charAt(0) === '#') return;
            let p = line;
            try { if (p.indexOf('file:///') === 0) p = decodeURIComponent(p.slice(8)); } catch (e) { }
            if (!util.isFile(p)) return;
            const e = util.extName(p);
            if (!util.isMediaExt(e)) return;
            items.push({ path: p, name: util.baseName(p), ext: e, dur: 0, w: 0, h: 0, url: '', subs: null });
          });
          resolve(JSON.stringify({ index: items.length ? 0 : -1, items: items }));
        } catch (e) { resolve(''); }
      }).catch(function () { resolve(''); });
    });
  },
  resume_set: function (p, t) { store.setResume(p, t); return true; },
  remember_subs: function (p, list) { store.rememberSubs(p, list); return true; },

  /* --------------------------------------------------------------- files */
  open_files: function (folder) {
    return new Promise(function (resolve) {
      if (!win) { resolve([]); return; }
      const props = folder ? ['openDirectory'] : ['openFile', 'multiSelections'];
      dialog.showOpenDialog(win, {
        title: folder ? 'Open folder' : 'Open media',
        properties: props,
        filters: folder ? [] : [
          { name: 'Media', extensions: MEDIA_EXT },
          { name: 'Video', extensions: ['mp4', 'mkv', 'webm', 'avi', 'mov', 'm4v', 'ts', 'm2ts', 'wmv', 'flv', 'ogv'] },
          { name: 'Audio', extensions: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'wma'] },
          { name: 'All files', extensions: ['*'] }
        ]
      }).then(function (r) {
        if (r.canceled || !r.filePaths.length) { resolve([]); return; }
        const out = [];
        r.filePaths.forEach(function (p) {
          if (util.isDir(p)) util.listFolderFiles(p).forEach(function (f) { out.push(f); });
          else out.push(p);
        });
        resolve(out);
      }).catch(function () { resolve([]); });
    });
  },
  open_subtitles: function () {
    return new Promise(function (resolve) {
      if (!win) { resolve([]); return; }
      dialog.showOpenDialog(win, {
        title: 'Open subtitles',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Subtitles', extensions: SUB_EXT }]
      }).then(function (r) {
        resolve(r.canceled ? [] : r.filePaths);
      }).catch(function () { resolve([]); });
    });
  },
  register_path: function (p) {
    if (!util.isFile(p)) return null;
    const token = srv.registerPath(p);
    if (!probeWarm.has(p) && ff && ff.available()) {
      ff.probe(p).then(function (info) {
        if (info) rememberProbe(p, info);
      }).catch(function () { });
    }
    const info = probeWarm.get(p);
    return {
      token: token,
      duration: (info && info.duration) || 0,
      w: (info && info.width) || 0,
      h: (info && info.height) || 0
    };
  },
  register_url: function (name, url) {
    if (!url) return null;
    return { token: srv.registerUrl(url, name) };
  },
  /* a dropped file that already exists on disk: just register its path */
  drop_path: function (name, p) {
    if (!util.isFile(p)) return '';
    srv.registerPath(p, name);
    return p;
  },
  drop_begin: function (id, size) {
    try {
      const dir = path.join(app.getPath('temp'), 'lumen-drop');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'drop-' + Date.now().toString(36) + '-' + String(id || 'x'));
      uploads.set(String(id), { file: file, stream: fs.createWriteStream(file), received: 0 });
      return true;
    } catch (e) { return false; }
  },
  drop_chunk: function (id, b64) {
    const up = uploads.get(String(id));
    if (!up) return false;
    try {
      const buf = Buffer.from(String(b64 || ''), 'base64');
      up.stream.write(buf);
      up.received += buf.length;
      return true;
    } catch (e) { return false; }
  },
  drop_finish: function (id, name) {
    const up = uploads.get(String(id));
    if (!up) return '';
    uploads.delete(String(id));
    return new Promise(function (resolve) {
      up.stream.end(function () {
        try {
          const ext = util.extName(name || up.file);
          const target = ext && util.extName(up.file) !== ext ? up.file + '.' + ext : up.file;
          if (target !== up.file) fs.renameSync(up.file, target);
          srv.registerPath(target, name);
          resolve(target);
        } catch (e) { resolve(up.file); }
      });
    });
  },
  /* dropping ffmpeg.exe (or its folder) onto the window sets the engine too */
  ffmpeg_drop: function (p) {
    const res = handlers.ffmpeg_pick(String(p || ''));
    return res && res.ok ? { ok: true, dir: res.dir, version: res.version } : { ok: false };
  },
  reveal: function (p) {
    try { shell.showItemInFolder(p); return true; } catch (e) { return false; }
  },

  /* Move a media file to the OS recycle bin (recoverable, not a hard unlink).
     The player asks for this when Delete is pressed *after* it moved on to the
     next item, but Windows may still hold the old file open for a moment while
     the media stream winds down — so the trash call is retried a few times
     instead of failing on the first EBUSY. */
  media_delete: function (p) {
    return new Promise(function (resolve) {
      if (!p || typeof p !== 'string') { resolve({ ok: false, error: 'no file name' }); return; }
      let target;
      try { target = path.resolve(p); } catch (e) { resolve({ ok: false, error: 'bad path' }); return; }
      if (!util.isFile(target)) { resolve({ ok: false, error: 'file not found' }); return; }
      if (!util.isMediaExt(util.extName(target))) {
        resolve({ ok: false, error: 'not a media file' });
        return;
      }
      /* forget everything cached about it first */
      try { probeWarm.delete(target); probeWarm.delete(p); } catch (e) { }
      try { if (store) store.forget(target); } catch (e) { }
      let tries = 0;
      const attempt = function () {
        tries++;
        Promise.resolve(shell.trashItem(target)).then(function () {
          log('[lumen] trashed ' + target);
          resolve({ ok: true, path: target });
        }).catch(function (e) {
          if (tries < 4) { setTimeout(attempt, 200 * tries); return; }
          log('[lumen] could not trash ' + target + ': ' + (e && e.message));
          resolve({ ok: false, error: String((e && e.message) || 'the file is locked').slice(0, 160) });
        });
      };
      attempt();
    });
  },
  
  /* Where will the stream really start? A stream copy snaps back to the
     previous keyframe, and the player needs that value for its timeline. */
  transcode_start: function (p, at, audioIdx, toneMap, reencode) {
    return new Promise(function (resolve) {
      if (!util.isFile(p)) { resolve(null); return; }
      at = Math.max(0, Number(at) || 0);
      const idx = (audioIdx === null || audioIdx === undefined || audioIdx === '' || isNaN(Number(audioIdx)))
        ? null : Number(audioIdx);
      const token = srv.registerPath(p, util.baseName(p));
      /* the host server tone-maps HDR by default; '&tm=0' turns that off */
      const tm = toneMap ? '' : '&tm=0';
      /* re=1 = skip the remux and go straight to a real H.264 encode. Used as
         the second stop when a remuxed stream has no picture (HEVC/x265, 10-bit…). */
      const re = reencode ? '&re=1' : '';
      const plainUrl = '/' + 'transcode?t=' + token + '&t0=' + at.toFixed(3) + (idx != null ? '&a=' + idx : '') + tm + re;
      if (!ff || !ff.available()) { resolve({ url: plainUrl, start: at, videoCopy: false }); return; }
      Promise.resolve(probeWarm.get(p) || ff.probe(p)).then(function (info) {
        if (!info) { resolve({ url: plainUrl, start: at, videoCopy: false }); return; }
        rememberProbe(p, info);
        const plan = ff.plan(info, idx);
        resolve({ url: plainUrl, start: at, videoCopy: reencode ? false : plan.videoCopy,
          codec: plan.codec, needEncode: !!plan.needEncode });
      }).catch(function () { resolve({ url: plainUrl, start: at, videoCopy: false }); });
    });
  },
  probe: function (p) {
    if (!ff || !ff.available() || !util.isFile(p)) return null;
    if (probeWarm.has(p)) return probeWarm.get(p);
    return ff.probe(p).then(function (info) {
      if (info) rememberProbe(p, info);
      return info;
    });
  },
  sidecar_subtitles: function (p) {
    if (!util.isFile(p)) return [];
    let list = [];
    /* Sidecar lookup is file-system work and does not require FFmpeg. */
    if (ff && typeof ff.sidecars === 'function') list = ff.sidecars(p) || [];
    const pathKey = function (value) {
      let key = path.resolve(String(value || ''));
      if (process.platform === 'win32') key = key.toLowerCase();
      return key;
    };
    const known = new Set(list.map(function (x) { return pathKey(x && x.path); }));
    const remembered = store.subsFor(p);
    remembered.forEach(function (sp) {
      if (!util.isFile(sp)) return;
      const key = pathKey(sp);
      if (known.has(key)) return;
      known.add(key);
      list.push({ path: sp, label: util.baseName(sp), remembered: true });
    });
    return list;
  }
};

const METHOD_NAMES = Object.keys(handlers);

ipcMain.handle('lumen:call', async function (event, name, args) {
  if (typeof name !== 'string' || METHOD_NAMES.indexOf(name) < 0) return null;
  try {
    return await handlers[name].apply(null, args || []);
  } catch (e) {
    log('bridge ' + name + ' failed:', e && e.message);
    return null;
  }
});

/* ============================================================== boot */
if (gotLock) {
  app.on('second-instance', function (e, argv) {
    const paths = collectPaths(argv);
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.focus();
      if (paths.length) notifyUi('window.lumenHost && window.lumenHost.openPaths(' + JSON.stringify(paths) + ')');
    }
  });

  app.whenReady().then(function () {
    try { app.setAppUserModelId('com.lumen.player'); } catch (e) { }
    store = createStore(path.join(userDataDir(), 'config.json'));
    applyManualFfmpeg();
    ff = createFfmpeg({
      dirs: [
        manualFfmpeg(),                           /* optional advanced override */
        process.resourcesPath || '',             /* bundled resources/ffmpeg/bin */
        path.dirname(process.execPath),           /* portable: next to Lumen.exe */
        path.join(process.resourcesPath || '', 'tools'),
        userDataDir(),
        path.join(__dirname, 'vendor', 'ffmpeg', 'win-x64'), /* developer run */
        __dirname
      ]
    });
    srv = createServer({ webDir: WEB_DIR, ff: ff, log: log });
    bootArgs = collectPaths(process.argv.slice(1));

    srv.listen().then(function (info) {
      origin = info.origin;
      log('server ready on ' + origin + ' · ' + (ff ? ff.describe() : 'no ffmpeg'));
      createWindow();
    }).catch(function (e) {
      dialog.showErrorBox('Lumen', 'The local media server could not start:\n' + (e && e.message));
      app.quit();
    });

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', function () { app.quit(); });

  app.on('before-quit', function () {
    quitting = true;
    try { releaseMediaKeys(); } catch (e) { }
    try { if (store) store.flush(); } catch (e) { }
    try { if (srv) srv.close(); } catch (e) { }
  });

  process.on('uncaughtException', function (e) {
    log('uncaught:', e && (e.stack || e.message));
  });
}
