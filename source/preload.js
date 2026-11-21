'use strict';
/* ==========================================================================
   Lumen — preload.js
   Exposes a small, pywebview-compatible bridge to the web core so the renderer
   (app.js / ui.js / shell.js) needs no knowledge of Electron at all:

     window.pywebview.api.<method>(...)  ->  Promise<result>
     window.pywebview._jsApiCallback()   ->  native window drag callback
     window.lumenNative.pathForFile(f)   ->  real path of a dropped File

   Everything is routed through one IPC channel; the main process validates the
   method name against a whitelist (see main.js).
   ========================================================================== */
const { ipcRenderer, webUtils } = require('electron');

/* every method the web core may call (mirrors the pywebview API surface) */
const METHODS = [
  /* window / shell */
  'window_action', 'set_fullscreen', 'set_mini', 'move_window', 'resize_window',
  'set_always_on_top', 'set_context_menu_enabled', 'set_hwaccel', 'set_hdr',
  /* config + state */
  'boot_state', 'settings_set', 'save_playlist', 'save_playlist_silent', 'load_playlist',
  'resume_set', 'remember_subs',
  /* files */
  'open_files', 'open_subtitles', 'register_path', 'register_url', 'drop_path',
  'drop_begin', 'drop_chunk', 'drop_finish', 'drop_abort', 'reveal', 'media_delete',
  /* media */
  'probe', 'sidecar_subtitles', 'transcode_start',
  /* ffmpeg: bundled engine status + optional advanced external override */
  'ffmpeg_status', 'ffmpeg_rescan', 'ffmpeg_pick', 'ffmpeg_drop', 'remote_probe',
  /* clipboard: URL dialog autofill + explicit Cut / Copy / Paste menu */
  'clipboard_read_text', 'clipboard_write_text',
  'open_external'
];

/* NOTE: this list must match the handler names in main.js. A method missing
   here is silently unreachable from the UI (that is how the FFmpeg
   `transcode_start` bridge once stopped working entirely) — tests/test-source-ui.js
   checks the two lists against each other. */
const api = {};
METHODS.forEach(function (name) {
  api[name] = function () {
    const args = Array.prototype.slice.call(arguments);
    return ipcRenderer.invoke('lumen:call', name, args);
  };
});

window.pywebview = {
  api: api,
  version: '1.0.0',
  platform: 'electron',
  /* legacy pywebview hook: used by the gesture layer to drag the window */
  _jsApiCallback: function (name, args) {
    try {
      if (name === 'pywebviewMoveWindow') return api.move_window(args[0], args[1]);
    } catch (e) { /* ignore */ }
    return Promise.resolve(null);
  }
};

window.lumenNative = {
  host: 'electron',
  /* Electron >= 30: File.path was removed, the path comes from webUtils */
  pathForFile: function (file) {
    try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; }
  }
};

/* mark the document so desktop.css can adapt the chrome (see desktop.css) */
function markDesktop() {
  try {
    if (document.documentElement) document.documentElement.classList.add('desktop-host');
    if (document.body) document.body.classList.add('desktop-host');
  } catch (e) { }
}
markDesktop();

/* the web core listens for this event; it also polls window.pywebview directly */
function announce() {
  try { window.dispatchEvent(new Event('pywebviewready')); } catch (e) { }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', function () { markDesktop(); setTimeout(announce, 0); });
} else {
  setTimeout(announce, 0);
}
