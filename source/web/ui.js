/* ==========================================================================
   Lumen — ui.js
   Chrome rendering (title bar, dock, panels, playlist), settings widgets,
   zoom / pan / pinch, and the click · double-click · long-press · swipe
   gesture engine. Everything the Python host drives lives in shell.js.
   ========================================================================== */
(function () {
  'use strict';

  var L = window.Lumen;
  if (!L) { console.error('[lumen] app.js must load before ui.js'); return; }
  var u = L.util, $ = u.$, $$ = u.$$, clamp = u.clamp, fmt = u.fmt, fmtLong = u.fmtLong;
  var S = L.S, P = L.Player, PL = L.Playlist, Ev = L.Events;

  /* ------------------------------------------------------------------ elements */
  var el = {
    html: document.documentElement,
    body: document.body,
    stage: $('#stage'), win: $('#win'), stack: $('#stack'), zoomer: $('#zoomer'),
    video: $('#video'), subs: $('#subsLayer'), loading: $('.loading'),
    titlebar: $('#titlebar'), tbFile: $('#tbFile'), tbChip: $('#tbChip'), tbMark: $('#tbMark'),
    zoomBadge: $('#zoomBadge'), zoomVal: $('#zoomVal'),
    scrub: $('#scrubPreview'), scrubTime: $('#scrubTime'), scrubDelta: $('#scrubDelta'), scrubIcon: $('#scrubIcon'),
    seekLeft: $('#seekFxLeft'), seekRight: $('#seekFxRight'),
    seekLeftN: $('#seekLeftN'), seekRightN: $('#seekRightN'),
    seekbar: $('#seekbar'), sbPlayed: $('#sbPlayed'), sbBuffered: $('#sbBuffered'),
    sbThumb: $('#sbThumb'), sbTip: $('#sbTip'), sbAB: $('#sbAB'), sbTick: $('#sbTick'),
    sbMarks: $('#sbMarks'), sbThumbImg: $('#sbThumbImg'),
    tNow: $('#tNow'), tDur: $('#tDur'), tSpeed: $('#tSpeed'),
    btnPlay: $('#btnPlay'), centerPlay: $('#centerPlay'),
    volFill: $('#volFill'), volDot: $('#volDot'), volRail: $('#volRail'),
    miniFill: $('#miniFill'), miniTime: $('#miniTime'), miniTitle: $('#miniTitle'), miniPlay: $('#miniPlay'),
    plBody: $('#plBody'), plChip: $('#plChip'), plSearch: $('#plSearch'), plMode: $('#plMode'),
    plStatus: $('#plStatus'),
    audioTracks: $('#audioTracks'), subTracks: $('#subTracks'), subsBadge: $('#subsBadge'),
    eqBands: $('#eqBands'), eqPreset: $('#eqPreset'),
    zoomLabel: $('#zoomLabel')
  };
  L.UI = { el: el };
  window.LumenUI = el; /* small hook for the host / debugging */

  /* ------------------------------------------------------------------ theme & chrome */
  var MODES = ['window', 'max', 'full', 'mini'];
  /* classes applyChrome() owns; everything else on <body> is left alone
     (panels-open, media-loaded, drop … used to be wiped on every redraw) */
  var MANAGED = ['theme-dark', 'theme-light', 'theme-black',
    'mode-window', 'mode-max', 'mode-full', 'mode-mini',
    'touch', 'lores', 'demo', 'playing'];
  function applyChrome() {
    MANAGED.forEach(function (c) { el.body.classList.remove(c); });
    el.body.classList.add('theme-' + S.theme, 'mode-' + (el.body.dataset.mode || 'window'));
    if (S.touchui) el.body.classList.add('touch');
    if (S.lores) el.body.classList.add('lores');
    if (!L.Bridge.ready) el.body.classList.add('demo');
    if (el.html.classList.contains('playing') || el.body.classList.contains('playing')) el.body.classList.add('playing');
    el.html.style.setProperty('--glass-blur', (S.lores ? 0 : S.glass) + 'px');
    el.html.style.setProperty('--sub-size', S.subSize + 'px');
    if (S.lores) el.html.style.setProperty('--glass-sat', '1');
    else el.html.style.removeProperty('--glass-sat');
    if (S.lores) el.html.classList.add('lores'); else el.html.classList.remove('lores');
    el.subs.className = 'subs-layer subs-' + (S.subPreset || 'default');
    el.subs.style.paddingBottom = (S.subPos || 0) + '%';
    var scrim = (S.theme === 'light') ? 0.18 : 0.42;
    el.html.style.setProperty('--scrim', String(scrim));
  }
  function setMode(mode) {
    if (MODES.indexOf(mode) < 0) mode = 'window';
    L.Player.applyVideoTransforms();
    el.body.dataset.mode = mode;
    el.html.setAttribute('data-mode', mode);
    if (el.win) el.win.style.transform = '';   /* drop the drag fallback offset */
    applyChrome();
    requestAnimationFrame(function () { updatePanBounds(); if (Zoom.z > 1.001) applyTransform(); });
    Ev.emit('mode', mode);
  }
  function setPlayingChrome(p) {
    el.html.classList.toggle('playing', p);
    if (p) el.body.classList.add('playing');
    else { el.body.classList.remove('playing'); el.body.classList.remove('center-hover'); el.html.classList.remove('center-hover'); }
    var name = p ? 'pause' : 'play';
    [[el.btnPlay, 22], [el.centerPlay, 34], [el.miniPlay, 20]].forEach(function (pair) {
      var host = pair[0]; if (!host) return;
      var span = $('span[data-icon]', host);
      if (!span) return;
      span.setAttribute('data-icon', name);
      u.injectIcons(host);
    });
    if (el.centerPlay) el.centerPlay.classList.toggle('paused', !p);
  }

  /* ------------------------------------------------------------------ dock / time */
  var rendered = {};
  function renderTime() {
    var t = P.time || 0, d = P.dur || 0;
    var p = d > 0 ? clamp(t / d, 0, 1) : 0;
    if (el.sbPlayed) el.sbPlayed.style.width = (p * 100) + '%';
    if (el.sbThumb) el.sbThumb.style.left = (p * 100) + '%';
    if (el.tNow) el.tNow.textContent = fmt(t);
    if (el.tDur) el.tDur.textContent = '/ ' + fmt(d);
    if (el.miniFill) el.miniFill.style.width = (p * 100) + '%';
    if (el.miniTime) el.miniTime.textContent = fmt(t) + ' / ' + fmt(d);
    if (el.sbTick && S.repeat === 'one') el.sbTick.style.left = '100%';
    P.renderSubs(t);
  }
  function renderBuffered() {
    var v = el.video, d = P.dur || 0;
    if (!el.sbBuffered) return;
    var w = 0;
    try {
      var b = v.buffered;
      for (var i = 0; i < b.length; i++) {
        if (b.start(i) <= (P.time + 0.5) && b.end(i) >= P.time) { w = b.end(i) / (d || 1); break; }
        if (i === b.length - 1) w = b.end(i) / (d || 1);
      }
    } catch (e) { }
    el.sbBuffered.style.width = (clamp(w, 0, 1) * 100) + '%';
  }
  function renderVolume() {
    var p = S.muted ? 0 : S.volume;
    if (el.volFill) el.volFill.style.width = (p * 100) + '%';
    if (el.volDot) el.volDot.style.left = (p * 100) + '%';
    var btn = $('#btnMute');
    if (btn) {
      var span = $('span[data-icon]', btn);
      if (span) {
        span.setAttribute('data-icon', (S.muted || p === 0) ? 'volume-mute' : (p < 0.5 ? 'volume-low' : 'volume-high'));
        u.injectIcons(btn);
      }
    }
    var setVol = $('#setVol'); if (setVol) setVol.value = String(p);
    var lv = $('#setVolVal'); if (lv) lv.textContent = Math.round(p * 100) + '%';
    /* one guarded writer: muting must not overwrite the remembered volume */
    if (P.applyVolume) P.applyVolume();
  }
  function renderRate() {
    if (el.tSpeed) {
      el.tSpeed.style.display = (Math.abs(S.speed - 1) > 0.001) ? '' : 'none';
      el.tSpeed.textContent = S.speed + '×';
    }
    if (el.miniTitle && P.item) el.miniTitle.textContent = P.item.title || P.item.name || 'Lumen';
  }
  function renderTitle() {
    var it = P.item;
    if (el.tbMark && window.LUMEN_LOGO) el.tbMark.innerHTML = window.LUMEN_LOGO;
    if (el.tbFile) {
      el.tbFile.textContent = it ? (it.title || it.name || it.path) : 'No media loaded — drop a file or press Ctrl+O';
    }
    var chip = el.tbChip;
    if (chip) {
      var info = P.info || {};
      var bits = [];
      if (it && it.h) bits.push(((it.h >= 2000) ? '4K' : (it.h >= 1000) ? '1080p' : (it.h >= 700) ? '720p' : it.h + 'p'));
      if (info.vcodec) bits.push(info.vcodec.toUpperCase());
      if (info.hdr) bits.push('HDR');
      if (P.transcode) bits.push('FFMPEG');
      if (bits.length) { chip.hidden = false; chip.textContent = bits.join(' · '); }
      else chip.hidden = true;
    }
    document.title = (it ? (it.title || it.name) + ' — ' : '') + 'Lumen';
    renderRate();
    renderChapters();
    if (it && it.token && !it.thumb) loadThumb(it);
  }
  /* chapter markers on the seekbar track (nothing shown without chapters) */
  function renderChapters() {
    if (!el.sbMarks) return;
    var ch = (P.chapters || []).slice(0, 64);
    if (!ch.length || !P.dur) { el.sbMarks.innerHTML = ''; return; }
    el.sbMarks.innerHTML = ch.map(function (c) {
      return '<i style="left:' + (clamp(c.start / P.dur, 0, 1) * 100).toFixed(3) + '%"></i>';
    }).join('');
  }
  /* hover a chapter marker → its title */
  function chapterAt(p) {
    var ch = P.chapters || [];
    if (!ch.length || !P.dur) return null;
    var t = p * P.dur;
    for (var i = 0; i < ch.length; i++) if (t >= ch[i].start && (i === ch.length - 1 || t < ch[i].end)) { ch[i].index = i; return ch[i]; }
    return null;
  }
  function loadThumb(it) {
    var url = L.Bridge.thumbUrl(it, 0);
    if (!url) return;
    it.thumb = url;
    Ev.emit('playlist');
  }
  function renderAB() {
    var ab = P.ab, bar = el.sbAB;
    if (!bar) return;
    if (!ab || ab.a == null) { bar.classList.add('hidden'); return; }
    var d = P.dur || 1;
    bar.classList.remove('hidden');
    bar.style.left = (clamp(ab.a / d, 0, 1) * 100) + '%';
    bar.style.width = ((ab.b != null ? clamp((ab.b - ab.a) / d, 0, 1) : 0.001) * 100) + '%';
  }

  /* ------------------------------------------------------------------ playlist */
  var plFilter = '';
  var plSig = '';          /* what the list currently shows */
  var plFrame = 0;

  /* Adding a folder emits `playlist` once per file; painting every one of those
     rebuilt the whole <div class="panel-body"> N times. Coalesce to one paint
     per animation frame. */
  function schedulePlaylist() {
    if (plFrame) return;
    plFrame = requestAnimationFrame(function () { plFrame = 0; renderPlaylist(); });
  }

  function renderPlaylist() {
    if (!el.plBody) return;
    var items = PL.items;
    var list = plFilter ? items.filter(function (x) { return (x.name || '').toLowerCase().indexOf(plFilter) >= 0; }) : items;

    /* A cheap signature of everything the rows actually show. When it did not
       change (play/pause, repeated emits, the same title update) the DOM is
       already correct — a full innerHTML rebuild is pure waste, and it also
       threw away the scroll position. */
    var sig = plFilter + '|' + PL.index + '|' + (S.shuffle ? 's' : '') + S.repeat + '|';
    for (var i = 0; i < list.length; i++) {
      var it0 = list[i];
      sig += it0.uid + ':' + (it0.dur || 0) + ':' + (it0.thumb ? 1 : 0) + ':' + (it0.title || it0.name || '') + ';';
    }
    if (sig === plSig) return;
    plSig = sig;

    var total = items.reduce(function (a, x) { return a + (x.dur || 0); }, 0);
    if (el.plChip) el.plChip.textContent = items.length + ' items' + (total > 0 ? ' · ' + fmtLong(total).replace(/^0:/, '') : '');
    if (el.plMode) el.plMode.textContent = (S.shuffle ? 'shuffle · ' : '') + 'repeat: ' + S.repeat;
    if (!list.length) {
      el.plBody.innerHTML = '<div class="pempty">' + (items.length ? 'No matches in the playlist.' :
        '<b>Playlist is empty.</b><br>Drop files on the video, or use <b>Ctrl+O</b> / the + button.') + '</div>';
      return;
    }
    var cur = PL.current();
    /* index lookup in a Map: items.indexOf() inside the row loop was O(n²) */
    var idxOf = new Map();
    items.forEach(function (x, n) { idxOf.set(x, n); });
    var html = list.map(function (it) {
      var idx = idxOf.get(it) || 0;
      var active = (it === cur);
      var thumb = it.thumb ? ' style="background-image:url(\'' + it.thumb + '\')"' : '';
      var lead = active ? '<span class="eq"><i></i><i></i><i></i></span>' : '<span class="idx">' + (idx + 1) + '</span>';
      return '<div class="pitem' + (active ? ' active' : '') + '" data-uid="' + it.uid + '" data-idx="' + idx + '" draggable="true">' +
        lead +
        '<div class="meta"><div class="t">' + u.esc(it.title || it.name) + '</div><div class="s">' +
        (it.dur ? fmt(it.dur) + ' · ' : '') + (it.ext ? it.ext.toUpperCase() : 'MEDIA') +
        (it.w ? ' · ' + it.w + '×' + it.h : '') + (it.subs && it.subs.length ? ' · subs' : '') + '</div></div>' +
        '<span class="thumb"' + thumb + '><span class="badge-dur">' + (it.dur ? fmt(it.dur) : '') + '</span></span>' +
        '<button class="dbtn kill" title="Remove from playlist">' + u.icon('trash', 14) + '</button>' +
        '</div>';
    }).join('');
    var sc = el.plBody.scrollTop;
    el.plBody.innerHTML = html;
    if (sc) el.plBody.scrollTop = sc;
    /* rows carry ready-made SVGs; only pay for the icon pass if a row uses a
       data-icon placeholder */
    if (html.indexOf('data-icon') >= 0) u.injectIcons(el.plBody);
  }
  function plClick(e) {
    var kill = e.target.closest('.kill');
    var row = e.target.closest('.pitem');
    if (!row) return;
    var it = PL.byUid(row.getAttribute('data-uid'));
    if (!it) return;
    if (kill) { e.stopPropagation(); PL.remove(it.uid); if (it === P.item) P.pause(); return; }
    L.loadItem(it);
  }
  function plContext(e) {
    var row = e.target.closest('.pitem'); if (!row) return;
    e.preventDefault();
    var it = PL.byUid(row.getAttribute('data-uid'));
    if (!it) return;
    Menu.show([
      { title: 'Item', sub: 'Playlist' },
      { head: u.esc(it.name) },
      { label: 'Play', icon: 'play', run: function () { L.loadItem(it); } },
      { label: 'Play next', icon: 'next', run: function (i) { PL.move(PL.items.indexOf(it), PL.index + 1); } },
      { label: 'Move to top', icon: 'layers', run: function () { PL.move(PL.items.indexOf(it), 0); } },
      { sep: true },
      { label: 'Attach subtitle…', icon: 'subtitles', run: function () { L.pickSubtitles(function (paths) { attachSubs(it, paths); }); } },
      { label: 'Copy path', icon: 'folder', disabled: !it.path, run: function () { L.copy(it.name, it.path); } },
      { label: 'Remove from playlist', icon: 'trash', run: function () { PL.remove(it.uid); } },
      { sep: true },
      { label: 'Media info…', icon: 'info', disabled: !it.path, run: function () { Info.open(it); } }
    ], e.clientX, e.clientY, L.isTouchUI());
  }
    function attachSubs(it, paths) {
      if (!paths || !paths.length) return;
      if (!it) {
        L.Toast.show('Subtitle ready — open a video to see it.', { icon: 'subtitles' });
        return;
      }
      it.subs = it.subs || [];
      paths.forEach(function (p) { it.subs.push(p); });
      Ev.emit('playlist');
      if (it === P.item) {
        P.subTracks = P.subTracks.concat(paths.map(function (p) {
          return { id: 'ext:' + p, label: u.baseName(p), kind: 'external', path: p };
        }));
        Ev.emit('tracks');
        L.Toast.show('Subtitle attached: ' + u.baseName(paths[0]), { icon: 'subtitles', ms: 2600 });
      }
      if (it.path) L.Bridge.call('remember_subs', it.path, paths);
    }
    /* chapter marks were attached when the probe answered — paint them */
    Ev.on('media', renderChapters);

  /* ------------------------------------------------------------------ tracks */
  function renderTracks() {
    if (el.audioTracks) {
      var cur = P.transcodeAudio;
      el.audioTracks.innerHTML = (P.audioTracks.length ? '' : '<option value="-1">Default</option>') +
        P.audioTracks.map(function (a, i) {
          return '<option value="' + i + '"' + (i === cur ? ' selected' : '') + '>' + u.esc(a.label || ('Track ' + (i + 1))) + '</option>';
        }).join('');
    }
    if (el.subTracks) {
      var act = P.subActive;
      el.subTracks.innerHTML = '<option value="-1"' + (!act ? ' selected' : '') + '>Off</option>' +
        P.subTracks.map(function (t, i) {
          return '<option value="' + i + '"' + (act === t ? ' selected' : '') + '>' + u.esc(t.label || ('Sub ' + (i + 1))) + '</option>';
        }).join('');
    }
    if (el.subsBadge) {
      var on = !!P.subActive;
      el.subsBadge.classList.toggle('hidden', !on);
      el.subsBadge.textContent = on ? String(P.subTracks.indexOf(P.subActive) + 1 || 1) : '';
    }
    var loadBtn = $('#subLoadBtn');
    var sel = $('#subTracks');
    if (sel && sel.value !== '-1' && !P.subActive && P.subTracks.length) { /* keep Off */ }
  }
  function cycleSubs(dir) {
    var n = P.subTracks.length;
    if (!n) { L.pickSubtitles(function (paths) { attachSubs(P.item, paths); }); return; }
    var i = P.subTracks.indexOf(P.subActive);
    i = dir > 0 ? (i + 1) : (i - 1);
    if (i >= n) i = -1;
    if (i < -1) i = n - 1;
    P.setSubtitle(i >= 0 ? P.subTracks[i] : null);
  }
  function cycleAudio() {
    if (!P.audioTracks.length) { L.Toast.show('No extra audio tracks found in this file.', { icon: 'audio-track' }); return; }
    var i = (P.transcodeAudio == null ? 0 : P.transcodeAudio + 1) % P.audioTracks.length;
    P.switchAudio(i);
  }
  var SPEEDS = [0.25, 0.5, 1, 1.5, 1.75, 2, 2.5, 3];
  function cycleSpeed(dir) {
    var i = SPEEDS.indexOf(S.speed);
    if (i < 0) i = SPEEDS.indexOf(1);
    i = clamp(i + dir, 0, SPEEDS.length - 1);
    P.setSpeed(SPEEDS[i]);
    L.Toast.show('Speed ' + SPEEDS[i] + '×', { icon: 'speed', ms: 1400 });
  }

  /* ------------------------------------------------------------------ zoom / pan */
  var Zoom = {
    z: 1, x: 0, y: 0, min: 1, max: 8, badgeT: null,
    to: function (z, x, y) {
      z = clamp(z, this.min, this.max);
      if (S.smooth) {
        el.zoomer.style.transition = 'transform 200ms var(--ease)';
        clearTimeout(this._tt);
        this._tt = setTimeout(function () { el.zoomer.style.transition = ''; }, 220);
      }
      this.z = z;
      this.x = x != null ? x : this.x;
      this.y = y != null ? y : this.y;
      this.clampPan();
      applyTransform();
      this.showBadge();
    },
    zoomBy: function (f, ax, ay) { this.zoomAbout(this.z * f, ax, ay); },
    zoomAbout: function (nz, ax, ay) {
      nz = clamp(nz, this.min, this.max);
      ax = ax || 0; ay = ay || 0;
      var k = nz / this.z;
      var nx = ax - k * (ax - this.x);
      var ny = ay - k * (ay - this.y);
      this.to(nz, nx, ny);
    },
    /* clamp so the picture never slides away: inside the frame when smaller,
       no gaps when larger */
    clampPan: function () {
      if (this.z <= 1.001) { this.x = 0; this.y = 0; return; }
      var b = panBounds();
      this.x = clamp(this.x, -b.x, b.x);
      this.y = clamp(this.y, -b.y, b.y);
    },
    showBadge: function () {
      if (!el.zoomBadge) return;
      el.zoomVal.textContent = this.z.toFixed(2).replace(/\.00$/, '.0') + '×';
      el.zoomBadge.classList.add('show');
      clearTimeout(this.badgeT);
      this.badgeT = setTimeout(function () { el.zoomBadge.classList.remove('show'); }, 1500);
      if (el.zoomLabel) el.zoomLabel.textContent = Math.round(this.z * 100) + '%';
      $('#zoomHint') && $('#zoomHint').classList.toggle('hidden', this.z <= 1.001);
    },
    reset: function () { this.to(1, 0, 0); },
    toggle: function () { if (this.z > 1.001) this.reset(); else this.to(2, 0, 0); },
    canPan: function () { return this.z > 1.001 && (panBounds().x > 0.5 || panBounds().y > 0.5); }
  };
  function panBounds() {
    if (Zoom.z <= 1.001) return { x: 0, y: 0 };
    var stack = el.stack, W = stack.clientWidth || 1, H = stack.clientHeight || 1;
    var c = P.contentBox();
    var sx = c.w * Zoom.z, sy = c.h * Zoom.z;
    var bx = sx > W ? (sx - W) / 2 : 0;
    var by = sy > H ? (sy - H) / 2 : 0;
    return { x: Math.max(0, bx), y: Math.max(0, by) };
  }
  function applyTransform() {
    el.zoomer.style.transform = 'translate3d(' + Zoom.x.toFixed(2) + 'px,' + Zoom.y.toFixed(2) + 'px,0) scale(' + Zoom.z.toFixed(4) + ')';
    el.stack.classList.toggle('grab', Zoom.z > 1.001);
  }
  function updatePanBounds() { Zoom.clampPan(); applyTransform(); }
  window.addEventListener('resize', u.debounce(function () {
    P.applyVideoTransforms();
    updatePanBounds();
  }, 120));

  /* ------------------------------------------------------------------ idle */
  var idleT = null;
  function wake() {
    el.html.classList.remove('idle');
    clearTimeout(idleT);
    if (S.idle <= 0) return;
    idleT = setTimeout(function () {
      if ($('.panel.open') || Menu.isOpen() || L.Modal.isOpen()) return;
      el.html.classList.add('idle');
    }, S.idle * 1000);
  }
  ['mousemove', 'mousedown', 'keydown', 'wheel', 'touchstart'].forEach(function (n) {
    window.addEventListener(n, wake, { passive: true });
  });

  /* ------------------------------------------------------------------ gestures */
  var G = {
    pointers: new Map(),
    mode: null,         /* 'pan' | 'swipe' | 'vswipe' | 'drag' | 'pinch' */
    moved: false,
    startX: 0, startY: 0, startPanX: 0, startPanY: 0,
    swipeSeconds: 0, vsStart: 0, lastTap: 0, lastTapSide: '',
    longT: null, dragFired: false, pinchStart: 0, pinchZ: 1, pinchMid: { x: 0, y: 0 }, longPressed: false
  };

  function stackRect() { return el.stack.getBoundingClientRect(); }
  function localX(e) { var r = stackRect(); return e.clientX - r.left; }
  function sideOf(clientX) {
    var r = stackRect();
    var x = (clientX - r.left) / r.width;
    if (x < S.dblw) return 'left';
    if (x > 1 - S.dblw) return 'right';
    return 'center';
  }

  /* ---- current CSS scale of the video element (rotation fit factor) */
  function zoomAnchor(clientX, clientY) {
    var r = stackRect();
    return { x: clientX - r.left - r.width / 2, y: clientY - r.top - r.height / 2 };
  }

  function moveWindow(dx, dy) {
    /* dx/dy are deltas from the pointer-down position (screen pixels) */
    if (L.Bridge && L.Bridge.ready) {
      L.Bridge.call('move_window', Math.round(dx), Math.round(dy));
      return;
    }
    if (window.pywebview && window.pywebview._jsApiCallback) {
      try { window.pywebview._jsApiCallback('pywebviewMoveWindow', [Math.round(dx), Math.round(dy)], 'move'); } catch (e) { }
      return;
    }
    /* browser preview without a host: fake the window drag on the mockup */
    var limX = window.innerWidth * 0.42, limY = window.innerHeight * 0.42;
    L._fakeX = clamp((L._fakeX || 0) + dx, -limX, limX);
    L._fakeY = clamp((L._fakeY || 0) + dy, -limY, limY);
    el.win.style.transform = 'translate(' + L._fakeX.toFixed(1) + 'px,' + L._fakeY.toFixed(1) + 'px)';
  }
  L.moveWindow = moveWindow;

  function startNativeDrag() {
    /* deprecated - window dragging is driven directly by moveWindow */
  }

  /* ---- pointer plumbing (mouse + touch share this path) */
  function onDown(e) {
    if (e.button === 2) return;      /* right button → context menu */
    if (e.button === 1) return;
    try { el.stack.setPointerCapture && el.stack.setPointerCapture(e.pointerId); } catch (err) { }
    G.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, t: Date.now(), type: e.pointerType, x0: e.clientX, y0: e.clientY });
    G.moved = false;
    G.dragFired = false;
    G.longPressed = false;
    G.startX = e.clientX; G.startY = e.clientY;
    /* anchors for the window drag: screen coords are the accurate source
       (the window follows the pointer), client coords are the fallback */
    G.winOffsetX = e.screenX; G.winOffsetY = e.screenY;
    G.screenX = e.screenX; G.screenY = e.screenY;
    G.clientX = e.clientX; G.clientY = e.clientY;
    G.startPanX = Zoom.x; G.startPanY = Zoom.y;

    if (G.pointers.size === 2) {
      var pts = Array.from(G.pointers.values());
      G.pinchStart = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      G.pinchZ = Zoom.z;
      G.pinchMid = { x: (pts[0].x + pts[1].x) / 2, y: (pts[0].y + pts[1].y) / 2 };
      G.mode = 'pinch';
      clearTimeout(G.longT);
      return;
    }

    var touch = (e.pointerType === 'touch');
    if (touch) L.markTouch();
    G.mode = Zoom.z > 1.001 ? 'pan' : (touch ? 'touch' : 'drag');

    if (touch && S.touch && S.longpress) {
      clearTimeout(G.longT);
      G.longT = setTimeout(function () {
        if (G.moved || G.pointers.size !== 1) return;
        L.vibrate(18);
        L.markTouch();
        L._menuGuard = Date.now() + 900;
        L._touchGuard = Date.now() + 900;
        if (L.openMenuAt(e.clientX, e.clientY, true)) {
          G.mode = 'menu';
          G.longPressed = true;   /* the release that follows must not close it */
        }
      }, 520);
    }
  }

  function onMove(e) {
    var p = G.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    var dx = e.clientX - G.startX, dy = e.clientY - G.startY;
    var ad = Math.abs(dx) + Math.abs(dy);

    /* two-finger pinch */
    if (G.mode === 'pinch' && G.pointers.size >= 2) {
      var pts = Array.from(G.pointers.values());
      var dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) || 1;
      var f = dist / G.pinchStart;
      if (S.pinch && S.touch) {
        var a = zoomAnchor(G.pinchMid.x, G.pinchMid.y);
        Zoom.zoomAbout(clamp(G.pinchZ * f, Zoom.min, Zoom.max), a.x, a.y);
      }
      G.moved = true;
      return;
    }

    if (ad > 4) { clearTimeout(G.longT); if (!G.moved) G.moved = true; }

    /* PAN ONLY WHEN ZOOMED */
    if (G.mode === 'pan') {
      if (Zoom.z <= 1.001) {
        G.mode = 'drag';
        return;
      }
      var nx = G.startPanX + dx, ny = G.startPanY + dy;
      var b = panBounds();
      Zoom.x = clamp(nx, -b.x, b.x);
      Zoom.y = clamp(ny, -b.y, b.y);
      /* the picture stops at its own edge and stays there: a zoomed drag is a
         pan and nothing else. (It used to hand the gesture over to a window
         move once a limit was hit, which threw the whole window around.) */
      applyTransform();
      return;
    }

    if (G.mode === 'touch' && S.touch) {
      if (S.swipe && Math.abs(dx) > 14 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        G.mode = 'swipe';
        G.swipeSeconds = 0;
        el.scrub.classList.add('show');
      } else if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx) * 1.2) {
        G.mode = 'vswipe';
        G.vsStart = (e.clientX < stackRect().width / 2) ? P.brightness : (S.muted ? 0 : S.volume);
      } else return;
    }

    if (G.mode === 'swipe') {
      var r = stackRect();
      var secs = (dx / Math.max(1, r.width)) * 90;
      G.swipeSeconds = clamp(secs, -360, 360);
      var target = clamp((P.time || 0) + G.swipeSeconds, 0, P.dur || 0);
      el.scrubTime.textContent = fmt(target);
      el.scrubDelta.textContent = (G.swipeSeconds >= 0 ? '+' : '−') + fmt(Math.abs(G.swipeSeconds));
      var ic = $( 'span[data-icon]', el.scrub);
      if (ic) { ic.setAttribute('data-icon', G.swipeSeconds >= 0 ? 'forward-10' : 'backward-10'); u.injectIcons(el.scrub); }
      return;
    }
    if (G.mode === 'vswipe') {
      var r2 = stackRect();
      var frac = -dy / Math.max(1, r2.height);
      if (dx0Left(e)) {   /* left half = picture brightness */
        P.brightness = clamp(G.vsStart + frac * 1.6, 0.25, 2);
        el.zoomer.style.filter = 'brightness(' + P.brightness.toFixed(2) + ')';
        vswipeToast('Brightness ' + Math.round(P.brightness * 100) + '%', 'sparkle');
      } else {
        L.setVolume(clamp(G.vsStart + frac * 1.4, 0, 1), true);
        vswipeToast('Volume ' + Math.round((S.muted ? 0 : S.volume) * 100) + '%', S.muted ? 'volume-mute' : 'volume-high');
      }
      return;
    }
    if (G.mode === 'drag') {                 /* 1× → dragging moves the window (picture does NOT move) */
      if (ad > 4) {
        G.moved = true;
        var d = winDelta(e);          /* stateful: read it once per event */
        moveWindow(d.dx, d.dy);
      }
      return;
    }
    if (G.mode === 'menu') return;
    if (G.mode === 'touch' && ad > 24 && !Zoom.canPan()) {
      /* one-finger drag on an unzoomed picture moves the window (touch too) */
      G.mode = 'drag';
      if (ad > 4) {
        G.moved = true;
        var d2 = winDelta(e);
        moveWindow(d2.dx, d2.dy);
      }
    }
  }
  function dx0Left(e) { var r = stackRect(); return (e.clientX - r.left) < r.width / 2; }

  /* incremental window drag: movement since the previous pointer event.
     Screen coordinates are exact (the window slides under the cursor), but
     some environments report 0 there — then the client delta is used. */
  function winDelta(e) {
    var sdx = e.screenX - (G.screenX || 0), sdy = e.screenY - (G.screenY || 0);
    var cdx = e.clientX - (G.clientX != null ? G.clientX : e.clientX);
    var cdy = e.clientY - (G.clientY != null ? G.clientY : e.clientY);
    var dx, dy;
    if (sdx || sdy) { dx = sdx; dy = sdy; }
    else { dx = cdx; dy = cdy; }
    G.screenX = e.screenX; G.screenY = e.screenY;
    G.clientX = e.clientX; G.clientY = e.clientY;
    return { dx: dx, dy: dy };
  }

  /* One live toast for the vertical brightness/volume swipe — the old code
     spawned a new toast on *every* pointermove. */
  function vswipeToast(text, ic) {
    if (!G.vToast || !G.vToast.parentNode) {
      G.vToast = L.Toast.show(text, { icon: ic, ms: 600000 });
      G.vToastIcon = ic;
      return;
    }
    var t = $('.txt', G.vToast);
    if (t && t.textContent !== text) t.textContent = text;
    if (ic && ic !== G.vToastIcon) {
      G.vToastIcon = ic;
      var box = $('.ic', G.vToast);
      if (box) box.innerHTML = u.icon(ic, 18);
    }
  }
  function endVswipeToast() {
    if (!G.vToast) return;
    L.Toast.dismiss(G.vToast);
    G.vToast = null; G.vToastIcon = null;
  }

  function onUp(e) {
    var p = G.pointers.get(e.pointerId);
    G.pointers.delete(e.pointerId);
    clearTimeout(G.longT);
    try { el.stack.releasePointerCapture && el.stack.releasePointerCapture(e.pointerId); } catch (err) { }

    if (G.mode === 'pinch') {
      if (G.pointers.size < 2) { G.mode = null; Zoom.clampPan(); }
      return;
    }
    if (G.mode === 'swipe') {
      el.scrub.classList.remove('show');
      if (Math.abs(G.swipeSeconds) > 1) P.seek((P.time || 0) + G.swipeSeconds);
      G.mode = null;
      wake();
      return;
    }
    if (G.longPressed) { G.longPressed = false; G.mode = null; return; }
    if (G.mode === 'vswipe') { endVswipeToast(); G.mode = null; return; }
    if (G.mode === 'drag' || G.mode === 'menu') { G.mode = null; return; }
    var wasPan = (G.mode === 'pan');
    G.mode = null;

    if (G.moved || G.dragFired) return;
    if (!p) return;
    var dur = Date.now() - p.t;
    var touch = (e.pointerType === 'touch');

    /* -------- tap / click semantics -------- */
    if (touch && S.touch) {
      var now = Date.now();
      if (now - G.lastTap < 320 && Math.abs(p.x0 - p.x) < 24) {
        /* double tap */
        G.lastTap = 0;
        var side = sideOf(p.x);
        L.handleDoubleClick(side, p.x, p.y);
        return;
      }
      G.lastTap = now;
      L.handleSingleClick(sideOf(p.x), p.x, p.y, true);
      return;
    }

    /* mouse click (the double-click handler cancels the pending single click) */
    L.handleSingleClick(sideOf(p.x), p.x, p.y, false);
    void wasPan;
  }

  /* ---- wheel ---- */
  function onWheel(e) {
    if (L.Modal.isOpen()) return;
    var mode = S.wheel;
    if (e.ctrlKey) mode = 'zoom';
    else if (e.shiftKey) mode = 'seek';
    if (mode === 'zoom') {
      e.preventDefault();
      var dy = e.deltaY;
      if (e.deltaMode === 1) dy *= 33;          /* lines → px */
      else if (e.deltaMode === 2) dy *= 300;    /* pages → px */
      var f = clamp(Math.pow(1.0015, -dy), 0.72, 1.38);
      var a = zoomAnchor(e.clientX, e.clientY);
      Zoom.zoomBy(f, a.x, a.y);
      return;
    }
    e.preventDefault();
    if (mode === 'volume') L.setVolume((S.muted ? 0 : S.volume) + (e.deltaY < 0 ? 0.03 : -0.03));
    else if (mode === 'seek') P.nudge(e.deltaY < 0 ? S.seekstep : -S.seekstep);
  }

  /* ---- seek ripple ---- */
  function seekFx(side, secs) {
    var fx = side === 'left' ? el.seekLeft : el.seekRight;
    if (fx) {
      fx.classList.remove('run'); void fx.offsetWidth; fx.classList.add('run');
      /* drop the class again: a lingering .run keeps a blurred chip alive */
      clearTimeout(fx._t);
      fx._t = setTimeout(function () { fx.classList.remove('run'); }, 760);
    }
    P.nudge(side === 'left' ? -secs : secs);
  }
  function renderSeekStep() {
    if (el.seekLeftN) el.seekLeftN.textContent = String(S.seekstep);
    if (el.seekRightN) el.seekRightN.textContent = String(S.seekstep);
  }

  /* ---- public click handlers used by both mouse and touch ---- */
  L.handleSingleClick = function (side, x, y, isTouch) {
    if (L.Menu.isOpen()) { L.Menu.close(); return; }
    if ($('.panel.open')) { L.closePanels(); return; }
    clearTimeout(L._clickT);
    L._clickT = setTimeout(function () {
      P.toggle();
      el.stack.classList.add('pulse');
      setTimeout(function () { el.stack.classList.remove('pulse'); }, 300);
    }, 230);
  };
  L.handleDoubleClick = function (side, x, y) {
    clearTimeout(L._clickT);
    L._touchGuard = Date.now() + 800;
    if (side === 'center') { L.toggleFullscreen(); return; }
    seekFx(side, S.seekstep);
  };

  /* ------------------------------------------------------------------ wire the video stack */
  /* The big play button lives in .chrome (a sibling of the video stack), so a
     tracker bound to the stack would fire pointerleave the moment the pointer
     touches the button — hiding it again. Track from the window instead:
     while playing the button is invisible, and moving the pointer into its box
     must bring it back so it can be clicked to pause. */
  /* The button sits in a fixed spot in the stage, so its box is measured once
     and reused. The previous version called getBoundingClientRect() on every
     mousemove in the window — a forced layout on each of them, right next to
     the pan/zoom transform writes. */
  var cpRect = null, cpRaf = 0, cpEvent = null;
  function centreHoverRect(invalidate) {
    if (invalidate) cpRect = null;
    if (!cpRect && el.centerPlay) cpRect = el.centerPlay.getBoundingClientRect();
    return cpRect;
  }
  function applyCentreHover() {
    cpRaf = 0;
    var e = cpEvent;
    if (!e || !el.centerPlay) return;
    var r = centreHoverRect(false);
    if (!r) return;
    var inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
    el.centerPlay.classList.toggle('hover', inside);
    var live = inside && el.body.classList.contains('playing');
    el.body.classList.toggle('center-hover', live);
    el.html.classList.toggle('center-hover', live);   /* lumen.css rule lives on .playing.center-hover */
  }
  function centreHover(e) {
    if (!el.centerPlay || G.pointers.size) return;
    /* while paused the button is simply visible; only the "hover to reveal"
       state of a playing video needs tracking */
    if (!el.body.classList.contains('playing')) {
      if (el.body.classList.contains('center-hover')) centreHoverOff();
      return;
    }
    cpEvent = e;
    if (!cpRaf) cpRaf = requestAnimationFrame(applyCentreHover);
  }
  function centreHoverOff() {
    if (el.centerPlay) el.centerPlay.classList.remove('hover');
    el.body.classList.remove('center-hover');
    el.html.classList.remove('center-hover');
  }
  window.addEventListener('pointermove', centreHover, { passive: true });
  window.addEventListener('blur', centreHoverOff);
  document.addEventListener('mouseleave', centreHoverOff);
  window.addEventListener('resize', function () { centreHoverRect(true); }, { passive: true });
  Ev.on('mode', function () { centreHoverRect(true); centreHoverOff(); });
  Ev.on('playstate', function () { centreHoverRect(true); if (!P.playing) centreHoverOff(); });
  el.stack.addEventListener('pointerdown', onDown);
  el.stack.addEventListener('pointermove', onMove);
  el.stack.addEventListener('pointerup', onUp);
  el.stack.addEventListener('pointercancel', function (e) {
    G.pointers.delete(e.pointerId); G.mode = null;
    el.scrub.classList.remove('show');
    endVswipeToast();
  });
  el.stack.addEventListener('wheel', onWheel, { passive: false });
  el.stack.addEventListener('dblclick', function (e) {
    if (G.moved && G.dragFired) return;
    if (Date.now() < (L._touchGuard || 0)) return;   /* the touch path already handled it */
    L.handleDoubleClick(sideOf(e.clientX), e.clientX, e.clientY);
  });
  el.stack.addEventListener('contextmenu', function (e) {
    e.preventDefault();
    if (Date.now() < (L._menuGuard || 0)) return;
    L.openMenuAt(e.clientX, e.clientY, L.isTouchUI());
  });
  el.stack.addEventListener('dragenter', function (e) { e.preventDefault(); el.stack.classList.add('drop'); });
  el.stack.addEventListener('dragover', function (e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; el.stack.classList.add('drop'); });
  el.stack.addEventListener('dragleave', function () { el.stack.classList.remove('drop'); });
  el.stack.addEventListener('drop', function (e) {
    e.preventDefault(); el.stack.classList.remove('drop');
    L.handleDrop(Array.prototype.slice.call(e.dataTransfer.files || []));
  });

  /* ------------------------------------------------------------------ dock wiring */
  el.btnPlay && el.btnPlay.addEventListener('click', function () { P.toggle(); });
  el.centerPlay && el.centerPlay.addEventListener('click', function (e) { e.stopPropagation(); P.toggle(); });
  $('#btnPrev') && $('#btnPrev').addEventListener('click', function () { P.prev(); });
  $('#btnNext') && $('#btnNext').addEventListener('click', function () { P.next(); });
  $('#btnMute') && $('#btnMute').addEventListener('click', function () { L.toggleMute(); });
  /* the two track buttons open the real track lists of the file that plays */
  $('#btnSubs') && $('#btnSubs').addEventListener('click', function () {
    L.openTrackMenu('subs', this);
  });
  $('#btnAudio') && $('#btnAudio').addEventListener('click', function () {
    L.openTrackMenu('audio', this);
  });
  el.miniPlay && el.miniPlay.addEventListener('click', function () { P.toggle(); });
  $('#miniClose') && $('#miniClose').addEventListener('click', function () { L.Bridge.call('window_action', 'close'); });
  $('#miniRestore') && $('#miniRestore').addEventListener('click', function () { L.setMini(false); });
  $('#miniBar2') && $('#miniBar2').addEventListener('click', function (e) {
    var r = this.getBoundingClientRect();
    P.seek(((e.clientX - r.left) / r.width) * (P.dur || 0));
  });

  /* volume rail */
  function volSet(e) {
    var r = $('.track', el.volRail).getBoundingClientRect();
    L.setVolume((e.clientX - r.left) / r.width);
  }
  if (el.volRail) {
    el.volRail.addEventListener('pointerdown', function (e) {
      el.volRail.setPointerCapture(e.pointerId); volSet(e);
      var mv = function (ev) { volSet(ev); };
      el.volRail.addEventListener('pointermove', mv);
      el.volRail.addEventListener('pointerup', function up() { el.volRail.removeEventListener('pointermove', mv); el.volRail.removeEventListener('pointerup', up); });
    });
    el.volRail.addEventListener('wheel', function (e) { e.preventDefault(); L.setVolume((S.muted ? 0 : S.volume) + (e.deltaY < 0 ? 0.03 : -0.03)); }, { passive: false });
  }

  /* seek bar (drag to scrub, click to jump) */
  var scrubbing = false;
  function sbSet(e, commit) {
    var r = $('.track', el.seekbar).getBoundingClientRect();
    var p = clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
    var t = p * (P.dur || 0);
    P.time = t;
    Ev.emit('time');
    if (commit) P.seek(t);
  }
  /* ---- hover preview: a frame from the host's thumbnail endpoint + the
     chapter under the pointer. The thumbnail is cached by the server, so a
     scrub costs almost nothing. */
  var sbHoverT = null;
  function sbShowPreview(e, frac) {
    if (!el.sbThumbImg || !P.item || P.item.demo || P.item.path === undefined && !P.item.url) { sbHidePreview(); return; }
    if (!P.item.token) { sbHidePreview(); return; }
    var t = frac * (P.dur || 0);
    if (!isFinite(t) || P.dur < 1) { sbHidePreview(); return; }
    var it = P.item;
    /* quantize to whole seconds so neighbouring moves reuse the same frame */
    var at = Math.max(0, Math.floor(t));
    var url = L.Bridge.thumbUrl(it, at);
    if (!url) { sbHidePreview(); return; }
    el.sbThumbImg.classList.add('show');
    if (el.sbThumbImg._src !== url) {
      el.sbThumbImg._src = url;
      var img = $('img', el.sbThumbImg);
      if (img) img.src = url;
    }
    var track = $('.track', el.seekbar).getBoundingClientRect();
    var w = el.sbThumbImg.offsetWidth || 150;
    var x = clamp(e.clientX - track.left, w / 2 + 6, track.width - w / 2 - 6);
    el.sbThumbImg.style.left = x + 'px';
    var timeEl = $('.sb-thumb-time', el.sbThumbImg);
    if (timeEl) timeEl.textContent = fmt(t);
    var chEl = $('.sb-thumb-ch', el.sbThumbImg);
    if (chEl) { var ch = chapterAt(frac); chEl.textContent = ch ? (ch.title || ('Chapter ' + (ch.index + 1))) : ''; }
  }
  function sbHidePreview() {
    if (el.sbThumbImg) el.sbThumbImg.classList.remove('show');
  }
  function sbMoveTip(e) {
    var r = $('.track', el.seekbar).getBoundingClientRect();
    if (el.sbTip) {
      var x = clamp(e.clientX - r.left, 24, r.width - 24);
      el.sbTip.style.left = x + 'px';
      el.sbTip.textContent = fmt(((e.clientX - r.left) / Math.max(1, r.width)) * (P.dur || 0));
    }
    sbShowPreview(e, clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1));
  }
  if (el.seekbar) {
    el.seekbar.addEventListener('pointerdown', function (e) {
      scrubbing = true;
      el.seekbar.classList.add('scrubbing');
      el.seekbar.setPointerCapture(e.pointerId);
      sbSet(e, false); sbMoveTip(e);
    });
    el.seekbar.addEventListener('pointermove', function (e) {
      sbMoveTip(e);
      if (scrubbing) sbSet(e, false);
    });
    el.seekbar.addEventListener('pointerup', function (e) {
      if (!scrubbing) return;
      scrubbing = false;
      el.seekbar.classList.remove('scrubbing');
      sbSet(e, true);
    });
    el.seekbar.addEventListener('wheel', function (e) {
      e.preventDefault();
      P.nudge(e.deltaY < 0 ? S.seekstep : -S.seekstep);
    }, { passive: false });
    el.seekbar.addEventListener('pointerleave', sbHidePreview);
  }

  /* ------------------------------------------------------------------ panels */
  function togglePanel(id) {
    var p = $('.panel.' + id);
    if (!p) return;
    var was = p.classList.contains('open');
    closePanels();
    if (!was) {
      p.classList.add('open');
      /* the ffmpeg card shows live state (installed? which path?) */
      if (id === 'settings' && L.FF) setTimeout(L.FF.refresh, 30);
    }
    document.body.classList.toggle('panels-open', anyPanelOpen());
    wake();
  }
  function closePanels() {
    $$('.panel').forEach(function (p) { p.classList.remove('open'); });
    document.body.classList.remove('panels-open');
  }
  function anyPanelOpen() { return !!$('.panel.open'); }
  L.togglePanel = togglePanel; L.closePanels = closePanels; L.anyPanelOpen = anyPanelOpen;
  $$('[data-panel]').forEach(function (b) {
    b.addEventListener('click', function () { togglePanel(b.getAttribute('data-panel')); });
  });
  $$('.close-panel').forEach(function (b) { b.addEventListener('click', closePanels); });

  el.plBody && el.plBody.addEventListener('click', plClick);
  el.plBody && el.plBody.addEventListener('contextmenu', plContext);
  el.plSearch && el.plSearch.addEventListener('input', function () { plFilter = this.value.trim().toLowerCase(); renderPlaylist(); });
  $('#plAdd') && $('#plAdd').addEventListener('click', function () { L.openFiles(); });
  $('#plAddFolder') && $('#plAddFolder').addEventListener('click', function () { L.openFiles(true); });
  $('#plClear') && $('#plClear').addEventListener('click', function () { PL.clear(); P.pause(); });
  $('#plSave') && $('#plSave').addEventListener('click', function () { L.savePlaylist(); });
  $('#plLoad') && $('#plLoad').addEventListener('click', function () { L.loadPlaylistFile(); });
  $('#plShuffle') && $('#plShuffle').addEventListener('click', function () {
    S.shuffle = !S.shuffle;
    this.classList.toggle('on', S.shuffle);
    L.setSetting('shuffle', S.shuffle);
    renderPlaylist();
    L.Toast.show('Shuffle ' + (S.shuffle ? 'on' : 'off'), { icon: 'shuffle', ms: 1200 });
  });
  $('#plRepeat') && $('#plRepeat').addEventListener('click', function () { L.cycleRepeat(); });
  /* drag & drop reorder inside the playlist */
  var dragUid = null;
  el.plBody && el.plBody.addEventListener('dragstart', function (e) {
    var row = e.target.closest('.pitem'); if (!row) return;
    dragUid = row.getAttribute('data-uid');
    row.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', dragUid); } catch (er) { }
  });
  el.plBody && el.plBody.addEventListener('dragover', function (e) {
    var row = e.target.closest('.pitem'); if (!row || !dragUid) return;
    e.preventDefault();
    $$('.pitem', el.plBody).forEach(function (r) { r.classList.remove('drop-before', 'drop-after'); });
    var r = row.getBoundingClientRect();
    row.classList.add((e.clientY - r.top) < r.height / 2 ? 'drop-before' : 'drop-after');
  });
  el.plBody && el.plBody.addEventListener('drop', function (e) {
    var row = e.target.closest('.pitem'); if (!row || !dragUid) return;
    e.preventDefault();
    var from = PL.items.findIndex(function (x) { return x.uid === dragUid; });
    var to = PL.items.findIndex(function (x) { return x.uid === row.getAttribute('data-uid'); });
    var r = row.getBoundingClientRect();
    var before = (e.clientY - r.top) < r.height / 2;
    $$('.pitem', el.plBody).forEach(function (x) { x.classList.remove('drop-before', 'drop-after', 'dragging'); });
    if (from >= 0 && to >= 0) PL.move(from, before ? to : to + 1);
    dragUid = null;
  });
  el.plBody && el.plBody.addEventListener('dragend', function () {
    $$('.pitem', el.plBody).forEach(function (x) { x.classList.remove('drop-before', 'drop-after', 'dragging'); });
    dragUid = null;
  });

  /* ------------------------------------------------------------------ settings widgets */
  var SETTING_SIDE = {
    speed: function (v) { P.setSpeed(parseFloat(v)); },
    hw: function (v) {
      L.Bridge.call('set_hwaccel', !!v).then(function (changed) {
        if (changed) {
          L.Toast.show('Hardware acceleration is applied the next time Lumen starts.',
            { icon: 'monitor', ms: 4200 });
        }
      });
      P.applyVideoTransforms();
    },
    resume: function () { },
    autonext: function () { },
    seekstep: function () { renderSeekStep(); },
    touch: function () { }, swipe: function () { }, pinch: function () { }, longpress: function () { },
    dblw: function () { }, touchui: function () { applyChrome(); },
    aspect: function () { P.applyVideoTransforms(); updatePanBounds(); },
    rotate: function () { P.applyVideoTransforms(); updatePanBounds(); },
    wheel: function () { }, smooth: function () { },
    hdr: function (v) { L.Bridge.call('set_hdr', !!v); P.applyVideoTransforms(); },
    normalize: function () { L.Audio.sync(); renderVolume(); },
    eq: function () { L.Audio.sync(); renderVolume(); },
    boost: function () { L.Audio.sync(); renderVolume(); },
    sublang: function () { },
    subpreset: function (v) { el.subs.className = 'subs-layer subs-' + v; },
    subfont: function () { if (L.subStyleApply) L.subStyleApply(); },
    subshadow: function () { if (L.subStyleApply) L.subStyleApply(); },
    suboutline: function () { if (L.subStyleApply) L.subStyleApply(); },
    subbg: function () { if (L.subStyleApply) L.subStyleApply(); },
    subbold: function () { if (L.subStyleApply) L.subStyleApply(); },
    subcolor: function () { if (L.subStyleApply) L.subStyleApply(); },
    theme: function () { applyChrome(); },
    lores: function () { applyChrome(); },
    ctxstyle: function () { },
    ontop: function (v) { L.Bridge.call('set_always_on_top', !!v); syncPins(); }
  };
  function bindWidgets() {
    $$('.seg[data-set]').forEach(function (seg) {
      seg.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        var key = seg.getAttribute('data-set');
        var raw = b.getAttribute('data-v');
        var val = (raw === 'true' || raw === 'false') ? (raw === 'true') : (/^-?\d*\.?\d+$/.test(raw) ? parseFloat(raw) : raw);
        $$('button', seg).forEach(function (x) { x.classList.toggle('on', x === b); });
        L.setSetting(key, val);
        if (SETTING_SIDE[key]) SETTING_SIDE[key](val);
      });
    });
    $$('.switch[data-set]').forEach(function (sw) {
      sw.addEventListener('click', function () {
        var key = sw.getAttribute('data-set');
        var val = !S[key];
        sw.classList.toggle('on', val);
        L.setSetting(key, val);
        if (SETTING_SIDE[key]) SETTING_SIDE[key](val);
      });
    });
    $('#setVol') && $('#setVol').addEventListener('input', function () { L.setVolume(parseFloat(this.value)); });
    $('#setGlass') && $('#setGlass').addEventListener('input', function () {
      L.setSetting('glass', parseFloat(this.value));
      el.html.style.setProperty('--glass-blur', this.value + 'px');
      var v = $('#setGlassVal'); if (v) v.textContent = this.value + 'px';
    });
    $('#setIdle') && $('#setIdle').addEventListener('input', function () {
      L.setSetting('idle', parseFloat(this.value));
      var v = $('#setIdleVal'); if (v) v.textContent = this.value + 's';
      wake();
    });
    $('#setSubSize') && $('#setSubSize').addEventListener('input', function () {
      L.setSetting('subSize', parseFloat(this.value));
      el.html.style.setProperty('--sub-size', this.value + 'px');
      var v = $('#setSubSizeVal'); if (v) v.textContent = this.value;
      if (L.subStyleApply) L.subStyleApply();
    });
    /* ------- subtitle look: font / colour / shadow / outline / background */
    $('#setSubFont') && $('#setSubFont').addEventListener('change', function () {
      L.setSetting('subFont', this.value);
      if (L.subStyleApply) L.subStyleApply();
    });
    $('#setSubColor') && $('#setSubColor').addEventListener('input', function () {
      L.setSetting('subColor', this.value);
      $$('#subColors .swatch').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-c') === this.value); }, this);
      if (L.subStyleApply) L.subStyleApply();
    });
    $$('#subColors .swatch').forEach(function (b) {
      b.addEventListener('click', function () {
        var c = b.getAttribute('data-c');
        $$('#subColors .swatch').forEach(function (x) { x.classList.toggle('on', x === b); });
        var pick = $('#setSubColor'); if (pick) pick.value = c;
        L.setSetting('subColor', c);
        if (L.subStyleApply) L.subStyleApply();
      });
    });
    $('#subResetBtn') && $('#subResetBtn').addEventListener('click', function () { L.subStyleReset(); });
    $('#setSubPos') && $('#setSubPos').addEventListener('input', function () {
      L.setSetting('subPos', parseFloat(this.value));
      el.subs.style.paddingBottom = this.value + '%';
      var v = $('#setSubPosVal'); if (v) v.textContent = this.value + '%';
    });
    $('#subDelayMinus') && $('#subDelayMinus').addEventListener('click', function () { subDelay(-500); });
    $('#subDelayPlus') && $('#subDelayPlus').addEventListener('click', function () { subDelay(500); });
    $('#subDelayReset') && $('#subDelayReset').addEventListener('click', function () { subDelay(-S.subDelay); });
    $('#subLoadBtn') && $('#subLoadBtn').addEventListener('click', function () { L.pickSubtitles(function (p) { attachSubs(P.item, p); }); });
    el.audioTracks && el.audioTracks.addEventListener('change', function () {
      var i = parseInt(this.value, 10);
      if (i >= 0) P.switchAudio(i);
    });
    el.subTracks && el.subTracks.addEventListener('change', function () {
      var i = parseInt(this.value, 10);
      P.setSubtitle(i >= 0 ? P.subTracks[i] : null);
    });
    el.eqPreset && el.eqPreset.addEventListener('change', function () {
      L.Audio.preset(this.value);
      renderEq();
    });
    $('#zoomInBtn') && $('#zoomInBtn').addEventListener('click', function () { Zoom.zoomAbout(Zoom.z * 1.25); });
    $('#zoomOutBtn') && $('#zoomOutBtn').addEventListener('click', function () { Zoom.zoomAbout(Zoom.z / 1.25); });
    $('#zoomResetBtn') && $('#zoomResetBtn').addEventListener('click', function () { Zoom.reset(); });
    $('#zoomFitBtn') && $('#zoomFitBtn').addEventListener('click', function () { L.setSetting('aspect', 'auto'); P.applyVideoTransforms(); syncWidgets(); Zoom.reset(); });
    $('#setResetBtn') && $('#setResetBtn').addEventListener('click', function () { L.resetSettings(); });
    $('#ffPickBtn') && $('#ffPickBtn').addEventListener('click', function () { L.FF.choose(); });
    $('#ffRescanBtn') && $('#ffRescanBtn').addEventListener('click', function () { L.FF.rescan(); });
    $('#aboutEmail') && $('#aboutEmail').addEventListener('click', function (e) {
      e.preventDefault();
      if (L.Bridge && L.Bridge.call) L.Bridge.call('open_external', 'mailto:Inbox.ehsani@gmail.com');
    });
    $('#showKeysBtn') && $('#showKeysBtn').addEventListener('click', function () { L.showShortcuts(); });
  }
  function subDelay(ms) {
    L.setSetting('subDelay', clamp((S.subDelay || 0) + ms, -30000, 30000));
    var v = $('#subDelayVal'); if (v) v.textContent = (S.subDelay > 0 ? '+' : '') + S.subDelay + ' ms';
    P.reloadSubtitleDelay();
  }
  function renderEq() {
    if (!el.eqBands) return;
    var host = el.eqBands;
    if (!host.children.length) {
      host.innerHTML = L.Audio.FREQ.map(function (f, i) {
        var hz = f >= 1000 ? (f / 1000) + 'k' : String(f);
        return '<div class="eq-band" data-i="' + i + '"><div class="vslider" title="' + f + ' Hz"><div class="mid"></div><div class="fill"></div></div>' +
          '<div class="db">0</div><div class="hz">' + hz + '</div></div>';
      }).join('');
      $$('.vslider', host).forEach(function (vs) {
        var band = vs.parentNode, i = parseInt(band.getAttribute('data-i'), 10);
        function setFromEvent(e) {
          var r = vs.getBoundingClientRect();
          var v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
          var gain = (v * 24) - 12;
          var bands = S.eqBands.slice(0);
          bands[i] = Math.round(gain * 2) / 2;
          L.setSetting('eqBands', bands);
          L.Audio.applyEq();
          updateBand(band, bands[i]);
        }
        var dragging = false;
        vs.addEventListener('pointerdown', function (e) { dragging = true; vs.setPointerCapture(e.pointerId); setFromEvent(e); });
        vs.addEventListener('pointermove', function (e) { if (dragging) setFromEvent(e); });
        vs.addEventListener('pointerup', function () { dragging = false; });
        vs.addEventListener('dblclick', function () {
          var bands = S.eqBands.slice(0); bands[i] = 0;
          L.setSetting('eqBands', bands); L.Audio.applyEq(); updateBand(band, 0);
        });
      });
    }
    $$('.eq-band', host).forEach(function (band) {
      var i = parseInt(band.getAttribute('data-i'), 10);
      updateBand(band, S.eqBands[i] || 0);
    });
    if (el.eqPreset) el.eqPreset.value = S.eqPreset;
  }
  function updateBand(band, db) {
    $('.fill', band).style.height = ((db + 12) / 24 * 100) + '%';
    $('.db', band).textContent = (db > 0 ? '+' : '') + (Math.round(db * 10) / 10);
  }

  /* push S into every widget */
  function syncWidgets() {
    $$('.seg[data-set]').forEach(function (seg) {
      var key = seg.getAttribute('data-set');
      var val = S[key];
      $$('button', seg).forEach(function (b) {
        var raw = b.getAttribute('data-v');
        var bv = (/^-?\d*\.?\d+$/.test(raw) ? parseFloat(raw) : raw);
        b.classList.toggle('on', String(bv) === String(val));
      });
    });
    $$('.switch[data-set]').forEach(function (sw) {
      var key = sw.getAttribute('data-set');
      sw.classList.toggle('on', !!S[key]);
    });
    var rv = [['#setVol', S.muted ? 0 : S.volume], ['#setGlass', S.glass], ['#setIdle', S.idle],
      ['#setSubSize', S.subSize], ['#setSubPos', S.subPos]];
    rv.forEach(function (p) { var e = $(p[0]); if (e) e.value = String(p[1]); });
    $('#setVolVal') && ($('#setVolVal').textContent = Math.round((S.muted ? 0 : S.volume) * 100) + '%');
    $('#setGlassVal') && ($('#setGlassVal').textContent = S.glass + 'px');
    $('#setIdleVal') && ($('#setIdleVal').textContent = S.idle + 's');
    $('#setSubSizeVal') && ($('#setSubSizeVal').textContent = String(S.subSize));
    if ($('#setSubFont')) $('#setSubFont').value = S.subFont || 'default';
    if ($('#setSubColor')) $('#setSubColor').value = S.subColor || '#ffffff';
    $$('#subColors .swatch').forEach(function (b) {
      b.classList.toggle('on', (b.getAttribute('data-c') || '').toLowerCase() === String(S.subColor || '').toLowerCase());
    });
    [['.seg[data-set="subshadow"]', S.subShadow], ['.seg[data-set="suboutline"]', S.subOutline],
      ['.seg[data-set="subbg"]', S.subBg]].forEach(function (pair) {
      var host = $(pair[0]);
      if (!host) return;
      $$('button', host).forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-v') === pair[1]); });
    });
    if ($('.switch[data-set="subbold"]')) $('.switch[data-set="subbold"]').classList.toggle('on', !!S.subBold);
    if (L.subStyleApply) L.subStyleApply();
    $('#setSubPosVal') && ($('#setSubPosVal').textContent = S.subPos + '%');
    $('#subDelayVal') && ($('#subDelayVal').textContent = (S.subDelay > 0 ? '+' : '') + S.subDelay + ' ms');
    $('#plShuffle') && $('#plShuffle').classList.toggle('on', !!S.shuffle);
    renderEq();
    syncPins();
    renderSeekStep();
  }
  function syncPins() {
    ['#tbPin', '#fsPin'].forEach(function (sel) {
      var b = $(sel); if (b) b.classList.toggle('on', !!S.ontop);
    });
    var sw = $('.switch[data-set="ontop"]'); if (sw) sw.classList.toggle('on', !!S.ontop);
  }

  /* ------------------------------------------------------------------ context menu
     A menu is a plain array of items:
       {title} {head} {sep} {label,icon,acc,disabled,checked,sw,sub,run}
     Menu is shared with shell.js through L.Menu. */
  var Menu = {
    root: null, stack: [], focus: -1,
    isOpen: function () { return !!(this.root && this.root.classList.contains('open')); },
    close: function () {
      $$('.ctx').forEach(function (m) { m.remove(); });
      this.root = null; this.stack = [];
    },
    show: function (items, x, y, touch) {
      this.close();
      var root = document.createElement('div');
      root.className = 'ctx' + (touch ? ' touch' : '');
      root.setAttribute('role', 'menu');
      this.build(root, items);
      el.win.appendChild(root);
      var r = root.getBoundingClientRect();
      var W = el.win.clientWidth, H = el.win.clientHeight;
      var px = x, py = y;
      if (px + r.width > W - 8) px = Math.max(8, W - r.width - 8);
      if (py + r.height > H - 8) py = Math.max(8, H - r.height - 8);
      root.style.left = Math.round(px) + 'px';
      root.style.top = Math.round(py) + 'px';
      requestAnimationFrame(function () { root.classList.add('open'); });
      this.root = root;
      this.touch = !!touch;
      this.focus = -1;
      return true;
    },
    build: function (host, items, parentItem) {
      var self = this;
      items.forEach(function (it) {
        if (it.sep) { var s = document.createElement('div'); s.className = 'sep'; host.appendChild(s); return; }
        if (it.title) { var t = document.createElement('div'); t.className = 'sub-title'; t.textContent = it.title; host.appendChild(t); return; }
        if (it.head) { var h = document.createElement('div'); h.className = 'head'; h.innerHTML = it.head; host.appendChild(h); return; }
        var b = document.createElement('button');
        b.className = 'mi' + (it.checked ? ' on' : '');
        b.type = 'button';
        if (it.disabled) b.setAttribute('disabled', 'disabled');
        var left = it.icon ? '<span class="ic">' + u.icon(it.icon, 17) + '</span>' : '<span class="mark">' + (it.checked ? u.icon('check', 15) : '') + '</span>';
        var right = it.sw ? '<span class="sw' + (it.swOn ? ' on' : '') + '"></span>'
          : (it.sub ? '<span class="arrow">' + u.icon('chevron-right', 14) + '</span>'
            : (it.acc ? '<span class="acc">' + u.esc(it.acc) + '</span>' : ''));
        b.innerHTML = left + '<span class="lbl">' + it.label + '</span>' + right;
        b._item = it;
        b.addEventListener('mouseenter', function () {
          self.focus = self.items().indexOf(b);
          self.paint();
          clearTimeout(self._hoverT);
          var host = b.parentNode;
          self._hoverT = setTimeout(function () {
            /* Move the menu chain to the level we are hovering:
                 · hovering a *top-level* row closes the open submenu,
                 · hovering a row *inside* a submenu keeps that submenu open.
               (The old code called collapseSubs() for every item without a
               submenu — including the items inside a submenu, which is why
               the submenu vanished as soon as the pointer entered it.) */
            self.chainTo(host);
            if (it.sub && !it.disabled && self.root === host) {
              self.openSub(b, it.sub, parentItem || it);
              host._subFor = b;
            }
          }, 120);
        });
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          if (it.disabled) return;
          if (it.sw) {
            it.swOn = !it.swOn;
            $('.sw', b).classList.toggle('on', it.swOn);
            if (it.run) it.run(it.swOn);
            return;
          }
          if (it.sub) { self.openSub(b, it.sub, parentItem || it); return; }
          /* items flagged sync:true (Picture-in-Picture) must run inside the
             click — a setTimeout would lose the user gesture Chromium wants */
          if (it.sync && it.run) { self.close(); it.run(); return; }
          self.close();
          if (it.run) setTimeout(function () { it.run(); }, 0);
        });
        host.appendChild(b);
      });
    },
    items: function () { return this.root ? $$('.mi', this.root) : []; },
    /* pop the open menus until `host` is the visible one (or nothing is) */
    chainTo: function (host) {
      var guard = 0;
      while (this.root && this.root !== host && this.stack.length && guard++ < 8) {
        this.root.remove();
        this.root = this.stack.pop();
        if (this.root) this.root._subFor = null;
      }
      return this.root === host;
    },
    collapseSubs: function () {
      while (this.stack.length) {
        if (!this.back()) break;
      }
      if (this.root) this.root._subFor = null;
    },
    paint: function () {
      var list = this.items();
      list.forEach(function (b, i) { b.classList.toggle('focus', i === this.focus); }, this);
    },
    openSub: function (btn, items, parentItem) {
      var r = btn.getBoundingClientRect();
      var wr = el.win.getBoundingClientRect();
      var x = r.right - wr.left + 4;
      var flip = (x + 260 > el.win.clientWidth);
      if (flip) x = r.left - wr.left - 254;
      var y = r.top - wr.top - 8;
      var prev = this.root;
      var sub = document.createElement('div');
      sub.className = 'ctx sub' + (this.touch ? ' touch' : '') + (flip ? ' left' : '');
      this.build(sub, items, parentItem);
      el.win.appendChild(sub);
      var sr = sub.getBoundingClientRect();
      y = clamp(y, 8, Math.max(8, el.win.clientHeight - sr.height - 8));
      sub.style.left = Math.round(x) + 'px';
      sub.style.top = Math.round(y) + 'px';
      requestAnimationFrame(function () { sub.classList.add('open'); });
      this.stack.push(prev);
      this.root = sub;
    },
    back: function () {
      if (!this.stack.length) return false;
      if (this.root) this.root.remove();
      this.root = this.stack.pop();
      return true;
    }
  };
  L.Menu = Menu;

  /* keep the menu inside the window on resize */
  window.addEventListener('resize', function () { if (Menu.isOpen()) Menu.close(); });

  L.G = G;   /* gesture state (debugging + host introspection) */

  /* ------------------------------------------------------------------ expose */
  Object.assign(L, {
    UI: { el: el, applyChrome: applyChrome, setMode: setMode, setPlayingChrome: setPlayingChrome,
      renderTime: renderTime, renderBuffered: renderBuffered, renderVolume: renderVolume,
      renderRate: renderRate, renderTitle: renderTitle, renderAB: renderAB,
      renderPlaylist: renderPlaylist, renderTracks: renderTracks, renderEq: renderEq,
      syncWidgets: syncWidgets, syncPins: syncPins, renderSeekStep: renderSeekStep,
      wake: wake, bindWidgets: bindWidgets, attachSubs: attachSubs, subDelay: subDelay,
      cycleSubs: cycleSubs, cycleAudio: cycleAudio, cycleSpeed: cycleSpeed, seekFx: seekFx, markTouch: markTouch },
    Zoom: Zoom, panBounds: panBounds, updatePanBounds: updatePanBounds
  });

  /* ------------------------------------------------------------------ events plumbing */
  function markTouch() { L._touchUI = true; clearTimeout(L._touchT); L._touchT = setTimeout(function () { L._touchUI = false; }, 4000); }
  L.markTouch = markTouch;
  L.isTouchUI = function () { return S.ctxstyle === 'touch' || (S.ctxstyle === 'auto' && (L._touchUI || S.touchui)); };
  L.vibrate = function (ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) { } };

  L.openMenuAt = function (x, y, touch) { L.buildMainMenu && L.buildMainMenu(x, y, touch); return true; };

  /* the playlist rows do not change when playback starts or stops — only the
     transport chrome does */
  Ev.on('playstate', function () { setPlayingChrome(P.playing); });
  Ev.on('time', function () { renderTime(); });
  Ev.on('buffered', renderBuffered);
  Ev.on('volume', renderVolume);
  Ev.on('rate', renderRate);
  Ev.on('media', function () {
    renderTitle(); schedulePlaylist();
    document.body.classList.add('media-loaded');
    P.applyVideoTransforms();       /* real width/height are known now */
    updatePanBounds();
  });
  Ev.on('playlist', schedulePlaylist);
  Ev.on('tracks', renderTracks);
  Ev.on('ab', renderAB);
  Ev.on('busy', function (b) { el.stack.classList.toggle('stack-busy', !!b); });
  Ev.on('setting', function (k) {
    if (k === 'theme' || k === 'lores' || k === 'touchui') applyChrome();
    if (k === 'subPreset') el.subs.className = 'subs-layer subs-' + S.subPreset;
  });
  Ev.on('loadstart', function () { renderTitle(); renderTracks(); });
  Ev.on('advance', function (it) { if (it) L.loadItem(it); });
  Ev.on('demo', function (scene) { L.setScene && L.setScene(scene); });
  Ev.on('transcode', function (on) {
    if (on) L.Toast.show('ffmpeg bridge active — the stream is being remuxed/transcoded live.', { icon: 'film', ms: 3200 });
    renderTitle();
  });

  /* ------------------------------------------------------------------ tooltips
     One shared tooltip for every control. The old ::after tips were clipped
     by the panels (overflow:hidden — the settings header showed a sliver
     instead of a tip) and the native title= tips lagged and looked alien.
     This one is position:fixed, so no panel can clip it, and it flips below
     the control when there is no room above it. */
  var tipEl = null, tipTimer = 0, tipTarget = null;
  function tipHide() {
    if (tipTimer) { clearTimeout(tipTimer); tipTimer = 0; }
    tipTarget = null;
    if (tipEl) tipEl.classList.remove('show');
  }
  function tipShow(node) {
    if (!tipEl) {
      tipEl = document.createElement('div');
      tipEl.className = 'app-tip';
      tipEl.setAttribute('role', 'tooltip');
      document.body.appendChild(tipEl);
    }
    var txt = node.getAttribute('data-tip') || '';
    if (!txt) return;
    tipEl.textContent = txt;
    tipEl.classList.add('show');
    /* measure after the text is in, then place with room to spare */
    var r = node.getBoundingClientRect();
    var tw = tipEl.offsetWidth || 0, th = tipEl.offsetHeight || 0;
    var vw = window.innerWidth || 0, vh = window.innerHeight || 0;
    var x = clamp(r.left + r.width / 2 - tw / 2, 8, Math.max(8, vw - tw - 8));
    var above = r.top - th - 10 >= 8;
    var y = above ? (r.top - th - 10) : Math.min(r.bottom + 10, Math.max(8, vh - th - 8));
    tipEl.style.left = Math.round(x) + 'px';
    tipEl.style.top = Math.round(y) + 'px';
  }
  document.addEventListener('pointerover', function (e) {
    if (e.pointerType === 'touch') return;
    var node = e.target && e.target.closest ? e.target.closest('[data-tip]') : null;
    if (node === tipTarget) return;
    tipHide();
    if (!node || !node.getAttribute('data-tip')) return;
    tipTarget = node;
    tipTimer = setTimeout(function () {
      if (tipTarget !== node || !document.contains(node)) { tipHide(); return; }
      tipShow(node);
    }, 240);
  }, true);
  document.addEventListener('pointerout', function (e) {
    if (!tipTarget) return;
    var to = e.relatedTarget;
    if (to && to.closest && to.closest('[data-tip]') === tipTarget) return;   /* still inside the same control */
    tipHide();
  }, true);
  window.addEventListener('pointerdown', tipHide, true);
  window.addEventListener('blur', tipHide);
  document.addEventListener('scroll', tipHide, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') tipHide(); }, true);

  /* ------------------------------------------------------------------ demo scenes
     The idle artwork is a full-screen JPEG. Only the visible scene is decoded
     and painted; the second one is fetched the first time it is needed
     (data-src → src) instead of sitting in memory for the whole session. */
  var sceneA = $('.vlayer[data-scene="bright"]'), sceneB = $('.vlayer[data-scene="dark"]');
  function showScene(img, on) {
    if (!img) return;
    if (on && !img.getAttribute('src') && img.getAttribute('data-src')) {
      img.setAttribute('src', img.getAttribute('data-src'));
      img.removeAttribute('data-src');
    }
    img.classList.toggle('on', on);
    /* a hidden scene can keep a decoded 4K frame in memory: release it */
    if (!on && img.complete && img.getAttribute('src')) img.style.visibility = 'hidden';
    if (on) img.style.visibility = '';
  }
  L.setScene = function (scene) {
    showScene(sceneA, scene === 'bright');
    showScene(sceneB, scene === 'dark');
    L._scene = scene;
  };
  window.__lumenReady = true;
})();
