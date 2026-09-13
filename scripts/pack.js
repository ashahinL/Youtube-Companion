#!/usr/bin/env node
/**
 * Chrome Web Store / Edge Add-ons zip. Packed from the tree as Chrome
 * loads it — no extra files, same bytes on every machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const INCLUDE_DIRS = ['_locales', 'icons', 'src'];

// Frozen so two packs of the same tree are byte-identical.
const DOS_TIME = 0;
const DOS_DATE = 0x0021; // 1980-01-01
const UTF8_FLAG = 1 << 11;
const VERSION = 20;

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;

const ZIP32_MAX_SIZE = 0xffffffff;
const ZIP32_MAX_COUNT = 0xffff;

function skipName(name) {
  return name.startsWith('.') || name === '.DS_Store';
}

function walkFiles(absDir, relDir, out) {
  if (!fs.existsSync(absDir)) return;
  for (const ent of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (skipName(ent.name)) continue;
    const abs = path.join(absDir, ent.name);
    const rel = `${relDir}/${ent.name}`;
    if (ent.isDirectory()) walkFiles(abs, rel, out);
    else if (ent.isFile()) out.push(rel);
  }
}

export function packEntries(root) {
  const entries = ['manifest.json'];
  for (const dir of INCLUDE_DIRS) {
    walkFiles(path.join(root, dir), dir, entries);
  }
  entries.sort();
  return entries;
}

export function missingManifestFiles(root, entries) {
  const have = new Set(entries);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const needed = [];
  const add = (p) => {
    if (p) needed.push(p);
  };

  add(manifest.background?.service_worker);
  add(manifest.action?.default_popup);
  for (const v of Object.values(manifest.action?.default_icon || {})) add(v);
  for (const v of Object.values(manifest.icons || {})) add(v);
  for (const cs of manifest.content_scripts || []) {
    for (const f of [...(cs.js || []), ...(cs.css || [])]) add(f);
  }
  for (const war of manifest.web_accessible_resources || []) {
    for (const r of war.resources || []) add(r);
  }
  if (manifest.default_locale) {
    add(`_locales/${manifest.default_locale}/messages.json`);
  }

  const missing = [];
  const seen = new Set();
  for (const p of needed) {
    if (seen.has(p)) continue;
    seen.add(p);
    if (!have.has(p)) missing.push(p);
  }
  return missing;
}

function assertZip32(n, max, label) {
  if (n > max) throw new Error(`zip64 required: ${label} is ${n}`);
}

function u16(n) {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
}

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
}

function compress(data) {
  const deflated = zlib.deflateRawSync(data, { level: 9 });
  // Store when deflate does not shrink — equal size still costs an inflate.
  if (deflated.length < data.length) return { method: 8, bytes: deflated };
  return { method: 0, bytes: data };
}

export function buildZip(root) {
  const names = packEntries(root);
  const missing = missingManifestFiles(root, names);
  if (missing.length) {
    throw new Error(`missing manifest file: ${missing[0]}`);
  }

  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const name of names) {
    const data = fs.readFileSync(path.join(root, name));
    const crc = zlib.crc32(data);
    const { method, bytes } = compress(data);
    const nameBuf = Buffer.from(name, 'utf8');

    assertZip32(data.length, ZIP32_MAX_SIZE, `${name} uncompressed size`);
    assertZip32(bytes.length, ZIP32_MAX_SIZE, `${name} compressed size`);
    assertZip32(offset, ZIP32_MAX_SIZE, `${name} local header offset`);
    assertZip32(nameBuf.length, ZIP32_MAX_COUNT, `${name} file name length`);

    const local = Buffer.concat([
      u32(LOCAL_SIG),
      u16(VERSION),
      u16(UTF8_FLAG),
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(bytes.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      nameBuf,
      bytes,
    ]);

    const central = Buffer.concat([
      u32(CENTRAL_SIG),
      u16(VERSION),
      u16(VERSION),
      u16(UTF8_FLAG),
      u16(method),
      u16(DOS_TIME),
      u16(DOS_DATE),
      u32(crc),
      u32(bytes.length),
      u32(data.length),
      u16(nameBuf.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      nameBuf,
    ]);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  assertZip32(names.length, ZIP32_MAX_COUNT, 'entry count');
  const centralDir = Buffer.concat(centrals);
  assertZip32(offset, ZIP32_MAX_SIZE, 'central directory offset');
  assertZip32(centralDir.length, ZIP32_MAX_SIZE, 'central directory size');

  const eocd = Buffer.concat([
    u32(EOCD_SIG),
    u16(0),
    u16(0),
    u16(names.length),
    u16(names.length),
    u32(centralDir.length),
    u32(offset),
    u16(0),
  ]);

  return Buffer.concat([...locals, centralDir, eocd]);
}

function run() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const entries = packEntries(root);
  const missing = missingManifestFiles(root, entries);
  if (missing.length) {
    console.error(`missing manifest file: ${missing[0]}`);
    process.exit(1);
  }

  const zip = buildZip(root);
  const version = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')).version;
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  const out = path.join(dist, `companion-for-youtube-${version}.zip`);
  fs.writeFileSync(out, zip);
  console.log(out);
  console.log(`${entries.length} entries`);
  console.log(`${zip.length} bytes`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
