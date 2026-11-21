/* Regenerates every raster icon Lumen ships from assets/lumen-mark.svg.
 *
 *   npm install --no-save sharp
 *   node tools/make-icons.js
 *
 * The committed PNG/ICO files are the real deliverables; this script only
 * exists so the mark can be re-rendered after the SVG is touched. Sharp is
 * intentionally *not* a devDependency: the build must not download a native
 * image pipeline just to package the app.
 */
'use strict';
const fs = require('fs');
const path = require('path');

let sharp;
try {
  sharp = require('sharp');
} catch (e) {
  console.error('[icons] sharp is missing. Run:  npm install --no-save sharp');
  process.exit(1);
}

const root = path.join(__dirname, '..');
const svgPath = path.join(root, 'assets', 'lumen-mark.svg');
const svg = fs.readFileSync(svgPath);

/* The same artwork shrunk to 16 px loses too much of the glyph, so the two
   smallest frames are drawn from a slightly larger mark. Invisible at the
   sizes where the difference could be noticed, decisive at 16. */
function compact(source, scale) {
  const t = 'translate(256 256) scale(' + scale + ') translate(-256 -256)';
  return Buffer.from(String(source)
    .replace('<g id="mark">', '<g id="mark" transform="' + t + '">'));
}

const SIZES = [16, 24, 32, 48, 64, 128, 256, 512];

async function renderPng(size) {
  const src = size <= 24 ? compact(svg, 1.09) : svg;
  /* render natively at the target size: librsvg hinting beats downscaling a
     big bitmap for the tiny frames */
  const density = 72 * (Math.max(size, 32) / 512) * 4;
  return sharp(src, { density }).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 }).toBuffer();
}

/* A 32-bpp DIB frame (BITMAPINFOHEADER + bottom-up BGRA + 1-bpp AND mask).
   Windows only accepts PNG inside an .ico from Vista on, while the DIB form is
   accepted by every Windows version and by the resedit icon stamper that puts
   the icon into Lumen.exe — so every frame but 256×256 is a DIB. */
async function dibFrame(png, size) {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const maskRow = Math.ceil(size / 32) * 4;          // 1 bpp, 4-byte aligned rows
  const mask = Buffer.alloc(maskRow * size, 0);
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = y * size * 4;
    const dstRow = (size - 1 - y) * size * 4;        // bottom-up
    for (let x = 0; x < size; x++) {
      const s = srcRow + x * 4;
      const d = dstRow + x * 4;
      xor[d] = data[s + 2];         // B
      xor[d + 1] = data[s + 1];     // G
      xor[d + 2] = data[s];         // R
      xor[d + 3] = data[s + 3];     // A
      if (data[s + 3] === 0) {
        const my = size - 1 - y;
        mask[my * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
      }
    }
  }
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8);                  // XOR + AND
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16);                       // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);
  return Buffer.concat([header, xor, mask]);
}

(async () => {
  const pngs = new Map();
  for (const s of SIZES) pngs.set(s, await renderPng(s));

  fs.writeFileSync(path.join(root, 'assets', 'lumen-mark.png'), pngs.get(512));
  fs.writeFileSync(path.join(root, 'web', 'assets', 'lumen-mark.png'), pngs.get(512));
  fs.writeFileSync(path.join(root, 'assets', 'icon.png'), pngs.get(512));

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = [];
  for (const s of icoSizes) frames.push(s === 256 ? pngs.get(256) : await dibFrame(pngs.get(s), s));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(frames.length, 4);
  let offset = 6 + 16 * frames.length;
  const entries = icoSizes.map((s, i) => {
    const e = Buffer.alloc(16);
    e.writeUInt8(s >= 256 ? 0 : s, 0);
    e.writeUInt8(s >= 256 ? 0 : s, 1);
    e.writeUInt8(0, 2);
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4);
    e.writeUInt16LE(32, 6);
    e.writeUInt32LE(frames[i].length, 8);
    e.writeUInt32LE(offset, 12);
    offset += frames[i].length;
    return e;
  });
  const ico = Buffer.concat([header].concat(entries).concat(frames));
  fs.writeFileSync(path.join(root, 'assets', 'icon.ico'), ico);
  console.log('[icons] lumen-mark.png ' + pngs.get(512).length + ' B · icon.ico ' + ico.length +
    ' B (' + icoSizes.join('/') + ', DIB frames except 256 PNG)');
})();
