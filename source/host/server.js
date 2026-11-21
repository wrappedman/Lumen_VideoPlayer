'use strict';
/* ==========================================================================
   Lumen — host/server.js
   The tiny local media server the player talks to (bound to 127.0.0.1).

     GET /                     the web core (index.html + assets)
     GET /media?t=<token>&t0=  the file itself, with HTTP range support
     GET /transcode?t=&t0=&a=  live remux / transcode through ffmpeg
     GET /thumb?t=&at=         one frame, cheap enough for the playlist
     GET /subtitle?t=&id=      WebVTT (sidecar file or embedded track)

   Every media route needs the session token that the host handed out, so a
   random page in a browser cannot pull files from the machine.
   ========================================================================== */
const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const util = require('./util');

function createServer(opts) {
  opts = opts || {};
  const webDir = opts.webDir;
  const ff = opts.ff || null;
  const log = opts.log || function () { };
  const registry = new Map();          /* token -> { path } | { url } */
  const children = new Set();          /* live ffmpeg pipes, killed on close */
  const thumbDir = path.join(os.tmpdir(), 'lumen-thumbs');
  const subCacheDir = path.join(os.tmpdir(), 'lumen-subs');

  function registerPath(p, name) {
    const entry = { path: p, name: name || util.baseName(p) };
    const token = crypto.randomBytes(16).toString('hex');
    registry.set(token, entry);
    return token;
  }
  function registerUrl(url, name) {
    const entry = { url: url, name: name || util.baseName(url) };
    const token = crypto.randomBytes(16).toString('hex');
    registry.set(token, entry);
    return token;
  }
  function lookup(token) {
    return token ? registry.get(String(token)) || null : null;
  }

  /* ------------------------------------------------------------- helpers */
  function send(res, code, body, type) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8');
    res.writeHead(code, {
      'Content-Type': type || 'text/plain; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  }

  function safeStatic(rel) {
    let clean;
    try { clean = decodeURIComponent(String(rel || '').split('?')[0]); } catch (e) { return null; }
    clean = clean.replace(/\\/g, '/');
    const root = path.resolve(webDir);
    const target = path.resolve(root, '.' + (clean.charAt(0) === '/' ? clean : '/' + clean));
    /* path.relative() is the only reliable containment test: a plain
       startsWith() also accepts a sibling folder such as web-old/ */
    const leaf = path.relative(root, target);
    if (!leaf || leaf.startsWith('..') || path.isAbsolute(leaf)) return null;
    return target;
  }

  function serveStatic(req, res, file) {
    let fst;
    try {
      if (fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      fst = fs.statSync(file);
    } catch (e) { send(res, 404, 'Not found'); return; }
    /* ETag + 304: a relaunch (or Ctrl+R in dev) revalidates instead of
       re-sending the ~250 kB of CSS/JS and the artwork on every load */
    const etag = 'W/"' + fst.size.toString(16) + '-' + Math.floor(fst.mtimeMs).toString(16) + '"';
    const mime = util.mimeFor(file);
    const head = {
      'Content-Type': mime,
      'Content-Length': fst.size,
      'Cache-Control': 'no-cache',
      'ETag': etag
    };
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }
    if (req.method === 'HEAD') { res.writeHead(200, head); res.end(); return; }
    res.writeHead(200, head);
    const stream = fs.createReadStream(file);
    stream.on('error', function () { try { res.destroy(); } catch (e) { } });
    stream.pipe(res);
  }

  /* byte-range file streaming (what <video> needs for seeking) */
  /* ------------------------------------------------ online / stream subtitles
     Two kinds of remote subtitles exist and both end up here as WebVTT:
       netfile:<url>    a .srt/.vtt sitting next to the stream
       netstream:<idx>  a subtitle stream inside the remote container
                        (muxed in the file or offered by an HLS playlist) */
  function subCacheFile(key, ext) {
    try { fs.mkdirSync(subCacheDir, { recursive: true }); } catch (e) { }
    return path.join(subCacheDir, crypto.createHash('sha1').update(String(key)).digest('hex') + (ext || '.vtt'));
  }

  function serveVtt(res, text) {
    const buf = Buffer.from(String(text), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/vtt; charset=utf-8',
      'Content-Length': buf.length,
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  }

  function serveVttFile(res, file) {
    let buf;
    try { buf = fs.readFileSync(file); } catch (e) { return false; }
    if (!buf.length) return false;
    res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
    return true;
  }

  function toVtt(text, name) {
    let t = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (/^WEBVTT/.test(t)) return t;
    if (/^\[Script Info\]/i.test(t) || /\nDialogue:\s*/.test(t)) {
      /* ass/ssa → keep the dialogue lines, drop the style tags */
      const out = ['WEBVTT', ''];
      t.split('\n').forEach(function (line) {
        const m = /^Dialogue:\s*([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),([^,]*),(.*)$/.exec(line);
        if (!m) return;
        const conv = function (v) {
          const p = String(v).trim().split(':');
          const sec = parseFloat(String(p[p.length - 1]).replace(',', '.')) || 0;
          const min = p.length > 2 ? parseInt(p[p.length - 2], 10) || 0 : 0;
          const hr = p.length > 3 ? parseInt(p[p.length - 3], 10) || 0 : 0;
          const s2 = hr * 3600 + min * 60 + sec;
          const hh = String(Math.floor(s2 / 3600)).padStart(2, '0');
          const mm = String(Math.floor((s2 % 3600) / 60)).padStart(2, '0');
          const ss = String(Math.floor(s2 % 60)).padStart(2, '0');
          const ms = String(Math.round((s2 % 1) * 1000)).padStart(3, '0');
          return hh + ':' + mm + ':' + ss + '.' + ms;
        };
        const body = String(m[10] || '').replace(/\{[^}]*\}/g, '').replace(/\\N|\\n/g, '\n').trim();
        if (!body) return;
        out.push(conv(m[1]) + ' --> ' + conv(m[2]));
        out.push(body, '');
      });
      return out.join('\n');
    }
    t = t.replace(/(\d{1,3}:\d{2}:\d{2}),(\d{1,3})/g, '$1.$2');
    /* SRT blocks may use a "1" index line — WebVTT is happy with it as long as
       it is not interpreted as a cue id, so strip the lone numbers */
    t = t.replace(/^\d+\s*$/gm, '');
    if (!/^WEBVTT/.test(t)) t = 'WEBVTT\n\n' + t;
    return t;
  }

  function fetchRemote(url, depth) {
    depth = depth || 0;
    return new Promise(function (resolve, reject) {
      if (depth > 4) { reject(new Error('too many redirects')); return; }
      let target;
      try { target = new URL(url); } catch (e) { reject(new Error('bad url')); return; }
      if (!/^https?:$/.test(target.protocol)) { reject(new Error('only http(s)')); return; }
      const lib = target.protocol === 'https:' ? https : http;
      const req = lib.get(target, {
        headers: { 'User-Agent': 'Lumen/1.0', 'Accept': '*/*', 'Accept-Encoding': 'identity' }
      }, function (upRes) {
        const code = upRes.statusCode || 0;
        if (code >= 300 && code < 400 && upRes.headers.location) {
          upRes.resume();
          fetchRemote(new URL(upRes.headers.location, target).toString(), depth + 1).then(resolve).catch(reject);
          return;
        }
        if (code !== 200) { upRes.resume(); reject(new Error('HTTP ' + code)); return; }
        const cap = 12 * 1024 * 1024;
        const chunks = [];
        let size = 0;
        upRes.on('data', function (d) {
          size += d.length;
          if (size > cap) { try { req.destroy(); } catch (e) { } reject(new Error('subtitle file is too big')); return; }
          chunks.push(d);
        });
        upRes.on('end', function () { resolve({ text: Buffer.concat(chunks).toString('utf8'), type: upRes.headers['content-type'] || '' }); });
        upRes.on('error', reject);
      });
      req.setTimeout(25000, function () { try { req.destroy(); } catch (e) { } reject(new Error('timed out')); });
      req.on('error', reject);
    });
  }

  function remoteSidecar(res, url) {
    const cached = subCacheFile('t:' + url, '.vtt');
    if (util.isFile(cached) && serveVttFile(res, cached)) return;
    log('[lumen] fetching online subtitle ' + url);
    fetchRemote(url).then(function (r) {
      const vtt = toVtt(r.text, util.baseName(url.split('?')[0]));
      if (!/-->/.test(vtt)) { send(res, 415, 'that link is not a subtitle file'); return; }
      try { fs.writeFileSync(cached, vtt, 'utf8'); } catch (e) { }
      serveVtt(res, vtt);
    }).catch(function (e) { send(res, 502, 'could not fetch that subtitle: ' + (e && e.message)); });
  }

  function remoteStreamSub(res, mediaUrl, idx) {
    if (!mediaUrl || !/^https?:/i.test(mediaUrl) || !isFinite(idx) || idx < 0) {
      send(res, 400, 'this stream has no readable subtitle track');
      return;
    }
    const cached = subCacheFile('e:' + mediaUrl + '#' + idx, '.vtt');
    if (util.isFile(cached) && serveVttFile(res, cached)) return;

    let child;
    const args = ['-hide_banner', '-nostdin', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', mediaUrl, '-map', '0:' + idx, '-c:s', 'webvtt', '-f', 'webvtt', 'pipe:1'];
    try { child = ff.spawnStream(args); }
    catch (e) { send(res, 500, 'ffmpeg could not start'); return; }
    children.add(child);
    let started = false, closed = false, sink = null;
    const guard = setTimeout(function () {
      if (started || closed) return;
      try { child.kill('SIGKILL'); } catch (e) { }
      send(res, 504, 'this subtitle track did not start — the stream may use image-based subtitles');
    }, 40000);

    child.stdout.once('data', function (first) {
      if (closed) return;
      started = true;
      clearTimeout(guard);
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8', 'Cache-Control': 'no-store' });
      try { res.write(first); } catch (e) { }
      try { sink = fs.createWriteStream(cached); sink.write(first); } catch (e) { sink = null; }
      child.stdout.on('data', function (d) { if (sink) { try { sink.write(d); } catch (e) { } } });
      child.stdout.pipe(res);
    });
    child.stderr.on('data', function (d) { const t = String(d).trim(); if (t) log('[ffmpeg] ' + t); });
    child.on('error', function (e) {
      clearTimeout(guard);
      if (!started) send(res, 500, 'ffmpeg error: ' + e.message); else try { res.destroy(); } catch (er) { }
    });
    child.on('close', function () {
      closed = true;
      clearTimeout(guard);
      children.delete(child);
      if (sink && started) { try { sink.end(); } catch (e) { } }
      try { res.end(); } catch (e) { }
      if (!started) send(res, 415, 'this stream has no text subtitle track (image-based subtitles cannot be converted)');
    });
    res.on('close', function () { if (!res.writableFinished) { try { child.kill('SIGKILL'); } catch (e) { } } });
  }

  function serveMedia(req, res, file) {
    let st;
    try { st = fs.statSync(file); } catch (e) { send(res, 404, 'File not found'); return; }
    if (!st.isFile()) { send(res, 404, 'Not a file'); return; }

    const total = st.size;
    const range = req.headers.range;
    const mime = util.mimeFor(file);
    const head = {
      'Accept-Ranges': 'bytes',
      'Content-Type': mime,
      'Cache-Control': 'no-store'
    };

    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] ? parseInt(m[1], 10) : 0;
        let end = m[2] ? parseInt(m[2], 10) : total - 1;
        if (!m[1] && m[2]) { start = Math.max(0, total - parseInt(m[2], 10)); end = total - 1; }
        if (isNaN(start) || isNaN(end) || start > end || start >= total) {
          res.writeHead(416, { 'Content-Range': 'bytes */' + total });
          res.end();
          return;
        }
        end = Math.min(end, total - 1);
        res.writeHead(206, Object.assign({}, head, {
          'Content-Range': 'bytes ' + start + '-' + end + '/' + total,
          'Content-Length': end - start + 1
        }));
        if (req.method === 'HEAD') { res.end(); return; }
        const stream = fs.createReadStream(file, { start, end });
        stream.on('error', function () { try { res.destroy(); } catch (e) { } });
        stream.pipe(res);
        return;
      }
    }
    res.writeHead(200, Object.assign({}, head, { 'Content-Length': total }));
    if (req.method === 'HEAD') { res.end(); return; }
    const stream = fs.createReadStream(file);
    stream.on('error', function () { try { res.destroy(); } catch (e) { } });
    stream.pipe(res);
  }

  /* remote http(s) source: pass through, keep the range header */
  function proxyUrl(req, res, url) {
    let target;
    try { target = new URL(url); } catch (e) { send(res, 400, 'Bad url'); return; }
    const lib = target.protocol === 'https:' ? https : http;
    const headers = {};
    if (req.headers.range) headers.Range = req.headers.range;
    const up = lib.get(target, { headers: headers }, function (upRes) {
      const h = Object.assign({}, upRes.headers);
      delete h['content-encoding'];
      res.writeHead(upRes.statusCode || 502, h);
      upRes.pipe(res);
    });
    up.on('error', function (e) { send(res, 502, 'Upstream error: ' + e.message); });
    req.on('close', function () { try { up.destroy(); } catch (e) { } });
  }

  function spawnPipe(args, req, res, contentType) {
    let child;
    try { child = ff.spawnStream(args); }
    catch (e) { send(res, 500, 'ffmpeg could not start'); return; }
    children.add(child);
    let started = false, done = false;
    const kill = function () {
      if (done) return;
      try { child.kill('SIGKILL'); } catch (e) { }
      children.delete(child);
    };
    /* nothing may leave the pipe: stop a stuck ffmpeg instead of hanging */
    const guard = setTimeout(function () {
      if (!started) {
        kill();
        try { send(res, 504, 'ffmpeg did not produce any data'); } catch (e) { }
      }
    }, 30000);

    child.on('error', function (e) {
      clearTimeout(guard);
      if (!started) send(res, 500, 'ffmpeg error: ' + e.message);
      else try { res.destroy(); } catch (er) { }
      kill();
    });
    child.stderr.on('data', function (d) {
      const t = String(d).trim();
      if (t) log('[ffmpeg] ' + t);
    });
    child.stdout.once('data', function (first) {
      clearTimeout(guard);
      /* first bytes arrived: commit the headers, then keep the chunk —
         attaching a 'data' listener consumes it, so it must be written here */
      if (!started && !res.headersSent) {
        started = true;
        res.writeHead(200, {
          'Content-Type': contentType || 'video/mp4',
          'Cache-Control': 'no-store'
        });
      }
      try { res.write(first); } catch (e) { }
      child.stdout.pipe(res);
    });
    child.on('close', function () {
      clearTimeout(guard);
      done = true;
      children.delete(child);
      try { res.end(); } catch (e) { }
    });
    /* the client went away (a *finished* response is not an abort) */
    res.on('close', function () { if (!res.writableFinished) kill(); });
  }

  /* ------------------------------------------------------------- routes */
  function handle(req, res) {
    let u;
    try { u = new URL(req.url, 'http://127.0.0.1'); }
    catch (e) { send(res, 400, 'Bad request'); return; }
    const p = u.pathname;
    const q = u.searchParams;

    if (p === '/media' || p === '/transcode' || p === '/thumb' || p === '/subtitle') {
      const entry = lookup(q.get('t'));
      if (!entry) { send(res, 403, 'Bad or expired token'); return; }
      if (p === '/media') {
        if (entry.url) proxyUrl(req, res, entry.url);
        else serveMedia(req, res, entry.path);
        return;
      }
      if (p === '/transcode') { transcode(req, res, entry, q); return; }
      if (p === '/thumb') { thumb(req, res, entry, q); return; }
      if (p === '/subtitle') { subtitle(req, res, entry, q); return; }
    }

    if (p === '/favicon.ico') {
      serveStatic(req, res, path.join(webDir, 'assets', 'lumen-mark.png'));
      return;
    }
    if (p === '/' || p === '') { serveStatic(req, res, path.join(webDir, 'index.html')); return; }
    const file = safeStatic(p);
    if (!file) { send(res, 403, 'Forbidden'); return; }
    serveStatic(req, res, file);
  }

  function transcode(req, res, entry, q) {
    if (!ff || !ff.available()) {
      send(res, 503, 'The bundled FFmpeg media engine is unavailable; reinstall Lumen or choose an optional custom build in Settings.');
      return;
    }
    const at = Math.max(0, parseFloat(q.get('t0')) || 0);
    const aRaw = q.get('a');
    const audioIdx = aRaw != null && aRaw !== '' ? parseInt(aRaw, 10) : null;

    if (entry.url) {
      if (!/^https?:/i.test(entry.url)) { send(res, 400, 'Only http(s) streams can be converted'); return; }
      /* probe remote files/playlists and use the exact same video/audio plan as
         local media: HEVC → H.264, unsupported audio → AAC, compatible tracks
         copied. If a server blocks probing, keep the old copy-only fallback. */
      ff.probeUrl(entry.url).then(function (info) {
        if (!info) {
          if (q.get('re') === '1') { send(res, 415, 'Could not inspect this online stream for H.264 conversion'); return; }
          const fallback = ['-hide_banner', '-nostdin', '-loglevel', 'error',
            '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
            '-user_agent', 'Lumen/1.0', '-rw_timeout', '20000000', '-i', entry.url,
            '-map', '0:v:0?', '-map', (audioIdx != null && isFinite(audioIdx)) ? ('0:a:' + audioIdx + '?') : '0:a:0?',
            '-c', 'copy', '-sn', '-dn', '-map_metadata', '-1',
            '-movflags', '+frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
          log('[lumen] transcode(url) probe unavailable; stream copy ' + entry.url);
          spawnPipe(fallback, req, res, 'video/mp4');
          return;
        }
        const built = ff.transcodeArgs(entry.url, info, at, audioIdx,
          { toneMap: q.get('tm') !== '0', forceEncode: q.get('re') === '1' });
        log('[lumen] transcode(url) ' + entry.url + ' video=' + (built.plan.videoCopy ? 'copy' : 'x264') +
          (built.plan.forced ? ' (forced re-encode)' : '') + ' codec=' + (built.plan.codec || '?') +
          ' audio=' + (built.plan.audioCopy ? 'copy' : (built.plan.audioSel ? 'aac' : 'none')));
        spawnPipe(built.args, req, res, 'video/mp4');
      }).catch(function (e) {
        send(res, 502, 'Could not inspect online media: ' + (e && e.message || 'probe failed'));
      });
      return;
    }

    ff.probe(entry.path).then(function (info) {
      if (!info) { send(res, 500, 'Could not read the media file (ffprobe failed)'); return; }
      const built = ff.transcodeArgs(entry.path, info, at, audioIdx,
        { toneMap: q.get('tm') !== '0', forceEncode: q.get('re') === '1' });
      log('[lumen] transcode ' + path.basename(entry.path) + ' at=' + at +
        (info.hdr ? ' hdr=' + (q.get('tm') === '0' ? 'passthrough' : 'tone-mapped') : '') +
        ' video=' + (built.plan.videoCopy ? 'copy' : 'x264') +
        (built.plan.forced ? ' (forced re-encode)' : '') +
        (built.plan.codec ? ' codec=' + built.plan.codec : '') +
        ' audio=' + (built.plan.audioCopy ? 'copy' : 'aac'));
      spawnPipe(built.args, req, res, 'video/mp4');
    }).catch(function (e) {
      send(res, 500, 'Probe failed: ' + (e && e.message));
    });
  }

  function thumb(req, res, entry, q) {
    if (!ff || !ff.available() || !entry.path) { send(res, 404, 'No thumbnail'); return; }
    const at = Math.max(0, parseFloat(q.get('at')) || 0);
    const width = Math.max(120, Math.min(640, parseInt(q.get('w'), 10) || 320));
    const key = crypto.createHash('sha1').update(entry.path + '|' + at.toFixed(1) + '|' + width).digest('hex');
    const cached = path.join(thumbDir, key + '.jpg');
    if (util.isFile(cached)) {
      try {
        const buf = fs.readFileSync(cached);
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'max-age=600' });
        res.end(buf);
        return;
      } catch (e) { /* regenerate */ }
    }
    ff.thumbnail(entry.path, at, width).then(function (buf) {
      if (!buf) { send(res, 404, 'No frame'); return; }
      try {
        fs.mkdirSync(thumbDir, { recursive: true });
        fs.writeFileSync(cached, buf);
      } catch (e) { }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': 'max-age=600' });
      res.end(buf);
    }).catch(function () { send(res, 500, 'Thumbnail failed'); });
  }

  function subtitle(req, res, entry, q) {
    const id = String(q.get('id') || '');
    /* a subtitle that lives online next to the stream */
    if (id.indexOf('netfile:') === 0) { remoteSidecar(res, id.slice(8)); return; }
    /* a subtitle stream inside a remote container / playlist */
    if (id.indexOf('netstream:') === 0) {
      if (!ff || !ff.available()) { send(res, 503, 'ffmpeg is required for the tracks inside a stream'); return; }
      remoteStreamSub(res, entry && entry.url ? entry.url : '', parseInt(id.slice(10), 10));
      return;
    }
    /* a sidecar file next to the local file: plain text work, no ffmpeg needed */
    if (id.indexOf('ext:') === 0) {
      if (!ff) { send(res, 503, 'the host is not ready'); return; }
      ff.extractSubtitle(entry && entry.path, id).then(function (txt) {
        if (txt == null) { send(res, 404, 'Subtitle track could not be read'); return; }
        serveVtt(res, txt);
      }).catch(function (e) { send(res, 500, 'Subtitle error: ' + (e && e.message)); });
      return;
    }
    /* embedded in a local file */
    if (!ff || !ff.available()) { send(res, 503, 'ffmpeg is required for embedded subtitles'); return; }
    if (!entry || !entry.path) { send(res, 400, 'no local file for this track'); return; }
    ff.extractSubtitle(entry.path, id).then(function (txt) {
      if (txt == null) { send(res, 404, 'Subtitle track could not be read'); return; }
      serveVtt(res, txt);
    }).catch(function (e) { send(res, 500, 'Subtitle error: ' + (e && e.message)); });
  }

  const server = http.createServer(function (req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'Use GET'); return; }
      handle(req, res);
    } catch (e) {
      log('[lumen] server error: ' + (e && e.stack || e));
      try { send(res, 500, 'Internal error'); } catch (er) { }
    }
  });
  server.keepAliveTimeout = 30000;

  return {
    listen() {
      return new Promise(function (resolve, reject) {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', function () {
          const port = server.address().port;
          resolve({ port: port, origin: 'http://127.0.0.1:' + port });
        });
      });
    },
    registerPath, registerUrl, lookup,
    close() {
      children.forEach(function (c) { try { c.kill('SIGKILL'); } catch (e) { } });
      children.clear();
      try { server.close(); } catch (e) { }
    }
  };
}

module.exports = { createServer };
