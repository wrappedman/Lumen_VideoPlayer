#!/usr/bin/env bash
set -euo pipefail
ROOT="${1:-/tmp/lumen-r7-fixtures}"
mkdir -p "$ROOT/stream" "$ROOT/cleanmedia"
rm -f "$ROOT/stream/"* "$ROOT/cleanmedia/"*
printf '1\n00:00:00,300 --> 00:00:02,500\nEnglish online subtitle\n' > "$ROOT/stream/movie.srt"
printf '1\n00:00:00,300 --> 00:00:02,500\nزیرنویس فارسی کنار استریم\n' > "$ROOT/stream/movie.fa.srt"
printf '1\n00:00:00,300 --> 00:00:02,500\nEmbedded subtitle\n' > "$ROOT/stream/embedded.srt"
printf '1\n00:00:00,300 --> 00:00:02,500\nLocal sidecar subtitle\n' > "$ROOT/cleanmedia/harness-media.srt"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=12:duration=3' \
  -f lavfi -i 'sine=frequency=880:sample_rate=48000:duration=3' \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p -threads 1 \
  -x265-params 'pools=1:frame-threads=1:log-level=error' \
  -c:a aac -b:a 96k -shortest -f matroska "$ROOT/stream/hevc.mkv" 2>/dev/null
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=12:duration=3' \
  -f lavfi -i 'sine=frequency=990:sample_rate=48000:duration=3' \
  -c:v libx265 -preset ultrafast -pix_fmt yuv420p10le -threads 1 \
  -x265-params 'pools=1:frame-threads=1:log-level=error' \
  -c:a ac3 -b:a 192k -shortest "$ROOT/stream/hevc10-ac3.mkv" 2>/dev/null
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=12:duration=3' \
  -f lavfi -i 'sine=frequency=440:sample_rate=48000:duration=3' \
  -i "$ROOT/stream/embedded.srt" \
  -map 0:v:0 -map 1:a:0 -map 2:s:0 -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -b:a 96k -c:s srt -metadata:s:s:0 language=eng -shortest \
  "$ROOT/stream/movie.mkv"
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i 'testsrc2=size=320x180:rate=12:duration=5' \
  -f lavfi -i 'sine=frequency=660:sample_rate=48000:duration=5' \
  -map 0:v:0 -map 1:a:0 -c:v libx264 -preset ultrafast -pix_fmt yuv420p \
  -c:a aac -b:a 96k -shortest "$ROOT/cleanmedia/harness-media.mp4"
printf 'Fixtures created in %s\n' "$ROOT"
ls -lh "$ROOT/stream" "$ROOT/cleanmedia"
