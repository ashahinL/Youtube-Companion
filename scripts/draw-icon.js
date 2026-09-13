/**
 * Draws the extension icon — headphones around a short feed list on an
 * indigo-to-purple tile — and writes it as PNG. The icon is geometry rather
 * than a hand-exported image so every size is rendered from the same shapes,
 * with the detail each size can carry.
 *
 *   node scripts/draw-icon.js              icons/icon{16,32,48,128}.png
 *   node scripts/draw-icon.js 300 out.png  one size, anywhere
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const FROM = [0x43, 0x38, 0xca];
const TO = [0x93, 0x33, 0xea];

function encodePng(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const stride = size * 4 + 1;
  const raw = Buffer.alloc(stride * size);
  for (let y = 0; y < size; y++) rgba.copy(raw, y * stride + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function roundRect(x, y, cx, cy, hw, hh, r) {
  const qx = Math.abs(x - cx) - hw + r;
  const qy = Math.abs(y - cy) - hh + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// The upper half of a ring, with round ends where it meets the ear cups.
function band(x, y, cx, cy, radius, half) {
  if (y <= cy) return Math.abs(Math.hypot(x - cx, y - cy) - radius) - half;
  return Math.min(Math.hypot(x - (cx - radius), y - cy), Math.hypot(x - (cx + radius), y - cy)) - half;
}

/* At 16px the feed lines smear into a grey block and the band goes thin, so
 * the smallest size is headphones alone, drawn heavier. 32px has room for two
 * lines, 48px and up for three. Chrome wants 16px of transparent margin
 * around the 128px icon; the toolbar sizes fill their square. */
function layoutFor(size) {
  if (size <= 16) return { pad: 0, radius: 26, detail: 'min' };
  if (size <= 32) return { pad: 2, radius: 28, detail: 'mid' };
  if (size <= 48) return { pad: 4, radius: 28, detail: 'full' };
  if (size <= 128) return { pad: 16, radius: 28, detail: 'full' };
  return { pad: 8, radius: 28, detail: 'full' };
}

// Signed distance to the white mark, in a 128-unit square.
function markFor(detail) {
  const cy = 58;
  const radius = 40;
  const half = detail === 'min' ? 9.5 : 7.5;
  const cupW = detail === 'min' ? 24 : 19;
  const cupH = detail === 'min' ? 36 : 31;
  const lineH = detail === 'mid' ? 10 : 8;
  const lines = detail === 'full' ? [[36, 62], [28, 78], [20, 94]]
    : detail === 'mid' ? [[34, 66], [22, 88]]
      : [];
  return (x, y) => {
    let d = band(x, y, 64, cy, radius, half);
    d = Math.min(d, roundRect(x, y, 64 - radius + cupW / 2 - half, cy + cupH / 2 - 1, cupW / 2, cupH / 2, cupW / 2.3));
    d = Math.min(d, roundRect(x, y, 64 + radius - cupW / 2 + half, cy + cupH / 2 - 1, cupW / 2, cupH / 2, cupW / 2.3));
    for (const [w, ly] of lines) d = Math.min(d, roundRect(x, y, 47 + w / 2, ly, w / 2, lineH / 2, lineH / 2));
    return d;
  };
}

export function renderIcon(size) {
  const { pad, radius, detail } = layoutFor(size);
  const mark = markFor(detail);
  const samples = 8;
  const scale = 128 / (128 - 2 * pad);
  const out = Buffer.alloc(size * size * 4);
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const x = ((px + (sx + 0.5) / samples) * 128 / size - pad) * scale;
          const y = ((py + (sy + 0.5) / samples) * 128 / size - pad) * scale;
          if (roundRect(x, y, 64, 64, 64, 64, radius) > 0) continue;
          const t = Math.min(1, Math.max(0, (x + y) / 256));
          const white = mark(x, y) <= 0;
          r += white ? 255 : FROM[0] + (TO[0] - FROM[0]) * t;
          g += white ? 255 : FROM[1] + (TO[1] - FROM[1]) * t;
          b += white ? 255 : FROM[2] + (TO[2] - FROM[2]) * t;
          hits++;
        }
      }
      const i = (py * size + px) * 4;
      if (hits) {
        out[i] = Math.round(r / hits);
        out[i + 1] = Math.round(g / hits);
        out[i + 2] = Math.round(b / hits);
      }
      out[i + 3] = Math.round((255 * hits) / (samples * samples));
    }
  }
  return encodePng(size, out);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [sizeArg, outArg] = process.argv.slice(2);
  const jobs = sizeArg
    ? [[Number(sizeArg), path.resolve(outArg || `icon${sizeArg}.png`)]]
    : [16, 32, 48, 128].map((s) => [s, path.join(ROOT, 'icons', `icon${s}.png`)]);
  for (const [size, file] of jobs) {
    if (!Number.isInteger(size) || size < 16 || size > 1024) {
      console.error(`size must be a whole number from 16 to 1024, got ${sizeArg}`);
      process.exit(1);
    }
    fs.writeFileSync(file, renderIcon(size));
    console.log(`${path.relative(process.cwd(), file)}  ${size}x${size}`);
  }
}
