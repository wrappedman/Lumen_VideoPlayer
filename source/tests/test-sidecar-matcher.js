'use strict';
/* Dependency-free regression tests for local subtitle sidecar discovery. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createFfmpeg } = require('../host/ffmpeg');

const ff = createFfmpeg({ dirs: [] });
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lumen-sidecar-test-'));
let passed = 0;
function dir(name) {
  const p = path.join(root, name);
  fs.mkdirSync(p, { recursive: true });
  return p;
}
function file(folder, name, text) {
  const p = path.join(folder, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text || '');
  return p;
}
function found(media) {
  return ff.sidecars(media).map(function (x) { return path.basename(x.path); });
}
function check(name, fn) {
  fn();
  passed++;
  console.log('PASS ' + name);
}
async function checkAsync(name, fn) {
  await fn();
  passed++;
  console.log('PASS ' + name);
}

(async function () {
try {
  const exactDir = dir('exact');
  const exactMedia = file(exactDir, 'Exact Movie.mkv');
  const exactSubtitle = file(exactDir, 'Exact Movie.srt', '1\n00:00:01,000 --> 00:00:02,000\nHello\n');
  file(exactDir, 'Another Film.mp4');
  check('exact basename match in a multi-media folder', function () {
    assert.deepEqual(found(exactMedia), ['Exact Movie.srt']);
  });
  await checkAsync('sidecar SRT converts to WebVTT without FFmpeg', async function () {
    const vtt = await ff.extractSubtitle(exactMedia, 'ext:' + exactSubtitle);
    assert.match(vtt, /^WEBVTT/);
    assert.match(vtt, /00:00:01\.000 --> 00:00:02\.000/);
    assert.match(vtt, /Hello/);
  });

  const episodeDir = dir('episode');
  const episodeMedia = file(episodeDir, 'Show S02E07 1080p.mkv');
  file(episodeDir, 'Show S02E07 Farsi.srt');
  file(episodeDir, 'Show S02E08 Farsi.srt');
  file(episodeDir, 'Different Series S02E07.srt');
  file(episodeDir, 'Other show.mp4');
  check('episode number selects the matching differently named subtitle', function () {
    assert.deepEqual(found(episodeMedia), ['Show S02E07 Farsi.srt']);
  });

  const unicodeDir = dir('unicode');
  const unicodeMedia = file(unicodeDir, 'سریال فارسی قسمت ۱۲ 1080p.mkv');
  file(unicodeDir, 'سریال فارسی قسمت ۱۲ زیرنویس.srt');
  file(unicodeDir, 'سریال فارسی قسمت ۱۳ زیرنویس.srt');
  file(unicodeDir, 'فیلم دیگری.mp4');
  check('Unicode/Persian letters and Persian digits match correctly', function () {
    assert.deepEqual(found(unicodeMedia), ['سریال فارسی قسمت ۱۲ زیرنویس.srt']);
  });

  const sparseDir = dir('sparse-with-clutter');
  const sparseMedia = file(sparseDir, 'Some Movie.mkv');
  file(sparseDir, 'فارسی.srt');
  for (let i = 0; i < 14; i++) file(sparseDir, 'poster-' + i + '.jpg');
  check('one media file keeps its differently named sidecar despite folder clutter', function () {
    assert.deepEqual(found(sparseMedia), ['فارسی.srt']);
  });

  const subsDir = dir('subtitle-folder');
  const folderMedia = file(subsDir, 'A Film.mkv');
  file(subsDir, 'Subs/fa.srt');
  file(subsDir, 'Subs/en.srt');
  check('sidecars in a conventional Subs subfolder are detected', function () {
    assert.deepEqual(found(folderMedia).sort(), ['en.srt', 'fa.srt']);
  });

  const ambiguousDir = dir('ambiguous');
  const ambiguousMedia = file(ambiguousDir, 'Movie A.mkv');
  file(ambiguousDir, 'Movie B.mp4');
  file(ambiguousDir, 'Unrelated captions.srt');
  check('unrelated subtitle is not attached when multiple media make the folder ambiguous', function () {
    assert.deepEqual(found(ambiguousMedia), []);
  });

  const textDir = dir('text-note');
  const textMedia = file(textDir, 'Documentary.mkv');
  file(textDir, 'notes.txt', 'Director notes, not subtitle cues.');
  check('a plain text note is not mistaken for a subtitle', function () {
    assert.deepEqual(found(textMedia), []);
  });

  console.log('\n' + passed + '/8 sidecar matcher/extraction tests passed.');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
})().catch(function (e) {
  console.error(e && e.stack || e);
  process.exitCode = 1;
});
