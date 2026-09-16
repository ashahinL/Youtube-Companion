#!/usr/bin/env node
/**
 * Static checks that don't need a browser:
 *   - manifest.json is valid JSON and is MV3
 *   - every file the manifest references actually exists
 *   - every source file parses
 *   - the popup's and welcome page's css/js references resolve on disk
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
  const isolated = csList.find((entry) => (entry.js || []).includes('src/content/content.js'));
  const main = csList.find((entry) => (entry.js || []).includes('src/content/inject.js'));
  if (!isolated) bad('isolated content script (content.js) is missing');
  else {
    if ((isolated.matches || []).includes('https://www.youtube.com/*')) ok('isolated matches https://www.youtube.com/*');
    else bad('isolated content_scripts matches', JSON.stringify(isolated.matches));
    if (isolated.run_at === 'document_idle') ok('isolated run_at is document_idle');
    else bad('isolated run_at is not document_idle', String(isolated.run_at));
    if (isolated.world && isolated.world !== 'ISOLATED') {
      bad('content.js must stay in the isolated world', String(isolated.world));
    } else {
      ok('content.js stays isolated');
    }
    const js = isolated.js || [];
    if (js[0] === 'src/content/core.js' && js[1] === 'src/content/content.js' && !js.includes('src/content/inject.js')) {
      ok('isolated js is core.js then content.js');
    } else {
      bad('isolated js order', JSON.stringify(js));
    }
    const css = isolated.css || [];
    if (css.includes('src/content/overlay.css')) ok('css includes overlay.css');
    else bad('css missing overlay.css', JSON.stringify(css));
  }
  if (!main) bad('MAIN-world inject.js content script is missing');
  else {
    if ((main.matches || []).includes('https://www.youtube.com/*')) ok('MAIN inject.js matches https://www.youtube.com/*');
    else bad('MAIN inject.js matches', JSON.stringify(main.matches));
    if (main.world === 'MAIN') ok('inject.js world is MAIN');
    else bad('inject.js world is not MAIN', String(main.world));
    if (main.run_at === 'document_start') ok('inject.js run_at is document_start');
    else bad('inject.js run_at is not document_start', String(main.run_at));
    const js = main.js || [];
    if (js.length === 1 && js[0] === 'src/content/inject.js') ok('MAIN js is only inject.js');
    else bad('MAIN js', JSON.stringify(js));
  }
}

const cmd = manifest.commands && manifest.commands['toggle-audio-mode'];
if (cmd && typeof cmd.description === 'string' && cmd.description.length) ok('toggle-audio-mode command is declared');
else bad('commands.toggle-audio-mode is missing');

const warList = manifest.web_accessible_resources || [];
if (!warList.length) ok('no web_accessible_resources');
else bad('web_accessible_resources must be absent', JSON.stringify(warList));

const minChrome = parseInt(String(manifest.minimum_chrome_version || ''), 10);
if (Number.isFinite(minChrome) && minChrome >= 111) ok(`minimum_chrome_version is ${manifest.minimum_chrome_version}`);
else bad('minimum_chrome_version must be >= 111', String(manifest.minimum_chrome_version));

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

for (const file of ['src', 'test', 'scripts', 'site'].flatMap((dir) => walk(path.join(ROOT, dir)))) {
  const rel = path.relative(ROOT, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    ok(rel);
  } catch (err) {
    bad(rel, String(err.stderr || err.message).split('\n')[2]?.trim() || '');
  }
}

/* ---- extension page references ------------------------------------ */
for (const page of ['src/popup/popup.html', 'src/welcome/welcome.html']) {
  const name = path.basename(page);
  console.log(`\n${name} assets`);
  const dir = path.join(ROOT, path.dirname(page));
  const html = fs.readFileSync(path.join(ROOT, page), 'utf8');
  for (const ref of [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1])) {
    if (/^https?:/.test(ref)) continue;
    if (fs.existsSync(path.join(dir, ref))) ok(`${name} -> ${ref}`);
    else bad(`${name} references missing ${ref}`);
  }
}

console.log(`\n${failures ? `${failures} problem(s)` : 'all checks passed'}\n`);
process.exit(failures ? 1 : 0);
