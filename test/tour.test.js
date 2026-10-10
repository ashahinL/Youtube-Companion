/**
 * The tour page: what `scripts/tour.js --build` writes for Pages, and the
 * scene data the player times itself by. No browser, no network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildApp } from '../scripts/tour.js';
import { CHAPTERS } from '../site/tour/scenes.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// src and href values of the tags that load something.
function loads(html) {
  return [...html.matchAll(/<(?:script|link|img)\b[^>]*\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
}

export default async function run(t) {
  t.section('the built popup');

  const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'tour-app-'));
  try {
    buildApp(dest);
    const html = fs.readFileSync(path.join(dest, 'popup.html'), 'utf8');
    t.check('the base is relative', /<head>\s*<base href="src\/popup\/">/.test(html), html.slice(0, 200));
    const scripts = [...html.matchAll(/<script\b[^>]*src="([^"]+)"/g)].map((m) => m[1]);
    t.check(
      'the two stubs come before the popup’s own scripts',
      scripts[0] === '../../scripts/shots/stub.js' && scripts[1] === '../../scripts/tour/stub-tour.js' && scripts.length > 2,
      JSON.stringify(scripts),
    );
    const missing = loads(html).filter((ref) => !fs.existsSync(path.join(dest, 'src/popup', ref)));
    t.check('every file popup.html loads is in the build', loads(html).length > 3 && missing.length === 0, JSON.stringify(missing));
    for (const rel of ['manifest.json', '_locales/en/messages.json', '_locales/ar/messages.json', 'scripts/shots/demo.js', 'icons/icon128.png']) {
      t.check(`${rel} is in the build`, fs.existsSync(path.join(dest, rel)));
    }
    const page = read('site/tour/index.html');
    const pageMissing = loads(page).filter((ref) => !/^https?:/.test(ref)).filter((ref) => {
      const rel = ref.startsWith('app/') ? path.join(dest, ref.slice(4)) : path.join(ROOT, 'site/tour', ref);
      return !fs.existsSync(rel);
    });
    t.check('every file the tour page loads exists', pageMissing.length === 0, JSON.stringify(pageMissing));
  } finally {
    fs.rmSync(dest, { recursive: true, force: true });
  }

  const stub = read('scripts/shots/stub.js');
  t.check(
    'the shots stub has no root-absolute paths left',
    !/'\/scripts\/shots\/demo\.js'|'\/manifest\.json'|return '\/' \+/.test(stub) && /document\.baseURI/.test(stub),
  );

  t.section('scenes');

  const steps = CHAPTERS.flatMap((ch) => ch.steps);
  t.check('seven chapters', CHAPTERS.length === 7, String(CHAPTERS.length));
  t.check('every chapter has a title and a blurb', CHAPTERS.every((ch) => ch.title && ch.blurb && ch.steps.length > 0));
  for (const [i, step] of steps.entries()) {
    t.check(
      `step ${i + 1} has a title, a caption, ms, setup and run`,
      typeof step.title === 'string' && step.title.length > 0
        && typeof step.caption === 'string' && step.caption.length > 0
        && Number.isFinite(step.ms) && step.ms >= 3000
        && typeof step.setup === 'function' && typeof step.run === 'function',
      step.title,
    );
  }
  // A deep link opens a step from its setup, so the setup has to choose the
  // camera's framing or the step inherits whatever the last one left.
  const setups = read('site/tour/scenes.js').split('async setup(stage)').slice(1).map((part) => part.split('async run(stage)')[0]);
  const unframed = setups.map((body, i) => (/camera\.focus|bothQueues\(stage\)/.test(body) ? -1 : i + 1)).filter((i) => i > 0);
  t.check('every setup frames the camera', setups.length === steps.length && unframed.length === 0, JSON.stringify(unframed));
  const total = steps.reduce((sum, step) => sum + step.ms, 0);
  t.check('the tour runs 2:40 to 3:10', total >= 160000 && total <= 190000, `${total / 1000}s`);
  const ids = read('site/tour/scenes.js').match(/'[\w-]{11}'/g) || [];
  const demo = read('scripts/shots/demo.js');
  const tourStub = read('scripts/tour/stub-tour.js');
  const unknown = ids.map((s) => s.slice(1, -1)).filter((id) => /[A-Z0-9_-]/.test(id) && !demo.includes(id) && !tourStub.includes(id));
  t.check('every video id a scene names is in the demo data', unknown.length === 0, JSON.stringify(unknown));
}
