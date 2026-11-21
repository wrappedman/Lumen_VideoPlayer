'use strict';
/* ==========================================================================
   Lumen — tools/zipfs.js
   Unpacking that cannot be blocked by a missing `unzip` or `7z`.

   Windows does not ship `unzip`, and plenty of machines have no 7-Zip either,
   which used to make `node tools/build-windows.js` die with
   "could not unpack …electron-v44.5.1-win32-x64.zip" *after* downloading and
   checksum-verifying a perfectly good archive.

   Every caller now goes through the chain below:
     1. `unzip`   (POSIX, Git-Bash, MSYS)
     2. `7z`/`7za`(7-Zip / p7zip)
     3. PowerShell + .NET ZipFile (Windows only, always installed)
     4. a built-in ZIP reader (inflate via zlib — no dependency at all)
   Step 4 is plain JavaScript, so it also works on a stripped-down Windows
   without PowerShell in the PATH and is unit-tested in tests/test-zip.js.
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

/* ------------------------------------------------------------------ helpers */
function trySpawn(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ stdio: 'ignore', windowsHide: true }, opts || {}));
  if (r.error) return { ok: false, why: cmd + ': ' + (r.error.code || r.error.message) };
  if (r.status !== 0) return { ok: false, why: cmd + ' exited ' + r.status };
  return { ok: true };
}

/* ------------------------------------------------------- built-in ZIP reader */
const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;

function findEndOfCentralDirectory(buf) {
  const min = Math.max(0, buf.length - 65558);
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/* the FFmpeg archive is opened once per bundled binary; re-reading a 100 MB
   file four times is pure waste, so the last parsed archive stays cached */
const ARCHIVE_CACHE = new Map();
const ARCHIVE_CACHE_MAX = 1;

function readEntries(zipPath) {
  let key = zipPath;
  try {
    const st = fs.statSync(zipPath);
    key = zipPath + '|' + st.size + '|' + Math.floor(st.mtimeMs);
  } catch (e) { /* let readFileSync report it */ }
  const hit = ARCHIVE_CACHE.get(key);
  if (hit) return hit;
  const buf = fs.readFileSync(zipPath);
  const eocd = findEndOfCentralDirectory(buf);
  if (eocd < 0) throw new Error('not a ZIP archive: ' + path.basename(zipPath));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported by the built-in reader; install 7-Zip or use PowerShell');
  }
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CEN_SIG) throw new Error('damaged central directory in ' + path.basename(zipPath));
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    entries.push({ name, method, csize, usize, offset, dir: name.endsWith('/') });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const parsed = { buf, entries };
  ARCHIVE_CACHE.set(key, parsed);
  while (ARCHIVE_CACHE.size > ARCHIVE_CACHE_MAX) {
    ARCHIVE_CACHE.delete(ARCHIVE_CACHE.keys().next().value);
  }
  return parsed;
}

function entryData(zip, entry) {
  const p = entry.offset;
  if (zip.buf.readUInt32LE(p) !== LOC_SIG) throw new Error('damaged local header for ' + entry.name);
  const nameLen = zip.buf.readUInt16LE(p + 26);
  const extraLen = zip.buf.readUInt16LE(p + 28);
  const start = p + 30 + nameLen + extraLen;
  const raw = zip.buf.subarray(start, start + entry.csize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return zlib.inflateRawSync(raw);
  throw new Error('unsupported ZIP compression method ' + entry.method + ' for ' + entry.name);
}

function safeJoin(dest, name) {
  const target = path.resolve(dest, name);
  const rel = path.relative(path.resolve(dest), target);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('refusing to write outside the output folder: ' + name);
  }
  return target;
}

function extractAllJs(zipPath, dest) {
  const zip = readEntries(zipPath);
  let n = 0;
  for (const e of zip.entries) {
    const target = safeJoin(dest, e.name);
    if (e.dir) { fs.mkdirSync(target, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entryData(zip, e));
    n++;
  }
  return n;
}

function extractEntryJs(zipPath, name, target) {
  const zip = readEntries(zipPath);
  const wanted = String(name).replace(/\\/g, '/');
  const e = zip.entries.find((x) => x.name === wanted) ||
    zip.entries.find((x) => x.name.toLowerCase() === wanted.toLowerCase());
  if (!e) return false;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, entryData(zip, e));
  return true;
}

/* ------------------------------------------------------------- PowerShell */
function powershellScript(body) {
  /* -EncodedCommand takes the script base64/UTF-16LE, so no quoting hell and
     no problem with spaces, quotes or non-ASCII in the file names. */
  return Buffer.from(body, 'utf16le').toString('base64');
}

function runPowershell(script) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', powershellScript(script)];
  for (const exe of ['powershell.exe', 'pwsh.exe', 'powershell', 'pwsh']) {
    const r = trySpawn(exe, args);
    if (r.ok) return true;
    if (!/ENOENT/.test(r.why)) lastPsReason = r.why;
  }
  return false;
}
let lastPsReason = '';

function psExtractAll(zipPath, dest) {
  if (process.platform !== 'win32') return false;
  const script = [
    '$ErrorActionPreference = "Stop"',
    'try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop } catch { }',
    '$z = [System.IO.Compression.ZipFile]::OpenRead($env:LUMEN_ZIP)',
    'try {',
    '  $sep = [char]92',
    '  $root = [System.IO.Path]::GetFullPath($env:LUMEN_DEST).TrimEnd($sep) + $sep',
    '  foreach ($e in $z.Entries) {',
    '    $t = [System.IO.Path]::GetFullPath((Join-Path $root $e.FullName))',
    '    if (-not $t.StartsWith($root, [System.StringComparison]::OrdinalIgnoreCase)) { continue }',
    '    if ([string]::IsNullOrEmpty($e.Name)) { [System.IO.Directory]::CreateDirectory($t) | Out-Null }',
    '    else {',
    '      [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($t)) | Out-Null',
    '      [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $t, $true)',
    '    }',
    '  }',
    '} finally { $z.Dispose() }'
  ].join('\n');
  return withPathEnv({ LUMEN_ZIP: zipPath, LUMEN_DEST: dest }, () => runPowershell(script));
}

function psExtractEntry(zipPath, name, target) {
  if (process.platform !== 'win32') return false;
  const script = [
    '$ErrorActionPreference = "Stop"',
    'try { Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction Stop } catch { }',
    '$z = [System.IO.Compression.ZipFile]::OpenRead($env:LUMEN_ZIP)',
    'try {',
    '  $e = $z.Entries | Where-Object { $_.FullName -eq $env:LUMEN_ENTRY } | Select-Object -First 1',
    '  if (-not $e) { exit 3 }',
    '  [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName([System.IO.Path]::GetFullPath($env:LUMEN_TARGET))) | Out-Null',
    '  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $env:LUMEN_TARGET, $true)',
    '} finally { $z.Dispose() }'
  ].join('\n');
  return withPathEnv({ LUMEN_ZIP: zipPath, LUMEN_ENTRY: name, LUMEN_TARGET: target }, () => runPowershell(script));
}

function withPathEnv(extra, fn) {
  const saved = {};
  for (const k of Object.keys(extra)) { saved[k] = process.env[k]; process.env[k] = extra[k]; }
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  }
}

/* ----------------------------------------------------------------- public */
const reasons = [];

function extractAll(zipPath, dest, opts) {
  opts = opts || {};
  fs.mkdirSync(dest, { recursive: true });
  reasons.length = 0;
  if (!opts.jsOnly) {
    let r = trySpawn('unzip', ['-q', '-o', zipPath, '-d', dest]);
    if (r.ok) return true;
    reasons.push(r.why);
    for (const seven of ['7z', '7za', '7zz']) {
      r = trySpawn(seven, ['x', '-y', '-o' + dest, zipPath]);
      if (r.ok) return true;
      reasons.push(r.why);
    }
  }
  /* the built-in reader is the tested path (tests/test-zip.js) and needs no
     external program, so it runs before the PowerShell last resort */
  try {
    extractAllJs(zipPath, dest);
    return true;
  } catch (e) {
    reasons.push('built-in reader: ' + (e && e.message));
  }
  if (!opts.jsOnly && psExtractAll(zipPath, dest)) return true;
  if (lastPsReason) reasons.push(lastPsReason);
  return false;
}

function extractEntry(zipPath, name, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  reasons.length = 0;
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
    let ok = false;
    const out = fs.openSync(target, 'w');
    try {
      let r = spawnSync('unzip', ['-p', zipPath, name], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      if (!r.error && r.status === 0 && r.stdout && r.stdout.length) { fs.writeSync(out, r.stdout); ok = true; }
      else {
        reasons.push('unzip: ' + (r.error ? r.error.code : 'no data'));
        const sevenOut = spawnSync('7z', ['e', '-so', zipPath, name], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        if (!sevenOut.error && sevenOut.status === 0 && sevenOut.stdout && sevenOut.stdout.length) { fs.writeSync(out, sevenOut.stdout); ok = true; }
        else reasons.push('7z: ' + (sevenOut.error ? sevenOut.error.code : 'no data'));
      }
    } finally { try { fs.closeSync(out); } catch (e) { } }
    if (!ok) {
      try { fs.unlinkSync(target); } catch (e) { }
      try {
        if (extractEntryJs(zipPath, name, target) && fs.statSync(target).size > 0) ok = true;
      } catch (e) { reasons.push('built-in reader: ' + (e && e.message)); }
    }
    if (!ok) {
      try { fs.unlinkSync(target); } catch (e) { }
      if (psExtractEntry(zipPath, name, target) && fs.existsSync(target) && fs.statSync(target).size > 0) ok = true;
    }
    if (!ok) {
      try { fs.unlinkSync(target); } catch (e) { }
      return false;
    }
  }
  return fs.existsSync(target) && fs.statSync(target).size > 0;
}

module.exports = {
  extractAll: extractAll,
  extractEntry: extractEntry,
  readEntries: readEntries,
  extractAllJs: extractAllJs,
  extractEntryJs: extractEntryJs,
  lastReasons: function () { return reasons.slice(); }
};
