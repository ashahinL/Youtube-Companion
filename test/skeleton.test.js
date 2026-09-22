/**
 * Manifest, locales, and package.json — the skeleton the rest of the
 * extension hangs off.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { thumbUrl, isAvatarUrl } from '../src/lib/yt.js';

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

  t.section('page rules');

  const csp = String(manifest.content_security_policy?.extension_pages || '');
  const directive = (name) => {
    const found = csp.split(';').map((part) => part.trim().split(/\s+/)).find((words) => words[0] === name);
    return found ? found.slice(1) : null;
  };
  t.check('scripts only from the extension', JSON.stringify(directive('script-src')) === JSON.stringify(["'self'"]), csp);
  t.check('no plugins', JSON.stringify(directive('object-src')) === JSON.stringify(["'none'"]), csp);
  t.check('no <base>', JSON.stringify(directive('base-uri')) === JSON.stringify(["'none'"]), csp);
  const imgSrc = directive('img-src') || [];
  // The hosts the code actually builds, so a new image host cannot slip past
  // the policy unnoticed and show up as broken pictures.
  t.check('thumbnails load', imgSrc.includes(new URL(thumbUrl('Od6M0AXpcxQ')).origin), JSON.stringify(imgSrc));
  for (const host of ['yt3.ggpht.com', 'yt3.googleusercontent.com']) {
    t.check(`channel pictures from ${host} load`, isAvatarUrl(`https://${host}/a`) && imgSrc.includes(`https://${host}`), JSON.stringify(imgSrc));
  }
  t.check(
    'no other image source',
    imgSrc.length === 4 && imgSrc.includes("'self'"),
    JSON.stringify(imgSrc),
  );

  const csList = manifest.content_scripts || [];
  const isolated = csList.find((entry) => (entry.js || []).includes('src/content/content.js')) || {};
  const main = csList.find((entry) => (entry.js || []).includes('src/content/inject.js')) || {};
  t.check(
    'isolated content_scripts matches youtube.com',
    Array.isArray(isolated.matches) && isolated.matches.includes('https://www.youtube.com/*'),
    JSON.stringify(isolated.matches),
  );
  t.check('isolated run_at is document_idle', isolated.run_at === 'document_idle', String(isolated.run_at));
  t.check(
    'isolated js is core.js then content.js',
    Array.isArray(isolated.js) && isolated.js[0] === 'src/content/core.js' && isolated.js[1] === 'src/content/content.js',
    JSON.stringify(isolated.js),
  );
  t.check(
    'isolated js does not include inject.js',
    Array.isArray(isolated.js) && !isolated.js.includes('src/content/inject.js'),
    JSON.stringify(isolated.js),
  );
  t.check(
    'content_scripts css includes overlay.css',
    Array.isArray(isolated.css) && isolated.css.includes('src/content/overlay.css'),
    JSON.stringify(isolated.css),
  );
  t.check(
    'inject.js is a MAIN-world content script',
    main.world === 'MAIN'
      && Array.isArray(main.js)
      && main.js.length === 1
      && main.js[0] === 'src/content/inject.js'
      && Array.isArray(main.matches)
      && main.matches.includes('https://www.youtube.com/*'),
    JSON.stringify(main),
  );
  t.check('inject.js run_at is document_start', main.run_at === 'document_start', String(main.run_at));
  const minChrome = parseInt(String(manifest.minimum_chrome_version || ''), 10);
  t.check(
    'minimum_chrome_version is at least 111',
    Number.isFinite(minChrome) && minChrome >= 111,
    String(manifest.minimum_chrome_version),
  );

  t.check(
    'the popup has a suggested shortcut of its own',
    manifest.commands?._execute_action?.suggested_key?.default === 'Alt+Shift+Y',
    JSON.stringify(manifest.commands),
  );
  t.check(
    'commands has toggle-audio-mode',
    !!manifest.commands && typeof manifest.commands['toggle-audio-mode'] === 'object',
    JSON.stringify(manifest.commands),
  );

  t.check(
    'web_accessible_resources is absent',
    !Object.prototype.hasOwnProperty.call(manifest, 'web_accessible_resources')
      && !(manifest.web_accessible_resources && manifest.web_accessible_resources.length),
    JSON.stringify(manifest.web_accessible_resources),
  );

  t.section('locales');

  const en = json('_locales/en/messages.json');
  const ar = json('_locales/ar/messages.json');
  t.check('en has tabAudio', 'tabAudio' in en);
  t.check('ar has tabAudio', 'tabAudio' in ar);
  t.check(
    'en groups-on-YouTube label',
    en.settingsGroupsOnYouTube?.message === 'My groups on YouTube',
    en.settingsGroupsOnYouTube?.message,
  );
  t.check(
    'en groups-on-YouTube title names the subscriptions page',
    /subscriptions page/.test(en.settingsGroupsOnYouTubeTitle?.message || ''),
    en.settingsGroupsOnYouTubeTitle?.message,
  );
  t.check(
    'ar groups-on-YouTube strings exist',
    typeof ar.settingsGroupsOnYouTube?.message === 'string'
      && ar.settingsGroupsOnYouTube.message.length > 0
      && typeof ar.settingsGroupsOnYouTubeTitle?.message === 'string'
      && ar.settingsGroupsOnYouTubeTitle.message.length > 0,
  );
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
