/**
 * The icons on disk are exactly what scripts/draw-icon.js renders, so the
 * geometry stays the source and a hand-edited PNG cannot slip in unnoticed.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { renderIcon } from '../scripts/draw-icon.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function decodePng(buf) {
  const size = buf.readUInt32BE(16);
  const idat = [];
  for (let p = 8; p < buf.length;) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    if (type === 'IDAT') idat.push(buf.subarray(p + 8, p + 8 + len));
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = (x, y) => {
    const i = y * (size * 4 + 1) + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
  return { size, colourType: buf[25], px };
}

export default async function run(t) {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

  for (const size of [16, 32, 48, 128]) {
    t.section(`icon${size}.png`);
    const file = path.join(ROOT, 'icons', `icon${size}.png`);
    const disk = fs.readFileSync(file);
    t.check('matches what the script renders', disk.equals(renderIcon(size)), 'run: node scripts/draw-icon.js');

    const png = decodePng(disk);
    t.check('is square at its size', png.size === size, String(png.size));
    t.check('is RGBA', png.colourType === 6, String(png.colourType));
    t.check('the manifest points at it', manifest.icons?.[size] === `icons/icon${size}.png`);

    // Somewhere on the tile, away from the white mark: bottom-left, inside the corner radius.
    const [r, g, b, a] = png.px(Math.floor(size * 0.3), Math.floor(size * 0.85));
    t.check('the tile is not YouTube red', a > 0 && !(r > 180 && g < 60 && b < 60), JSON.stringify([r, g, b, a]));
  }

  t.section('store margin');
  const big = decodePng(fs.readFileSync(path.join(ROOT, 'icons', 'icon128.png')));
  t.check('the 128px icon keeps a transparent margin', big.px(4, 64)[3] === 0 && big.px(64, 4)[3] === 0);
}
