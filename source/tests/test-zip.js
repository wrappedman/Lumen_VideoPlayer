'use strict';
/* ==========================================================================
   tests/test-zip.js — the unpacking fallback used by the Windows build.
   Runs anywhere: no unzip, no 7-Zip, no PowerShell needed.
   ========================================================================== */
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const assert = require('assert');

const zipfs = require('../tools/zipfs.js');

const results = [];
function check(name, fn) {
  fn();
  results.push(name);
  console.log('PASS ' + name);
}

/* ---------------------------------------------------------- zap a ZIP file */
const CRC_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function makeZip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data);
    const method = e.method === 0 ? 0 : 8;
    const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
    const name = Buffer.from(e.name, 'utf8');
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x800, 6);            // utf8 names
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x800, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, body);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([Buffer.concat(locals), cd, eocd]);
}

/* ----------------------------------------------------------------- the test */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-zip-'));
const archive = path.join(tmp, 'runtime.zip');
const big = Buffer.alloc(300 * 1024);
for (let i = 0; i < big.length; i++) big[i] = i % 251;

fs.writeFileSync(archive, makeZip([
  { name: 'electron.exe', data: 'MZ fake launcher', method: 8 },
  { name: 'resources/', data: '', method: 0 },
  { name: 'resources/default_app.asar', data: big, method: 0 },
  { name: 'locales/en-US.pak', data: big, method: 8 },
  { name: 'nested/deep/dir/notes.txt', data: 'hello lumen', method: 8 }
]));

check('the built-in reader lists every entry of the archive', function () {
  const zip = zipfs.readEntries(archive);
  assert.equal(zip.entries.length, 5);
  assert.deepEqual(zip.entries.map((e) => e.name).sort(), [
    'electron.exe', 'locales/en-US.pak', 'nested/deep/dir/notes.txt', 'resources/', 'resources/default_app.asar'
  ]);
});

check('extractAll unpacks stored and deflated entries byte for byte', function () {
  const out = path.join(tmp, 'full');
  assert.equal(zipfs.extractAll(archive, out, { jsOnly: true }), true);
  assert.equal(fs.readFileSync(path.join(out, 'electron.exe'), 'utf8'), 'MZ fake launcher');
  assert.ok(fs.readFileSync(path.join(out, 'resources', 'default_app.asar')).equals(big));
  assert.ok(fs.readFileSync(path.join(out, 'locales', 'en-US.pak')).equals(big));
  assert.equal(fs.readFileSync(path.join(out, 'nested', 'deep', 'dir', 'notes.txt'), 'utf8'), 'hello lumen');
  assert.ok(fs.statSync(path.join(out, 'resources')).isDirectory());
});

check('extractEntry works without unzip or 7z on PATH (the Windows case)', function () {
  const out = path.join(tmp, 'single.bin');
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(tmp, 'nowhere');   // pretend: no unzip, no 7z
  try {
    assert.equal(zipfs.extractEntry(archive, 'locales/en-US.pak', out), true);
  } finally {
    process.env.PATH = savedPath;
  }
  assert.ok(fs.readFileSync(out).equals(big));
});

check('a missing entry is reported instead of writing an empty file', function () {
  const out = path.join(tmp, 'nope.bin');
  const savedPath = process.env.PATH;
  process.env.PATH = path.join(tmp, 'nowhere');
  try {
    assert.equal(zipfs.extractEntry(archive, 'no/such/file.exe', out), false);
  } finally {
    process.env.PATH = savedPath;
  }
  assert.equal(fs.existsSync(out), false);
  assert.ok(zipfs.lastReasons().length > 0);
});

check('a hostile ../ entry cannot escape the output folder', function () {
  const evil = path.join(tmp, 'evil.zip');
  fs.writeFileSync(evil, makeZip([{ name: '../escaped.txt', data: 'nope', memo: 0 }]));
  const out = path.join(tmp, 'evil-out');
  const ok = zipfs.extractAll(evil, out, { jsOnly: true });
  assert.equal(ok, false);
  assert.equal(fs.existsSync(path.join(tmp, 'escaped.txt')), false);
  assert.match(zipfs.lastReasons().join(' '), /outside the output folder|built-in reader/i);
});

check('a file that is not a ZIP is rejected with a readable reason', function () {
  const bad = path.join(tmp, 'fake.zip');
  fs.writeFileSync(bad, 'this is not a zip archive at all, just text padded to be long enough'.repeat(4));
  assert.equal(zipfs.extractAll(bad, path.join(tmp, 'bad-out')), false);
  assert.match(zipfs.lastReasons().join(' '), /not a ZIP archive|damaged/i);
});


check('a real Info-ZIP archive extracts through the built-in reader', function () {
  const { spawnSync } = require('child_process');
  if (spawnSync('zip', ['-v'], { stdio: 'ignore' }).status !== 0) return;   // no zip CLI: skip
  const tree = path.join(tmp, 'tree');
  fs.mkdirSync(path.join(tree, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(tree, 'locales', 'fa.pak'), 'دادهٔ آزمایشی');
  fs.writeFileSync(path.join(tree, 'electron.exe'), big);
  const real = path.join(tmp, 'real.zip');
  const z = spawnSync('zip', ['-q', '-r', real, '.'], { cwd: tree, stdio: 'ignore' });
  assert.equal(z.status, 0);
  const out = path.join(tmp, 'real-out');
  assert.equal(zipfs.extractAll(real, out, { jsOnly: true }), true);
  assert.ok(fs.readFileSync(path.join(out, 'electron.exe')).equals(big));
  assert.equal(fs.readFileSync(path.join(out, 'locales', 'fa.pak'), 'utf8'), 'دادهٔ آزمایشی');
});

check('an unsupported ZIP64 archive fails with a readable reason', function () {
  const zip64 = path.join(tmp, 'zip64.zip');
  const buf = Buffer.from(makeZip([{ name: 'x.txt', data: 'x', method: 0 }]));
  const eocd = buf.length - 22;
  buf.writeUInt16LE(0xffff, eocd + 8);      // "65535 entries" = ZIP64 marker
  buf.writeUInt16LE(0xffff, eocd + 10);
  fs.writeFileSync(zip64, buf);
  assert.equal(zipfs.extractAll(zip64, path.join(tmp, 'z64'), { jsOnly: true }), false);
  assert.match(zipfs.lastReasons().join(' '), /ZIP64/i);
});

console.log('\n' + results.length + '/' + results.length + ' ZIP extraction tests passed.');
