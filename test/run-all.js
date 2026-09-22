#!/usr/bin/env node
/**
 * Runs every suite in-process and aggregates the result.
 *
 * Suites run sequentially and each installs its own chrome mock, so ordering
 * doesn't leak state between them. No dependencies — `node test/run-all.js`.
 */

import { createReporter } from './helpers/report.js';

const args = new Set(process.argv.slice(2));
const mode = args.has('--json') ? 'json' : (args.has('--summary') ? 'summary' : 'verbose');

const SUITES = [
  ['manifest + locales', './skeleton.test.js'],
  ['popup shell',        './popup.test.js'],
  ['popup view',         './view.test.js'],
  ['welcome page',       './welcome.test.js'],
  ["what's new page",    './whatsnew.test.js'],
  ['shots',              './shots.test.js'],
  ['formatting',         './fmt.test.js'],
  ['i18n',               './i18n.test.js'],
  ['yt wire layer',      './yt.test.js'],
  ['settings',           './settings.test.js'],
  ['audio cover',        './cover.test.js'],
  ['store',              './store.test.js'],
  ['backup',             './backup.test.js'],
  ['takeout import',     './takeout.test.js'],
  ['subscription scan',  './subscriptions.test.js'],
  ['service worker',     './worker.test.js'],
  ['audio-mode core',    './core.test.js'],
  ['audio-mode engine',  './audio-engine.test.js'],
  ['store package',      './pack.test.js'],
  ['icon',               './icon.test.js'],
  ['support',            './support.test.js'],
];

const results = [];

for (const [name, modulePath] of SUITES) {
  if (mode !== 'json') console.log(`\n${'─'.repeat(56)}\n${name}`);
  const reporter = createReporter(name, { mode });
  try {
    const { default: run } = await import(modulePath);
    await run(reporter);
  } catch (err) {
    reporter.check(`suite crashed: ${err.message}`, false, err.stack?.split('\n')[1]?.trim() || '');
  }
  results.push(reporter.summary());
}

let totalPass = 0;
let totalFail = 0;
for (const r of results) {
  totalPass += r.pass;
  totalFail += r.fail;
}

if (mode === 'json') {
  console.log(JSON.stringify({ totalPass, totalFail, results }, null, 2));
} else {
  console.log(`\n${'═'.repeat(56)}`);
  for (const r of results) {
    const status = r.fail ? `${r.fail} FAILED` : 'ok';
    console.log(`  ${r.suiteName.padEnd(28)} ${String(r.pass).padStart(3)} passed  ${status}`);
  }

  console.log(`${'═'.repeat(56)}`);
  console.log(`  ${totalPass} passed, ${totalFail} failed`);

  if (totalFail) {
    console.log('\nFailures:');
    for (const r of results) {
      for (const f of r.failures) console.log(`  [${r.suiteName}] ${f.label}${f.detail ? `  (got: ${f.detail})` : ''}`);
    }
  }
}

process.exit(totalFail ? 1 : 0);
