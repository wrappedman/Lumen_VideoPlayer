/* ==========================================================================
   Lumen — shell.js
   Context menu model, keyboard map, window controls, file open/save,
   drag&drop from Explorer, modals and the handshake with the Python host.
   ========================================================================== */
(function () {
  'use strict';

  var L = window.Lumen;
  if (!L) { console.error('[lumen] app.js must load before shell.js'); return; }
  var u = L.util, $ = u.$, $$ = u.$$, clamp = u.clamp, fmt = u.fmt, fmtLong = u.fmtLong;
  var S = L.S, P = L.Player, PL = L.Playlist, Ev = L.Events, B = L.Bridge;
  var el = L.UI.el;

  /* ================================================================== items */
  L.loadItem = function (item, opts) {
    if (!item) return;
    var i = PL.items.indexOf(item);
    if (i >= 0) PL.index = i;
    P.load(item, opts || {});
    Ev.emit('playlist');
  };

  /* ---------------------------------------------------------------- delete file
     Delete = move the playing file to the Recycle Bin and continue with the
     next item. Order matters: the next picture starts first, then the old file
     leaves the list and the host trashes it (Windows keeps it recoverable).
     The file is never removed while it is the only item — deleting the media
     the user is watching by accident would be unrecoverable in practice. */
  L.deleteCurrent = function () {
    /* the file the user is watching — not the one that may already be queued
       behind an in-flight load */
    var it = P.item || P.pendingItem;
    if (!it) { L.Toast.show('Nothing is playing.', { icon: 'info', ms: 2600 }); return; }
    if (it.demo) { L.Toast.show('Demo items are not real files.', { icon: 'info', ms: 2600 }); return; }
    if (!it.path) {
      L.Toast.show('Streams cannot be deleted — only local files.', { kind: 'err', icon: 'info', ms: 3600 });
      return;
    }
    if (!B.ready) {
      L.Toast.show('Deleting files needs the desktop app.', { kind: 'err', icon: 'info', ms: 3600 });
      return;
    }
    var next = PL.next(1, true);
    if (!next || next === it) {
      L.Toast.show('This is the only item in the playlist — Lumen will not delete the file it is playing.',
        { kind: 'err', icon: 'info', ms: 4600 });
      return;
    }
    var target = it.path;
    var name = it.name || u.baseName(target);
    L.loadItem(next);                     /* keep watching: the next file starts */
    PL.remove(it.uid);
    L.resumeClear(target);
    B.call('media_delete', target).then(function (res) {
      if (res && res.ok) {
        L.Toast.show('Deleted <b>' + u.esc(name) + '</b> → Recycle Bin', { kind: 'ok', icon: 'trash', ms: 3200 });
      } else {
        L.Toast.show('Could not delete <b>' + u.esc(name) + '</b>' +
          (res && res.error ? ': ' + u.esc(res.error) : '') + ' — the file is still on disk.',
          { kind: 'err', icon: 'info', ms: 6000 });
      }
    });
  };

  L.cycleRepeat = function () {
    S.repeat = S.repeat === 'off' ? 'all' : S.repeat === 'all' ? 'one' : 'off';
    L.setSetting('repeat', S.repeat);
    var btn = $('#plRepeat');
    if (btn) btn.classList.toggle('on', S.repeat !== 'off');
    L.UI.renderPlaylist();
    L.Toast.show('Repeat: ' + (S.repeat === 'off' ? 'off' : S.repeat === 'all' ? 'all items' : 'this item'),
      { icon: 'repeat', ms: 1500 });
  };

  /* ================================================================== fullscreen / mini / window */
  var prevMode = 'window';
  L.toggleFullscreen = function (force) {
    var cur = el.body.dataset.mode;
    if (force === true || (force == null && cur !== 'full')) {
      prevMode = (cur === 'full') ? 'window' : cur;
      L.UI.setMode('full');
      B.call('set_fullscreen', true);
      L.Toast.show('Fullscreen — press F or Esc to exit', { icon: 'fullscreen', ms: 2200 });
    } else {
      L.UI.setMode(prevMode === 'full' ? 'window' : prevMode);
      B.call('set_fullscreen', false);
    }
    L.UI.wake();
  };
  /* the mini window is a slim bar for audio and a square little picture
     window for video, so the host needs to know which one is playing */
  var VIDEO_EXT = ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'mpg', 'mpeg', 'ts', 'm2ts', 'wmv', 'flv', 'ogv', '3gp'];
  var AUDIO_EXT = ['mp3', 'm4a', 'm4b', 'aac', 'flac', 'wav', 'wave', 'ogg', 'oga', 'opus', 'wma', 'mka', 'aiff', 'alac'];
  L.miniIsVideo = function () {
    /* the item the user just opened counts too — load() is async (it fetches
       the stream token first), so P.item lags a moment behind */
    var it = P.pendingItem || P.item;
    if (!it || it.demo) return false;
    /* decide from the item itself — <video>.videoWidth still belongs to the
       file that was loaded before (that made audio files open a square) */
    var e = String(it.ext || '').toLowerCase();
    if (!e && it.path) e = (u.extName(it.path) || '').toLowerCase();
    if (AUDIO_EXT.indexOf(e) >= 0) return false;
    if (VIDEO_EXT.indexOf(e) >= 0) return true;
    if (it.w && it.h) return true;
    return !!(el.video && el.video.videoWidth && el.video.currentSrc);
  };
  L.setMini = function (on) {
    if (on) { prevMode = el.body.dataset.mode === 'mini' ? prevMode : el.body.dataset.mode; L.UI.setMode('mini'); }
    else L.UI.setMode(prevMode === 'mini' || prevMode === 'full' ? 'window' : prevMode);
    B.call('set_mini', !!on, !!on && L.miniIsVideo());
  };
  L.toggleMax = function () {
    var cur = el.body.dataset.mode;
    if (cur === 'max') { L.UI.setMode('window'); B.call('window_action', 'restore'); }
    else { L.UI.setMode('max'); B.call('window_action', 'maximize'); }
  };

  /* ================================================================== context menu */
  var ASPECTS = [['auto', 'Auto'], ['cover', 'Fill / crop'], ['16:9', '16:9'], ['4:3', '4:3'], ['21:9', '21:9']];
  var SPEEDS = [0.25, 0.5, 1, 1.5, 1.75, 2, 2.5, 3];

  function speedItems() {
    return SPEEDS.map(function (v) {
      return { label: v + '×', checked: Math.abs(S.speed - v) < 0.001, run: function () { P.setSpeed(v); L.UI.syncWidgets(); } };
    });
  }
  function zoomItems() {
    return [
      { label: 'Zoom in', icon: 'zoom-in', acc: '+', run: function () { L.Zoom.zoomAbout(L.Zoom.z * 1.25); } },
      { label: 'Zoom out', icon: 'zoom-out', acc: '−', run: function () { L.Zoom.zoomAbout(L.Zoom.z / 1.25); } },
      { label: 'Reset zoom (100%)', icon: 'zoom-100', acc: 'Ctrl+0', run: function () { L.Zoom.reset(); } },
      { sep: true },
      { label: 'Toggle zoom 1× / 2×', icon: 'zoom-in', run: function () { L.Zoom.toggle(); } },
      { label: 'Fit window (no zoom)', icon: 'zoom-fit', run: function () { L.setSetting('aspect', 'auto'); P.applyVideoTransforms(); L.UI.syncWidgets(); L.Zoom.reset(); } }
    ];
  }
  function aspectItems() {
    return ASPECTS.map(function (a) {
      return { label: a[1], checked: S.aspect === a[0], run: function () { L.setSetting('aspect', a[0]); P.applyVideoTransforms(); L.updatePanBounds(); L.UI.syncWidgets(); } };
    });
  }
  function rotateItems() {
    return [0, 90, 180, 270].map(function (d) {
      return { label: d + '°', checked: (S.rotate || 0) === d, run: function () { L.setSetting('rotate', d); P.applyVideoTransforms(); L.updatePanBounds(); L.UI.syncWidgets(); } };
    });
  }
  function subItems() {
    var online = !!(P.item && !P.item.path && P.item.url);
    var what = online ? 'this stream' : 'this file';
    var out = [{ title: P.subTracks.length ? 'Subtitles in ' + what : 'No subtitle track found' }];
    if (!P.subTracks.length && !B.ffmpeg) {
      out.push({ label: 'Built-in media engine unavailable for tracks inside ' + what, icon: 'settings',
        run: function () { L.togglePanel('settings'); } });
    }
    if (!P.subTracks.length && online) {
      out.push({ label: 'Paste a subtitle link…', icon: 'open-url', run: function () { L.openSubUrl(); } });
    }
    out.push({ label: 'Off', checked: !P.subActive, run: function () { P.setSubtitle(null); } });
    P.subTracks.forEach(function (t, i) {
      out.push({ label: u.esc(t.label || ('Track ' + (i + 1))), checked: P.subActive === t, run: function () { P.setSubtitle(t); } });
    });
    out.push({ sep: true });
    out.push({ label: 'Add subtitle file…', icon: 'folder', acc: 'C', run: function () { L.pickSubtitles(function (p) { L.UI.attachSubs(P.item, p); }); } });
    out.push({ label: 'Add subtitle link…', icon: 'open-url', run: function () { L.openSubUrl(); } });
    out.push({ label: 'Bigger text', icon: 'text-size', run: function () { L.setSetting('subSize', clamp(S.subSize + 2, 16, 72)); L.UI.syncWidgets(); } });
    out.push({ label: 'Smaller text', icon: 'text-size', run: function () { L.setSetting('subSize', clamp(S.subSize - 2, 16, 72)); L.UI.syncWidgets(); } });
    out.push({ sep: true });
    out.push({ label: 'Delay −0.5 s', icon: 'stopwatch', run: function () { L.UI.subDelay(-500); } });
    out.push({ label: 'Delay +0.5 s', icon: 'stopwatch', run: function () { L.UI.subDelay(500); } });
    out.push({ label: 'Reset delay', run: function () { L.UI.subDelay(-S.subDelay); } });
    return out;
  }
  function audioItems() {
    if (!P.audioTracks.length) {
      return [{ label: 'No extra audio track found in this file', disabled: true }];
    }
    var out = [{ label: 'Default (as stored in the file)', checked: P.transcodeAudio == null,
      run: function () { P.useDefaultAudio(); } }];
    out.push({ sep: true });
    P.audioTracks.forEach(function (a, i) {
      out.push({ label: u.esc(a.label || ('Track ' + (i + 1))), checked: P.transcodeAudio === i,
        run: function () { P.switchAudio(i); } });
    });
    return out;
  }
  function loopItems() {
    return [
      { label: 'Repeat off', checked: S.repeat === 'off', run: function () { S.repeat = 'off'; L.setSetting('repeat', 'off'); L.UI.renderPlaylist(); } },
      { label: 'Repeat all', icon: 'repeat', checked: S.repeat === 'all', run: function () { S.repeat = 'all'; L.setSetting('repeat', 'all'); L.UI.renderPlaylist(); } },
      { label: 'Repeat one', icon: 'repeat', checked: S.repeat === 'one', run: function () { S.repeat = 'one'; L.setSetting('repeat', 'one'); L.UI.renderPlaylist(); } },
      { label: 'Shuffle', icon: 'shuffle', sw: true, swOn: !!S.shuffle, run: function (v) { S.shuffle = v; L.setSetting('shuffle', v); L.UI.renderPlaylist(); } },
      { sep: true },
      { label: P.ab && P.ab.a != null ? 'Set B' : 'Set A', icon: 'ab-loop',
        acc: 'X', disabled: !!(P.ab && P.ab.b != null),
        run: function () { P.abSet(P.ab && P.ab.a != null ? 'b' : 'a'); Ev.emit('ab'); } },
      { label: 'Clear A-B loop', disabled: !P.ab, run: function () { P.abSet(null); Ev.emit('ab'); } }
    ];
  }

  L.buildMainMenu = function (x, y, touch) {
    var common = [];

    /* --- files -------------------------------------------------------- */
    common.push({ label: 'Open file…', icon: 'open-url', acc: 'Ctrl+O', run: function () { L.openFiles(); } });
    common.push({ label: 'Open folder…', icon: 'folder', acc: 'Ctrl+Shift+O', run: function () { L.openFiles(true); } });
    common.push({ label: 'Open URL / stream…', icon: 'open-url', acc: 'U', run: function () { L.openUrlDialog(); } });

    /* --- window ------------------------------------------------------- */
    common.push({ sep: true });
    common.push({ label: 'Always on top', icon: 'pin', sw: true, swOn: !!S.ontop, run: function (v) { L.setSetting('ontop', v); B.call('set_always_on_top', v); L.UI.syncPins(); } });
    common.push({ label: 'Mini player', icon: 'mini-player', acc: 'W', run: function () { L.setMini(el.body.dataset.mode !== 'mini'); } });
    common.push({ label: 'Fullscreen', icon: 'fullscreen', acc: 'F', run: function () { L.toggleFullscreen(); } });
    /* sync:true → the handler runs inside the click, so Chromium still counts
       it as a user gesture (Picture-in-Picture refuses to open otherwise) */
    common.push({ label: 'Picture in picture', icon: 'pip', sync: true,
      disabled: !P.item || !!P.item.demo, run: function () { L.togglePip(); } });
    common.push({ label: 'Playlist panel', icon: 'playlist', acc: 'P', run: function () { L.togglePanel('playlist'); } });

    /* --- info --------------------------------------------------------- */
    common.push({ sep: true });
    common.push({ label: 'Media info…', icon: 'info', acc: 'Y', disabled: !P.item, run: function () { Info.open(P.item); } });
    common.push({ label: 'Delete file (Recycle Bin)', icon: 'trash', acc: 'Del',
      disabled: !P.item || !!P.item.demo || !P.item.path, run: function () { L.deleteCurrent(); } });

    /* --- quit --------------------------------------------------------- */
    common.push({ sep: true });
    common.push({ label: 'Exit Lumen', icon: 'close', acc: 'Alt+F4', run: function () { B.call('window_action', 'close'); } });

    if (!touch) return L.Menu.show(common, x, y, false);

    /* touch menu: the very same order, minus the keyboard hints */
    var t = [];
    t.push({ label: 'Open file…', icon: 'open-url', run: function () { L.openFiles(); } });
    t.push({ label: 'Open folder…', icon: 'folder', run: function () { L.openFiles(true); } });
    t.push({ label: 'Open URL / stream…', icon: 'open-url', run: function () { L.openUrlDialog(); } });
    t.push({ sep: true });
    t.push({ label: 'Always on top', icon: 'pin', sw: true, swOn: !!S.ontop, run: function (v) { L.setSetting('ontop', v); B.call('set_always_on_top', v); L.UI.syncPins(); } });
    t.push({ label: 'Mini player', icon: 'mini-player', run: function () { L.setMini(el.body.dataset.mode !== 'mini'); } });
    t.push({ label: 'Fullscreen', icon: 'fullscreen', run: function () { L.toggleFullscreen(); } });
    t.push({ label: 'Picture in picture', icon: 'pip', sync: true,
      disabled: !P.item || !!P.item.demo, run: function () { L.togglePip(); } });
    t.push({ label: 'Playlist panel', icon: 'playlist', run: function () { L.togglePanel('playlist'); } });
    t.push({ sep: true });
    t.push({ label: 'Media info…', icon: 'info', disabled: !P.item, run: function () { Info.open(P.item); } });
    t.push({ label: 'Delete file (Recycle Bin)', icon: 'trash',
      disabled: !P.item || !!P.item.demo || !P.item.path, run: function () { L.deleteCurrent(); } });
    t.push({ sep: true });
    t.push({ label: 'Exit Lumen', icon: 'close', run: function () { B.call('window_action', 'close'); } });
    return L.Menu.show(t, x, y, true);
  };

  /* ---------------------------------------------------------------- picture in picture
     Called synchronously from the click handler (the Menu runs items flagged
     with sync:true inside the gesture) — Chromium refuses PiP outside one. */
  L.togglePip = function () {
    var v = el.video;
    if (!v || !P.item || P.item.demo) {
      L.Toast.show('Picture in picture needs a playing file.', { icon: 'pip', ms: 2400 });
      return false;
    }
    try {
      if (document.pictureInPictureElement) {
        document.exitPictureInPicture().then(function () {
          L.Toast.show('Picture in picture closed.', { icon: 'pip', ms: 1600 });
        }).catch(function () { });
        return true;
      }
      var p = v.requestPictureInPicture();
      if (p && p.then) {
        p.then(function () { L.Toast.show('Picture in picture — drag the small window anywhere.', { icon: 'pip', ms: 3000 }); })
          .catch(function (e) {
            L.Toast.show('Picture in picture is not available: ' + ((e && e.message) || 'unknown error'),
              { kind: 'err', icon: 'pip', ms: 4500 });
          });
      }
    } catch (e) {
      L.Toast.show('Picture in picture is not available: ' + ((e && e.message) || 'unknown error'),
        { kind: 'err', icon: 'pip', ms: 4500 });
      return false;
    }
    return true;
  };

  /* ---------------------------------------------------------------- track menus
     One file has one list of subtitle tracks and one list of audio tracks —
     the dock buttons and the context-menu submenus show exactly that list. */
  L.openTrackMenu = function (kind, anchor) {
    var items = (kind === 'audio') ? audioItems() : subItems();
    var x = 24, y = 24;
    if (anchor && anchor.getBoundingClientRect) {
      var r = anchor.getBoundingClientRect();
      var h = 16;
      items.forEach(function (it) { h += it.sep ? 11 : (it.title || it.head ? 30 : 36); });
      x = Math.round(r.left + r.width / 2 - 150);
      y = Math.round(r.top - h - 14);
    }
    L.Menu.show(items, x, y, L.isTouchUI());
  };

  /* ================================================================== media engine
     The Windows installer carries FFmpeg + ffprobe inside resources/ffmpeg.
     Advanced users may still point Lumen at a different local build, but that
     is optional: normal playback never asks the user to install anything. */
  var FF = {
    say: function (text, tone) {
      var st = $('#ffStatus');
      if (st) st.textContent = text;
      var chip = $('#ffChip');
      if (chip) {
        chip.textContent = tone === 'ok' ? 'ready' : tone === 'bad' ? 'unavailable' : '…';
        chip.classList.toggle('accent', tone === 'ok');
      }
    },
    refresh: function () {
      if (!$('#ffStatus')) return;
      if (!B.ready) { FF.say('Desktop host not attached (browser demo mode).'); return; }
      B.call('ffmpeg_status').then(function (info) {
        info = info || {};
        B.ffmpeg = !!info.available;
        var chip = $('#aboutChip2');
        if (chip) chip.textContent = info.available ? (info.bundled ? 'FFmpeg bundled' : 'FFmpeg ready') : 'FFmpeg unavailable';
        if (info.available) {
          var mode = info.bundled ? 'Built-in FFmpeg ' : 'Custom FFmpeg ';
          FF.say(mode + (info.version || 'ready') + (info.probe === false ? '' : ' + ffprobe') +
            (info.path ? '   ·   ' + info.path : ''), 'ok');
          FF.mark(true, !!info.bundled);
        } else {
          FF.say('The bundled FFmpeg engine could not start. Repair or reinstall Lumen; no separate codec pack is required.', 'bad');
          FF.mark(false, false);
        }
      });
    },
    mark: function (ok, bundled) {
      var btn = $('#ffPickBtn');
      if (btn) btn.textContent = bundled ? 'Optional override…' : (ok ? 'Change custom build…' : 'Choose optional build…');
    },
    /* optional advanced override (also used by tests and drag-and-drop) */
    choose: function (forced) {
      if (!B.ready) {
        L.Toast.show('A custom FFmpeg override is available only in the desktop app.', { kind: 'err', icon: 'info' });
        return Promise.resolve(null);
      }
      var btn = $('#ffPickBtn');
      if (btn) { btn.disabled = true; }
      return B.call('ffmpeg_pick', forced || null).then(function (res) {
        if (btn) btn.disabled = false;
        res = res || {};
        if (res.cancelled) return null;
        if (res.ok) {
          L.Toast.show('Custom FFmpeg is ready: ' + (res.version || ''), { kind: 'ok', icon: 'check', ms: 4200 });
          FF.refresh();
        } else {
          L.Toast.show(res.error || 'That file is not a working ffmpeg.exe.', { kind: 'err', icon: 'info', ms: 6000 });
        }
        return res;
      });
    },
    rescan: function () {
      if (!B.ready) { FF.refresh(); return; }
      B.call('ffmpeg_rescan').then(function () {
        FF.refresh();
        L.Toast.show('Rechecked the bundled media engine.', { icon: 'reset', ms: 2000 });
      });
    }
  };
  L.FF = FF;

  /* ============================================================ subtitle look
     The chosen font / colour / shadow / outline / background are written on
     every cue (see Player.subStyle) and persisted with the other settings. */
  L.subStyleApply = function () {
    P.renderSubs(P.time || 0);
  };
  L.subStyleReset = function () {
    var d = L.DEFAULTS;
    ['subFont', 'subColor', 'subBg', 'subShadow', 'subOutline', 'subBold', 'subSize', 'subPreset'].forEach(function (k) {
      L.setSetting(k, d[k]);
    });
    if (L.UI && L.UI.syncWidgets) L.UI.syncWidgets();
    L.subStyleApply();
    P.renderSubs(P.time || 0);
    L.Toast.show('Subtitle look reset to the defaults.', { icon: 'reset', ms: 2400 });
  };

  /* close the menu on any outside press */
  ['pointerdown', 'wheel'].forEach(function (n) {
    el.win.addEventListener(n, function (e) {
      if (!L.Menu.isOpen()) return;
      if (e.target.closest('.ctx')) return;
      L.Menu.close();
    }, true);
  });

  /* ================================================================== modals */
  var Info = {
    open: function (item) {
      item = item || P.item || {};
      var i = P.info || {};
      var rows = [
        ['File', u.esc(item.name || '—')],
        ['Path', u.esc(item.path || item.url || '—')],
        ['Duration', (P.dur ? fmtLong(P.dur) : '—')],
        ['Resolution', (item.w ? item.w + ' × ' + item.h + '  (' + (i.ar || '') + ')' : '—')],
        ['Video codec', u.esc([i.vcodec, i.profile, i.pixfmt].filter(Boolean).join(' · ') || '—')],
        ['Frame rate', i.fps ? (i.fps + ' fps' + (i.rfps && i.rfps !== i.fps ? ' (' + i.rfps + ' avg)' : '')) : '—'],
        ['Bitrate', i.bitrate ? (Math.round(i.bitrate / 1000) + ' kb/s') : '—'],
        ['HDR', i.hdr ? 'yes' : 'no'],
        ['Audio', (P.audioTracks.length ? P.audioTracks.map(function (a) { return a.label; }).join(' · ') : (i.acodec || '—'))],
        ['Subtitles', (P.subTracks.length ? P.subTracks.length + ' track(s)' : 'none')],
        ['Container', u.esc(i.format || u.extName(item.path || '') || '—')],
        ['Decode path', P.transcode ? 'ffmpeg bridge (remux/transcode)' : 'hardware/webview2'],
        ['Host bridge', B.ready ? ('connected · ffmpeg ' + (B.ffmpeg ? 'available' : 'missing')) : 'not attached (demo mode)']
      ];
      L.Modal.open('<h2>' + u.icon('film', 18) + 'Media info</h2>' +
        '<table>' + rows.map(function (r) { return '<tr><td class="k">' + r[0] + '</td><td class="v">' + r[1] + '</td></tr>'; }).join('') + '</table>' +
        '<div class="mrow"><button class="btn" data-close>Close</button>' +
        (item.path ? '<button class="btn accent" data-copy>Copy path</button>' : '') + '</div>', {
        onOpen: function (box) {
          box.querySelector('[data-close]').addEventListener('click', L.Modal.close);
          var c = box.querySelector('[data-copy]');
          if (c) c.addEventListener('click', function () { L.copy(item.name, item.path); });
        }
      });
    }
  };
  L.Info = Info;

  L.showShortcuts = function () {
    var keys = [
      ['Space / K', 'Play / Pause'],
      ['← / →', 'Seek back / forward (' + S.seekstep + ' s)'],
      ['Shift + ← / →', 'Seek 60 s'],
      ['J', 'Previous item'],
      ['Ctrl + ← / →', 'Previous / next item'],
      ['PageDown / PageUp', 'Next / previous item'],
      ['Delete', 'Delete this file (Recycle Bin) and play the next'],
      ['↑ / ↓', 'Volume ±5%'],
      ['M', 'Mute'],
      ['0 … 9', 'Jump to 0% … 90%'],
      ['Home / End', 'Start / end of file'],
      [', / .', 'Frame step (while paused)'],
      ['[ / ]', 'Speed down / up'],
      ['\\', 'Reset speed'],
      ['+ / −', 'Zoom in / out'],
      ['Ctrl + 0', 'Reset zoom'],
      ['Alt + arrows', 'Pan the picture'],
      ['F / F11', 'Fullscreen'],
      ['Esc', 'Close menu → panel → fullscreen'],
      ['W', 'Mini player'],
      ['T', 'Always on top'],
      ['A', 'Cycle aspect ratio'],
      ['R', 'Rotate 90°'],
      ['V', 'Cycle subtitles'],
      ['C', 'Load subtitle file'],
      ['B', 'Cycle audio track'],
      ['X', 'A-B loop (set A → set B → clear)'],
      ['L', 'Cycle repeat mode'],
      ['Y', 'Media info'],
      ['Ctrl + O', 'Open files'],
      ['Ctrl + Shift + O', 'Open folder'],
      ['U', 'Open URL / stream'],
      ['P / I', 'Playlist / settings panel'],
      ['Mouse wheel', 'Volume · seek · zoom (see Settings)'],
      ['Double-click sides', 'Seek ± ' + S.seekstep + ' s'],
      ['Double-click center', 'Fullscreen'],
      ['Right-click', 'Full player menu'],
      ['Middle-click', 'Mute'],
      ['Touch: double-tap sides', 'Seek ± ' + S.seekstep + ' s'],
      ['Touch: pinch', 'Zoom the picture'],
      ['Touch: one-finger drag', 'Pan (zoomed) / move window'],
      ['Touch: long-press', 'Open the player menu'],
      ['Touch: swipe ↔ / ↕', 'Seek / volume (left = brightness)']
    ];
    L.Modal.open('<h2>' + u.icon('keyboard', 18) + 'Keyboard &amp; touch</h2>' +
      '<div class="grid2"><table>' +
      keys.slice(0, Math.ceil(keys.length / 2)).map(function (k) {
        return '<tr><td class="k"><span class="kbd">' + k[0] + '</span></td><td class="v">' + k[1] + '</td></tr>';
      }).join('') +
      '</table><table>' +
      keys.slice(Math.ceil(keys.length / 2)).map(function (k) {
        return '<tr><td class="k"><span class="kbd">' + k[0] + '</span></td><td class="v">' + k[1] + '</td></tr>';
      }).join('') +
      '</table></div><div class="mrow"><button class="btn accent" data-close>Got it</button></div>', {
      onOpen: function (box) { box.querySelector('[data-close]').addEventListener('click', L.Modal.close); }
    });
  };

  function readClipboardText() {
    if (B.ready) {
      return B.call('clipboard_read_text').then(function (text) {
        if (text != null) return String(text);
        if (navigator.clipboard && navigator.clipboard.readText) return navigator.clipboard.readText().catch(function () { return ''; });
        return '';
      });
    }
    if (navigator.clipboard && navigator.clipboard.readText) return navigator.clipboard.readText().catch(function () { return ''; });
    return Promise.resolve('');
  }
  function writeClipboardText(text) {
    if (B.ready) return B.call('clipboard_write_text', String(text || '')).then(function () { return true; });
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(String(text || '')).then(function () { return true; }).catch(function () { return false; });
    return Promise.resolve(false);
  }
  function bindEditContextMenu(input) {
    input.addEventListener('contextmenu', function (e) {
      e.preventDefault(); e.stopPropagation();
      var start = input.selectionStart == null ? 0 : input.selectionStart;
      var end = input.selectionEnd == null ? input.value.length : input.selectionEnd;
      var selected = input.value.slice(start, end);
      function replace(text) {
        input.focus();
        if (input.setRangeText) input.setRangeText(String(text), start, end, 'end');
        else input.value = input.value.slice(0, start) + String(text) + input.value.slice(end);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      var items = [
        { label: 'Cut', disabled: !selected, run: function () { writeClipboardText(selected).then(function () { replace(''); }); } },
        { label: 'Copy', disabled: !selected, run: function () { writeClipboardText(selected).then(function () { input.focus(); input.setSelectionRange(start, end); }); } },
        { label: 'Paste', run: function () { readClipboardText().then(replace); } }
      ];
      var wr = $('#win').getBoundingClientRect();
      L.Menu.show(items, e.clientX - wr.left, e.clientY - wr.top, false);
    });
  }

  L.openUrlDialog = function () {
    L.Modal.open('<h2>' + u.icon('open-url', 18) + 'Open URL / stream</h2>' +
      '<p>Paste a direct link, HLS (.m3u8) or network stream. Common unsupported codecs are converted by Lumen’s built-in FFmpeg engine.</p>' +
      '<div class="row"><input type="text" id="urlIn" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…/movie.m3u8" style="flex:1;background:var(--chip);border:1px solid var(--stroke);border-radius:10px;padding:9px 11px;color:var(--text);font:inherit"></div>' +
      '<div class="mrow"><button class="btn" data-close>Cancel</button><button class="btn accent" data-go>Load</button></div>', {
      onOpen: function (box) {
        box.querySelector('[data-close]').addEventListener('click', L.Modal.close);
        var input = box.querySelector('#urlIn');
        var userEdited = false;
        input.addEventListener('input', function () { userEdited = true; });
        bindEditContextMenu(input);
        function go() {
          var v = (input.value || '').trim();
          if (!v) return;
          L.Modal.close();
          var raw = v.split('?')[0];
          var name = u.baseName(raw) || 'Stream';
          /* links are percent-encoded — show the real file name in the UI */
          try { name = decodeURIComponent(name); } catch (e) { }
          name = name.replace(/\+$/, '') || 'Stream';
          var item = PL.add({ path: '', url: v, name: name, ext: u.extName(name) || 'stream' });
          L.loadItem(item);
        }
        box.querySelector('[data-go]').addEventListener('click', go);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        input.focus();
        readClipboardText().then(function (text) {
          if (!document.body.contains(input) || userEdited) return;
          input.value = String(text || '');
          input.focus();
          input.select();
        });
      }
    });
  };

  /* paste an online .srt/.vtt for the current stream (or for any item) */
  L.openSubUrl = function () {
    L.Modal.open('<h2>' + u.icon('subtitles', 18) + 'Add subtitle link</h2>' +
      '<p>Paste the address of an .srt or .vtt file (for example from your subtitle site). It is fetched once and shown on top of the picture.</p>' +
      '<div class="row"><input type="text" id="subUrlIn" placeholder="https://…/movie.fa.srt" style="flex:1;background:var(--chip);border:1px solid var(--stroke);border-radius:10px;padding:9px 11px;color:var(--text);font:inherit"></div>' +
      '<div class="mrow"><button class="btn" data-close>Cancel</button><button class="btn accent" data-go>Load subtitles</button></div>', {
      onOpen: function (box) {
        box.querySelector('[data-close]').addEventListener('click', L.Modal.close);
        var input = box.querySelector('#subUrlIn');
        function go() {
          var v = (input.value || '').trim();
          if (!v) return;
          L.Modal.close();
          L.attachSubUrl(v);
        }
        box.querySelector('[data-go]').addEventListener('click', go);
        input.addEventListener('keydown', function (e) { if (e.key === 'Enter') go(); });
        try { input.focus(); } catch (e) { }
      }
    });
  };

  /* attach a remote subtitle by url — kept next to attachSubs (files) */
  L.attachSubUrl = function (url) {
    if (!P.item) { L.Toast.show('Load a file or a stream first.', { icon: 'info' }); return; }
    url = String(url || '').trim();
    if (!/^https?:/i.test(url)) { L.Toast.show('That does not look like an http(s) subtitle link.', { kind: 'err', icon: 'info', ms: 4000 }); return; }
    var name = u.baseName(url.split('?')[0]) || 'online';
    try { name = decodeURIComponent(name); } catch (e) { }
    var track = { id: 'netfile:' + url, label: name + ' · online', kind: 'remote', net: true, url: url };
    if (!P.subTracks.some(function (t) { return t.id === track.id; })) {
      P.subTracks = P.subTracks.concat([track]);
    }
    P.setSubtitle(track);
    Ev.emit('tracks');
  };

  L.resetSettings = function () {
    L.Modal.open('<h2>' + u.icon('reset', 18) + 'Reset settings?</h2>' +
      '<p>Theme, gestures, zoom and decode preferences go back to their defaults. The playlist is kept.</p>' +
      '<div class="mrow"><button class="btn" data-close>Cancel</button><button class="btn accent" data-go>Reset</button></div>', {
      onOpen: function (box) {
        box.querySelector('[data-close]').addEventListener('click', L.Modal.close);
        box.querySelector('[data-go]').addEventListener('click', function () {
          for (var k in L.DEFAULTS) if (Object.prototype.hasOwnProperty.call(L.DEFAULTS, k)) S[k] = Array.isArray(L.DEFAULTS[k]) ? L.DEFAULTS[k].slice(0) : L.DEFAULTS[k];
          L.saveSettings();
          L.UI.syncWidgets(); L.UI.applyChrome(); L.UI.renderVolume();
          P.applyVideoTransforms(); P.setSpeed(S.speed);
          L.setVolume(S.volume, true);
          B.call('set_always_on_top', false);
          L.Modal.close();
          L.Toast.show('Settings reset to defaults', { kind: 'ok', icon: 'check' });
        });
      }
    });
  };

  L.copy = function (label, text) {
    function done() { L.Toast.show('Copied: ' + (label || ''), { kind: 'ok', icon: 'check', ms: 1600 }); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(function () { fallback(); });
    } else fallback();
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { }
      ta.remove();
    }
  };

  /* ================================================================== files */
  var filePick = $('#localFilePick');
  var pickMode = null;

  L.openFiles = function (folder) {
    if (B.ready) {
      B.call('open_files', !!folder).then(function (paths) {
        if (!paths || !paths.length) return;
        addPaths(paths, { play: true, folder: !!folder });
      });
    } else {
      pickMode = 'media';
      filePick.webkitdirectory = !!folder;   /* folder picker (browser fallback) */
      filePick.value = '';
      filePick.click();
    }
  };
  L.pickSubtitles = function (cb) {
    if (B.ready) {
      B.call('open_subtitles').then(function (paths) { if (paths && paths.length) cb(paths); });
    } else {
      pickMode = 'subs';
      filePick.value = '';
      filePick.click();
      L._subCb = cb;
    }
  };
  filePick && filePick.addEventListener('change', function () {
    var files = Array.prototype.slice.call(this.files || []);
    if (!files.length) return;
    if (pickMode === 'subs') {
      var f = files[0];
      var fr = new FileReader();
      fr.onload = function () {
        L.loadSubtitleText(String(fr.result), f.name);
        if (L._subCb) L._subCb(null);
      };
      fr.readAsText(f);
      return;
    }
    var subs = [], media = [];
    files.forEach(function (f) {
      if (u.isSubExt(u.extName(f.name))) subs.push(f); else media.push(f);
    });
    if (subs.length && P.subTracks) {
      var sf = subs[0];
      var fr = new FileReader();
      fr.onload = function () { L.loadSubtitleText(String(fr.result), sf.name); };
      fr.readAsText(sf);
    }
    var items = [];
    media.forEach(function (f) {
      var url = URL.createObjectURL(f);
      items.push({ name: f.name, ext: u.extName(f.name), path: '', url: url, blobUrl: url, size: f.size });
    });
    items.forEach(function (it) { PL.add(it); });
    if (items.length) L.loadItem(items[0]);
    if (items.length) L.Toast.show('Added ' + items.length + ' item(s) to the playlist', { icon: 'list-plus' });
  });

  /* pure-web subtitle support (no host): parse the dropped/chosen text */
  L.loadSubtitleText = function (text, label) {
    var track = { id: 'local:' + u.uid(), label: label || 'subtitle', kind: 'external', text: text };
    P.subActive = track;
    P.subCues = L.Subs.parse(text);
    P._subSig = '';
    Ev.emit('tracks');
    P.renderSubs(P.time);
    L.Toast.show('Subtitles: ' + track.label + ' · ' + P.subCues.length + ' cues', { icon: 'subtitles', ms: 2200 });
  };

  /* host paths → playlist */
  function addPaths(paths, opts) {
    opts = opts || {};
    var med = [], subs = [];
    (paths || []).forEach(function (p) {
      var e = u.extName(p);
      if (u.isSubExt(e) && !opts.folder) subs.push(p);
      else if (u.isVideoExt(e) || u.isAudioExt(e)) med.push(p);
      else if (u.extName(p) === 'm3u8' || u.extName(p) === 'm3u') med.push(p);
      else if (opts.folder) med.push(p);
    });
    var added = PL.addMany(med);
    if (subs.length) {
      var it = PL.current();
      if (it) L.UI.attachSubs(it, subs);
      else L.Toast.show('Subtitle added — open a video to use it.', { icon: 'subtitles' });
    }
    if (added.length) {
      if (opts.play !== false) L.loadItem(added[0]);
      L.Toast.show('Added ' + added.length + ' item(s)' + (opts.folder ? ' from folder' : ''), { kind: 'ok', icon: 'list-plus' });
    } else if (!subs.length) {
      L.Toast.show('Nothing playable in that selection.', { kind: 'err', icon: 'info' });
    }
  }
  L.addPaths = addPaths;

  /* ---- drag & drop from Explorer / Finder ---- */
  L.handleDrop = function (files) {
    if (!files || !files.length) return;
    var media = [], subs = [], big = [];
    /* dropping the engine itself is a shortcut for Settings → Choose ffmpeg.exe */
    var engine = files.filter(function (f) { return /^ffmpeg(for)?\.exe$/i.test(f.name || '') || /^ffprobe\.exe$/i.test(f.name || ''); });
    if (engine.length) {
      files = files.filter(function (f) { return engine.indexOf(f) < 0; });
      (function (f) {
        var nativePaths = !!(window.lumenNative && typeof window.lumenNative.pathForFile === 'function');
        if (!B.ready || !nativePaths) { L.Toast.show('Dropping ffmpeg.exe needs the desktop app.', { icon: 'info' }); return; }
        var p = window.lumenNative.pathForFile(f);
        if (!p) return;
        L.FF.choose(p).then(function (res) {
          if (res && res.ok) L.Toast.show('ffmpeg set from the dropped file.', { kind: 'ok', icon: 'check' });
        });
      })(engine[0]);
      if (!files.length) return;
    }
    files.forEach(function (f) {
      if (u.isSubExt(u.extName(f.name))) subs.push(f); else media.push(f);
      if (f.size > 1500 * 1024 * 1024) big.push(f.name);
    });
    /* subtitles first: text is small, always reads fine */
    subs.forEach(function (f) {
      var fr = new FileReader();
      fr.onload = function () { L.loadSubtitleText(String(fr.result), f.name); };
      fr.readAsText(f);
    });
    if (!media.length) return;
    /* with a native host the file is only referenced by path, so size is a
       non-issue; in pure-web mode the bytes have to travel through the bridge */
    var nativePaths = !!(window.lumenNative && typeof window.lumenNative.pathForFile === 'function');
    if (big.length && (!B.ready || !nativePaths)) {
      L.Toast.show('Large file — for best performance open it with Ctrl+O instead of dropping.\n<b>' +
        u.esc(big[0]) + '</b>', { icon: 'info', ms: 6000 });
    }
    if (!B.ready) {
      var items = media.map(function (f) {
        var url = URL.createObjectURL(f);
        return { name: f.name, ext: u.extName(f.name), path: '', url: url, blobUrl: url };
      });
      items.forEach(function (i) { PL.add(i); });
      L.loadItem(items[0]);
      L.Toast.show('Added ' + items.length + ' item(s) (browser mode)', { icon: 'list-plus' });
      return;
    }
    /* host present: stream the bytes into a temp/known folder, then play natively */
    var done = 0, paths = [], failed = 0;
    var toast = L.Toast.show('Importing <b>' + u.esc(media[0].name) + '</b>… <span id="dropProg">0%</span>', { icon: 'folder', ms: 60000 });
    media.forEach(function (f) {
      B.uploadTemp(f, function (p) {
        var e = $('#dropProg');
        if (e) e.textContent = Math.round(p * 100) + '%';
      }).then(function (path) {
        if (path) paths.push(path); else failed++;
        if (++done === media.length) {
          L.Toast.dismiss(toast);
          if (paths.length) addPaths(paths, { play: true });
          if (failed) L.Toast.show(failed + ' file(s) could not be imported.', { kind: 'err', icon: 'info' });
        }
      });
    });
  };

  /* ================================================================== playlist save / load */
  L.savePlaylist = function () {
    var data = JSON.stringify(PL.serialize(), null, 2);
    if (B.ready) {
      B.call('save_playlist', data).then(function (path) {
        if (path) L.Toast.show('Playlist saved', { kind: 'ok', icon: 'folder', ms: 2600, action: { label: 'Show', fn: function () { B.call('reveal', path); } } });
      });
    } else {
      var blob = new Blob(['#EXTM3U\n' + PL.items.map(function (i) { return '#EXTINF:' + Math.round(i.dur || 0) + ',' + (i.name || '') + '\n' + (i.path || i.url || ''); }).join('\n') + '\n'], { type: 'audio/x-mpegurl' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'lumen.m3u8'; a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
    }
  };
  L.loadPlaylistFile = function () {
    if (!B.ready) { L.Toast.show('Loading playlists needs the desktop host.', { icon: 'info' }); return; }
    B.call('load_playlist').then(function (res) {
      if (!res) return;
      try {
        var data = typeof res === 'string' ? JSON.parse(res) : res;
        PL.hydrate(data);
        L.Toast.show('Playlist loaded (' + PL.items.length + ' items)', { kind: 'ok', icon: 'folder' });
      } catch (e) {
        L.Toast.show('That playlist could not be parsed.', { kind: 'err', icon: 'info' });
      }
    });
  };

  /* ================================================================== keyboard */
  function isTyping(e) {
    var t = e.target;
    /* SELECT belongs here too: arrow keys / PageDown must move inside the
       audio, subtitle or EQ dropdown instead of seeking or skipping media */
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' ||
      t.tagName === 'SELECT' || t.isContentEditable);
  }
  function frameStep(dir) {
    if (!P.item || P.item.demo) return;
    P.pause();
    var fps = (P.info && (P.info.rfps || P.info.fps)) || 25;
    P.seek(clamp((P.time || 0) + dir / fps, 0, P.dur || 0));
  }
  function panBy(dx, dy) {
    var b = L.panBounds();
    L.Zoom.x = clamp(L.Zoom.x + dx, -b.x, b.x);
    L.Zoom.y = clamp(L.Zoom.y + dy, -b.y, b.y);
    L.Zoom.to(L.Zoom.z, L.Zoom.x, L.Zoom.y);
  }
  window.addEventListener('keydown', function (e) {
    if (isTyping(e)) { if (e.key === 'Escape') e.target.blur(); return; }
    var k = e.key;
    var ctrl = e.ctrlKey || e.metaKey;
    var alt = e.altKey;
    var shift = e.shiftKey;

    /* menu navigation takes priority */
    if (L.Menu.isOpen()) {
      var items = L.Menu.items();
      if (k === 'Escape') { e.preventDefault(); L.Menu.close(); return; }
      if (k === 'ArrowDown' || k === 'ArrowUp') {
        e.preventDefault();
        var f = L.Menu.focus;
        f = clamp(f + (k === 'ArrowDown' ? 1 : -1), 0, items.length - 1);
        L.Menu.focus = f;
        L.Menu.paint();
        items[f] && items[f].focus();
        return;
      }
      if (k === 'ArrowLeft') { e.preventDefault(); L.Menu.back(); return; }
      if (k === 'ArrowRight' || k === 'Enter') {
        e.preventDefault();
        var cur = items[clamp(L.Menu.focus, 0, items.length - 1)];
        if (cur) cur.click();
        return;
      }
      return;
    }
    if (L.Modal.isOpen()) {
      if (k === 'Escape') { e.preventDefault(); L.Modal.close(); }
      return;
    }

    switch (k) {
      case ' ': case 'k': case 'K': e.preventDefault(); P.toggle(); L.UI.wake(); return;
      case 'MediaPlayPause': P.toggle(); return;
      case 'MediaTrackNext': P.next(); return;
      case 'MediaTrackPrevious': P.prev(); return;
      case 'ArrowLeft':
        e.preventDefault();
        if (alt) panBy(40, 0);
        else if (ctrl) P.prev();
        else if (shift) P.nudge(-60);
        else L.UI.seekFx('left', S.seekstep);
        return;
      case 'ArrowRight':
        e.preventDefault();
        if (alt) panBy(-40, 0);
        else if (ctrl) P.next();
        else if (shift) P.nudge(60);
        else L.UI.seekFx('right', S.seekstep);
        return;
      case 'ArrowUp':
        e.preventDefault();
        if (alt) panBy(0, 40); else L.setVolume((S.muted ? 0 : S.volume) + (shift ? 0.1 : 0.05));
        return;
      case 'ArrowDown':
        e.preventDefault();
        if (alt) panBy(0, -40); else L.setVolume((S.muted ? 0 : S.volume) - (shift ? 0.1 : 0.05));
        return;
      case 'm': case 'M': L.toggleMute(); return;
      case 'f': case 'F': case 'F11': e.preventDefault(); L.toggleFullscreen(); return;
      case 'w': case 'W': L.setMini(el.body.dataset.mode !== 'mini'); return;
      case 't': case 'T': L.setSetting('ontop', !S.ontop); B.call('set_always_on_top', !S.ontop); L.UI.syncPins();
        L.Toast.show('Always on top ' + (!S.ontop ? 'on' : 'off'), { icon: 'pin', ms: 1400 }); return;
      case 'p': case 'P': e.preventDefault(); L.togglePanel('playlist'); return;
      case 'i': case 'I': e.preventDefault(); L.togglePanel('settings'); return;
      case 'j': case 'J': P.prev(); return;
      case 'l': case 'L': L.cycleRepeat(); return;
      case 'v': case 'V': L.UI.cycleSubs(1); return;
      case 'c': case 'C': L.pickSubtitles(function (p) { L.UI.attachSubs(P.item, p); }); return;
      case 'b': case 'B': L.UI.cycleAudio(); return;
      case 'y': case 'Y': Info.open(P.item); return;
      case 'u': case 'U': L.openUrlDialog(); return;
      case 'x': case 'X':
        if (!P.ab) P.abSet('a');
        else if (P.ab && P.ab.a != null && P.ab.b == null) P.abSet('b');
        else P.abSet(null);
        Ev.emit('ab');
        L.Toast.show(!P.ab ? 'A-B loop cleared' : (P.ab.b == null ? 'A = ' + fmt(P.ab.a) : 'Looping ' + fmt(P.ab.a) + ' → ' + fmt(P.ab.b)), { icon: 'ab-loop', ms: 1800 });
        return;
      case 'a': case 'A': {
        var list = ['auto', 'cover', '16:9', '4:3', '21:9'];
        var i = list.indexOf(S.aspect);
        L.setSetting('aspect', list[(i + 1) % list.length]);
        P.applyVideoTransforms(); L.updatePanBounds(); L.UI.syncWidgets();
        L.Toast.show('Aspect: ' + S.aspect, { icon: 'aspect', ms: 1500 });
        return;
      }
      case 'r': case 'R': {
        var rot = ((S.rotate || 0) + 90) % 360;
        L.setSetting('rotate', rot);
        P.applyVideoTransforms(); L.updatePanBounds(); L.UI.syncWidgets();
        L.Toast.show('Rotate ' + rot + '°', { icon: 'rotate', ms: 1400 });
        return;
      }
      case ',': case '<': frameStep(-1); return;
      case '.': case '>': frameStep(1); return;
      /* NB: no cycleSpeed() here — it snapped the freshly set 1.25× straight
         back to the nearest preset (1×), so [ and ] did nothing at all */
      case '[': case ']': {
        var step = (k === ']') ? 0.25 : -0.25;
        P.setSpeed(clamp(Math.round((S.speed + step) * 4) / 4, 0.25, 3));
        L.Toast.show('Speed ' + S.speed + '×', { icon: 'speed', ms: 1200 });
        return;
      }
      case '\\': P.setSpeed(1); L.Toast.show('Speed 1×', { icon: 'speed', ms: 1200 }); return;
      case '+': case '=': L.Zoom.zoomAbout(L.Zoom.z * 1.25); return;
      case '-': case '_': L.Zoom.zoomAbout(L.Zoom.z / 1.25); return;
      case 'Home': P.seek(0); return;
      case 'End': P.seek(P.dur || 0); return;
      /* PageDown / PageUp = jump through the playlist (wraps around) */
      case 'PageDown': e.preventDefault(); P.next(); return;
      case 'PageUp': e.preventDefault(); P.prev(); return;
      /* Delete = trash the playing file and immediately continue with the next */
      case 'Delete': case 'Del': e.preventDefault(); L.deleteCurrent(); return;
      case 'Escape': {
        if (L.Menu.isOpen()) { L.Menu.close(); return; }
        if (L.Modal.isOpen()) { L.Modal.close(); return; }
        if (L.anyPanelOpen()) { L.closePanels(); return; }
        if (L.Zoom.z > 1.001) { L.Zoom.reset(); return; }
        if (el.body.dataset.mode === 'full' || el.body.dataset.mode === 'max') { L.toggleFullscreen(false); L.UI.setMode('window'); }
        return;
      }
      case 'F1': e.preventDefault(); L.showShortcuts(); return;
      case 'o': case 'O':
        if (!ctrl) return;
        e.preventDefault();
        L.openFiles(shift);
        return;
      default: break;
    }
    if (ctrl && (k === '0')) { e.preventDefault(); L.Zoom.reset(); return; }
    if (ctrl && (k === '1')) { e.preventDefault(); L.Zoom.to(1, 0, 0); return; }
    if (/^[0-9]$/.test(k)) {
      var pct = parseInt(k, 10) / 10;
      P.seek((P.dur || 0) * pct);
      return;
    }
  }, { passive: false });
  /* middle click = mute (like most players) */
  el.stack.addEventListener('pointerdown', function (e) { if (e.button === 1) { e.preventDefault(); L.toggleMute(); } });

  /* ================================================================== window chrome */
  $('#tbMin') && $('#tbMin').addEventListener('click', function () { B.call('window_action', 'minimize'); });
  $('#tbMax') && $('#tbMax').addEventListener('click', function () { L.toggleMax(); });
  $('#tbClose') && $('#tbClose').addEventListener('click', function () { B.call('window_action', 'close'); });
  $('#tbPin') && $('#tbPin').addEventListener('click', function () {
    L.setSetting('ontop', !S.ontop); B.call('set_always_on_top', !S.ontop); L.UI.syncPins();
  });
  $('#fsPin') && $('#fsPin').addEventListener('click', function () {
    L.setSetting('ontop', !S.ontop); B.call('set_always_on_top', !S.ontop); L.UI.syncPins();
  });
  $('#fsToggle') && $('#fsToggle').addEventListener('click', function () { L.toggleFullscreen(); });
  (function () {
    var b = $('#btnFullscreen');
    if (b) b.addEventListener('click', function () { L.toggleFullscreen(); });
  })();
  var tbIcon = $('#fsToggle');
  function syncFullscreenIcon() {
    if (!tbIcon) return;
    var full = el.body.dataset.mode === 'full';
    var span = $('span[data-icon]', tbIcon);
    var dockSpan = $('#btnFullscreen') ? $('span[data-icon]', $('#btnFullscreen')) : null;
    [span, dockSpan].forEach(function (s) {
      if (!s) return;
      s.setAttribute('data-icon', full ? 'fullscreen-exit' : 'fullscreen');
    });
    u.injectIcons(tbIcon);
    if ($('#btnFullscreen')) u.injectIcons($('#btnFullscreen'));
    var mx = $('#tbMax') ? $('span[data-icon]', $('#tbMax')) : null;
    if (mx) { mx.setAttribute('data-icon', el.body.dataset.mode === 'max' ? 'restore' : 'maximize'); u.injectIcons($('#tbMax')); }
  }
  Ev.on('mode', syncFullscreenIcon);

  /* title bar drag + double-click maximize */
  (function () {
    var tb = $('#titlebar');
    var wb = $('#winbar');
    function down(e) {
      if (e.button !== 0) return;
      if (e.target.closest('button')) return;
      /* in the desktop host the title bar is a native drag region (CSS
         -webkit-app-region) — moving it here too would double the speed */
      if (window.lumenNative) return;
      var sx = e.clientX, sy = e.clientY;
      /* the window moves under the cursor, so the drag is fed with *deltas*
         measured against the previous screen position (not the absolute one) */
      var lastX = e.screenX, lastY = e.screenY, moved = false;
      function move(ev) {
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) <= 3) return;
        moved = true;
        var dx = ev.screenX - lastX, dy = ev.screenY - lastY;
        lastX = ev.screenX; lastY = ev.screenY;
        if (dx || dy) L.moveWindow(dx, dy);
      }
      function up() { cleanup(); }
      function cleanup() { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    }
    [tb, wb].forEach(function (row) {
      if (!row) return;
      row.addEventListener('pointerdown', down);
      row.addEventListener('dblclick', function (e) {
        if (e.target.closest('button')) return;
        if (window.lumenNative) return;    /* the OS maximizes native drag regions */
        L.toggleMax();
      });
    });
  })();

  /* resize grips (frameless window) */
  $$('#grips i').forEach(function (g) {
    var dir = g.getAttribute('data-dir');
    g.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      try { g.setPointerCapture(e.pointerId); } catch (err) { }
      /* screen coords are the accurate source, client coords the fallback
         (some platforms report 0 there — see ui.js winDelta) */
      function point(ev) {
        if ((ev.screenX || 0) || (ev.screenY || 0)) return { x: ev.screenX, y: ev.screenY };
        return { x: ev.clientX, y: ev.clientY };
      }
      var last = point(e), raf = null, dx = 0, dy = 0, busy = false;
      function flush() {
        raf = null;
        if (!dx && !dy) return;
        if (busy) {
          raf = requestAnimationFrame(flush);
          return;
        }
        var sendX = dx, sendY = dy;
        dx = 0; dy = 0;
        busy = true;
        B.call('resize_window', sendX, sendY, dir).then(function () {
          busy = false;
        }).catch(function () {
          busy = false;
        });
      }
      function move(ev) {
        var p = point(ev);
        dx += p.x - last.x;
        dy += p.y - last.y;
        last = p;
        if (!raf) raf = requestAnimationFrame(flush);
      }
      function up(ev) {
        try { g.releasePointerCapture(ev.pointerId); } catch (err) { }
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        flush();
        P.applyVideoTransforms(); L.updatePanBounds();
      }
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  });

  /* Global context menu handling: prevent browser default and open Lumen menu on main screen */
  document.addEventListener('contextmenu', function (e) {
    if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA')) return;
    e.preventDefault();
    if (e.target.closest('#panelPlaylist') || e.target.closest('#panelSettings') || e.target.closest('#modal') || e.target.closest('.ctx')) {
      return;
    }
    if (Date.now() < (L._menuGuard || 0)) return;
    L.openMenuAt(e.clientX, e.clientY, L.isTouchUI());
  });

  /* ================================================================== host bridge */
  function connectBridge() {
    B.ready = true;
    L.UI.applyChrome();
    document.body.classList.remove('demo');
    B.call('set_context_menu_enabled', false);
    B.call('set_always_on_top', !!S.ontop);
    B.call('boot_state').then(function (st) {
      if (!st) return;
      B.ffmpeg = !!st.ffmpeg;
      B.version = st.version || B.version;
      if (st.settings) {
        try {
          var remote = typeof st.settings === 'string' ? JSON.parse(st.settings) : st.settings;
          for (var k in remote) if (Object.prototype.hasOwnProperty.call(remote, k) && remote[k] !== null && remote[k] !== undefined) S[k] = remote[k];
        } catch (e) { }
      }
      if (st.playlist && st.playlist.items) PL.hydrate(st.playlist);
      L.UI.syncWidgets();
      L.UI.applyChrome();
      L.UI.renderVolume();
      P.setSpeed(S.speed);
      P.applyVideoTransforms();
      var chip = $('#aboutChip2');
      if (chip) chip.textContent = B.ffmpeg ? 'Built-in media engine' : 'Media engine unavailable';
      var hwSub = $('#hwSub');
      if (hwSub && st.gpu) hwSub.textContent = st.gpu;
      var dev = $('#audioDev');
      if (dev && st.audio) dev.textContent = st.audio;
      if (!B.ffmpeg) {
        L.Toast.show('The bundled FFmpeg engine is unavailable. Repair or reinstall Lumen to restore its media codecs.', { icon: 'info', ms: 6500 });
      }
      /* command-line files (or the last session) */
      if (st.args && st.args.length) addPaths(st.args, { play: true });
      else if (st.lastFile && S.autoload) {
        var i = PL.findPath(st.lastFile);
        if (i >= 0) {
          var item = PL.items[i];
          L.loadItem(item, { paused: true });
          L.Toast.show('Resuming <b>' + u.esc(item.name) + '</b> — press Space', { icon: 'history', ms: 3200 });
        }
      }
    });
  }

  /* called from the host (window.lumenHost.*) — merged, never replaced, so any
     callback registered earlier stays alive */
  Object.assign(window.lumenHost = window.lumenHost || {}, {
    openPaths: function (paths) { addPaths(paths, { play: true }); },
    appendPaths: function (paths) { addPaths(paths, { play: false }); },
    notify: function (msg, kind) { L.Toast.show(msg, { kind: kind || 'info' }); },
    command: function (cmd, arg) {
      switch (cmd) {
        case 'open': L.openFiles(false); break;
        case 'open-folder': L.openFiles(true); break;
        case 'play-pause': P.toggle(); break;
        case 'play': P.play(); break;
        case 'pause': P.pause(); break;
        case 'stop': P.pause(); P.seek(0); break;
        case 'next': P.next(); break;
        case 'prev': P.prev(); break;
        case 'volume-up': L.setVolume((S.muted ? 0 : S.volume) + 0.05); break;
        case 'volume-down': L.setVolume((S.muted ? 0 : S.volume) - 0.05); break;
        case 'mute': L.toggleMute(); break;
        case 'fullscreen': L.toggleFullscreen(); break;
        case 'mini': L.setMini(true); break;
        case 'restore': L.setMini(false); break;
        case 'ontop': L.setSetting('ontop', !S.ontop); B.call('set_always_on_top', !S.ontop); L.UI.syncPins(); break;
        case 'menu': L.buildMainMenu(window.innerWidth / 2 - 140, 80, L.isTouchUI()); break;
        case 'shortcuts': L.showShortcuts(); break;
        case 'info': Info.open(P.item); break;
        case 'panel-playlist': L.togglePanel('playlist'); break;
        case 'panel-settings': L.togglePanel('settings'); break;
        case 'zoom-in': L.Zoom.zoomAbout(L.Zoom.z * 1.25); break;
        case 'zoom-out': L.Zoom.zoomAbout(L.Zoom.z / 1.25); break;
        case 'zoom-reset': L.Zoom.reset(); break;
        case 'aspect-cycle': {
          var list = ['auto', 'cover', '16:9', '4:3', '21:9'];
          L.setSetting('aspect', list[(list.indexOf(S.aspect) + 1) % list.length]);
          P.applyVideoTransforms(); L.updatePanBounds(); L.UI.syncWidgets(); break;
        }
        case 'subs-cycle': L.UI.cycleSubs(1); break;
        case 'audio-cycle': L.UI.cycleAudio(); break;
        case 'speed-cycle': L.UI.cycleSpeed(1); break;
        case 'loop-cycle': L.cycleRepeat(); break;
        case 'open-url': L.openUrlDialog(); break;
        default: break;
      }
    },
    setMode: function (mode) { L.UI.setMode(mode); },
    mediaKeys: function (cmd) { window.lumenHost.command(cmd === 'playpause' ? 'play-pause' : cmd); }
  });

  /* ================================================================== boot */
  function demoBoot() {
    if (B.ready) return;
    document.body.classList.add('demo');
    L.UI.applyChrome();
    var demo = [
      { name: 'Aurora.2024.2160p.HDR.HEVC.mkv', dur: 7112, ext: 'mkv', w: 3840, h: 2160, scene: 'bright', demo: true },
      { name: 'Interstellar.2014.1080p.BluRay.mkv', dur: 10151, ext: 'mkv', w: 1920, h: 1080, scene: 'dark', demo: true },
      { name: 'Dune.Part.Two.2024.2160p.WEB.mkv', dur: 9964, ext: 'mkv', w: 3840, h: 2160, scene: 'bright', demo: true },
      { name: 'Blade.Runner.2049.4K.Remux.mkv', dur: 9840, ext: 'mkv', w: 3840, h: 2160, scene: 'dark', demo: true },
      { name: 'Arrival.2016.1080p.mkv', dur: 6960, ext: 'mkv', w: 1920, h: 1080, scene: 'bright', demo: true },
      { name: 'Gravity.2013.2160p.mkv', dur: 5460, ext: 'mkv', w: 3840, h: 2160, scene: 'dark', demo: true },
      { name: 'The.Matrix.1999.1080p.mkv', dur: 8160, ext: 'mkv', w: 1920, h: 1080, scene: 'bright', demo: true },
      { name: 'Inception.2010.2160p.HDR.mkv', dur: 8880, ext: 'mkv', w: 3840, h: 2160, scene: 'dark', demo: true }
    ];
    demo.forEach(function (d) { PL.add(d); });
    L.UI.renderPlaylist();
    L.Toast.show('Demo mode: the Python host is not attached. Gestures, zoom, panels and menus all work — drop a video file to play it.',
      { icon: 'info', ms: 7000 });
  }

  function init() {
    u.injectIcons(document);
    P.init(el.video);
    L.UI.bindWidgets();
    L.UI.syncWidgets();
    L.UI.applyChrome();
    L.setVolume(S.volume, true);
    P.setSpeed(S.speed);
    P.applyVideoTransforms();
    L.UI.renderSeekStep();
    L.UI.renderVolume();
    L.UI.renderPlaylist();
    L.UI.renderTracks();
    L.UI.renderEq();
    L.UI.wake();
    L.UI.setMode(el.body.dataset.mode || 'window');
    if (window.LUMEN_LOGO) { var m = $('#aboutMark'); if (m) m.innerHTML = window.LUMEN_LOGO; }

    /* demo ribbon (only visible without the host) */
    $$('[data-scene-btn]').forEach(function (b) {
      b.addEventListener('click', function () {
        L.setScene(b.getAttribute('data-scene-btn'));
        $$('[data-scene-btn]').forEach(function (x) { x.classList.toggle('on', x === b); });
      });
    });
    var fade = $('[data-demo-fade]');
    if (fade) fade.addEventListener('click', function () { el.html.classList.add('idle'); });

    /* the host announces itself */
    window.addEventListener('pywebviewready', function () { connectBridge(); });
    if (window.pywebview && window.pywebview.api) connectBridge();
    else setTimeout(demoBoot, 1100);

    window.addEventListener('beforeunload', function () {
      L.saveSettings();
      B.call('settings_set', JSON.stringify(S));
      try { B.call('save_playlist_silent', JSON.stringify(PL.serialize())); } catch (e) { }
    });
    /* autosave the playlist (the host keeps it in config.json) */
    setInterval(function () { B.call('save_playlist_silent', JSON.stringify(PL.serialize())); }, 20000);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

})();
