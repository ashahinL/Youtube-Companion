#!/usr/bin/env node
/**
 * Static checks that don't need a browser:
 *   - manifest.json is valid JSON and is MV3
 *   - every file the manifest references actually exists
 *   - every source file parses
 *   - popup.html's css/js references resolve on disk
 *
 * Cheap to run and catches the class of mistake that otherwise only shows up
 * as a silent "failed to load extension" in Chrome.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label, detail) => {
  failures++;
  console.log(`  ✗ ${label}${detail ? `  ${detail}` : ''}`);
};

/* ---- manifest ------------------------------------------------------ */
console.log('\nmanifest');
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  ok(`valid JSON (manifest v${manifest.manifest_version})`);
} catch (err) {
  bad('manifest.json does not parse', err.message);
  process.exit(1);
}

if (manifest.manifest_version === 3) ok('manifest_version is 3');
else bad('manifest_version is not 3', String(manifest.manifest_version));

const referenced = new Set([manifest.background?.service_worker, manifest.action?.default_popup]);
for (const cs of manifest.content_scripts || []) {
  for (const f of [...(cs.js || []), ...(cs.css || [])]) referenced.add(f);
}
for (const v of Object.values(manifest.action?.default_icon || {})) referenced.add(v);
for (const v of Object.values(manifest.icons || {})) referenced.add(v);
for (const war of manifest.web_accessible_resources || []) {
  for (const r of war.resources || []) referenced.add(r);
}
referenced.delete(undefined);

const missing = [...referenced].filter((f) => !fs.existsSync(path.join(ROOT, f)));
if (missing.length) bad(`${missing.length} referenced file(s) missing`, missing.join(', '));
else ok(`all ${referenced.size} referenced files resolve`);

console.log('\ncontent scripts');
const csList = manifest.content_scripts || [];
if (!csList.length) bad('content_scripts is missing');
else {
  const cs = csList[0];
  if ((cs.matches || []).includes('https://www.youtube.com/*')) ok('matches https://www.youtube.com/*');
  else bad('content_scripts matches', JSON.stringify(cs.matches));
  if (cs.run_at === 'document_idle') ok('run_at is document_idle');
  else bad('run_at is not document_idle', String(cs.run_at));
  const js = cs.js || [];
  if (js[0] === 'src/content/core.js' && js[1] === 'src/content/content.js' && js.length === 2) {
    ok('js is core.js then content.js');
  } else {
    bad('js order', JSON.stringify(js));
  }
  if (js.includes('src/content/inject.js')) {
    bad('inject.js is a content_scripts js entry; it must be MAIN-world via web_accessible_resources');
  }
  const css = cs.css || [];
  if (css.includes('src/content/overlay.css')) ok('css includes overlay.css');
  else bad('css missing overlay.css', JSON.stringify(css));
}

const cmd = manifest.commands && manifest.commands['toggle-audio-mode'];
if (cmd && typeof cmd.description === 'string' && cmd.description.length) ok('toggle-audio-mode command is declared');
else bad('commands.toggle-audio-mode is missing');

const warList = manifest.web_accessible_resources || [];
const warHit = warList.some((entry) => (
  Array.isArray(entry.resources)
  && entry.resources.includes('src/content/inject.js')
  && Array.isArray(entry.matches)
  && entry.matches.includes('https://www.youtube.com/*')
));
if (warHit) ok('inject.js is web-accessible on youtube.com');
else bad('web_accessible_resources does not expose inject.js on youtube.com');

/* ---- source parses -------------------------------------------------- */
console.log('\nsyntax');
function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

for (const file of [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'test'))]) {
  const rel = path.relative(ROOT, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    ok(rel);
  } catch (err) {
    bad(rel, String(err.stderr || err.message).split('\n')[2]?.trim() || '');
  }
}

/* ---- popup html references ------------------------------------------ */
console.log('\npopup assets');
const popupDir = path.join(ROOT, 'src/popup');
const html = fs.readFileSync(path.join(popupDir, 'popup.html'), 'utf8');
for (const ref of [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])) {
  if (/^https?:/.test(ref)) continue;
  if (fs.existsSync(path.join(popupDir, ref))) ok(`popup.html -> ${ref}`);
  else bad(`popup.html references missing ${ref}`);
}

console.log(`\n${failures ? `${failures} problem(s)` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
