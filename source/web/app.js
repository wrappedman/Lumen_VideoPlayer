/* ==========================================================================
   Lumen — app.js · core layer
   Playback engine, state, settings, subtitles, audio chain, bridge to Python.
   The visual layer (chrome, gestures, context menu, shortcuts) lives in ui.js
   and talks to this file through window.Lumen.
   ========================================================================== */
(function () {
  'use strict';

  /* --------------------------------------------------------------------------
     Subtitle look: the app ships a handful of ready-made fonts / colours /
     shadows, and the chosen combination is written inline on every cue, so it
     wins over the style presets and works for both local and online tracks. */
  var SUB_FONTS = {
    'default': '',
    'segoe': '"Segoe UI Variable Display", "Segoe UI", Tahoma, sans-serif',
    'tahoma': 'Tahoma, "Segoe UI", sans-serif',
    'iransans': '"IRANSans", "IRANSansX", "Vazirmatn", Tahoma, sans-serif',
    'vazir': '"Vazirmatn", "IRANSans", Tahoma, sans-serif',
    'naskh': '"Segoe UI Historic", "Traditional Arabic", "Times New Roman", serif',
    'georgia': 'Georgia, "Times New Roman", serif',
    'mono': 'Consolas, "Courier New", monospace'
  };
  var SUB_SHADOWS = {
    'none': 'none',
    'soft': '0 2px 10px rgba(0,0,0,.85), 0 0 2px rgba(0,0,0,.9)',
    'hard': '2px 2px 0 rgba(0,0,0,.95), -1px -1px 0 rgba(0,0,0,.6)',
    'glow': '0 0 12px rgba(0,0,0,.95), 0 0 3px rgba(0,0,0,.9)'
  };
  var SUB_BGS = {
    'none': '',
    'dark': 'rgba(0,0,0,.55)',
    'solid': 'rgba(0,0,0,.85)',
    'light': 'rgba(255,255,255,.78)',
    'accent': 'rgba(232,56,79,.72)'
  };
  var SUB_OUTLINES = { 'off': '', 'thin': '1px #000', 'thick': '2.5px #000', 'white': '1.5px #fff' };

  function subInlineStyle() {
    var out = 'font-size:' + (Number(S.subSize) || 34) + 'px;';
    var fam = SUB_FONTS[S.subFont || 'default'];
    /* single quotes only — the string ends up inside a style="…" attribute */
    if (fam) out += 'font-family:' + fam.replace(/"/g, "'") + ';';
    if (S.subColor) out += 'color:' + S.subColor + ';';
    if (S.subBold) out += 'font-weight:800;';
    var bg = SUB_BGS[S.subBg || 'none'];
    if (bg) out += 'background:' + bg + ';padding:2px 10px;';
    var sh = SUB_SHADOWS[S.subShadow || 'soft'];
    if (sh && sh !== 'none') out += 'text-shadow:' + sh + ';';
    var ol = SUB_OUTLINES[S.subOutline || 'off'];
    if (ol) out += '-webkit-text-stroke:' + ol + ';paint-order:stroke fill;';
    return out.replace(/"/g, "'");
  }
  var SUB_STYLE = { fonts: SUB_FONTS, shadows: SUB_SHADOWS, bgs: SUB_BGS, outlines: SUB_OUTLINES,
    inline: subInlineStyle };

  /* ------------------------------------------------------------------ utils */
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmt(s) {
    s = Math.max(0, Math.round(s || 0));
    var h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60;
    return (h ? h + ':' + pad(m) : pad(m)) + ':' + pad(x);
  }
  function fmtLong(s) { s = Math.max(0, Math.round(s || 0)); return Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60); }
  function baseName(p) { if (!p) return ''; var s = String(p).replace(/\\/g, '/'); return s.slice(s.lastIndexOf('/') + 1); }
  function sidecarPathKey(p) { return String(p || '').replace(/\\/g, '/').toLowerCase(); }
  function extName(p) { var b = baseName(p); var i = b.lastIndexOf('.'); return i < 0 ? '' : b.slice(i + 1).toLowerCase(); }
  function fileUrl(p) { return 'file:///' + String(p).replace(/\\/g, '/').replace(/ /g, '%20').replace(/#/g, '%23'); }
  function isVideoExt(e) { return ['mp4','m4v','mkv','webm','avi','mov','mpg','mpeg','ts','m2ts','wmv','flv','ogv','3gp','mpd','m3u8'].indexOf(e) >= 0; }
  function isAudioExt(e) { return ['mp3','m4a','aac','flac','wav','ogg','oga','opus','wma','mka'].indexOf(e) >= 0; }
  function isSubExt(e) { return ['srt','vtt','ass','ssa','sub','txt','ttml','dfxp'].indexOf(e) >= 0; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function uid() { return Math.random().toString(36).slice(2, 10); }
  function icon(name, size) {
    var svg = (window.LUMEN_ICONS && window.LUMEN_ICONS[name]) || '';
    if (!svg) return '';
    if (size) svg = svg.replace(/width="24" height="24"/, 'width="' + size + '" height="' + size + '"');
    return svg;
  }
  function injectIcons(root) {
    $$('[data-icon]', root || document).forEach(function (el) {
      var name = el.getAttribute('data-icon');
      var svg = (window.LUMEN_ICONS && window.LUMEN_ICONS[name]) || '';
      if (!svg) return;
      var size = el.getAttribute('data-size') || 20;
      var box = document.createElement('span');
      box.innerHTML = svg;
      var s = box.querySelector('svg');
      if (s) { s.setAttribute('width', size); s.setAttribute('height', size); }
      el.innerHTML = box.innerHTML;
    });
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t); t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  }

  /* ------------------------------------------------------------------ bridge */
  var Bridge = {
    ready: false,
    token: '',
    ffmpeg: false,
    version: '1.0.0',
    call: function (name) {
      var A = window.pywebview && window.pywebview.api;
      if (!A || typeof A[name] !== 'function') {
        /* A typo (or a method missing from preload.js' whitelist) used to fail
           silently and look like "this feature does nothing". Say it once. */
        Bridge._missing = Bridge._missing || {};
        if (!Bridge._missing[name]) {
          Bridge._missing[name] = true;
          console.warn('[lumen] host method not available: ' + name);
        }
        return Promise.resolve(null);
      }
      var args = Array.prototype.slice.call(arguments, 1);
      try {
        var r = A[name].apply(A, args);
        return (r && typeof r.then === 'function') ? r : Promise.resolve(r);
      } catch (e) {
        console.warn('[lumen] bridge error on ' + name, e);
        return Promise.resolve(null);
      }
    },
    /* URLs are handed out by Python: it knows the port + session token */
    mediaUrl: function (item, at) {
      if (!Bridge.ready || !item || !item.token) return null;
      var u = '/media?t=' + encodeURIComponent(item.token);
      if (at) u += '&t0=' + Math.max(0, at).toFixed(2);
      return u;
    },
    transcodeUrl: function (item, at, audioIdx, opts) {
      if (!Bridge.ready || !item || !item.token) return null;
      var u = '/transcode?t=' + encodeURIComponent(item.token) + '&t0=' + Math.max(0, at || 0).toFixed(2);
      if (audioIdx != null) u += '&a=' + audioIdx;
      /* S.hdr = 'tone-map HDR to SDR'. The server tone-maps by default and
         only skips it when tm=0 is present, so the flag is appended when the
         switch is OFF (raw HDR passthrough). */
      if (!S.hdr) u += '&tm=0';
      if (opts && opts.reencode) u += '&re=1';
      if (opts && opts.mode) u += '&mode=' + opts.mode;
      return u;
    },
    /* The <video> tag carries no crossorigin attribute (it must be present
       before the element starts loading). WebAudio graphs therefore mute the
       sound of *online* streams — the media element treats them as tainted
       cross-origin content. Serving the bytes through the same-origin /media
       proxy keeps the WebAudio path audible; plain playback still uses the
       original URL so live streams keep their headers. */
    playbackUrl: function (item, at) {
      if (!item) return null;
      if (item.path) return Bridge.mediaUrl(item, at);
      if (/^https?:/i.test(item.url || '') && Audio.wanted() && item.token) return Bridge.mediaUrl(item, at);
      return item.url || null;
    },
    /* Ask the host where the ffmpeg stream will really start (a stream copy
       snaps back to the previous keyframe) and get the url for it. */
    startTranscode: function (item, at, audioIdx, opts) {
      at = Math.max(0, at || 0);
      if (!Bridge.ready || !item) return Promise.resolve(null);
      var re = !!(opts && opts.reencode);
      if (item.path) {
        /* last arg = skip the remux and re-encode to H.264 (stage 2) */
        return Bridge.call('transcode_start', item.path, at, audioIdx == null ? null : audioIdx, !!S.hdr, re)
          .then(function (res) {
            if (res && res.url) return res;
            var u = Bridge.transcodeUrl(item, at, audioIdx, opts);
            return u ? { url: u, start: at } : null;
          });
      }
      var url = Bridge.transcodeUrl(item, at, audioIdx, opts);
      return Promise.resolve(url ? { url: url, start: at } : null);
    },
    thumbUrl: function (item, t) {
      if (!Bridge.ready || !item || !item.token) return null;
      return '/thumb?t=' + encodeURIComponent(item.token) + '&at=' + (t || 0).toFixed(1);
    },
    subUrl: function (item, id, delayMs, atSec, fmt) {
      if (!Bridge.ready || !item || !item.token) return null;
      /* the delay is applied by the renderer at paint time — the host only
         needs the position hint (atSec) and the ASS safety flag */
      return '/subtitle?t=' + encodeURIComponent(item.token) + '&id=' + encodeURIComponent(id) +
        (atSec > 60 ? '&at=' + Math.round(atSec) : '') +
        (fmt === 'ass' || fmt === 'ssa' ? '&fmt=' + fmt : '');
    },
    /* drag&drop from Explorer: the host either hands us a real path
       (Electron / WebView2) or we ship the bytes over the bridge in chunks */
    uploadTemp: function (file, onProgress) {
      if (!Bridge.ready) return Promise.resolve(null);
      var chunked = function () {
        return new Promise(function (resolve) {
          var CHUNK = 8 * 1024 * 1024, off = 0, upId = uid();
          function step() {
            if (off >= file.size) {
              Bridge.call('drop_finish', upId, file.name, file.size).then(function (p) {
                if (onProgress) onProgress(1);
                resolve(p || null);
              });
              return;
            }
            var blob = file.slice(off, Math.min(off + CHUNK, file.size));
            var fr = new FileReader();
            fr.onload = function () {
              var b64 = String(fr.result).split(',')[1] || '';
              Bridge.call('drop_chunk', upId, b64).then(function () {
                off += CHUNK;
                if (onProgress) onProgress(clamp(off / file.size, 0, 1));
                step();
              });
            };
            fr.onerror = function () {
              /* the read died mid-upload: tell the host to drop the partial
                 file instead of leaking the stream and temp file forever */
              Bridge.call('drop_abort', upId);
              resolve(null);
            };
            fr.readAsDataURL(blob);
          }
          Bridge.call('drop_begin', upId, file.size).then(step);
        });
      };
      /* fast path: the dropped file exists on disk — pass its path over */
      try {
        if (window.lumenNative && typeof window.lumenNative.pathForFile === 'function') {
          var np = window.lumenNative.pathForFile(file);
          if (np) {
            return Bridge.call('drop_path', file.name, np).then(function (p) {
              if (p) { if (onProgress) onProgress(1); return p; }
              return chunked();
            });
          }
        }
      } catch (e) { }
      return chunked();
    }
  };

  /* ------------------------------------------------------------------ settings */
  var SK = 'lumen.settings.v1';
  var DEFAULTS = {
    theme: 'dark', glass: 22, idle: 2.6, lores: false, ctxstyle: 'auto',
    volume: 0.65, muted: false, speed: 1,
    hw: true, resume: true, autonext: true, seekstep: 10, autoload: true,
    touch: true, swipe: true, pinch: true, longpress: true, dblw: 0.31, touchui: false,
    aspect: 'auto', rotate: 0, wheel: 'volume', smooth: true, hdr: true,
    normalize: false, eq: false, eqPreset: 'flat', eqBands: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    boost: false, subLang: 'fa',
    subPreset: 'default', subSize: 34, subPos: 14, subDelay: 0, subOn: true, subautoload: true,
    subFont: 'default', subColor: '#ffffff', subBg: 'none', subShadow: 'soft',
    subOutline: 'off', subBold: false,
    ontop: false, repeat: 'off', shuffle: false, abLoop: true
  };
  var S = {};
  (function loadSettings() {
    var raw = null;
    try { raw = localStorage.getItem(SK); } catch (e) { raw = null; }
    var o = {};
    if (raw) { try { o = JSON.parse(raw) || {}; } catch (e) { o = {}; } }
    for (var k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) S[k] = (o[k] === undefined ? DEFAULTS[k] : o[k]);
    S.eqBands = (S.eqBands && S.eqBands.length === 10) ? S.eqBands.slice(0) : DEFAULTS.eqBands.slice(0);
  })();
  function flushSettings() {
    try { localStorage.setItem(SK, JSON.stringify(S)); } catch (e) { }
    Bridge.call('settings_set', JSON.stringify(S));
  }
  var saveSettings = debounce(flushSettings, 350);
  function setSetting(k, v) { S[k] = v; saveSettings(); Events.emit('setting', k, v); }

  /* ------------------------------------------------------------------ events */
  var Events = (function () {
    var map = {};
    return {
      on: function (n, f) { (map[n] = map[n] || []).push(f); return function off() { Events.off(n, f); }; },
      off: function (n, f) { var a = map[n] || []; var i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
      emit: function (n) { var args = Array.prototype.slice.call(arguments, 1); (map[n] || []).slice().forEach(function (f) { try { f.apply(null, args); } catch (e) { console.error(e); } }); }
    };
  })();

  /* ------------------------------------------------------------------ playlist */
  var Playlist = {
    items: [],
    index: -1,
    add: function (item, at) {
      if (typeof item === 'string') item = { path: item, name: baseName(item), ext: extName(item) };
      if (!item.name) item.name = baseName(item.path) || item.path;
      if (!item.ext) item.ext = extName(item.path);
      if (!item.uid) item.uid = uid();
      if (at == null || at < 0 || at > this.items.length) this.items.push(item);
      else this.items.splice(at, 0, item);
      Events.emit('playlist');
      return item;
    },
    addMany: function (paths, at) {
      var self = this, added = [];
      (paths || []).forEach(function (p) {
        var e = extName(p);
        if (!isVideoExt(e) && !isAudioExt(e)) return;
        added.push(self.add(p, at == null ? null : at++));
      });
      return added;
    },
    remove: function (uidOrIndex) {
      var i = typeof uidOrIndex === 'number' ? uidOrIndex : this.items.findIndex(function (x) { return x.uid === uidOrIndex; });
      if (i < 0) return null;
      var was = this.items[i];
      this.items.splice(i, 1);
      if (i === this.index) this.index = Math.min(this.index, this.items.length - 1);
      else if (i < this.index) this.index--;
      Events.emit('playlist');
      return was;
    },
    move: function (from, to) {
      if (from === to || from < 0 || to < 0 || from >= this.items.length || to > this.items.length) return;
      var it = this.items.splice(from, 1)[0];
      this.items.splice(to > from ? to - 1 : to, 0, it);
      if (this.index === from) this.index = this.items.indexOf(it);
      Events.emit('playlist');
    },
    clear: function () { this.items = []; this.index = -1; Events.emit('playlist'); },
    current: function () { return this.items[this.index] || null; },
    byUid: function (uidv) { return this.items.find(function (x) { return x.uid === uidv; }) || null; },
    findPath: function (p) {
      var norm = function (x) { return String(x || '').replace(/\\/g, '/').toLowerCase(); };
      return this.items.findIndex(function (x) { return norm(x.path) === norm(p); });
    },
    /* step through the list. `wrap` is for an explicit skip (PageDown, media
       keys, Ctrl+→): at the last item it loops back to the first one instead
       of returning the item that is already playing. */
    next: function (step, wrap) {
      if (!this.items.length) return null;
      step = step || 1;
      if (S.shuffle && this.items.length > 1) {
        var i;
        do { i = Math.floor(Math.random() * this.items.length); } while (i === this.index);
        return this.items[i];
      }
      var loop = wrap || S.repeat === 'all';
      var n = this.index + step;
      if (n >= this.items.length) n = loop ? 0 : this.items.length - 1;
      if (n < 0) n = loop ? this.items.length - 1 : 0;
      return this.items[n];
    },
    serialize: function () {
      return { index: this.index, items: this.items.map(function (x) {
        return { path: x.path, name: x.name, ext: x.ext, dur: x.dur || 0, w: x.w || 0, h: x.h || 0, url: x.url || '', subs: x.subs || null };
      }) };
    },
    hydrate: function (data) {
      if (!data || !data.items) return;
      this.items = data.items.map(function (x) { var it = { path: x.path, name: x.name || baseName(x.path), ext: x.ext || extName(x.path), dur: x.dur || 0, w: x.w || 0, h: x.h || 0, url: x.url || '', subs: x.subs || null }; it.uid = uid(); return it; });
      this.index = typeof data.index === 'number' ? data.index : -1;
      Events.emit('playlist');
      /* Tokens are registered lazily by Player.load(). Registering the whole
         playlist here used to spawn one ffprobe per item and repaint the list
         once per file — a folder with hundreds of videos stalled for seconds
         before the first frame. */
    }
  };

  /* ------------------------------------------------------------------ player */
  var Player = {
    el: null,
    item: null,
    transcode: false,
    transcodeAudio: null,
    tOffset: 0,
    pendingSeek: null,
    time: 0, dur: 0, playing: false,
    info: null,
    chapters: null,                         /* [{title, start, end}] seekbar marks */
    audioTracks: [], subTracks: [],
    subCues: [], subActive: null,
    brightness: 1,
    _lastSave: 0,

    init: function (videoEl) {
      this.el = videoEl;
      var v = this.el, self = this;

      v.addEventListener('loadedmetadata', function () {
        if (self.transcode) {
          /* the bridge stream starts at tOffset and reports the *remaining* length */
          var rest = (v.duration && isFinite(v.duration)) ? v.duration : 0;
          var total = (self.tOffset || 0) + rest;
          self.dur = total > 1 ? total : ((self.item && self.item.dur) || total || 0);
        } else {
          self.dur = v.duration && isFinite(v.duration) ? v.duration : (self.item && self.item.dur) || 0;
        }
        self.item && (self.item.dur = self.dur, self.item.w = v.videoWidth || self.item.w, self.item.h = v.videoHeight || self.item.h);
        document.documentElement.classList.add('has-media');
        Events.emit('media', self.item);
        Events.emit('time');
        if (self.pendingSeek != null && !self.transcode) { try { v.currentTime = self.pendingSeek; } catch (e) { } }
        self.pendingSeek = null;
        Events.emit('playlist');
      });
      v.addEventListener('timeupdate', function () {
        self.time = (self.transcode ? (self.tOffset || 0) : 0) + (v.currentTime || 0);
        Events.emit('time');
        self.loopGuard();
      });
      v.addEventListener('seeked', function () {
        var t = (self.transcode ? (self.tOffset || 0) : 0) + (v.currentTime || 0);
        self.renderSubs(t);
        self.subSeekCheck(t);
      });
      v.addEventListener('durationchange', function () {
        if (!isFinite(v.duration)) return;
        self.dur = self.transcode ? ((self.tOffset || 0) + v.duration) : v.duration;
        Events.emit('time');
      });
      v.addEventListener('progress', function () { Events.emit('buffered'); });
      v.addEventListener('play', function () { self.playing = true; Events.emit('playstate'); self.subFrame(); });
      v.addEventListener('pause', function () { self.playing = false; Events.emit('playstate'); });
      v.addEventListener('waiting', function () { Events.emit('busy', true); });
      v.addEventListener('playing', function () { Events.emit('busy', false); });
      v.addEventListener('canplay', function () { Events.emit('busy', false); });
      v.addEventListener('ratechange', function () { Events.emit('rate'); Events.emit('time'); });
      /* Only the *outside* world (OS mixer, media keys) may write the level
         back into the state. Lumen's own updates set _settingVolume, so the
         mute handshake cannot round-trip "muted → element volume 0 → saved
         volume 0" and silently forget the user's level. */
      v.addEventListener('volumechange', function () {
        if (self._settingVolume) return;
        S.volume = v.volume;
        S.muted = v.muted;
        saveSettings();
        Events.emit('volume');
      });
      v.addEventListener('ended', function () {
        /* a finished clip fires `ended` without a `pause` event, so the busy
           state has to be dropped here — otherwise the big play button stays
           hidden after the picture reaches its end */
        self.playing = false;
        Events.emit('playstate');
        self.onEnded();
      });
      v.addEventListener('error', function () {
        Events.emit('busy', false);
        if (!self.item) return;
        var canBridge = Bridge.ready && (self.item.path || /^https?:/i.test(self.item.url || ''));
        if (!self.transcode && canBridge) {
          /* Local and online media share the same two-step FFmpeg fallback:
             compatible tracks are remuxed, unsupported codecs are encoded to
             Chromium-friendly H.264/AAC by the bundled media engine. */
          Toast.show('This media needs conversion — starting the built-in FFmpeg bridge…', { icon: 'film', ms: 2600 });
          self.recover(1);
        } else if (self.transcode && self.recoverStage < 2 && Bridge.ready) {
          /* the remux itself refused to play (the video codec survived the
             copy but Chromium cannot decode it — x265 & friends) */
          self.recover(2);
        } else {
          var why = (v.error && v.error.code === 4) ? 'this format/codec cannot be played'
            : (v.error && v.error.code === 2) ? 'network or file error'
              : (v.error && v.error.code === 3) ? 'the file could not be decoded'
                : (v.error && v.error.code ? 'code ' + v.error.code : 'unknown error');
          Toast.show('Playback error — ' + why + '\n' + esc(self.item.name || '') +
            (Bridge.ready ? '' : '\n(no desktop host attached)'), { kind: 'err', icon: 'info', ms: 6000 });
        }
      });

      v.addEventListener('click', function (e) { e.stopPropagation(); });
      v.addEventListener('play', function () {
        Audio.ensure();
        /* the probe already said this codec is not decodable (HEVC/x265,
           10-bit …): don't show a black picture first — re-encode right away */
        if ((self.codecUnsafe || self.audioCodecUnsafe) && !self.transcode && (self.recoverStage || 0) === 0 &&
            Bridge.ready && self.item && (self.item.path || /^https?:/i.test(self.item.url || ''))) {
          self.recover(1);
        }
      });
      return this;
    },

    ensureToken: function (item) {
      if (!item || item.token || !item.path) return Promise.resolve(item);
      return Bridge.call('register_path', item.path).then(function (res) {
        if (res && res.token) { item.token = res.token; if (res.duration) item.dur = res.duration; if (res.w) { item.w = res.w; item.h = res.h; } }
        Events.emit('playlist');
        return item;
      });
    },

    /* ------------------------------------------------ load / play */
    /* A file can only be streamed by the host once it handed out a token for
       it, so the load is a two-step: register (async) → really load. */
    load: function (item, opts) {
      var self = this;
      opts = opts || {};
      if (!item) return;
      var prep;
      if (item.demo || !Bridge.ready) prep = Promise.resolve();
      else if (item.path && !item.token) prep = this.ensureToken(item);
      else if (!item.path && item.url && !item.token) {
        prep = Bridge.call('register_url', item.name || item.url, item.url).then(function (res) {
          if (res && res.token) item.token = res.token;
        });
      } else prep = Promise.resolve();
      var seq = this._loadSeq = (this._loadSeq || 0) + 1;
      this.pendingItem = item;                 /* what the UI should talk about
                                                  while the token is fetched */
      prep.then(function () {
        if (seq !== self._loadSeq) return;      /* a newer load won the race */
        self._load(item, opts);
      }).catch(function () {
        if (seq === self._loadSeq) self._load(item, opts);
      });
    },

    /* A new file must start clean: playback state from the *previous* item
       (an ffmpeg stream still winding down, its position offset, its saved
       resume point) must never leak into the next load. */
    _resetLoadState: function (item) {
      this.stopTranscode();
      this.setSubtitle(null, true);
      this.item = item;
      this.transcode = false;
      this.transcodeAudio = null;
      this.info = null;
      this.codec = ''; this.codecUnsafe = false; this.audioCodecUnsafe = false;
      this.probeRemoteInfo = null; this.recoverStage = 0;
      this.subTracks = []; this.audioTracks = []; this.subCues = []; this.subActive = null;
      this.chapters = null;
      this._subAutoItem = null; this._subStreamOpen = false; this._subFrom = 0;
      this.time = 0;
      this.playing = false;
      this.dur = item ? (item.dur || 0) : 0;
      this._subSig = '';
      this._lastTranscodeSeek = 0;
      var pi = item ? Playlist.items.indexOf(item) : -1;
      Playlist.index = pi >= 0 ? pi : -1;
    },

    /* the current position persisted for the next launch: local files and
       online streams both get a resume entry (the host prunes the list) */
    _saveResume: function (t) {
      var item = this.item;
      if (!item || !S.resume) return;
      var key = item.path || (/^https?:/i.test(item.url || '') ? item.url : '');
      if (key) resumeSet(key, t != null ? t : this.time);
    },

    _load: function (item, opts) {
      opts = opts || {};
      this.pendingItem = null;
      if (!item) return;
      this._resetLoadState(item);
      if (Audio.wanted() && !item.demo && !item.path && /^https?:/i.test(item.url || '')) item._proxied = true;
      var v = this.el;

      var at = opts.at;
      if (at == null && S.resume && item.path) at = resumeGet(item.path);
      if (at == null && S.resume && !item.path && /^https?:/i.test(item.url || '')) at = resumeGet(item.url);
      if (at == null) at = 0;
      this.pendingSeek = at > 1 ? at : null;

      /* design/demo items (no host attached): still fully interactive */
      if (item.demo) {
        this.playing = false;
        this.dur = item.dur || 180;
        this.time = 0;
        document.documentElement.classList.remove('has-media');
        try { this.el.removeAttribute('src'); this.el.load(); } catch (e) { }
        Events.emit('busy', false);
        Events.emit('media', item);
        Events.emit('time');
        Events.emit('playlist');
        Events.emit('demo', item.scene || 'bright');
        if (!opts.paused) this.play();
        return;
      }

      Events.emit('loadstart', item);
      Events.emit('playlist');
      Events.emit('busy', true);

      var url = Bridge.playbackUrl(item, 0);
      if (!url) {
        /* no host (pure web preview) — play straight from the file system when
           the browser allows it (drag&drop / file picker gives us a blob URL) */
        url = item.blobUrl || (item.path ? fileUrl(item.path) : null);
      }
      if (!url) { Events.emit('busy', false); return; }
      /* release the previous blob url (file-picker / drag&drop in web mode) */
      if (this._lastBlobUrl && this._lastBlobUrl !== item.blobUrl) {
        try { URL.revokeObjectURL(this._lastBlobUrl); } catch (e) { }
        this._lastBlobUrl = null;
      }
      if (item.blobUrl) this._lastBlobUrl = item.blobUrl;
      v.src = url;
      v.load();
      try { v.playbackRate = S.speed; } catch (e) { }
      this.applyVideoTransforms();
      Audio.attach();
      /* a stale timer must never start a file the user already switched away from */
      /* the real frame size is only known once metadata arrives — re-apply the
         geometry then, so the picture always sits right in the window */
      if (!this.el._metaHooked) {
        this.el._metaHooked = true;
        this.el.addEventListener('loadedmetadata', function () {
          try { P.applyVideoTransforms(); } catch (e) { }
          var W = window.Lumen;
          if (W && W.updatePanBounds) W.updatePanBounds();
        });
      }
      v.autoplay = !opts.paused;
      var token = this._loadToken = (this._loadToken || 0) + 1;
      var go = function () {
        if (token !== self._loadToken || self.item !== item || opts.paused) return;
        self.play();
      };
      setTimeout(go, 40);

      /* sidecar subtitles next to the file: pure file-system work, so it must
         run even when ffmpeg is missing (embedded tracks need ffprobe, these
         do not) */
      if (item.path) this.probeExtras(item);
      /* online streams: subtitle files sitting next to the stream + the
         tracks muxed into the stream itself. A local file that also carries
         an http url must still get the remote probe. */
      if (/^https?:/i.test(item.url || '')) this.probeRemote(item);

      /* metadata for the info sheet + tracks (only with a live host) */
      if (item.path) {
        Bridge.call('probe', item.path).then(function (info) {
          if (!info || self.item !== item) return;
          self.info = info;
          /* chapters for the seekbar markers (never mapped into transcodes) */
          self.chapters = (info.chapters && info.chapters.length) ? info.chapters.slice(0) : null;
          /* Probe before Chromium has time to settle on an unsupported track.
             High-bit-depth / non-native video is encoded to H.264 immediately;
             audio-only incompatibilities are remuxed with AAC. */
          var flags = codecFlags(info);
          self.codec = flags.videoCodec;
          self.codecUnsafe = flags.videoUnsafe;
          self.audioCodecUnsafe = flags.audioUnsafe;
          if ((self.codecUnsafe || self.audioCodecUnsafe) && !self.transcode &&
              (self.recoverStage || 0) === 0 && !self.el.paused && self.item === item) {
            self.recover(1);
          }
          self.audioTracks = info.audio || [];
          /* A fast sidecar lookup can finish before the slower media probe.
             Keep those external tracks when embedded tracks arrive. */
          var foundSidecars = self.subTracks.filter(function (t) {
            return t && (t.kind === 'external' || /^ext:/.test(String(t.id || '')));
          });
          self.subTracks = (info.subs || []).slice(0);
          var knownSubtitlePaths = new Set(self.subTracks.filter(function (t) { return t && t.path; })
            .map(function (t) { return sidecarPathKey(t.path); }));
          foundSidecars.forEach(function (t) {
            var key = sidecarPathKey(t.path);
            if (!knownSubtitlePaths.has(key)) { self.subTracks.push(t); knownSubtitlePaths.add(key); }
          });
          if (info.duration && !self.dur) { self.dur = info.duration; item.dur = info.duration; }
          if (info.width) { item.w = info.width; item.h = info.height; }
          if (info.title && !item.title) item.title = info.title;
          self.probeExtras(item);        /* merges with what we already found */
          self.autoPickSub(item);
        });
      } else if (item.subs) {
        this.subTracks = item.subs.slice(0);
      }
      Events.emit('tracks');
      this.updateMediaSession();
    },

    probeRemote: function (item) {
      var self = this;
      if (!Bridge.ready || !item || !/^https?:/i.test(item.url || '')) return;
      Bridge.call('remote_probe', item.url).then(function (info) {
        if (!info || self.item !== item) return;
        var add = [];
        (info.subs || []).forEach(function (sp) {
          if (self.subTracks.some(function (t) { return t.id === sp.id; })) return;
          add.push({ id: sp.id, label: sp.label || 'Subtitle · online', kind: sp.kind || 'remote', net: true });
        });
        if (add.length) self.subTracks = self.subTracks.concat(add);
        if ((info.audio || []).length) self.audioTracks = info.audio.slice(0);
        if (info.duration && !self.dur) { self.dur = info.duration; item.dur = info.duration; }
        if (info.width) { item.w = info.width; item.h = info.height; }
        self.probeRemoteInfo = info;
        /* chapters: the player does not map them into the transcode stream
           (-map_chapters -1), so they only exist on the plain file path */
        self.chapters = (info && info.chapters && info.chapters.length) ? info.chapters.slice(0) : null;
        Events.emit('media', item);
        var flags = codecFlags(info);
        self.codec = flags.videoCodec;
        self.codecUnsafe = flags.videoUnsafe;
        self.audioCodecUnsafe = flags.audioUnsafe;
        if ((self.codecUnsafe || self.audioCodecUnsafe) && !self.transcode &&
            (self.recoverStage || 0) === 0 && !self.el.paused && self.item === item) {
          self.recover(1);
        }
        Events.emit('tracks');
        if (add.length) {
          Toast.show(add.length + ' subtitle track' + (add.length > 1 ? 's' : '') + ' found for this stream.', { icon: 'subtitles', ms: 3200 });
        } else if (info.needsFfmpeg) {
          Toast.show('The built-in media engine could not inspect this stream’s embedded subtitle tracks.', { icon: 'subtitles', ms: 4200 });
        }
      }).catch(function () { });
    },

    probeExtras: function (item) {
      var self = this;
      if (!item || !item.path) return;
      Bridge.call('sidecar_subtitles', item.path).then(function (list) {
        if (self.item !== item || !Array.isArray(list)) return;
        var add = [];
        var known = new Set(self.subTracks.filter(function (t) { return t && t.path; })
          .map(function (t) { return sidecarPathKey(t.path); }));
        list.forEach(function (sp) {
          if (!sp || !sp.path) return;
          var key = sidecarPathKey(sp.path);
          if (known.has(key)) return;
          known.add(key);
          add.push({ id: 'ext:' + sp.path, label: (sp.label || baseName(sp.path)),
            kind: 'external', path: sp.path, remembered: !!sp.remembered });
        });
        if (!add.length) return;
        self.subTracks = self.subTracks.concat(add);
        Events.emit('tracks');
        /* sidecars are found before the media probe answers — show the best
           one right away instead of waiting for the embedded track list */
        self.autoPickSub(item);
      }).catch(function () { });
    },

    play: function () {
      if (!this.item) return;
      if (this.item.demo) { this.playing = true; this.startDemoClock(); Events.emit('playstate'); return; }
      var self = this;
      var p = this.el.play();
      if (p && p.catch) p.catch(function (e) {
        /* a pending load was interrupted by a newer one (rapid file switch,
           quick seek during a re-encode) — that is not an autoplay block */
        if (e && e.name === 'AbortError') return;
        Toast.show('Press play to start (browser autoplay policy)', { icon: 'info' });
      });
      Audio.ensure();
      return p;
    },
    pause: function () {
      if (this.item && this.item.demo) { this.playing = false; this.stopDemoClock(); Events.emit('playstate'); return; }
      try { this.el.pause(); } catch (e) { }
    },
    toggle: function () { if (this.playing) this.pause(); else this.play(); },

    /* synthetic clock for design/demo items */
    _demoRaf: null, _demoLast: 0,
    startDemoClock: function () {
      var self = this;
      if (this._demoRaf) return;
      this._demoLast = (window.performance || Date).now();
      var step = function (now) {
        if (!self.item || !self.item.demo || !self.playing) { self._demoRaf = null; return; }
        var dt = (now - self._demoLast) / 1000;
        self._demoLast = now;
        self.time = (self.time || 0) + dt * (S.speed || 1);
        if (self.dur && self.time >= self.dur) {
          self.time = self.dur; Events.emit('time');
          self.playing = false; self._demoRaf = null; self.onEnded(); return;
        }
        self.loopGuard();
        Events.emit('time');
        self._demoRaf = requestAnimationFrame(step);
      };
      this._demoRaf = requestAnimationFrame(step);
    },
    stopDemoClock: function () { if (this._demoRaf) cancelAnimationFrame(this._demoRaf); this._demoRaf = null; },

    seek: function (t, opts) {
      opts = opts || {};
      t = clamp(t, 0, this.dur || 1e9);
      this.time = t;
      Events.emit('time');
      if (!this.item) return;
      if (this.item.demo) return;
      if (this.transcode) {
        /* the bridge stream is a growing fragment — restart it at the new
           time. Dragging the seekbar fires this continuously, and each call
           spawns a fresh ffmpeg process: debounce so only the final position
           (plus a spaced update while dragging) really restarts the stream. */
        var self = this, now = Date.now();
        clearTimeout(this._seekT);
        if (!this._lastTranscodeSeek || now - this._lastTranscodeSeek > 650) {
          this._lastTranscodeSeek = now;
          this.startTranscode(t);
        } else {
          this._seekT = setTimeout(function () {
            self._lastTranscodeSeek = Date.now();
            self.startTranscode(self.time);
          }, 320);
        }
        if (opts.reason === 'step') Events.emit('seekstep', t - (opts.from != null ? opts.from : this.time));
        return;
      }
      try { this.el.currentTime = t; } catch (e) { }
      if (S.resume && this.item.path) resumeSet(this.item.path, t);
      if (S.resume && !this.item.path && /^https?:/i.test(this.item.url || '')) resumeSet(this.item.url, t);
    },
    nudge: function (d) {
      var from = this.time;
      this.seek((this.time || 0) + d, { reason: 'step', from: from, delta: d });
    },

    onEnded: function () {
      if (this.item && this.item.path) resumeClear(this.item.path);
      if (this.item && !this.item.path && /^https?:/i.test(this.item.url || '')) resumeClear(this.item.url);
      if (S.repeat === 'one' && !this.transcode) { this.seek(0); this.play(); return; }
      var nx = Playlist.next(1);
      if (nx && (S.autonext || S.repeat === 'all') && (Playlist.items.length > 1)) {
        if (nx === Playlist.current() && S.repeat !== 'all') return;
        Events.emit('advance', nx);
      } else Events.emit('playstate');
    },
    next: function () {
      var n = Playlist.next(1, true);
      if (n && n !== Playlist.current()) Events.emit('advance', n);
    },
    prev: function () {
      if (this.time > 3) { this.seek(0); return; }
      var n = Playlist.next(-1, true);
      if (n && n !== Playlist.current()) Events.emit('advance', n);
    },

    /* ------------------------------------------------ ffmpeg bridge path */
    /* Two-stage recovery. Stage 1 = remux (copy the video stream); stage 2 =
       a real H.264 re-encode. A file whose codec Chromium cannot decode at all
       (HEVC/x265, MPEG-2, VC-1, 10-bit …) is known from the probe already, so
       it skips straight to stage 2 instead of playing black for a while. */
    recover: function (stage) {
      var item = this.item;
      if (!item || !Bridge.ready || !(item.path || /^https?:/i.test(item.url || ''))) return;
      var at = this.time || this.pendingSeek || 0;
      var want = stage || 1;
      if (want === 1 && this.codecUnsafe) want = 2;
      if (want > 2) {
        Toast.show('This media cannot be played — its codec (' + esc(this.codec || '?') +
          ') could not be decoded by the built-in FFmpeg engine.', { kind: 'err', icon: 'info', ms: 7000 });
        Events.emit('busy', false);
        return;
      }
      this.recoverStage = want;
      this.startTranscode(at, null, { reencode: want >= 2 });
    },
    startTranscode: function (at, audioIdx, opts) {
      var item = this.item;
      if (!item || !Bridge.ready) return;
      var self = this;
      this._lastTranscodeSeek = Date.now();
      /* seeking inside a transcode moves the saved resume point too — the
         old code only stored seeks on the direct file path */
      if (S.resume) {
        var rkey = item.path || (/^https?:/i.test(item.url || '') ? item.url : '');
        if (rkey && at > 1) resumeSet(rkey, at);
      }
      var idx = (audioIdx != null) ? audioIdx : this.transcodeAudio;
      Bridge.startTranscode(item, at || 0, idx, opts).then(function (res) {
        if (self.item !== item) return;               /* user moved on */
        if (!res || !res.url) {
          Toast.show('Cannot start the built-in media conversion for this item.', { kind: 'err', icon: 'info' });
          Events.emit('busy', false);
          return;
        }
        self.transcode = true;
        self.transcodeReencoded = !!(opts && opts.reencode);
        self.tOffset = Math.max(0, res.start != null ? res.start : (at || 0));
        if (audioIdx != null) self.transcodeAudio = audioIdx;
        self.pendingSeek = null;
          if (self.transcodeReencoded) {
          Toast.show('Converting this media to H.264 — the picture appears once the conversion starts (a few seconds).',
            { icon: 'film', ms: 4600 });
        }
        self.el.src = res.url;
        self.el.load();
        self.play();
        Events.emit('busy', true);
        Events.emit('transcode', true);
        /* a plain remux of a codec Chromium cannot decode sometimes plays with
           sound and *no picture* without ever firing `error` — watch for that */
        clearTimeout(self._recoverT);
        if (!self.transcodeReencoded) {
          self._recoverT = setTimeout(function () {
            if (self.item !== item || !self.transcode || self.transcodeReencoded) return;
            if (self.el.paused || self.el.readyState < 2) return;
            if (self.el.videoWidth > 0) return;
            var hasVideo = !!(self.info && self.info.video) ||
              !!(self.probeRemoteInfo && (self.probeRemoteInfo.vcodec || self.probeRemoteInfo.video));
            if (!hasVideo) return;                           /* audio-only file */
            self.recover(2);
          }, 5200);
        }
      });
    },
    stopTranscode: function () {
      clearTimeout(this._recoverT);
      if (this.transcode) { this.transcode = false; this.transcodeReencoded = false; this.tOffset = 0; Events.emit('transcode', false); }
    },
    /* back to the audio the file carries natively (leaves the ffmpeg bridge) */
    useDefaultAudio: function () {
      if (this.transcodeAudio == null && !this.transcode) {
        Toast.show('Already using the default audio track.', { icon: 'audio-track', ms: 1600 });
        return;
      }
      var at = this.time || 0;
      this.transcodeAudio = null;
      this.recoverStage = 0;
      this.stopTranscode();
      var item = this.item;
      if (!item) { Events.emit('tracks'); return; }
      var url = Bridge.playbackUrl(item, at);
      if (!url) { Events.emit('tracks'); return; }
      this.el.src = url;
      this.pendingSeek = at > 0.3 ? at : null;
      this.el.load();
      this.play();
      Toast.show('Audio: default track', { icon: 'audio-track', ms: 1800 });
      Events.emit('tracks');
    },
    switchAudio: function (idx) {
      var a = this.audioTracks[idx];
      if (!a) return;
      if (!Bridge.ffmpeg) { Toast.show('The built-in media engine is unavailable; reinstall Lumen to switch embedded tracks.', { kind: 'err', icon: 'audio-track' }); return; }
      this.transcodeAudio = idx;
      this.recoverStage = 0;                    /* a manual pick restarts the ladder */
      /* an online stream cannot seek its audio either: it also goes through
         the transcode bridge (remux only — the stream is not re-encoded) */
      var isOnline = !this.item.path && /^https?:/i.test(this.item.url || '');
      var opts = isOnline ? { mode: 'remux' } : null;
      this.startTranscode(this.time || 0, idx, opts);
          Toast.show('Audio track: ' + esc(a.label || ('#' + (idx + 1))), { icon: 'audio-track', ms: 2200 });
      Events.emit('tracks');
    },

    /* ------------------------------------------------ picture geometry
       Everything (pan bounds, zoom anchor, pinch) is derived from these two
       helpers so the maths stays in one place. */
    natural: function () {
      var v = this.el;
      return {
        w: v.videoWidth || (this.item && this.item.w) || 16,
        h: v.videoHeight || (this.item && this.item.h) || 9
      };
    },
    /* the box the <video> element itself occupies (forced AR / rotation knobs) */
    fitBox: function (W, H) {
      var a = S.aspect, target = (a === '16:9') ? 16 / 9 : (a === '4:3') ? 4 / 3 : (a === '21:9') ? 21 / 9 : null;
      if (!target) return { w: W, h: H };
      var ar = W / H;
      if (ar > target) return { w: Math.round(H * target), h: H };
      return { w: W, h: Math.round(W / target) };
    },
    /* the visible picture box, after fit/aspect/rotation (used for pan limits) */
    contentBox: function () {
      var stack = $('#stack');
      if (!stack) return { w: 1, h: 1 };
      var W = stack.clientWidth || 1, H = stack.clientHeight || 1;
      var b = this.fitBox(W, H);
      var rot = S.rotate || 0;
      if (rot % 180) {
        var k = Math.min(1, W / b.h, H / b.w);
        return { w: b.h * k, h: b.w * k };
      }
      return { w: b.w, h: b.h };
    },
    applyVideoTransforms: function () {
      var v = this.el, z = $('#zoomer'), html = document.documentElement, stack = $('#stack');
      if (!v || !stack) return;
      html.classList.toggle('fit-cover', S.aspect === 'cover');
      html.classList.toggle('fit-fill', S.aspect === 'fill');
      html.classList.toggle('fit-contain', S.aspect !== 'cover' && S.aspect !== 'fill');
      var W = stack.clientWidth || 1, H = stack.clientHeight || 1;
      var b = this.fitBox(W, H);
      var rot = S.rotate || 0;
      var k = 1;
      if (rot % 180) k = Math.min(1, W / b.h, H / b.w);
      v.style.width = b.w + 'px';
      v.style.height = b.h + 'px';
      v.style.left = '50%';
      v.style.top = '50%';
      v.style.right = 'auto';
      v.style.bottom = 'auto';
      v.style.transformOrigin = '50% 50%';
      v.style.transform = 'translate(-50%,-50%) rotate(' + rot + 'deg) scale(' + k + ')';
      if (z) z.style.filter = 'brightness(' + (this.brightness || 1) + ')';
      html.setAttribute('data-rot', String(rot));
      Events.emit('transform');
    },

    /* ------------------------------------------------ A-B loop */
    loopGuard: function () {
      var ab = this.ab;
      if (ab && ab.a != null && ab.b != null && this.time >= ab.b) this.seek(ab.a);
    },
    ab: null,
    abSet: function (which) {
      if (!this.ab) this.ab = { a: null, b: null };
      if (which === 'a') { this.ab.a = this.time; if (this.ab.b != null && this.ab.b <= this.ab.a) this.ab.b = null; }
      else if (which === 'b') { this.ab.b = this.time; if (this.ab.a != null && this.ab.a >= this.ab.b) this.ab.a = null; }
      else this.ab = null;
      Events.emit('ab');
    },

    /* the single writer for the element's level; muting never destroys the
       remembered volume (el.muted does the silencing) */
    applyVolume: function () {
      var v = this.el;
      if (!v) return;
      var graph = !!(Audio && Audio.on);
      this._settingVolume = true;
      try {
        v.volume = graph ? 1 : clamp(S.volume == null ? 1 : S.volume, 0, 1);
        v.muted = graph ? false : !!S.muted;
      } catch (e) { }
      this._settingVolume = false;
      /* with the EQ/normalizer graph in the path, the gain node owns the level */
      if (graph && Audio.setVolume) Audio.setVolume(S.volume, S.muted);
    },

    setSpeed: function (rate) {
      setSetting('speed', rate);
      try { this.el.playbackRate = rate; } catch (e) { }
      Events.emit('rate');
      if (!this.item) Events.emit('time');
    },

    updateMediaSession: function () {
      if (!('mediaSession' in navigator) || !this.item) return;
      try {
        navigator.mediaSession.metadata = new window.MediaMetadata({
          title: this.item.title || this.item.name, artist: 'Lumen', album: baseName(this.item.path || '')
        });
        navigator.mediaSession.setActionHandler('play', function () { Player.play(); });
        navigator.mediaSession.setActionHandler('pause', function () { Player.pause(); });
        /* the Windows media flyout / hardware keys can skip too */
        try {
          navigator.mediaSession.setActionHandler('nexttrack', function () { Player.next(); });
          navigator.mediaSession.setActionHandler('previoustrack', function () { Player.prev(); });
          navigator.mediaSession.setActionHandler('seekbackward', function () { Player.nudge(-S.seekstep); });
          navigator.mediaSession.setActionHandler('seekforward', function () { Player.nudge(S.seekstep); });
        } catch (e2) { }
      } catch (e) { }
    },

  };

  /* keep the OS media controls in step with the transport */
  Events.on('playstate', function () {
    try {
      if ('mediaSession' in navigator && Player.item) {
        navigator.mediaSession.playbackState = Player.playing ? 'playing' : 'paused';
      }
    } catch (e) { }
  });

  /* -------- resume positions (per file, mirrored to the host) -------
     The host store (config.json) is the source of truth — its entries survive
     restarts and are injected into RCACHE at boot. localStorage is kept as a
     legacy mirror for pure-web demo mode (no host). */
  var RKEY = 'lumen.resume.v1';
  var RCACHE = (function () { try { return JSON.parse(localStorage.getItem(RKEY) || '{}'); } catch (e) { return {}; } })();
  function resumeGet(p) { var r = RCACHE[String(p).toLowerCase()]; return (r && r.t > 10) ? r.t : null; }
  function resumeSet(p, t) {
    var now = Date.now();
    if (now - Player._lastSave < 4000) return;
    Player._lastSave = now;
    RCACHE[String(p).toLowerCase()] = { t: t, at: now };
    try { localStorage.setItem(RKEY, JSON.stringify(RCACHE)); } catch (e) { }
    Bridge.call('resume_set', p, t);
  }
  function resumeClear(p) { delete RCACHE[String(p).toLowerCase()]; try { localStorage.setItem(RKEY, JSON.stringify(RCACHE)); } catch (e) { } Bridge.call('resume_set', p, 0); }
  /* the host is the source of truth for resume positions — pre-fill the cache
     from the boot state so a file re-opened after a restart continues where it
     stopped (localStorage dies with the random port origin) */
  function resumeSeed(map) {
    Object.keys(map || {}).forEach(function (k) {
      var r = map[k];
      if (r && r.t > 0) RCACHE[String(k).toLowerCase()] = { t: r.t, at: r.at || Date.now() };
    });
  }

  /* periodic resume checkpoint while watching: a crash, a power cut or a
     plain Alt+F4 in the middle of a long file used to lose the position
     because only seek() wrote it */
  setInterval(function () {
    if (!Player.playing || !Player.item || Player.item.demo) return;
    if (Player.time > 10) Player._saveResume();
  }, 5000);

  /* ------------------------------------------------------------------ subtitles
     A tiny WEBVTT engine so the style presets (size, weight, box, position) can
     be real CSS instead of ::cue() limitations. */
  var Subs = {
    parse: function (text) {
      var cues = [];
      if (!text) return cues;
      text = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
      if (!/\n\s*\n/.test(text)) text = text.replace(/\n(?=\d{1,3}:\d{2}:\d{2}[.,]\d{1,3}\s*-->)/g, '\n\n');
      var blocks = text.split(/\n{2,}/);
      var re = /(?:^|\n)(?:([^\n]*)\n)?(\d{1,3}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,3}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,3}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,3}:\d{2}[.,]\d{1,3})([^\n]*)\n([\s\S]*)$/;
      blocks.forEach(function (b) {
        var m = b.match(re);
        if (!m) return;
        var start = Subs.t2s(m[2]), end = Subs.t2s(m[3]);
        var payload = m[5].replace(/\n+$/, '');
        var settings = {};
        (m[4] || '').trim().split(/\s+/).forEach(function (kv) { var p = kv.split(':'); if (p.length === 2) settings[p[0]] = p[1]; });
        cues.push({ start: start, end: end, text: payload, settings: settings });
      });
      cues.sort(function (a, b) { return a.start - b.start; });
      return cues;
    },
    t2s: function (t) {
      var parts = String(t).replace(',', '.').split(':').map(parseFloat);
      if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
      if (parts.length === 2) return parts[0] * 60 + parts[1];
      return parts[0] || 0;
    },
    markup: function (txt) {
      var out = esc(txt);
      out = out.replace(/&lt;(\/?)(b|i|u|s)&gt;/gi, '<$1$2>')
        .replace(/&lt;(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3})&gt;/g, '')
        .replace(/\{\\[^}]*\}/g, '');
      return out.split('\n').map(function (l) { return '<span>' + l + '</span>'; }).join('<br>');
    },
    indexAt: function (cues, t) {
      var lo = 0, hi = cues.length - 1, res = -1;
      while (lo <= hi) { var mid = (lo + hi) >> 1; if (cues[mid].start <= t) { res = mid; lo = mid + 1; } else hi = mid - 1; }
      return res;
    }
  };

  /* Conservative codec allow-lists: codecs outside these commonly-decoded
     browser sets use the bundled FFmpeg build instead. Unusual pixel formats
     and high-bit-depth profiles are also transcoded, even when the codec name
     itself (for example H.264 High 10) looks familiar. */
  var NATIVE_VIDEO = /^(h264|avc1|avc3|vp8|vp9|vp09|av1|av01)$/;
  var NATIVE_AUDIO = /^(aac|mp3|opus|vorbis|flac|alac|pcm_(?:s16|s24|s32|f32|f64)(?:le|be)?)$/;
  function codecFlags(info) {
    info = info || {};
    var v = info.video || {};
    var videoCodec = String(info.vcodec || v.codec_name || '').toLowerCase();
    var profile = String(info.profile || v.profile || '');
    var pixfmt = String(info.pixfmt || v.pix_fmt || '');
    var highBit = /\b(?:10|12|14|16)\b/.test(profile) ||
      /(?:p0?(?:10|12|14|16)|(?:10|12|14|16)(?:le|be)|yuv(?:420|422|444)p\d{2})/i.test(pixfmt);
    var audio = info.audio || [];
    var selected = audio.filter(function (a) { return !!a.default; })[0] || audio[0] || null;
    var audioCodec = String((selected && selected.codec) || info.acodec || '').toLowerCase();
    return {
      videoCodec: videoCodec,
      audioCodec: audioCodec,
      videoUnsafe: (!!videoCodec && !NATIVE_VIDEO.test(videoCodec)) || highBit,
      audioUnsafe: !!audioCodec && !NATIVE_AUDIO.test(audioCodec),
      highBitDepth: highBit
    };
  }

  /* plain UTF-8 decode for webviews without TextDecoder — multi-byte
     sequences and surrogate pairs included (Persian text stays intact) */
  function utf8Decode(bytes) {
    var out = '', i = 0, n = bytes.length;
    while (i < n) {
      var c = bytes[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if (c < 0xE0) out += String.fromCharCode(((c & 0x1F) << 6) | (bytes[i++] & 0x3F));
      else if (c < 0xF0) out += String.fromCharCode(((c & 0x0F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F));
      else {
        var cp = ((c & 0x07) << 18) | ((bytes[i++] & 0x3F) << 12) | ((bytes[i++] & 0x3F) << 6) | (bytes[i++] & 0x3F);
        cp -= 0x10000;
        out += String.fromCharCode(0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF));
      }
    }
    return out;
  }
  /* how many bytes at the end of the chunk form a complete UTF-8 sequence —
     an incomplete tail is carried over to the next chunk so a Persian letter
     split across two network chunks is never mangled */
  function utf8SafeCut(u8) {
    var n = u8.length;
    if (!n) return 0;
    for (var back = 1; back <= 4 && back <= n; back++) {
      var b = u8[n - back];
      if (b < 0x80) return n;
      if (b >= 0xC0) {
        var len = b >= 0xF0 ? 4 : (b >= 0xE0 ? 3 : 2);
        return (back === len) ? n : n - back;
      }
    }
    return Math.max(0, n - 4);
  }
  /* ASS/SSA tracks must be stream-copied: the ffmpeg WebVTT encoder drops the
     cue text in several builds, so the host converts the events itself */
  function subTrackFmt(track) {
    var c = String((track && track.codec) || '').toLowerCase();
    if (c === 'ass' || c === 'ssa') return c;
    if (/\b(ass|ssa)\b/i.test(String((track && track.label) || ''))) return 'ass';
    return '';
  }

  Player.setSubtitle = function (track, silent, atOverride) {
    var item = this.item, layer = $('#subsLayer');
    this.subActive = track;
    this.subCues = [];
    this._subSig = '';
    this._subFrom = 0;
    this._subStreamOpen = false;
    this._subToastDone = false;
    /* every load gets a token — a stream that is still walking the file must
       never overwrite a newer choice */
    var tok = this._subFetch = (this._subFetch || 0) + 1;
    if (this._subAbort) { try { this._subAbort.abort(); } catch (e) { } this._subAbort = null; }
    if (!layer) return;
    layer.innerHTML = '';
    if (!track) { Events.emit('tracks'); return; }
    var self = this;
    var url = null;
    var at = Math.max(0, atOverride != null ? atOverride : (this.time || 0));
    /* every track the host knows — sidecar (ext:), embedded (s:), remote
       (netfile:/netstream:) — is fetched through the local server. Embedded
       tracks carry no .path, so the old guard silently skipped them and the
       track never loaded at all. */
    var tid = String(track.id || '');
    if (Bridge.ready && item && item.token && (track.path || track.net || tid)) {
      url = Bridge.subUrl(item, track.id, S.subDelay, at, subTrackFmt(track));
      if (at > 60) this._subFrom = Math.max(0, at - 30);
    }
    if (!url && track.url) url = track.url;
    if (!url) { /* pure web: convert locally with the built-in parser via fetch of a file url */ url = track.path ? fileUrl(track.path) : null; }
    if (!url) { Events.emit('tracks'); return; }
    Events.emit('busy', true);
    var ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    if (ctl) this._subAbort = ctl;
    fetch(url, ctl ? { signal: ctl.signal } : undefined).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      if (self.subActive !== track || tok !== self._subFetch) {
        try { if (r.body && r.body.cancel) r.body.cancel(); } catch (e) { }
        throw { skip: true };
      }
      /* embedded tracks arrive as a live stream: the first demuxed cues are
         painted long before ffmpeg has walked to the end of the file */
      if (r.body && typeof r.body.getReader === 'function') return self._subStream(r.body.getReader(), track, tok, silent);
      return r.text().then(function (txt) { self._subMerge(txt, track, tok, silent, true); });
    }).catch(function (e) {
      if (!e || !e.skip) {
        if (self.subActive === track) {
          Events.emit('busy', false);
          Toast.show('Subtitle load failed: ' + esc((e && e.message) || ''), { kind: 'err', icon: 'subs-off' });
        }
      }
    });
  };

  /* merge one piece of VTT/SRT text into the cue list and repaint */
  Player._subMerge = function (txt, track, tok, silent, final) {
    if (tok !== this._subFetch || this.subActive !== track) return;
    var cues = Subs.parse(txt);
    if (cues.length) {
      var arr = this.subCues;
      for (var i = 0; i < cues.length; i++) {
        /* cues arrive in order; a rare out-of-order batch triggers one sort */
        if (!arr.length || cues[i].start >= arr[arr.length - 1].start) arr.push(cues[i]);
        else { arr = arr.concat(cues.slice(i)); arr.sort(function (a, b) { return a.start - b.start; }); break; }
      }
      this.subCues = arr;
      if (!this._subToastDone && silent !== true) {
        this._subToastDone = true;
        Toast.show('Subtitles: ' + esc(track.label || 'track'), { icon: 'subtitles', ms: 1800 });
      }
      this.renderSubs(this.time);
      this.subFrame();
    }
    if (final) {
      this._subStreamOpen = false;
      Events.emit('busy', false);
      Events.emit('tracks');
    }
  };

  Player._subStream = function (reader, track, tok, silent) {
    var self = this;
    self._subStreamOpen = true;
    var dec = null;
    try { dec = new TextDecoder('utf-8'); } catch (e) { dec = null; }
    var pend = '', carry = null;
    function pull(res) {
      if (tok !== self._subFetch || self.subActive !== track) { try { reader.cancel(); } catch (e) { } return; }
      if (res.done) {
        if (carry && carry.length) { try { pend += utf8Decode(carry); } catch (e) { } carry = null; }
        self._subMerge(pend ? pend + '\n\n' : '', track, tok, silent, true);
        return;
      }
      var txt = null;
      try {
        if (dec) txt = dec.decode(res.value, { stream: true });
        else if (typeof res.value === 'string') txt = res.value;
        else {
          /* no TextDecoder: keep an incomplete trailing sequence for the
             next chunk, then decode the safe part with the built-in decoder */
          var u8 = res.value;
          if (carry && carry.length) {
            var joined = new Uint8Array(carry.length + u8.length);
            joined.set(carry); joined.set(u8, carry.length);
            u8 = joined; carry = null;
          }
          var cut = utf8SafeCut(u8);
          if (cut < u8.length) carry = Array.prototype.slice.call(u8, cut);
          txt = utf8Decode(cut ? u8.subarray(0, cut) : new Uint8Array(0));
        }
      } catch (e) { txt = null; }
      if (txt) {
        pend += txt;
        /* feed only complete blocks to the parser; the partial tail waits */
        var blocks = pend.split(/\n{2,}/);
        pend = blocks.pop() || '';
        if (blocks.length) self._subMerge(blocks.join('\n\n') + '\n\n', track, tok, silent, false);
      }
      return reader.read().then(pull).catch(function (e) {
        if (tok === self._subFetch && self.subActive === track) {
          self._subStreamOpen = false;
          Events.emit('busy', false);
          Toast.show('Subtitle load failed: ' + esc((e && e.message) || ''), { kind: 'err', icon: 'subs-off' });
        }
      });
    }
    return reader.read().then(pull);
  };

  /* per-frame subtitle paint. timeupdate only fires about four times a
     second, which let cues pop in up to a quarter second late — with an
     active track the cue search runs on every animation frame instead. */
  Player.subFrame = function () {
    if (this._subRaf || typeof requestAnimationFrame !== 'function') return;
    var self = this;
    this._subRaf = requestAnimationFrame(function step() {
      self._subRaf = 0;
      if (!self.playing || !self.subCues || !self.subCues.length || document.hidden) return;
      var v = self.el;
      var t = (self.transcode ? (self.tOffset || 0) : 0) + ((v && v.currentTime) || 0);
      self.renderSubs(t);
      self._subRaf = requestAnimationFrame(step);
    });
  };

  /* cues are fetched around the position the track was selected at; a jump
     outside that window re-requests the track from the new position so the
     subs appear at once instead of waiting for the walk to catch up */
  Player.subSeekCheck = function (t) {
    var a = this.subActive;
    if (!a || !this.item) return;
    var cues = this.subCues || [];
    var last = cues.length ? (cues[cues.length - 1].end || 0) : 0;
    if (t < (this._subFrom || 0) - 5) { this.setSubtitle(a, true, 0); return; }
    if (t > last + 90 && this._subStreamOpen) this.setSubtitle(a, true, t);
  };

  /* pick a subtitle automatically when a file opens — the remembered choice
     first, then the best sidecar, then the first embedded track. Switch it
     off in Settings → Subtitles if you prefer to choose manually. */
  Player.autoPickSub = function (item) {
    if (!S.subautoload || !item || this.item !== item) return;
    if (this.subActive || this._subAutoItem === item) return;
    this._subAutoItem = item;
    var pick = null, i;
    var ext = this.subTracks.filter(function (tr) { return tr && tr.kind === 'external'; });
    /* a remembered pick always wins; then the subtitle whose language matches
       the preferred one (fa/per/fas/farsi/… by default); then the first one */
    for (i = 0; i < ext.length && !pick; i++) if (ext[i].remembered) pick = ext[i];
    var langOf = function (tr) {
      var s = String((tr && (tr.lang || '')) + ' ' + ((tr && tr.label) || '')).toLowerCase();
      return /(?:^|[^a-z])(fa|fas|per|farsi|persian|فارسی)(?:[^a-z]|$)/.test(s);
    };
    if (!pick && S.subLang !== 'off') {
      for (i = 0; i < ext.length && !pick; i++) if (langOf(ext[i])) pick = ext[i];
    }
    if (!pick && ext.length) pick = ext[0];
    if (!pick) {
      for (i = 0; i < this.subTracks.length && !pick; i++) {
        if (this.subTracks[i] && this.subTracks[i].kind === 'embedded') pick = this.subTracks[i];
      }
    }
    if (pick) this.setSubtitle(pick, true, this.pendingSeek || this.time || 0);
  };

  Player.reloadSubtitleDelay = function () {
    /* the delay is applied while the cues are painted — changing it is a
       repaint, the track is not fetched again */
    if (this.subActive) this.renderSubs(this.time);
  };
  Player.renderSubs = function (t) {
    var layer = $('#subsLayer');
    if (!layer) return;
    /* a look change while a cue is on screen must repaint it immediately */
    if (this._subStyleSig && this._subStyleSig !== subInlineStyle()) this._subSig = '';
    var cues = this.subCues;
    if (!cues.length) { if (layer.firstChild) layer.innerHTML = ''; return; }
    var tt = t + (S.subDelay / 1000);
    var i = Subs.indexAt(cues, tt);
    var active = [];
    /* a cue can span several lines; also allow overlapping cues (dual subs) */
    for (var k = Math.max(0, i - 2); k < Math.min(cues.length, i + 3); k++) {
      var c = cues[k];
      if (c.start <= tt && c.end > tt) active.push(c);
    }
    var sig = active.map(function (c) { return c.start + ':' + c.text; }).join('|');
    if (sig === this._subSig) return;
    this._subSig = sig;
    var style = subInlineStyle();
    this._subStyleSig = style;
    layer.innerHTML = active.map(function (c) {
      return '<div class="sub-line" dir="auto" style="' + style + '">' + Subs.markup(c.text) + '</div>';
    }).join('');
  };

  /* ------------------------------------------------------------------ audio chain
     Real WebAudio graph: 10 peaking bands + optional compressor (loudness) + gain. */
  var Audio = {
    ctx: null, src: null, bands: null, comp: null, gain: null, on: false,
    FREQ: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
    PRESETS: {
      flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      bass: [7, 6, 4.5, 2.5, 0.5, -0.5, -1, -1, 0, 1],
      voice: [-3, -2.5, -1, 1.5, 3.5, 4.5, 3.5, 2, 0.5, -1],
      rock: [5, 4, 2, -1, -2, -0.5, 2.5, 4, 4.5, 3.5],
      pop: [-1.5, -1, 0, 2, 4, 4, 2, 0, -1, -1.5],
      jazz: [3.5, 2.5, 1, 1.5, -1, -1.5, 0, 1.5, 3, 3.5],
      cinema: [4, 3, 1.5, 0, -1, 0.5, 2, 3.5, 5, 6],
      night: [-6, -4, -1, 2, 4, 4, 3, 2, 0, -2]
    },
    ensure: function () {
      if (!this.wanted()) return false;
      if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return true; }
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.src = this.ctx.createMediaElementSource(Player.el);
        this.bands = this.FREQ.map(function (f, i) {
          var f2 = this.ctx.createBiquadFilter();
          f2.type = 'peaking'; f2.frequency.value = f; f2.Q.value = 1.1; f2.gain.value = S.eqBands[i] || 0;
          return f2;
        }, this);
        this.comp = this.ctx.createDynamicsCompressor();
        this.comp.threshold.value = -24; this.comp.knee.value = 24; this.comp.ratio.value = 6;
        this.comp.attack.value = 0.02; this.comp.release.value = 0.25;
        this.gain = this.ctx.createGain();
        var node = this.src;
        this.bands.forEach(function (b) { node.connect(b); node = b; });
        node.connect(this.gain);
        this.gain.connect(this.ctx.destination);
        this.on = true;
        this.route();
        /* the graph now owns the output level: the element plays at 100% and
           the interface volume lives on the gain node */
        this.setVolume(S.volume, S.muted);
        return true;
      } catch (e) {
        console.warn('[lumen] audio graph unavailable', e);
        this.ctx = null; this.on = false;
        return false;
      }
    },
    wanted: function () { return !!(S.eq || S.normalize || S.boost); },
    teardown: function () {
      if (!this.ctx) return;
      try {
        this.src.disconnect();
        this.bands.forEach(function (b) { b.disconnect(); });
        this.comp.disconnect(); this.gain.disconnect();
      } catch (e) { }
      /* the element keeps playing through the graph if we cannot unplug it */
      this.on = false;
    },
    route: function () {
      if (!this.ctx || !this.on) return;
      try {
        this.gain.disconnect();
        if (S.normalize) { this.gain.connect(this.comp); this.comp.connect(this.ctx.destination); }
        else { this.gain.connect(this.ctx.destination); this.comp.disconnect(); }
      } catch (e) { }
    },
    applyEq: function () {
      if (!this.bands) return;
      var self = this;
      this.bands.forEach(function (b, i) { b.gain.value = S.eqBands[i] || 0; });
    },
    /* master level of the graph (interface volume / mute / boost) */
    setVolume: function (v, muted) {
      if (!this.ctx || !this.gain) return;
      var target = muted ? 0 : clamp(v == null ? 1 : v, 0, 1);
      if (S.boost) target *= 2;                       /* up to 200% */
      try {
        if (this.gain.gain.setTargetAtTime) this.gain.gain.setTargetAtTime(target, this.ctx.currentTime, 0.012);
        else this.gain.gain.value = target;
      } catch (e) { this.gain.gain.value = target; }
    },
    preset: function (name) {
      var p = this.PRESETS[name] || this.PRESETS.flat;
      setSetting('eqPreset', name);
      setSetting('eqBands', p.slice(0));
      this.ensure(); this.applyEq();
      Events.emit('eq');
    },
    attach: function () { if (this.wanted()) { this.ensure(); this.route(); } },
    /* react to the Settings switches while a file is playing: build the graph
       when EQ/normalize is turned on, dismantle it when both are off, and
       re-route the gain through (or around) the compressor. Switching to an
       online stream source is also handled here. */
    sync: function () {
      if (this.wanted()) {
        this.ensure();
        this.route();
        this.applyEq();
      } else if (this.on) {
        this.teardown();
      }
      /* with the graph dismantled the element owns its volume again */
      Player.applyVolume();
      /* an online item played directly sounds muted once a WebAudio graph
         attaches to it (the <video> tag has no crossorigin attribute), so it
         is rebased onto the same-origin proxy; the reverse happens on off */
      var item = Player.item;
      if (!item || item.demo || item.path || !/^https?:/i.test(item.url || '') || Player.transcode) return;
      var wantProxy = this.wanted();
      if (!!item._proxied === !!wantProxy) return;
      var t = Player.time || 0;
      item._proxied = wantProxy;
      var url = wantProxy ? Bridge.playbackUrl(item, t) : item.url;
      if (!url) return;
      Player.el.src = url;
      Player.pendingSeek = t > 0.3 ? t : null;
      Player.el.load();
      if (Player.playing) Player.play();
    }
  };

  /* ------------------------------------------------------------------ toasts */
  var Toast = {
    show: function (text, opts) {
      opts = opts || {};
      var host = $('#toasts');
      if (!host) return null;
      var el = document.createElement('div');
      el.className = 'toast ' + (opts.kind || 'info');
      el.innerHTML = '<span class="ic">' + icon(opts.icon || 'info', 18) + '</span><div class="txt">' + text + '</div>';
      if (opts.action && opts.action.label) {
        var b = document.createElement('button');
        b.className = 'act'; b.textContent = opts.action.label;
        b.addEventListener('click', function (e) { e.stopPropagation(); opts.action.fn(); Toast.dismiss(el); });
        el.appendChild(b);
      }
      host.appendChild(el);
      requestAnimationFrame(function () { el.classList.add('in'); });
      var ms = opts.ms || (opts.action ? 7000 : 3200);
      el._t = setTimeout(function () { Toast.dismiss(el); }, ms);
      el.addEventListener('click', function () { Toast.dismiss(el); });
      Toast.trim();
      return el;
    },
    dismiss: function (el) {
      if (!el || !el.parentNode) return;
      clearTimeout(el._t);
      el.classList.remove('in');
      setTimeout(function () { el.remove(); }, 260);
    },
    trim: function () {
      var host = $('#toasts');
      if (!host) return;
      while (host.children.length > 4) host.removeChild(host.firstChild);
    },
    clear: function () { var h = $('#toasts'); if (h) h.innerHTML = ''; }
  };

  /* ------------------------------------------------------------------ modal */
  var Modal = {
    open: function (html, opts) {
      opts = opts || {};
      var bd = $('#modalBd'), box = $('#modal');
      if (!bd || !box) return;
      box.innerHTML = html;
      bd.classList.add('open');
      Modal.el = box;
      if (opts.onOpen) opts.onOpen(box);
      injectIcons(box);
      var first = box.querySelector('input,button.btn');
      if (first && opts.focus !== false) setTimeout(function () { try { first.focus(); } catch (e) { } }, 60);
      return box;
    },
    close: function () { var bd = $('#modalBd'); if (bd) { bd.classList.remove('open'); bd.dataset.kind = ''; } },
    isOpen: function () { var bd = $('#modalBd'); return !!(bd && bd.classList.contains('open')); }
  };

  /* ------------------------------------------------------------------ OSD (volume etc.) */
  var Osd = {
    show: function () {
      var osd = $('#osd');
      if (!osd) return;
      var p = S.muted ? 0 : S.volume;
      var name = (S.muted || p === 0) ? 'volume-mute' : (p < 0.5 ? 'volume-low' : 'volume-high');
      var span = $('span[data-icon]', osd);
      if (span) { span.setAttribute('data-icon', name); injectIcons(osd); }
      var pct = clamp(S.boost ? (p * 2) : p, 0, 2);          /* boost: 100–200% */
      $('.osd .meter i', osd).style.width = (pct * 50) + '%';
      var b = $('.osd b', osd); if (b) b.textContent = Math.round(pct * 100) + '%';
      osd.classList.add('show');
      clearTimeout(Osd._t);
      Osd._t = setTimeout(function () { osd.classList.remove('show'); }, 1100);
    }
  };

  /* ------------------------------------------------------------------ public API */
  window.Lumen = {
    util: { $: $, $$: $$, clamp: clamp, fmt: fmt, fmtLong: fmtLong, baseName: baseName, extName: extName,
      isVideoExt: isVideoExt, isAudioExt: isAudioExt, isSubExt: isSubExt, esc: esc, uid: uid,
      icon: icon, injectIcons: injectIcons, debounce: debounce },
    S: S, setSetting: setSetting, saveSettings: saveSettings, saveSettingsNow: flushSettings, DEFAULTS: DEFAULTS,
    Events: Events, Bridge: Bridge, Playlist: Playlist, Player: Player, Subs: Subs, Audio: Audio,
    subStyle: SUB_STYLE,
    Toast: Toast, Modal: Modal, Osd: Osd, resumeGet: resumeGet, resumeSet: resumeSet, resumeClear: resumeClear, resumeSeed: resumeSeed,
    notify: function (t, o) { return Toast.show(t, o); },
    setVolume: function (v, silent) {
      S.volume = clamp(v, 0, 1);
      if (S.volume > 0) S.muted = false;
      Player.applyVolume();
      saveSettings();
      if (!silent) Osd.show();
      Events.emit('volume');
    },
    /* boost amplifies on top of the interface volume (100→200%) — the WebAudio
       gain node is the only place a level above the file's own volume is
       possible, so turning it on may switch the playback chain */
    setBoost: function (on) {
      S.boost = !!on;
      saveSettings();
      Audio.sync();
      Osd.show();
      Events.emit('volume');
    },
    toggleMute: function () {
      S.muted = !S.muted;
      Player.applyVolume();
      saveSettings(); Osd.show(); Events.emit('volume');
    }
  };
  /* fix the typo-safe alias collection (kept explicit for clarity) */
  window.Lumen.util.isSubExt = isSubExt;

})();
