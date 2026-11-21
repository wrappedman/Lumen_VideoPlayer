'use strict';
/* ==========================================================================
   Lumen — host/store.js
   The host side of the app state: settings, playlist, resume positions and
   remembered subtitles live in one JSON file inside the user data folder.
   Writes are debounced; flush() forces them out (used before quitting).
   ========================================================================== */
const fs = require('fs');
const path = require('path');

function createStore(file) {
  const defaults = {
    version: 1,
    settings: {},
    playlist: { index: -1, items: [] },
    resume: {},           /* "path" -> { t, at } */
    subs: {},             /* "path" -> [subtitle paths] */
    recent: [],           /* recently opened files */
    lastFile: '',
    window: null          /* { x, y, width, height, maximized, mini } */
  };

  let data = JSON.parse(JSON.stringify(defaults));
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw && typeof raw === 'object') data = Object.assign(data, raw);
    }
  } catch (e) { /* a broken config must never stop the app from starting */ }

  let timer = null;

  function flush() {
    if (timer) { clearTimeout(timer); timer = null; }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data, null, 2));
      return true;
    } catch (e) {
      return false;
    }
  }

  function touch() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 500);
    if (timer.unref) timer.unref();
  }

  return {
    file,
    get all() { return data; },
    get(key) { return data[key]; },
    set(key, value) { data[key] = value; touch(); },
    merge(key, value) {
      data[key] = Object.assign({}, data[key], value);
      touch();
    },
    settings() { return data.settings || {}; },
    setSettings(obj) { data.settings = obj || {}; touch(); },
    playlist() { return data.playlist || { index: -1, items: [] }; },
    setPlaylist(obj) { data.playlist = obj || { index: -1, items: [] }; touch(); },
    resume() { return data.resume || {}; },
    setResume(p, t) {
      if (!p) return;
      const key = String(p);
      if (!t) delete data.resume[key];
      else data.resume[key] = { t: t, at: Date.now() };
      touch();
    },
    rememberSubs(p, list) {
      if (!p) return;
      const key = String(p);
      if (!list || !list.length) delete data.subs[key];
      else data.subs[key] = list.slice(0);
      touch();
    },
    subsFor(p) { return (p && data.subs[String(p)]) || []; },
    /* a deleted file must not leave resume positions, remembered subtitles or
       recents behind (they would keep pointing at a path that no longer exists) */
    forget(p) {
      if (!p) return;
      const key = String(p);
      if (data.resume) delete data.resume[key];
      if (data.subs) delete data.subs[key];
      const eq = (x) => String(x || '').toLowerCase() === key.toLowerCase();
      if (data.recent) data.recent = data.recent.filter((x) => !eq(x));
      if (eq(data.lastFile)) data.lastFile = '';
      if (data.playlist && Array.isArray(data.playlist.items)) {
        data.playlist.items = data.playlist.items.filter((it) => !it || !eq(it.path));
        if (data.playlist.index >= data.playlist.items.length) {
          data.playlist.index = data.playlist.items.length - 1;
        }
      }
      touch();
    },
    pushRecent(p) {
      if (!p) return;
      data.recent = [p].concat((data.recent || []).filter((x) => x !== p)).slice(0, 12);
      data.lastFile = p;
      touch();
    },
    windowState() { return data.window; },
    setWindowState(state) { data.window = state; touch(); },
    flush
  };
}

module.exports = { createStore };
