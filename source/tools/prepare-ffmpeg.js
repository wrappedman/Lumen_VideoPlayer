'use strict';
/*
 * Downloads/verifies the exact FFmpeg package required by Windows builds.
 * This is a developer build-time helper only; the installed player never
 * downloads or installs FFmpeg at runtime.
 *
 *   node tools/prepare-ffmpeg.js --download
 *   node tools/prepare-ffmpeg.js --zip <existing-package.zip>
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');

const SOURCE_URL = 'https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-9.0.2-essentials_build.zip';
const SHA256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba';
const DEFAULT_ZIP = path.join(os.homedir(), '.cache', 'lumen-build', 'ffmpeg-9.0.2-essentials_build.zip');

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}
function hash(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(1024 * 1024);
  try {
    let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function verify(file) {
  if (!fs.existsSync(file)) throw new Error('File not found: ' + file);
  const got = hash(file);
  if (got !== SHA256) throw new Error('SHA-256 mismatch. Expected ' + SHA256 + ', got ' + got);
  console.log('[ffmpeg] verified pinned FFmpeg 9.0.2 package: ' + file);
  console.log('[ffmpeg] sha256 ' + got);
  return file;
}
function download(url, target, depth) {
  depth = depth || 0;
  if (depth > 6) return Promise.reject(new Error('too many redirects'));
  return new Promise(function (resolve, reject) {
    const req = https.get(url, { headers: { 'User-Agent': 'Lumen-build/1.0', 'Accept': 'application/zip' } }, function (res) {
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        download(next, target, depth + 1).then(resolve, reject);
        return;
      }
      if (code !== 200) { res.resume(); reject(new Error('HTTP ' + code + ' from ' + url)); return; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const tmp = target + '.part';
      const out = fs.createWriteStream(tmp);
      const total = Number(res.headers['content-length']) || 0;
      let bytes = 0, last = -1;
      res.on('data', function (chunk) {
        bytes += chunk.length;
        if (total) {
          const pct = Math.floor(bytes * 100 / total);
          if (pct !== last && (pct % 10 === 0 || pct === 100)) {
            console.log('[ffmpeg] download ' + pct + '% (' + bytes.toLocaleString() + '/' + total.toLocaleString() + ' bytes)');
            last = pct;
          }
        }
      });
      res.pipe(out);
      out.on('finish', function () {
        out.close(function () {
          try {
            try { fs.rmSync(target, { force: true }); } catch (e) { }
            fs.renameSync(tmp, target);
            verify(target);
            resolve(target);
          } catch (e) { try { fs.unlinkSync(tmp); } catch (x) { } reject(e); }
        });
      });
      out.on('error', function (e) { try { out.close(); } catch (x) { } try { fs.unlinkSync(tmp); } catch (x) { } reject(e); });
      res.on('error', function (e) { try { out.destroy(); } catch (x) { } try { fs.unlinkSync(tmp); } catch (x) { } reject(e); });
    });
    req.on('error', reject);
    req.setTimeout(120000, function () { req.destroy(new Error('download timed out')); });
  });
}

(async function main() {
  try {
    const supplied = arg('--zip');
    if (supplied) { verify(path.resolve(supplied)); return; }
    if (process.argv.indexOf('--download') >= 0) {
      const file = await download(SOURCE_URL, DEFAULT_ZIP, 0);
      console.log('[ffmpeg] ready for build: ' + file);
      return;
    }
    if (fs.existsSync(DEFAULT_ZIP)) { verify(DEFAULT_ZIP); return; }
    console.log('Build-time FFmpeg helper. The app ships with FFmpeg; this is not a runtime installer.');
    console.log('Download and verify the pinned Windows package with:');
    console.log('  node tools/prepare-ffmpeg.js --download');
    console.log('Or verify an existing package with --zip <file>.');
    process.exitCode = 2;
  } catch (e) {
    console.error('[ffmpeg] FAILED: ' + (e && e.message || e));
    process.exitCode = 1;
  }
})();
