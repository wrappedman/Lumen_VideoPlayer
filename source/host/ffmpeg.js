'use strict';
/* ==========================================================================
   Lumen — host/ffmpeg.js
   Thin, dependency-free wrapper around ffmpeg / ffprobe:
     · detect the binaries (either chosen by hand in Settings, or dropped next to
       Lumen.exe / picked up from PATH and the usual install folders)
     · probe a file (codecs, tracks, duration, HDR, frame rate …)
     · grab a thumbnail frame
     · find sidecar subtitles / extract embedded ones as WebVTT
     · build the remux / transcode pipeline for the built-in HTTP server
   ========================================================================== */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const util = require('./util');

/* The bundled Chromium decoder set is intentionally treated conservatively.
   Everything outside these widely supported video codecs is sent through the
   bundled FFmpeg build and converted to H.264. HEVC/H.265 (including x265/Main10),
   MPEG-2, VC-1, ProRes and legacy codecs therefore never rely on a Windows HEVC
   extension or a vendor codec pack being installed. */
const SAFE_VIDEO = ['h264', 'avc1', 'avc3', 'av01', 'av1', 'vp8', 'vp9', 'vp09'];
/* the compatibility MP4 path copies only AAC audio. Other formats (DTS, AC3,
   E-AC3, TrueHD, WMA, Opus-in-MP4, etc.) are normalized to AAC for Chromium. */
const REENCODE_VIDEO = ['hevc', 'h265', 'mpeg2video', 'vc1', 'wmv3', 'msmpeg4v3',
  'prores', 'dnxhd', 'flv1', 'svq3', 'mpeg4', 'mpeg1video', 'theora', 'cavs', 'rv40'];
const SAFE_AUDIO = ['aac'];
/* inputs ffmpeg may refuse to copy while they stay playable in MP4 */
const HDR_TRANSFERS = ['smpte2084', 'arib-std-b67'];

function num(v) {
  const n = parseFloat(v);
  return isFinite(n) ? n : 0;
}

function parseRate(r) {
  if (!r || typeof r !== 'string') return 0;
  const parts = r.split('/');
  if (parts.length === 2) {
    const a = parseFloat(parts[0]), b = parseFloat(parts[1]);
    if (b) return Math.round((a / b) * 100) / 100;
  }
  const n = parseFloat(r);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function channelLabel(ch) {
  ch = Number(ch) || 0;
  return ({ 1: 'mono', 2: 'stereo', 6: '5.1', 8: '7.1', 3: '2.1' })[ch] || (ch + ' ch');
}

function createFfmpeg(opts) {
  opts = opts || {};
  const dirs = (opts.dirs || []).filter(Boolean);
  const isWin = process.platform === 'win32';
  const exe = isWin ? '.exe' : '';

  function testBin(file) {
    try {
      const r = spawnSync(file, ['-hide_banner', '-version'], { timeout: 8000, windowsHide: true });
      return r.status === 0 || !!(r.stdout && r.stdout.length);
    } catch (e) { return false; }
  }

  function testBinSafe(file) {
    try { return util.isFile(file) && testBin(file); } catch (e) { return false; }
  }

  /* Places a *manual* install usually lands in on Windows. The app may have
     been started long before the user installed ffmpeg (and winget/scoop only
     update new processes' PATH), so these are checked explicitly. */
  function extraWinDirs() {
    if (!isWin) return [];
    const home = process.env.USERPROFILE || '';
    const local = process.env.LOCALAPPDATA || (home ? path.join(home, 'AppData', 'Local') : '');
    const appdata = process.env.APPDATA || (home ? path.join(home, 'AppData', 'Roaming') : '');
    const pf = process.env.ProgramFiles || 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const prog = process.env.ProgramData || 'C:\\ProgramData';
    const list = [
      local && path.join(local, 'Microsoft', 'WinGet', 'Links'),
      local && path.join(local, 'Programs', 'ffmpeg', 'bin'),
      local && path.join(local, 'ffmpeg', 'bin'),
      appdata && path.join(appdata, 'Lumen', 'ffmpeg'),
      home && path.join(home, 'scoop', 'shims'),
      home && path.join(home, 'scoop', 'apps', 'ffmpeg', 'current', 'bin'),
      prog && path.join(prog, 'chocolatey', 'bin'),
      pf && path.join(pf, 'ffmpeg', 'bin'),
      pf86 && path.join(pf86, 'ffmpeg', 'bin'),
      'C:\\ffmpeg\\bin'
    ].filter(Boolean);

    /* winget unpacks versioned folders: …\WinGet\Packages\Gyan.FFmpeg_*\ffmpeg-*\bin */
    const wingetPkg = local && path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      if (wingetPkg && fs.existsSync(wingetPkg)) {
        fs.readdirSync(wingetPkg).forEach(function (pkg) {
          if (!/ffmpeg/i.test(pkg)) return;
          const root = path.join(wingetPkg, pkg);
          let inside = [];
          try { inside = fs.readdirSync(root); } catch (e) { return; }
          inside.forEach(function (sub) {
            list.push(path.join(root, sub, 'bin'));
            list.push(path.join(root, sub));
          });
          list.push(root);
        });
      }
    } catch (e) { }
    return list;
  }

  /* PATH of the *registry* — a freshly added folder is not in our own env yet */
  function registryPathDirs() {
    if (!isWin) return [];
    const out = [];
    [['HKCU\\Environment', 'Path'], ['HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path']]
      .forEach(function (pair) {
        try {
          const r = spawnSync('reg', ['query', pair[0], '/v', pair[1]], { timeout: 6000, windowsHide: true });
          const txt = String(r.stdout || '');
          const m = /REG_(?:EXPAND_)?SZ\s+(.+)/.exec(txt);
          if (!m) return;
          String(m[1]).split(';').forEach(function (p) {
            const dir = p.trim().replace(/%([^%]+)%/g, function (_, n) { return process.env[n] || ''; });
            if (dir) out.push(dir);
          });
        } catch (e) { }
      });
    return out;
  }

  function findBin(name) {
    /* 1) explicit environment override (file or folder) */
    const envVal = process.env.LUMEN_FFMPEG || process.env.FFMPEG_PATH;
    if (envVal) {
      if (util.isFile(envVal) && name === 'ffmpeg') return envVal;
      if (util.isDir(envVal)) {
        const cand = path.join(envVal, name + exe);
        if (testBinSafe(cand)) return cand;
      }
    }
    /* 2) next to the executable / in a tools folder / user data */
    for (let i = 0; i < dirs.length; i++) {
      const cands = [
        path.join(dirs[i], name + exe),
        path.join(dirs[i], 'tools', name + exe),
        path.join(dirs[i], 'ffmpeg', 'bin', name + exe),
        path.join(dirs[i], 'ffmpeg', name + exe)
      ];
      for (let k = 0; k < cands.length; k++) {
        if (testBinSafe(cands[k])) return cands[k];
      }
    }
    /* 3) the well-known Windows install folders (winget / scoop / choco / …) */
    const extras = extraWinDirs().concat(registryPathDirs());
    for (let i = 0; i < extras.length; i++) {
      const cand = path.join(extras[i], name + exe);
      if (testBinSafe(cand)) return cand;
    }
    /* 4) this process' PATH */
    const r = spawnSync(name + exe, ['-hide_banner', '-version'], { timeout: 8000, windowsHide: true });
    if (r && (r.status === 0 || (r.stdout && String(r.stdout).indexOf('ffmpeg version') >= 0))) return name + exe;
    return '';
  }

  /* resolved lazily so an optional advanced override or a bundled-engine
     rescan is picked up without restarting Lumen */
  let ffmpegPath = findBin('ffmpeg');
  let ffprobePath = findBin('ffprobe');
  let versionCache = '';
  const probeCache = new Map();      /* path -> { key, info } */
  const PROBE_CACHE_MAX = 64;        /* keep metadata for a folder, not the world */
  let filtersCache = null;

  function rescan() {
    const before = ffmpegPath;
    ffmpegPath = findBin('ffmpeg');
    ffprobePath = findBin('ffprobe');
    filtersCache = null;
    versionCache = '';
    probeCache.clear();
    return { available: !!ffmpegPath, changed: ffmpegPath !== before, path: ffmpegPath };
  }

  function version() {
    if (!ffmpegPath) return '';
    if (versionCache) return versionCache;
    try {
      const r = spawnSync(ffmpegPath, ['-hide_banner', '-version'], { timeout: 8000, windowsHide: true });
      const m = String(r.stdout || '').split('\n')[0];
      versionCache = (m || '').replace('ffmpeg version ', '').split(' ')[0] || 'ready';
    } catch (e) { versionCache = 'ready'; }
    return versionCache;
  }

  function available() { return !!ffmpegPath; }
  function canProbe() { return !!ffprobePath; }

  function describe() {
    if (!ffmpegPath) return 'ffmpeg not found';
    return 'ffmpeg ' + (version() || 'ready') + (ffprobePath ? ' + ffprobe' : '');
  }

  function hasFilter(name) {
    if (!filtersCache) {
      filtersCache = new Set();
      try {
        const r = spawnSync(ffmpegPath, ['-hide_banner', '-filters'], { timeout: 15000, windowsHide: true });
        String(r.stdout || '').split('\n').forEach(function (line) {
          const m = line.match(/^\s*[TSC.]{3}\s+([a-z0-9_]+)/i);
          if (m) filtersCache.add(m[1]);
        });
      } catch (e) { }
    }
    return filtersCache.has(name);
  }

  function run(args, opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      let child;
      try {
        child = spawn(ffmpegPath, args, { windowsHide: true });
      } catch (e) { resolve({ code: -1, stdout: '', stderr: String(e && e.message) }); return; }
      const out = [], err = [];
      let killed = false;
      if (child.stdout) child.stdout.on('data', function (d) { out.push(d); });
      if (child.stderr) child.stderr.on('data', function (d) { err.push(d); });
      if (opt.timeout) {
        setTimeout(function () { killed = true; try { child.kill('SIGKILL'); } catch (e) { } }, opt.timeout);
      }
      child.on('error', function (e) { resolve({ code: -1, stdout: '', stderr: String(e && e.message) }); });
      child.on('close', function (code) {
        resolve({
          code: code,
          killed: killed,
          stdout: Buffer.concat(out).toString('utf8'),
          stdoutRaw: Buffer.concat(out),
          stderr: Buffer.concat(err).toString('utf8')
        });
      });
    });
  }

  /* --------------------------------------------------------------- probing */
  function infoFromStreams(streams, format, extra) {
    const info = {
      duration: num(format && format.duration),
      format: (format && (format.format_long_name || format.format_name)) || '',
      bitrate: num(format && format.bit_rate),
      size: num(format && format.size),
      title: (format && format.tags && (format.tags.title || format.tags.TITLE)) || '',
      video: null, audio: [], subs: [], hdr: false,
      vcodec: '', acodec: '', profile: '', pixfmt: '', fps: 0, rfps: 0,
      width: 0, height: 0, ar: ''
    };
    (extra && extra.streams || []).forEach(function (s) {
      if (s.codec_type === 'video' && s.disposition && s.disposition.attached_pic) return;
      if (s.codec_type === 'video' && !info.video) {
        info.video = s;
        info.vcodec = s.codec_name || '';
        info.profile = s.profile || '';
        info.pixfmt = s.pix_fmt || '';
        info.width = num(s.width); info.height = num(s.height);
        info.fps = parseRate(s.r_frame_rate);
        info.rfps = parseRate(s.avg_frame_rate) || info.fps;
        info.ar = util.aspectLabel(info.width, info.height);
        const tr = (s.color_transfer || '').toLowerCase();
        info.hdr = HDR_TRANSFERS.indexOf(tr) >= 0;
        if (s.side_data_list) {
          s.side_data_list.forEach(function (sd) {
            const t = String(sd.side_data_type || '');
            if (t.indexOf('Mastering display') >= 0 || t.indexOf('Content light') >= 0) info.hdr = true;
          });
        }
      }
    });
    /* audio tracks: the *order* is what the UI cycles through */
    let ai = 0;
    (extra && extra.streams || []).forEach(function (s) {
      if (s.codec_type !== 'audio') return;
      const tags = s.tags || {};
      const lang = (tags.language || tags.LANGUAGE || '').toString();
      const title = (tags.title || tags.TITLE || '').toString();
      const ch = channelLabel(num(s.channels));
      const bits = [];
      if (lang && lang !== 'und') bits.push(lang.toUpperCase());
      if (title) bits.push(title);
      bits.push((s.codec_name || 'audio').toUpperCase());
      bits.push(ch);
      info.audio.push({
        id: 'a:' + ai,
        index: s.index,
        order: ai,
        label: bits.join(' · '),
        codec: s.codec_name || '',
        lang: lang,
        title: title,
        channels: num(s.channels),
        default: !!(s.disposition && s.disposition.default)
      });
      ai++;
    });
    if (info.audio.length && !info.acodec) info.acodec = info.audio[0].codec;
    /* subtitle tracks */
    let si = 0;
    (extra && extra.streams || []).forEach(function (s) {
      if (s.codec_type !== 'subtitle') return;
      const tags = s.tags || {};
      const lang = (tags.language || tags.LANGUAGE || '').toString();
      const title = (tags.title || tags.TITLE || '').toString();
      const bits = [];
      if (lang && lang !== 'und') bits.push(lang.toUpperCase());
      if (title) bits.push(title);
      bits.push((s.codec_name || 'sub').toUpperCase());
      info.subs.push({
        id: 's:' + s.index,
        index: s.index,
        order: si,
        label: bits.join(' · '),
        kind: 'embedded',
        lang: lang
      });
      si++;
    });
    return info;
  }

  function probeViaFfprobe(file) {
    return new Promise(function (resolve) {
      const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file];
      let child;
      try { child = spawn(ffprobePath, args, { windowsHide: true }); }
      catch (e) { resolve(null); return; }
      const out = [], err = [];
      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      child.on('error', () => resolve(null));
      child.on('close', function () {
        try {
          const json = JSON.parse(Buffer.concat(out).toString('utf8'));
          resolve(infoFromStreams(json.streams, json.format, json));
        } catch (e) { resolve(null); }
      });
    });
  }

  function probeViaFfmpeg(file) {
    return run(['-hide_banner', '-i', file, '-f', 'null', '-']).then(function (r) {
      const txt = r.stderr || '';
      const info = {
        duration: 0, format: '', bitrate: 0, title: '', video: null, audio: [], subs: [],
        hdr: false, vcodec: '', acodec: '', profile: '', pixfmt: '', fps: 0, rfps: 0,
        width: 0, height: 0, ar: ''
      };
      const dm = txt.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (dm) info.duration = (+dm[1]) * 3600 + (+dm[2]) * 60 + parseFloat(dm[3]);
      const bm = txt.match(/bitrate:\s*(\d+)\s*kb\/s/);
      if (bm) info.bitrate = (+bm[1]) * 1000;
      const vm = txt.match(/Video:\s*([a-z0-9_]+)([^,]*),\s*([a-z0-9]+)[^,]*,\s*(\d+)x(\d+)/i);
      if (vm) {
        info.vcodec = vm[1].toLowerCase();
        info.profile = (vm[2] || '').trim().replace(/^\(|\)$/g, '');
        info.pixfmt = vm[3];
        info.width = +vm[4]; info.height = +vm[5];
        info.ar = util.aspectLabel(info.width, info.height);
      }
      const fm = txt.match(/,\s*([\d.]+)\s*fps/);
      if (fm) { info.fps = parseFloat(fm[1]); info.rfps = info.fps; }
      const lines = txt.split('\n');
      lines.forEach(function (line) {
        const am = line.match(/Stream #\d+:\d+(?:\((\w+)\))?: Audio:\s*([a-z0-9_]+)(.*)/i);
        if (am) {
          const ch = (am[3].match(/(mono|stereo|5\.1|7\.1|\d+ channels)/i) || [])[1] || '';
          const label = [am[1] ? am[1].toUpperCase() : '', (am[2] || '').toUpperCase(), ch]
            .filter(Boolean).join(' · ');
          info.audio.push({ id: 'a:' + info.audio.length, index: -1, order: info.audio.length,
            label: label, codec: (am[2] || '').toLowerCase(), lang: am[1] || '', channels: 0, default: info.audio.length === 0 });
          if (!info.acodec) info.acodec = (am[2] || '').toLowerCase();
        }
        const sm = line.match(/Stream #\d+:\d+(?:\((\w+)\))?: Subtitle:\s*([a-z0-9_]+)/i);
        if (sm) {
          info.subs.push({ id: 's:' + (-1), index: -1, order: info.subs.length,
            label: [(sm[1] || '').toUpperCase(), (sm[2] || '').toUpperCase()].filter(Boolean).join(' · '),
            kind: 'embedded', lang: sm[1] || '' });
        }
      });
      info.format = (txt.match(/Input #0,\s*([^,]+)/) || [])[1] || '';
      return info;
    });
  }

  /* cached probe — the file's size + mtime form the cache key */
  function probe(file) {
    return new Promise(function (resolve) {
      if (!util.isFile(file)) { resolve(null); return; }
      let key = '';
      try { const st = fs.statSync(file); key = st.size + ':' + st.mtimeMs; } catch (e) { }
      const hit = probeCache.get(file);
      if (hit && hit.key === key) { resolve(hit.info); return; }
      const p = ffprobePath ? probeViaFfprobe(file) : probeViaFfmpeg(file);
      p.then(function (info) {
        if (!info) { resolve(null); return; }
        if (!canProbe() && info && info.audio && info.audio.length && info.audio[0].index < 0) {
          /* fallback parser only knows the order, not the stream index */
          info.degraded = true;
        }
        if (probeCache.has(file)) probeCache.delete(file);
        probeCache.set(file, { key: key, info: info });
        while (probeCache.size > PROBE_CACHE_MAX) {
          probeCache.delete(probeCache.keys().next().value);
        }
        resolve(info);
      });
    });
  }

  /* ffprobe over http(s): same shape as probe(), for streams the user opened
     with "Open URL / stream…". Embedded subtitle tracks come back with their
     absolute stream index ("s:<index>"), which is what -map 0:<index> needs. */
  function probeUrl(url) {
    return new Promise(function (resolve) {
      const bin = ffprobePath || ffmpegPath;
      if (!bin || !/^https?:/i.test(String(url || ''))) { resolve(null); return; }
      const args = ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
        '-user_agent', 'Lumen/1.0', '-rw_timeout', '20000000', url];
      let child;
      try { child = spawn(bin, args, { windowsHide: true }); }
      catch (e) { resolve(null); return; }
      const out = [];
      let done = false;
      const guard = setTimeout(function () {
        if (done) return;
        done = true;
        try { child.kill('SIGKILL'); } catch (e) { }
        resolve(null);
      }, 45000);
      child.stdout.on('data', (d) => out.push(d));
      child.on('error', function () { if (!done) { done = true; clearTimeout(guard); resolve(null); } });
      child.on('close', function () {
        if (done) return;
        done = true;
        clearTimeout(guard);
        try {
          const json = JSON.parse(Buffer.concat(out).toString('utf8'));
          resolve(infoFromStreams(json.streams, json.format, json));
        } catch (e) { resolve(null); }
      });
    });
  }

  function probeSync(file) {
    if (!ffprobePath) return null;
    try {
      const r = spawnSync(ffprobePath, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', file],
        { windowsHide: true, timeout: 20000, maxBuffer: 8 * 1024 * 1024 });
      const json = JSON.parse(String(r.stdout || '{}'));
      return infoFromStreams(json.streams, json.format, json);
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------- thumbnail */
  function thumbnail(file, at, width) {
    if (!ffmpegPath) return Promise.resolve(null);
    const w = Math.max(120, Math.min(1024, width || 320));
    const t = Math.max(0, Number(at) || 0);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
    if (t > 0) args.push('-ss', t.toFixed(2));
    args.push('-i', file, '-frames:v', '1', '-vf', 'scale=' + w + ':-2', '-f', 'image2pipe',
      '-vcodec', 'mjpeg', 'pipe:1');
    return run(args, { timeout: 30000 }).then(function (r) {
      return (r.code === 0 && r.stdoutRaw && r.stdoutRaw.length > 100) ? r.stdoutRaw : null;
    });
  }

  /* ------------------------------------------------------------ sidecars */
  /* ---------------------------------------------------- subtitle sidecars ----
     Names vary by release group and language, so matching uses normalized
     Unicode tokens (including Persian/Arabic digits), exact/prefix matches,
     season/episode signatures, and title-token overlap. Explicitly conflicting
     episode numbers are rejected. If the parent contains exactly one media
     file, its sidecars may have unrelated names and folders can be cluttered;
     common Subs/Subtitles folders are also scanned, with a bounded search. */
  function normalizeSidecarText(value) {
    return String(value || '').normalize('NFKD')
      .replace(/[٠-٩۰-۹]/g, function (d) {
        const digits = '٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹';
        const ascii = '01234567890123456789';
        return ascii[digits.indexOf(d)] || d;
      })
      .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک')
      .replace(/[\u200c\u200d]/g, ' ')
      .replace(/\p{M}/gu, '')
      .toLowerCase();
  }

  const SIDE_NOISE = new Set([
    '2160p', '1440p', '1080p', '720p', '576p', '480p', '4k', '8k',
    'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'hdr', 'hdr10', 'dv',
    'bluray', 'brrip', 'webrip', 'webdl', 'web', 'hdtv', 'proper', 'repack',
    'aac', 'ac3', 'eac3', 'dts', 'truehd', 'atmos', '10bit', '8bit'
  ]);

  function normTokens(name) {
    const stem = util.stripExt(String(name || ''));
    return normalizeSidecarText(stem)
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim().split(/\s+/)
      .filter(function (w) {
        return w.length > 1 && !SIDE_NOISE.has(w) &&
          !/^(?:s\d+e\d+|\d+x\d+)$/.test(w) &&
          !/^(the|and|of|a|an|to|at|for|by|with)$/.test(w);
      });
  }

  function episodeKey(name) {
    const t = normalizeSidecarText(util.stripExt(String(name || '')))
      .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
    let m = /s\s*(\d{1,2})\s*e\s*(\d{1,3})/u.exec(t) || /(\d{1,2})\s*x\s*(\d{1,3})/u.exec(t);
    if (m) return 's' + String(m[1]).padStart(2, '0') + 'e' + String(m[2]).padStart(2, '0');
    m = /(?:^|\s)(?:ep|e|episode|قسمت)\s*(\d{1,3})(?![0-9])/u.exec(t);
    if (m) return 'e' + String(m[1]).padStart(3, '0');
    m = /\s(\d{1,3})\s*$/.exec(t);
    if (m) return 'n' + String(m[1]).padStart(3, '0');
    return '';
  }

  function overlap(a, b) {
    if (!a.length || !b.length) return 0;
    const setB = new Set(b);
    let hit = 0;
    a.forEach(function (w) { if (setB.has(w)) hit++; });
    return hit / Math.min(a.length, b.length);
  }

  function isSubtitleFolder(name) {
    const words = normalizeSidecarText(name).replace(/[^\p{L}\p{N}]+/gu, ' ').split(/\s+/);
    return words.some(function (w) { return /^(sub|subs|subtitle|subtitles|caption|captions)$/.test(w); });
  }

  function looksLikeSubtitleText(file) {
    try {
      const text = fs.readFileSync(file, 'utf8').slice(0, 128 * 1024);
      return /(?:^|\n)\s*WEBVTT\b/i.test(text) ||
        /(?:^|\n)\s*\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(text) ||
        /(?:^|\n)\s*\{\d+\}\{\d+\}/.test(text) ||
        /(?:^|\n)\s*\[\d{1,2}:\d{2}(?:[.,]\d{1,3})?\]/.test(text);
    } catch (e) { return false; }
  }

  function sidecars(file) {
    const out = [];
    if (!file || !util.isFile(file) || !util.isMediaExt(util.extName(file))) return out;
    const mediaPath = path.resolve(file);
    const dir = path.dirname(mediaPath);
    const vName = util.baseName(mediaPath);
    const vTok = normTokens(vName);
    const vKey = vTok.join(' ');
    const vEp = episodeKey(vName);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }

    const mediaCount = entries.reduce(function (n, ent) {
      return n + (ent.isFile() && util.isMediaExt(util.extName(ent.name)) ? 1 : 0);
    }, 0);
    const candidates = [];
    const seen = new Set();
    let visited = 0;
    function scanFolder(folder, depth, dedicated) {
      if (++visited > 160) return;
      let list = [];
      try { list = fs.readdirSync(folder, { withFileTypes: true }); } catch (e) { return; }
      list.forEach(function (ent) {
        if (candidates.length >= 256) return;
        const full = path.join(folder, ent.name);
        if (ent.isFile() && util.isSubExt(util.extName(ent.name))) {
          let key = path.resolve(full);
          if (process.platform === 'win32') key = key.toLowerCase();
          if (!seen.has(key)) {
            seen.add(key);
            candidates.push({ path: full, name: ent.name, ext: util.extName(ent.name), inSubDir: dedicated });
          }
          return;
        }
        if (ent.isDirectory() && dedicated && depth < 2) scanFolder(full, depth + 1, true);
      });
    }

    scanFolder(dir, 0, false);
    entries.forEach(function (ent) {
      if (ent.isDirectory() && isSubtitleFolder(ent.name)) scanFolder(path.join(dir, ent.name), 1, true);
    });

    candidates.forEach(function (candidate) {
      const e = candidate.ext;
      const sTok = normTokens(candidate.name);
      const sKey = sTok.join(' ');
      const sEp = episodeKey(candidate.name);
      const exact = !!vKey && (sKey === vKey || sKey.indexOf(vKey + ' ') === 0);
      const nameScore = overlap(vTok, sTok);
      const epConflict = !!(vEp && sEp && vEp !== sEp);
      /* Episode numbers alone are not unique across shows. In a busy folder,
         require at least one shared title token; a single-media folder remains
         a safe fallback for subtitles named only by language/episode. Never
         attach a subtitle explicitly numbered for a different episode. */
      const epMatch = !!(vEp && sEp && vEp === sEp && (nameScore > 0 || mediaCount === 1));
      const prefix = !!(vTok.length && vTok.length <= sTok.length && vTok.every(function (w, i) { return sTok[i] === w; }));
      const nameMatch = !epConflict && (exact || prefix || epMatch || nameScore >= 0.55);
      /* A lone media item gives differently named sidecars a safe context,
         regardless of clutter such as posters, metadata, or extra files. */
      const uniqueMedia = mediaCount === 1;
      const contentMatch = e !== 'txt' || nameMatch || looksLikeSubtitleText(candidate.path);
      if (epConflict || !contentMatch || !(nameMatch || uniqueMedia)) return;

      let score = exact ? 100 : (epMatch ? 92 : (prefix ? 86 : (nameScore ? 55 + nameScore * 25 : 20)));
      if (candidate.inSubDir && uniqueMedia && !nameMatch) score = 15;
      const label = e.toUpperCase() + ' · ' + candidate.name + (nameMatch ? '' : '   (same folder)');
      out.push({ path: candidate.path, label: label, score: score });
    });

    out.sort(function (a, b) {
      if (b.score !== a.score) return b.score - a.score;
      return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });
    });
    return out.slice(0, 12).map(function (x) {
      return { path: x.path, label: x.label + (x.score < 100 && !/\((?:same folder|name match)\)$/.test(x.label) ? '   (name match)' : '') };
    });
  }

  /* ------------------------------------------------- srt/ass → webvtt ---- */
  function srtToVtt(text) {
    let t = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    t = t.replace(/(\d{1,3}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
    if (!/^WEBVTT/.test(t)) t = 'WEBVTT\n\n' + t;
    return t;
  }

  function extractSubtitle(file, selector, opts) {
    opts = opts || {};
    /* sidecar file */
    if (typeof selector === 'string' && selector.indexOf('ext:') === 0) {
      const p = selector.slice(4);
      if (!util.isFile(p) || !util.isSubExt(util.extName(p))) return Promise.resolve(null);
      const e = util.extName(p);
      if (e === 'vtt') {
        return Promise.resolve(fs.readFileSync(p, 'utf8'));
      }
      if (e === 'srt' || e === 'txt' || e === 'sub') {
        if (e === 'sub' && /\[\d+\]\[/.test(fs.readFileSync(p, 'utf8').slice(0, 400))) {
          /* MicroDVD — ffmpeg understands it */
          return ffmpegSubtitle(p, null);
        }
        return Promise.resolve(srtToVtt(fs.readFileSync(p, 'utf8')));
      }
      return ffmpegSubtitle(p, null);
    }
    /* embedded stream: selector is "s:<streamIndex>" */
    const idx = typeof selector === 'string' ? parseInt(selector.replace(/^s:/, ''), 10) : parseInt(selector, 10);
    if (!isFinite(idx) || idx < 0) return Promise.resolve(null);
    return ffmpegSubtitle(file, idx);
  }

  function ffmpegSubtitle(file, streamIndex) {
    if (!ffmpegPath) return Promise.resolve(null);
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-i', file];
    args.push('-map', '0:' + streamIndex);
    args.push('-f', 'webvtt', 'pipe:1');
    return run(args, { timeout: 90000 }).then(function (r) {
      if (r.code !== 0 || !r.stdout) return null;
      return srtToVtt(r.stdout);
    });
  }

  /* ------------------------------------------------------- transcode plan */
  function plan(info, audioIdx) {
    const v = info && info.video;
    const vcodec = (v && v.codec_name) || (info && info.vcodec) || '';
    const list = (info && info.audio) || [];
    let requested = (audioIdx === null || audioIdx === undefined || audioIdx === '' || !isFinite(Number(audioIdx)))
      ? list.findIndex(function (a) { return !!a.default; }) : Math.trunc(Number(audioIdx));
    if (requested < 0) requested = 0;
    const want = Math.max(0, Math.min(Math.max(0, list.length - 1), requested));
    const audio = list.length ? list[want] : null;
    const acodec = (audio && audio.codec) || (info && info.acodec) || '';
    const profile = String((v && v.profile) || (info && info.profile) || '');
    const pixfmt = String((v && v.pix_fmt) || (info && info.pixfmt) || '');
    const highBitDepth = /\b(?:10|12|14|16)\b/.test(profile) ||
      /(?:p0?(?:10|12|14|16)|(?:10|12|14|16)(?:le|be)|yuv(?:420|422|444)p\d{2})/i.test(pixfmt);
    const vSafe = SAFE_VIDEO.indexOf(String(vcodec).toLowerCase()) >= 0 && !highBitDepth;
    const aSafe = !!audio && SAFE_AUDIO.indexOf(String(acodec).toLowerCase()) >= 0;
    /* stream selector: ffprobe gives the absolute index, the fallback parser
       only knows the order inside the audio streams */
    let audioSel = null;
    if (audio) audioSel = audio.index >= 0 ? ('0:' + audio.index + '?') : ('0:a:' + audio.order + '?');
    else if (list.length) audioSel = '0:a:0?';
    return {
      hasVideo: !!v,
      videoCopy: !!v && vSafe,
      needEncode: !!v && !vSafe,
      codec: vcodec,
      highBitDepth: highBitDepth,
      audioCopy: aSafe,
      vcodec: vcodec,
      acodec: acodec,
      hdr: !!(info && info.hdr),
      audioIndex: audio ? audio.index : -1,
      audioOrder: audio ? audio.order : -1,
      audioSel: audioSel
    };
  }

  function h264Level(info) {
    const v = (info && info.video) || {};
    const w = num(v.width || (info && info.width));
    const h = num(v.height || (info && info.height));
    const fps = num(info && (info.rfps || info.fps)) || 30;
    const pixels = w * h * fps;
    if (w >= 7680 || h >= 4320 || pixels > 900000000) return '6.1';
    if (w > 4096 || h > 2160 || pixels > 500000000) return '5.2';
    if (w > 2048 || h > 1080) return '5.1';
    if (fps > 30 && (w > 1280 || h > 720)) return '4.2';
    return '4.1';
  }

  function transcodeArgs(file, info, at, audioIdx, opts) {
    opts = opts || {};
    const p = plan(info, audioIdx);
    if (opts.forceEncode && p.hasVideo) { p.videoCopy = false; p.forced = true; }
    at = Math.max(0, Number(at) || 0);
    const seek = at > 0.05;
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error'];
    const remote = /^https?:/i.test(String(file || ''));
    if (remote) args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-user_agent', 'Lumen/1.0', '-rw_timeout', '20000000');
    /* Seeking rules that keep a fragmented-mp4 pipe honest: a re-encode seeks
       on the input side, while stream-copy seeks on the output side. */
    if (seek && !p.videoCopy) args.push('-ss', at.toFixed(3));
    args.push('-i', file);
    if (seek && p.videoCopy) args.push('-ss', at.toFixed(3));
    if (p.hasVideo) args.push('-map', '0:v:0?');
    if (p.audioSel) args.push('-map', p.audioSel);
    args.push('-sn', '-dn', '-map_metadata', '-1', '-map_chapters', '-1');
    if (p.hasVideo) {
      if (p.videoCopy) args.push('-c:v', 'copy');
      else {
        args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p');
        if (!p.hdr) args.push('-profile:v', 'high', '-level:v', h264Level(info));
        /* 10-bit HEVC and friends carry a depth Chromium will not show either */
        args.push('-x264-params', 'log-level=none');
        if (p.hdr && opts.toneMap !== false && hasFilter('zscale') && hasFilter('tonemap')) {
          args.push('-vf', 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,' +
            'tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p');
        }
      }
    }
    if (p.audioSel) {
      args.push('-c:a', p.audioCopy ? 'copy' : 'aac');
      if (!p.audioCopy) {
        const channels = (info && info.audio && info.audio[p.audioOrder]) ? Number(info.audio[p.audioOrder].channels) || 2 : 2;
        args.push('-b:a', channels > 2 ? '384k' : '192k');
      }
    } else {
      args.push('-an');
    }
    args.push('-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');
    return { args: args, plan: p };
  }

  function spawnStream(args) {
    return spawn(ffmpegPath, args, { windowsHide: true });
  }

  return {
    get path() { return ffmpegPath; },
    get probePath() { return ffprobePath; },
    searchDirs: function () { return dirs.slice(0); },
    available, canProbe, describe, hasFilter, rescan, version,
    probe, probeSync, probeUrl, thumbnail, sidecars, extractSubtitle, srtToVtt,
    plan, transcodeArgs, spawnStream, run
  };
}

module.exports = { createFfmpeg, SAFE_VIDEO, SAFE_AUDIO };
