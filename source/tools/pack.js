'use strict';
/* ==========================================================================
   Lumen — tools/pack.js
   Assembles a portable Electron app from the official Electron release zip:
     · stages the app sources (web/, host/, docs/, main.js, preload.js,
       package.json, assets/, README.md) and packs them into resources/app.asar
     · unpacks the Electron runtime, swaps in our asar, removes the default app
     · optionally renames the launcher to Lumen.exe and stamps icon + version
   Needs: unzip (or 7z) on PATH, and `@electron/asar` (+ `resedit` on Windows
   targets for the icon/version stamp) available through NODE_PATH or node_modules.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const zipfs = require('./zipfs.js');
const asar = require('@electron/asar');

/* Pinned Gyan.dev 64-bit static essentials package (FFmpeg 9.0.2, GPLv3).
   Exact digest keeps a rebuild from silently picking up a different release. */
const FFMPEG_ZIP_SHA256 = '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba';
const FFMPEG_ZIP_PREFIX = 'ffmpeg-9.0.2-essentials_build/';

const APP_FILES = ['web', 'host', 'docs', 'main.js', 'preload.js', 'package.json', 'assets', 'README.md', 'BUILD-ID.txt'];

function log() { console.log.apply(console, ['[pack]'].concat(Array.prototype.slice.call(arguments))); }

function rmrf(p) {
  try { fs.rmSync(p, { recursive: true, force: true }); } catch (e) { }
}

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name), d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d);
    else if (e.isFile()) fs.copyFileSync(s, d);
  }
}

/* Windows has no `unzip` binary, and 7-Zip is not guaranteed either — this
   used to abort the build after the runtime archive had already been
   downloaded and checksum-verified. zipfs tries unzip → 7z → PowerShell →
   a built-in inflater, so unpacking can no longer fail for lack of a tool. */
function unzip(zip, dest) {
  if (!zipfs.extractAll(zip, dest)) {
    throw new Error('could not unpack ' + zip + '\n  tried: ' + zipfs.lastReasons().join(' · '));
  }
  return true;
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const data = fs.readFileSync(file);
  hash.update(data);
  return hash.digest('hex');
}

function extractZipEntry(zip, entry, target) {
  if (!zipfs.extractEntry(zip, entry, target)) {
    throw new Error('cannot extract ' + entry + ' from the pinned FFmpeg archive\n  tried: ' +
      zipfs.lastReasons().join(' · '));
  }
}

/* the pinned archive is the only source of truth, but a renamed licence or
   readme inside a future build must not fail the whole packaging run with a
   bare "cannot extract" line */
function extractAnyEntry(zip, names, target, what) {
  for (const name of names) {
    try {
      if (zipfs.extractEntry(zip, name, target)) return name;
    } catch (e) { /* try the next spelling */ }
  }
  let listing = [];
  try {
    listing = zipfs.readEntries(zip).entries.map(function (e) { return e.name; }).slice(0, 25);
  } catch (e) { listing = ['(archive could not be read: ' + (e && e.message) + ')']; }
  throw new Error('cannot find ' + what + ' in the pinned FFmpeg archive.\n  looked for: ' + names.join(', ') +
    '\n  the archive contains: ' + listing.join(', '));
}

function installBundledFfmpeg(zip, resourcesDir, srcDir) {
  if (!zip || !fs.existsSync(zip)) {
    throw new Error('bundled FFmpeg archive is required for a Windows build. Run `node tools/prepare-ffmpeg.js --download` or pass --ffmpeg-zip <path>.');
  }
  const got = sha256File(zip);
  if (got !== FFMPEG_ZIP_SHA256) {
    throw new Error('FFmpeg archive SHA-256 mismatch. Expected ' + FFMPEG_ZIP_SHA256 + ', got ' + got);
  }
  const target = path.join(resourcesDir, 'ffmpeg');
  const bin = path.join(target, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  ['ffmpeg.exe', 'ffprobe.exe'].forEach(function (name) {
    const dest = path.join(bin, name);
    extractZipEntry(zip, FFMPEG_ZIP_PREFIX + 'bin/' + name, dest);
    const b = Buffer.alloc(2);
    const fd = fs.openSync(dest, 'r');
    try { fs.readSync(fd, b, 0, 2, 0); } finally { fs.closeSync(fd); }
    if (b.toString('ascii') !== 'MZ' || fs.statSync(dest).size < 50000000) {
      throw new Error('the extracted ' + name + ' is not a valid 64-bit Windows binary');
    }
    log('bundled ' + name + ' (' + fs.statSync(dest).size + ' bytes)');
  });
  extractAnyEntry(zip, [FFMPEG_ZIP_PREFIX + 'LICENSE', FFMPEG_ZIP_PREFIX + 'LICENSE.txt',
    FFMPEG_ZIP_PREFIX + 'COPYING.GPLv3'], path.join(target, 'LICENSE.GPL-3.0.txt'), 'the GPLv3 licence');
  extractAnyEntry(zip, [FFMPEG_ZIP_PREFIX + 'README.txt', FFMPEG_ZIP_PREFIX + 'README.md'],
    path.join(target, 'README-upstream.txt'), 'the upstream README');
  const notice = path.join(srcDir, 'vendor', 'ffmpeg', 'win-x64', 'NOTICE-FA.txt');
  if (fs.existsSync(notice)) fs.copyFileSync(notice, path.join(target, 'NOTICE-FA.txt'));
  fs.writeFileSync(path.join(target, 'BUILD-INFO.txt'),
    'FFmpeg 9.0.2 essentials_build-www.gyan.dev, 64-bit static Windows binaries.\r\n' +
    'Archive SHA-256: ' + FFMPEG_ZIP_SHA256 + '\r\n' +
    'See README-upstream.txt for the exact upstream FFmpeg source commit and build configuration.\r\n' +
    'GPLv3 license: LICENSE.GPL-3.0.txt.\r\n', 'utf8');
  return target;
}

/* ---------------------------------------------------------------- icon/version */
function stampExe(exePath, icoPath, version) {
  let ResEdit;
  try { ResEdit = require('resedit'); } catch (e) {
    log('resedit not available — skipping icon/version stamp');
    return false;
  }
  const data = fs.readFileSync(exePath);
  const exe = ResEdit.NtExecutable.from(data, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  if (icoPath && fs.existsSync(icoPath)) {
    try {
      const iconFile = ResEdit.Data.IconFile.from(fs.readFileSync(icoPath));
      ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
        res.entries, 1, 1033, iconFile.icons.map(function (i) { return i.data; }));
      log('icon applied (' + iconFile.icons.length + ' sizes)');
    } catch (e) { log('icon stamp failed:', e && e.message); }
  }

  try {
    const viList = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
    if (viList && viList.length) {
      const vi = viList[0];
      const p = String(version || '1.0.0').split('.').map(function (n) { return parseInt(n, 10) || 0; });
      vi.setFileVersion(p[0], p[1], p[2], 0);
      vi.setProductVersion(p[0], p[1], p[2], 0);
      vi.setStringValues({ lang: 1033, codepage: 1200 }, {
        ProductName: 'Lumen',
        FileDescription: 'Lumen — Liquid Glass Player',
        CompanyName: 'Behnam Ehsani',
        LegalCopyright: '© Behnam Ehsani',
        OriginalFilename: path.basename(exePath),
        ProductVersion: version,
        FileVersion: version + '.0'
      });
      vi.outputToResourceEntries(res.entries);
      log('version info applied (v' + version + '.0)');
    }
  } catch (e) { log('version stamp failed:', e && e.message); }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  return true;
}

/* ---------------------------------------------------------------- main */
async function pack(opts) {
  opts = opts || {};
  const srcDir = opts.srcDir || path.join(__dirname, '..');
  const outRoot = path.resolve(opts.out || path.join(srcDir, '..', 'build'));
  const platform = opts.platform === 'linux' ? 'linux' : 'windows';
  const zip = opts.zip;
  if (!zip || !fs.existsSync(zip)) throw new Error('electron runtime zip not found: ' + zip);
  if (!fs.existsSync(path.join(srcDir, 'main.js'))) throw new Error('main.js not found in ' + srcDir);

  const outDir = path.join(outRoot, platform);
  const stage = path.join(outRoot, '.pack-' + Date.now().toString(36));
  const asarPath = path.join(stage, 'app.asar');

  /* 1) stage the app sources and build the asar (async API — must be awaited) */
  fs.mkdirSync(stage, { recursive: true });
  for (const f of APP_FILES) {
    const s = path.join(srcDir, f);
    if (!fs.existsSync(s)) continue;
    const d = path.join(stage, f);
    if (fs.statSync(s).isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
  await asar.createPackage(stage, asarPath);
  const asarSize = fs.statSync(asarPath).size;

  /* 2) unpack the runtime next to the output (cross-device safe) */
  rmrf(outDir);
  unzip(zip, outDir);

  /* 3) drop in our app */
  const resDir = path.join(outDir, 'resources');
  fs.mkdirSync(resDir, { recursive: true });
  fs.copyFileSync(asarPath, path.join(resDir, 'app.asar'));
  try { fs.rmSync(path.join(resDir, 'default_app.asar'), { force: true }); } catch (e) { }
  if (platform === 'windows') installBundledFfmpeg(opts.ffmpegZip || process.env.LUMEN_FFMPEG_ZIP, resDir, srcDir);

  /* 4) rename the launcher + stamp it (windows only) */
  let launcher = path.join(outDir, 'electron' + (platform === 'windows' ? '.exe' : ''));
  if (platform === 'windows') {
    const target = path.join(outDir, 'Lumen.exe');
    fs.renameSync(launcher, target);
    launcher = target;
    const ico = opts.icon || path.join(srcDir, 'assets', 'icon.ico');
    stampExe(launcher, ico, opts.version || '1.0.0');
    fs.writeFileSync(path.join(outDir, 'READ-ME.txt'),
      'Lumen — Liquid Glass Player (portable)\r\n\r\n' +
      'Double-click Lumen.exe, or run it from a shell with a file name:\r\n' +
      '    Lumen.exe "D:\\Movies\\movie.mkv"\r\n\r\n' +
      'The FFmpeg + ffprobe media engine is bundled in resources\\ffmpeg\\bin.\r\n' +
      'HEVC / x265 and many other codecs are converted during playback.\r\n' +
      'Build identity: see BUILD-ID.txt. Third-party notices: resources\\ffmpeg.\r\n');
    const buildIdFile = path.join(srcDir, 'BUILD-ID.txt');
    if (fs.existsSync(buildIdFile)) fs.copyFileSync(buildIdFile, path.join(outDir, 'BUILD-ID.txt'));
  } else {
    const sh = '#!/bin/sh\n' +
      'HERE=$(dirname "$(readlink -f "$0")")\n' +
      'exec "$HERE/electron" "$@"\n';
    fs.writeFileSync(path.join(outDir, 'lumen'), sh, { mode: 0o755 });
  }

  rmrf(stage);
  const fileCount = (function count(dir) {
    let n = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      n += e.isDirectory() ? count(path.join(dir, e.name)) : 1;
    }
    return n;
  })(outDir);

  return { outDir: outDir, launcher: launcher, asarSize: asarSize, files: fileCount };
}

module.exports = { pack, stampExe, copyDir, log };
