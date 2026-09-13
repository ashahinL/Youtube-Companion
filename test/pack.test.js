/**
 * Store zip: entry set, round-trip bytes, determinism, and manifest coverage.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { buildZip, packEntries, missingManifestFiles } from '../scripts/pack.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const UTF8_FLAG = 1 << 11;

const FORBIDDEN_PREFIXES = ['test/', 'docs/', 'scripts/', 'dist/', '.claude/'];
const FORBIDDEN_FILES = ['package.json', 'README.md', 'CLAUDE.md', 'DESIGN.md', 'LICENSE'];

function skipName(name) {
  return name.startsWith('.') || name === '.DS_Store';
}

function walkExpected(root) {
  const out = ['manifest.json'];
  function walk(absDir, relDir) {
    for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (skipName(ent.name)) continue;
      const abs = path.join(absDir, ent.name);
      const rel = `${relDir}/${ent.name}`;
      if (ent.isDirectory()) walk(abs, rel);
      else if (ent.isFile()) out.push(rel);
    }
  }
  for (const dir of ['_locales', 'icons', 'src']) {
    walk(path.join(root, dir), dir);
  }
  out.sort();
  return out;
}

function sameList(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

function findEocd(buf) {
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen === buf.length) return i;
  }
  throw new Error('end-of-central-directory record not found');
}

function readZip(buf) {
  const eocd = findEocd(buf);
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== CENTRAL_SIG) {
      throw new Error(`bad central directory signature at ${p}`);
    }
    const flag = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;

    if (buf.readUInt32LE(localOff) !== LOCAL_SIG) {
      throw new Error(`bad local header signature for ${name}`);
    }
    const localFlag = buf.readUInt16LE(localOff + 6);
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    const compressed = buf.subarray(dataStart, dataStart + compSize);
    const bytes = method === 8
      ? zlib.inflateRawSync(compressed)
      : Buffer.from(compressed);

    entries.push({ name, method, crc, flag, localFlag, bytes });
  }
  return entries;
}

export default async function run(t) {
  const packed = packEntries(ROOT);
  const zip = buildZip(ROOT);
  const entries = readZip(zip);
  const names = entries.map((e) => e.name);
  const expected = walkExpected(ROOT);

  t.section('entry set');

  t.check(
    'manifest.json is an entry at the zip root',
    names.includes('manifest.json') && !names.some((n) => n !== 'manifest.json' && n.endsWith('/manifest.json')),
    names.filter((n) => n.endsWith('manifest.json')).join(', '),
  );
  t.check('entry set equals packEntries', sameList(names, packed), names.join('\n'));
  t.check('packEntries equals the included tree', sameList(packed, expected), packed.join('\n'));

  const leakedPrefix = names.find((n) => FORBIDDEN_PREFIXES.some((p) => n.startsWith(p)));
  t.check('no test/docs/scripts/dist/.claude entries', !leakedPrefix, leakedPrefix || '');
  const leakedFile = names.find((n) => FORBIDDEN_FILES.includes(n));
  t.check('no package.json/README/CLAUDE/DESIGN/LICENSE', !leakedFile, leakedFile || '');

  t.section('contents');

  for (const e of entries) {
    const disk = fs.readFileSync(path.join(ROOT, e.name));
    t.check(`${e.name} inflates to disk bytes`, e.bytes.equals(disk));
    t.check(`${e.name} crc matches`, e.crc === zlib.crc32(disk), String(e.crc));
  }

  t.section('determinism');

  t.check('two buildZip calls return equal buffers', zip.equals(buildZip(ROOT)));

  t.section('manifest coverage');

  const missing = missingManifestFiles(ROOT, packed);
  t.check('real repo is complete', missing.length === 0, JSON.stringify(missing));

  const withoutPopup = packed.filter((p) => p !== 'src/popup/popup.html');
  const named = missingManifestFiles(ROOT, withoutPopup);
  t.check(
    'names popup.html when that path is removed',
    named.length === 1 && named[0] === 'src/popup/popup.html',
    JSON.stringify(named),
  );

  t.section('zip format');

  t.check(
    'every entry name uses forward slashes',
    names.every((n) => n.includes('/') || n === 'manifest.json') && names.every((n) => !n.includes('\\')),
    names.join(', '),
  );
  t.check(
    'UTF-8 flag is set on every entry',
    entries.every((e) => (e.flag & UTF8_FLAG) !== 0 && (e.localFlag & UTF8_FLAG) !== 0),
  );
}
