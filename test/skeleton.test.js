/**
 * Manifest, locales, and package.json — the skeleton the rest of the
 * extension hangs off.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const json = (rel) => JSON.parse(read(rel));

export default async function run(t) {
  t.section('manifest');

  let manifest;
  try {
    manifest = json('manifest.json');
    t.check('manifest.json parses', typeof manifest === 'object' && manifest !== null);
  } catch (err) {
    t.check('manifest.json parses', false, err.message);
    return;
  }

  t.check('is MV3', manifest.manifest_version === 3, String(manifest.manifest_version));

  const expectedPerms = [
    'storage',
    'alarms',
    'notifications',
    'declarativeNetRequestWithHostAccess',
    'activeTab',
  ];
  const perms = manifest.permissions || [];
  t.check(
    'has storage, alarms, notifications, declarativeNetRequestWithHostAccess, activeTab',
    perms.length === expectedPerms.length && expectedPerms.every((p) => perms.includes(p)),
    JSON.stringify(perms),
  );

  const hosts = manifest.host_permissions || [];
  t.check(
    'host_permissions is exactly https://www.youtube.com/*',
    hosts.length === 1 && hosts[0] === 'https://www.youtube.com/*',
    JSON.stringify(hosts),
  );

  const cs = (manifest.content_scripts || [])[0] || {};
  t.check(
    'content_scripts matches youtube.com',
    Array.isArray(cs.matches) && cs.matches.includes('https://www.youtube.com/*'),
    JSON.stringify(cs.matches),
  );
  t.check('content_scripts run_at is document_idle', cs.run_at === 'document_idle', String(cs.run_at));
  t.check(
    'content_scripts js is core.js then content.js',
    Array.isArray(cs.js) && cs.js[0] === 'src/content/core.js' && cs.js[1] === 'src/content/content.js',
    JSON.stringify(cs.js),
  );
  t.check(
    'content_scripts css includes overlay.css',
    Array.isArray(cs.css) && cs.css.includes('src/content/overlay.css'),
    JSON.stringify(cs.css),
  );

  t.check(
    'commands has toggle-audio-mode',
    !!manifest.commands && typeof manifest.commands['toggle-audio-mode'] === 'object',
    JSON.stringify(manifest.commands),
  );

  const war = (manifest.web_accessible_resources || [])[0] || {};
  t.check(
    'web_accessible_resources lists inject.js for youtube.com',
    Array.isArray(war.resources)
      && war.resources.includes('src/content/inject.js')
      && Array.isArray(war.matches)
      && war.matches.includes('https://www.youtube.com/*'),
    JSON.stringify(war),
  );

  t.section('locales');

  const en = json('_locales/en/messages.json');
  const ar = json('_locales/ar/messages.json');
  t.check('en has tabAudio', 'tabAudio' in en);
  t.check('ar has tabAudio', 'tabAudio' in ar);
  const enKeys = Object.keys(en).sort();
  const arKeys = Object.keys(ar).sort();
  t.check(
    'en and ar have identical key sets',
    enKeys.join() === arKeys.join(),
    `en=${enKeys.join(',')} ar=${arKeys.join(',')}`,
  );

  for (const [locale, messages] of [['en', en], ['ar', ar]]) {
    for (const [key, entry] of Object.entries(messages)) {
      t.check(
        `${locale}.${key} has a non-empty message`,
        typeof entry?.message === 'string' && entry.message.length > 0,
        JSON.stringify(entry?.message),
      );
      t.check(
        `${locale}.${key} has a non-empty description`,
        typeof entry?.description === 'string' && entry.description.length > 0,
        JSON.stringify(entry?.description),
      );
    }
  }

  const placeholders = [...JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g)].map((m) => m[1]);
  for (const key of placeholders) {
    t.check(`manifest placeholder __MSG_${key}__ resolves in en`, key in en);
  }

  t.section('package.json');

  const pkg = json('package.json');
  const scripts = pkg.scripts || {};
  for (const name of ['test', 'test:verbose', 'test:json', 'check']) {
    t.check(`has ${name} script`, typeof scripts[name] === 'string' && scripts[name].length > 0);
  }
}
