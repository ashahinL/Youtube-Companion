/**
 * Draws the extension icon — a C with a small moon in its open side, the
 * companion that goes along, on an indigo-to-purple tile — and writes it
 * as PNG. The icon is geometry rather
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

// A ring with an opening centred on the right, with round ends.
function openRing(x, y, cx, cy, radius, half, openDeg) {
  const angle = Math.abs(Math.atan2(cy - y, x - cx)) * 180 / Math.PI;
  if (angle >= openDeg) return Math.abs(Math.hypot(x - cx, y - cy) - radius) - half;
  const a = openDeg * Math.PI / 180;
  const ex = cx + radius * Math.cos(a);
  const ey = radius * Math.sin(a);
  return Math.min(Math.hypot(x - ex, y - (cy - ey)), Math.hypot(x - ex, y - (cy + ey))) - half;
}

/* At 16px the ring goes thin and the moon closes the gap, so the smallest
 * size draws both heavier and opens the ring wider. Chrome wants 16px of
 * transparent margin around the 128px icon; the toolbar sizes fill their
 * square. */
function layoutFor(size) {
  if (size <= 16) return { pad: 0, radius: 26, detail: 'min' };
  if (size <= 32) return { pad: 2, radius: 28, detail: 'full' };
  if (size <= 48) return { pad: 4, radius: 28, detail: 'full' };
  if (size <= 128) return { pad: 16, radius: 28, detail: 'full' };
  return { pad: 8, radius: 28, detail: 'full' };
}

// Signed distance to the white mark, in a 128-unit square.
function markFor(detail) {
  const ring = 33;
  const half = detail === 'min' ? 10 : 8;
  const open = detail === 'min' ? 58 : 42;
  const moon = detail === 'min' ? 11 : 8.5;
  return (x, y) => Math.min(
    openRing(x, y, 64, 64, ring, half, open),
    Math.hypot(x - (64 + ring), y - 64) - moon,
  );
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
