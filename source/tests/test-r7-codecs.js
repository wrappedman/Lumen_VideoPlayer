'use strict';
/* R7 codec-pipeline regression test; run only in an environment with FFmpeg. */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createFfmpeg } = require('../host/ffmpeg');
const ROOT = process.argv[2] || '/tmp/lumen-r7-fixtures';
const OUT = path.join(os.tmpdir(), 'lumen-r7-codec-output');
const ff = createFfmpeg({ dirs: [process.env.LUMEN_FFMPEG_DIR || '/usr/bin'] });
const results = [];

function check(name, ok, details) {
  results.push({ name, ok: !!ok, details: details || null });
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (details ? ' → ' + JSON.stringify(details) : ''));
}
function encode(file, output, args) {
  return new Promise(function (resolve, reject) {
    try { fs.rmSync(output, { force: true }); } catch (e) { }
    const child = spawn(ff.path, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    const err = [];
    const timer = setTimeout(function () { try { child.kill('SIGKILL'); } catch (e) { } }, 90000);
    child.stderr.on('data', d => err.push(d));
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0 || !fs.existsSync(output) || !fs.statSync(output).size) {
        reject(new Error('ffmpeg exit=' + code + ': ' + Buffer.concat(err).toString('utf8').slice(-1600)));
      } else resolve();
    });
  });
}
async function transcodeFixture(file, label) {
  const info = await ff.probe(file);
  if (!info) throw new Error('ffprobe failed for ' + file);
  const plan = ff.plan(info);
  const out = path.join(OUT, label + '.mp4');
  fs.mkdirSync(OUT, { recursive: true });
  const command = ff.transcodeArgs(file, info, 0, null, {}).args.map(function (arg) {
    return arg === 'pipe:1' ? out : arg;
  });
  await encode(file, out, command);
  const result = await ff.probe(out);
  return { info, plan, output:{ video:result && result.vcodec, audio:result && result.acodec, size:fs.statSync(out).size } };
}

(async function main() {
  try {
    if (!ff.available() || !ff.canProbe()) throw new Error('ffmpeg and ffprobe are required for this test');
    const eight = await transcodeFixture(path.join(ROOT, 'stream', 'hevc.mkv'), 'hevc8');
    check('HEVC/x265 is selected for H.264 conversion',
      eight.plan.needEncode && !eight.plan.videoCopy && eight.output.video === 'h264' && eight.output.audio === 'aac',
      { source:eight.info.vcodec, profile:eight.info.profile, plan:eight.plan, output:eight.output });

    const ten = await transcodeFixture(path.join(ROOT, 'stream', 'hevc10-ac3.mkv'), 'hevc10-ac3');
    check('10-bit HEVC + AC-3 is converted to browser-compatible H.264/AAC',
      ten.plan.highBitDepth && ten.plan.needEncode && !ten.plan.audioCopy &&
      ten.output.video === 'h264' && ten.output.audio === 'aac',
      { sourceVideo:ten.info.vcodec, profile:ten.info.profile, pixfmt:ten.info.pixfmt,
        sourceAudio:ten.info.acodec, plan:ten.plan, output:ten.output });

    const failed = results.filter(r => !r.ok);
    fs.writeFileSync(path.join(__dirname, 'results-r7-codecs.json'), JSON.stringify({ results, allok:!failed.length }, null, 2));
    console.log((failed.length ? 'TESTS FAILED' : 'ALL PASS') + ' (' + (results.length - failed.length) + '/' + results.length + ')');
    if (failed.length) process.exitCode = 1;
  } catch (e) {
    console.error('[codec test] ' + (e && e.stack || e));
    process.exitCode = 1;
  }
})();
