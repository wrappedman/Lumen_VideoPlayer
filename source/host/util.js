'use strict';
/* ==========================================================================
   Lumen — host/util.js · small shared helpers for the desktop host
   ========================================================================== */
const path = require('path');
const fs = require('fs');
const { TextDecoder } = require('util');

const VIDEO_EXT = ['mp4', 'm4v', 'mkv', 'webm', 'avi', 'mov', 'mpg', 'mpeg', 'ts', 'm2ts',
  'wmv', 'flv', 'ogv', '3gp', 'mpd', 'm3u8', 'm3u', 'vob', 'divx', 'rmvb'];
const AUDIO_EXT = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'mka', 'aiff', 'ape'];
const SUB_EXT = ['srt', 'vtt', 'ass', 'ssa', 'sub', 'txt', 'ttml', 'dfxp'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t'
};

function baseName(p) {
  if (!p) return '';
  const s = String(p).replace(/\\/g, '/');
  return s.slice(s.lastIndexOf('/') + 1);
}

function extName(p) {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i < 0 ? '' : b.slice(i + 1).toLowerCase();
}

function stripExt(p) {
  const b = baseName(p);
  const i = b.lastIndexOf('.');
  return i < 0 ? b : b.slice(0, i);
}

function isVideoExt(e) { return VIDEO_EXT.indexOf(String(e || '').toLowerCase()) >= 0; }
function isAudioExt(e) { return AUDIO_EXT.indexOf(String(e || '').toLowerCase()) >= 0; }
function isSubExt(e) { return SUB_EXT.indexOf(String(e || '').toLowerCase()) >= 0; }
function isMediaExt(e) { return isVideoExt(e) || isAudioExt(e); }

function mimeFor(file) {
  return MIME[path.extname(String(file || '')).toLowerCase()] || 'application/octet-stream';
}

function exists(p) {
  try { return !!p && fs.existsSync(p); } catch (e) { return false; }
}

function isFile(p) {
  try { return !!p && fs.statSync(p).isFile(); } catch (e) { return false; }
}

function isDir(p) {
  try { return !!p && fs.statSync(p).isDirectory(); } catch (e) { return false; }
}

function fmtBytes(n) {
  n = Number(n) || 0;
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + ' ' + u[i];
}

/* reduce a ratio to the usual "16:9" style string */
function aspectLabel(w, h) {
  w = Math.round(w || 0); h = Math.round(h || 0);
  if (!w || !h) return '';
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const g = gcd(w, h) || 1;
  let a = Math.round(w / g), b = Math.round(h / g);
  if (a > 50 || b > 50) {           /* collapse oddities like 1920:1040 */
    const r = w / h;
    const known = [[16, 9], [4, 3], [21, 9], [3, 2], [5, 4], [1, 1], [2.35, 1], [2.39, 1]];
    let best = null, bd = Infinity;
    known.forEach(function (k) {
      const d = Math.abs(r - k[0] / k[1]);
      if (d < bd) { bd = d; best = k; }
    });
    if (best && bd < 0.14) return best[0] + ':' + best[1];
    return r.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + ':1';
  }
  return a + ':' + b;
}

function fmtDuration(sec) {
  if (!sec || !isFinite(sec)) return '';
  sec = Math.round(sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor(sec / 60) % 60;
  const s = sec % 60;
  const pad = (n) => (n < 10 ? '0' : '') + n;
  return h ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
}

/* list the media files of a folder (non recursive, like the shell does) */
function listFolderFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .map((n) => path.join(dir, n))
      .filter((p) => isFile(p) && isMediaExt(extName(p)));
  } catch (e) { return []; }
}

/* ------------------------------------------------------------------ text ----
   Persian subtitle files in the wild arrive as UTF-8 (with or without BOM),
   UTF-16 (usually LE with BOM) and — from the older sites — Windows-1256.
   A plain readFileSync(p, 'utf8') produced NUL-soup that no cue parser could
   read, so sidecar files "just didn't load". Decode properly instead. */
function isValidUtf8(buf) {
  let i = 0;
  const n = buf.length;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { i++; continue; }
    let len = 0;
    if ((b & 0xE0) === 0xC0) len = 1;
    else if ((b & 0xF0) === 0xE0) len = 2;
    else if ((b & 0xF8) === 0xF0) len = 3;
    else return false;
    if (i + len >= n) return false;
    for (let j = 1; j <= len; j++) { if ((buf[i + j] & 0xC0) !== 0x80) return false; }
    i += len + 1;
  }
  return true;
}

function swapUtf16be(buf, offset) {
  const sw = Buffer.allocUnsafe(buf.length - offset - ((buf.length - offset) % 2));
  for (let i = 0; i + 1 < buf.length - offset; i += 2) {
    sw[i] = buf[offset + i + 1];
    sw[i + 1] = buf[offset + i];
  }
  return sw;
}

function decodeSubtitleBuffer(buf) {
  if (!buf || !buf.length) return '';
  /* BOMs first */
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le', 2);
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) return swapUtf16be(buf, 2).toString('utf16le', 0);
  if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) return buf.toString('utf8', 3);
  /* UTF-16 without a BOM: one half of the byte pairs is NUL for ASCII text */
  let nulOdd = 0, nulEven = 0;
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i + 1 < n; i += 2) if (buf[i] === 0) nulEven++;
  for (let i = 1; i + 1 < n; i += 2) if (buf[i] === 0) nulOdd++;
  const pairs = Math.ceil(n / 2) || 1;
  if (nulOdd > pairs / 2) return buf.toString('utf16le', 0);
  if (nulEven > pairs / 2) return swapUtf16be(buf, 0).toString('utf16le', 0);
  if (isValidUtf8(buf)) return buf.toString('utf8', 0);
  /* legacy single-byte: Persian SRTs are very often Windows-1256 */
  try { return new TextDecoder('windows-1256').decode(buf); } catch (e) { return buf.toString('latin1'); }
}

function decodeSubtitleFile(file) {
  const buf = fs.readFileSync(file);
  return decodeSubtitleBuffer(buf);
}

module.exports = {
  VIDEO_EXT, AUDIO_EXT, SUB_EXT, MIME,
  baseName, extName, stripExt, mimeFor, exists, isFile, isDir,
  isVideoExt, isAudioExt, isSubExt, isMediaExt,
  fmtBytes, aspectLabel, fmtDuration, listFolderFiles,
  isValidUtf8, decodeSubtitleBuffer, decodeSubtitleFile
};
