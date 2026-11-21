# Lumen — Liquid Glass Player

Lumen is a Windows media player built with **Electron + HTML/CSS/JavaScript**. Its glass UI, transitions, motion and gestures remain in the web layer; the desktop host adds local-file access, streaming and a bundled FFmpeg media engine.

## R9 source revision

This archive is **source only**. It contains no EXE, installer, or build output. On Windows, extract the ZIP and run `build-windows-r9.bat` from the `source` folder to build locally. The script places build output outside the source folder.

R9 preserves the R8 subtitle and Settings fixes and addresses a Windows download failure:

- On Windows, if curl fails because Schannel cannot reach the certificate-revocation server (`CRYPT_E_REVOCATION_OFFLINE`), the BAT retries with `--ssl-no-revoke` while retaining TLS certificate/hostname checks; the pinned SHA-256 is still mandatory before extraction. The fallback covers both FFmpeg and Electron downloads.
- More reliable local sidecar subtitle discovery: Unicode/Persian names, differently named subtitles in a one-media folder, cluttered folders, and conventional `Subs` subfolders are handled; explicitly mismatched episode numbers and ambiguous unrelated subtitles are rejected.
- Subtitle style controls remain in Settings, but the sample **Preview** row is removed. **Reset look** and the actual subtitle styling remain.
- External subtitle tracks found before the slower media probe are retained when embedded tracks arrive, avoiding an async overwrite.

## Hotfix pass on this source drop (same R9 build id)

Playback, shortcuts and performance fixes on top of R9:

- **PageDown / PageUp** step to the next / previous playlist item (wrapping at the ends). **Delete** moves the file that was playing to the Windows **Recycle Bin** and immediately continues with the next item; a file is never removed while it is the only item in the playlist. The same action is in the right-click menu (`Delete file (Recycle Bin)`).
- **The FFmpeg fallback works again.** `transcode_start` was missing from the `preload.js` method whitelist, so every incompatible file ended in “Cannot start the built-in media conversion” instead of being remuxed/re-encoded. A test now keeps the preload whitelist and the `main.js` handlers in sync.
- **Lighter playlist and startup.** The playlist is painted at most once per frame, cached by content signature, its index lookup is O(n) instead of O(n²), and the scroll position survives updates. A saved playlist is no longer tokenised/probed file by file at startup — that used to spawn one `ffprobe` per entry.
- **No wasted GPU work.** Closed panels, the volume OSD, zoom badge, context menu, modal, seek chips and the big play button are `visibility:hidden` when they are not shown, so their `backdrop-filter` no longer blurs the video every frame. The hidden spinner and the equaliser no longer animate forever (the equaliser uses `scaleY`).
- **Real low-resource mode.** Settings → *Low-resource mode* now removes every live blur and uses solid surfaces; it was previously almost a no-op.
- Smaller host-state writes, bounded metadata caches, ETag/304 static files, the unused `scene_bright.jpg` removed and the second idle artwork loaded only when it is displayed.

## R7 feature baseline

- The Windows installer and portable package include **FFmpeg 9.0.2 + ffprobe**. Users do not need to install a codec pack or a separate FFmpeg program.
- HEVC/H.265 (including x265 10-bit), and other formats Chromium cannot decode, are converted to H.264/AAC while playing. High-resolution conversion is CPU-intensive.
- Open URL / stream reads the current clipboard text into its link box. The link box has a Cut / Copy / Paste context menu.
- Settings includes About: **Behnam Ehsani**, `Inbox.ehsani@gmail.com`, app version and bundled-engine details.
- The default idle/player background is the included dark cinematic artwork at `web/assets/scene_cinema.jpg`.

The app does **not** download or install FFmpeg at runtime. Choosing a custom FFmpeg executable remains an optional advanced override only.

## Use after building on Windows

Run `build-windows-r9.bat` from this source folder. It always creates the **portable app** and, when NSIS 3.x is available, the **installer**, both under the parent folder's `build\r9\windows` directory; nothing is prebuilt in this source ZIP. **NSIS is optional** — it only packs the installer. Without it the script finishes successfully, tells you where `Lumen.exe` is, and writes `Lumen-portable-1.0.0-r9.zip` instead. The following commands apply only after that local build:

```bat
Lumen-Setup-1.0.0-r9.exe                 &REM normal install + Start Menu
Lumen-Setup-1.0.0-r9.exe /desktop        &REM also create a Desktop shortcut
Lumen-Setup-1.0.0-r9.exe /PORTABLE /D=D:\Apps\Lumen   &REM extract only; no shortcuts
```

Drag a media file/folder onto the window, or open it from a terminal:

```bat
Lumen.exe "D:\Movies\movie.mkv"
Lumen.exe "D:\Series"
```

## Format coverage

FFmpeg supplies demuxers and decoders for a broad range of common and legacy containers/codecs, including MKV, MP4/MOV, WebM, AVI, MPEG-TS, FLV, VOB, WMV/ASF, Ogg and MXF; HEVC/H.265, H.264, AV1, VP9/VP8, MPEG-1/2/4, VC-1, ProRes and WMV video; and AAC, MP3, FLAC, Opus/Vorbis, AC-3/E-AC-3, DTS, TrueHD, WMA, ALAC and PCM audio. Exact support depends on the individual file, profile, bit depth, stream encryption and platform.

Lumen probes a file with ffprobe and routes incompatible video/audio through FFmpeg into browser-compatible H.264/AAC. Local files and supported remote media use the same compatibility path. No player can guarantee every damaged, encrypted, unusual or unsupported stream.

## Build from source

Requirements: Node.js 22.12 or newer and the official Electron 44.5.1 Windows x64 runtime ZIP. No `unzip` or 7-Zip is needed on Windows: `tools/zipfs.js` unpacks both pinned archives with `unzip` → 7-Zip → its own built-in inflater → PowerShell, so a bare Windows install works. The ZIP is not the npm Electron package; put it at `.electron/electron-v44.5.1-win32-x64.zip` or pass `--zip <path>`. The supplied `build-windows-r9.bat` can download and verify both pinned runtime archives.

NSIS 3.x (`makensis`) is **optional** and only needed for the `Lumen-Setup` installer. When it is missing, the build still succeeds with the portable app and a shareable `Lumen-portable-1.0.0-r9.zip`. `build-installer.js` searches PATH, `NSIS_DIR`, the usual install folders (including Chocolatey, Scoop and the `winget` link folder) and the NSIS registry key, so `winget install --id NSIS.NSIS -e` (or `choco install nsis -y`) is enough for it to be picked up on the next run. It also accepts `--makensis "C:\path\makensis.exe"` for unusual installations.

```bash
npm install
node tools/prepare-ffmpeg.js --download   # build-time only; SHA-256 pinned
node tools/build-windows.js --zip .electron/electron-v44.5.1-win32-x64.zip
node tools/build-installer.js --revision r9
```

`prepare-ffmpeg.js` stores the verified archive under `~/.cache/lumen-build/`. It is a developer build helper; the installed app never invokes it. The expected FFmpeg archive digest is recorded in `tools/pack.js` and the bundled engine's `BUILD-INFO.txt`.

Brand assets: `assets/lumen-mark.svg` is the source of the logo. `assets/lumen-mark.png` (512 px, also served as the favicon from `web/assets/`) and the 7-frame `assets/icon.ico` used for the window, the taskbar and `Lumen.exe` are generated from it:

```bash
npm install --no-save sharp     # optional tooling, not a build dependency
node tools/make-icons.js
```

The 16/24 px frames are drawn from a 9 % larger mark (optical sizing) and every .ico frame except 256 px is a DIB, so Windows and the `resedit` icon stamper both read it.

Other commands:

```bash
npm start                         # run from source
npm start -- --dev                # development mode
npm run dist:win                  # portable Windows folder
npm run dist:win:setup -- --revision r9
npm run dist:linux                # experimental Linux folder
```

## Project layout

```text
main.js / preload.js       Electron host and bridge
host/                      local media server, ffprobe/FFmpeg integration, config
web/                       player interface and behavior (HTML/CSS/JS)
tools/                     Windows/Linux packaging and FFmpeg staging scripts
vendor/ffmpeg/win-x64/     bundled-engine notices and licensing records
docs/                      Persian user guide and change log
tests/                     headless renderer harnesses and sidecar/BAT regression tests
```

## Third-party licensing note

The pinned Gyan.dev FFmpeg 9.0.2 essentials archive identifies the executable build as **GPLv3** and lists third-party libraries used by that build. Its included upstream README names FFmpeg commit `946fcce07b`; the app includes the upstream GPL text and that README with the installed binary. See `vendor/ffmpeg/win-x64/NOTICE-FA.txt` and `README-upstream.txt`.

The FFmpeg binary and its full Corresponding Source for every linked third-party component must be reviewed before public redistribution. The supplied upstream metadata does not by itself prove that the source and build scripts for every listed dependency are present in this source bundle. Do not treat this note as legal advice or as a claim that such a review is complete.

Application code is MIT-licensed; that does not replace the separate terms that apply to bundled third-party software.

## Tests

```bash
node tests/test-sidecar-matcher.js        # 8 checks, no dependencies
node tests/test-zip.js                    # 8 checks, the build's unzip fallback
node tests/test-source-ui.js              # 15 static checks
npm install --no-save jsdom               # optional, only for the next one
node tests/test-keyboard-renderer.js      # 8 headless UI checks
node tests/test-ui-smoke.js               # 12 interaction checks
```

Persian guide: [`docs/README-FA.md`](docs/README-FA.md) ·
Revision notes: [`docs/BUGFIXES-FA.md`](docs/BUGFIXES-FA.md)
