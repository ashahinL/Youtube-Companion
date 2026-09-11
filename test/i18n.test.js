/**
 * Locale resolution, message loading, translation, and direction.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  resolveLocale,
  loadMessages,
  translate,
  direction,
  applyTo,
  applyDirection,
} from '../src/lib/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

export default async function run(t) {
  t.section('resolveLocale');

  t.check("auto + ar is ar", resolveLocale('auto', 'ar') === 'ar');
  t.check("auto + ar-EG is ar", resolveLocale('auto', 'ar-EG') === 'ar');
  t.check("auto + en is en", resolveLocale('auto', 'en') === 'en');
  t.check("auto + en-GB is en", resolveLocale('auto', 'en-GB') === 'en');
  t.check("auto + fr is en", resolveLocale('auto', 'fr') === 'en');
  t.check("auto + missing is en", resolveLocale('auto', undefined) === 'en');
  t.check("auto + empty is en", resolveLocale('auto', '') === 'en');
  t.check("explicit en ignores ar browser", resolveLocale('en', 'ar') === 'en');
  t.check("explicit ar ignores en browser", resolveLocale('ar', 'en') === 'ar');
  t.check("explicit en ignores fr browser", resolveLocale('en', 'fr') === 'en');

  t.section('translate');

  const map = {
    hi: 'Hello $1',
    two: '$1 and $2',
    plain: 'Ready',
  };
  t.check('substitutes $1', translate(map, 'hi', ['Ada']) === 'Hello Ada');
  t.check('substitutes two slots', translate(map, 'two', ['A', 'B']) === 'A and B');
  t.check('missing key returns the key', translate(map, 'nope') === 'nope');
  t.check('missing key ignores substitutions', translate(map, 'missing', ['x']) === 'missing');
  t.check(
    'extra substitutions do not throw',
    translate(map, 'hi', ['Ada', 'extra']) === 'Hello Ada',
  );
  t.check(
    'missing substitutions do not throw',
    translate(map, 'two', ['only']) === 'only and ',
  );
  t.check(
    'null substitutions do not throw',
    translate(map, 'hi', null) === 'Hello ',
  );
  t.check(
    'undefined substitutions do not throw',
    translate(map, 'hi') === 'Hello ',
  );
  t.check('no slots is unchanged', translate(map, 'plain', ['x']) === 'Ready');
  t.check('empty map returns the key', translate({}, 'hi') === 'hi');
  t.check('null map returns the key', translate(null, 'hi') === 'hi');

  t.section('direction');

  t.check('ar is rtl', direction('ar') === 'rtl');
  t.check('en is ltr', direction('en') === 'ltr');
  t.check('unknown is ltr', direction('fr') === 'ltr');

  t.section('loadMessages');

  const previousFetch = globalThis.fetch;
  const previousChrome = globalThis.chrome;
  let fetchCount = 0;

  globalThis.chrome = {
    runtime: {
      getURL(p) {
        return 'https://ext/' + String(p || '').replace(/^\//, '');
      },
    },
  };
  globalThis.fetch = async (url) => {
    fetchCount++;
    const rel = String(url).replace(/^https:\/\/ext\//, '');
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    return { ok: true, async json() { return JSON.parse(text); } };
  };

  try {
    const first = await loadMessages('en');
    const second = await loadMessages('en');
    t.check('second loadMessages does not refetch', fetchCount === 1, String(fetchCount));
    t.check('cached map is the same object', first === second);
    t.check(
      'nNewVideos named placeholder becomes $1',
      first.nNewVideos === '$1 new videos',
      first.nNewVideos,
    );
    t.check(
      'translate uses the resolved $1',
      translate(first, 'nNewVideos', ['3']) === '3 new videos',
      translate(first, 'nNewVideos', ['3']),
    );
    t.check(
      'two-placeholder message resolves in order',
      first.settingsImportAdded === 'Added $1 channels, $2 already present.',
      first.settingsImportAdded,
    );
    t.check(
      'settingsImportAdded substitutes both slots',
      translate(first, 'settingsImportAdded', ['3', '1']) === 'Added 3 channels, 1 already present.',
      translate(first, 'settingsImportAdded', ['3', '1']),
    );

    const ar = await loadMessages('ar');
    t.check('loading ar fetches once more', fetchCount === 2, String(fetchCount));
    t.check(
      'ar nNewVideos placeholder becomes $1',
      typeof ar.nNewVideos === 'string' && ar.nNewVideos.includes('$1') && !ar.nNewVideos.includes('$COUNT$'),
      ar.nNewVideos,
    );
    const arAgain = await loadMessages('ar');
    t.check('second ar load does not refetch', fetchCount === 2, String(fetchCount));
    t.check('ar cache is the same object', ar === arAgain);
  } finally {
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }

  t.section('applyTo');

  function fakeEl(attrs) {
    return {
      attrs: { ...attrs },
      textContent: '',
      getAttribute(name) { return this.attrs[name]; },
      setAttribute(name, value) { this.attrs[name] = value; },
    };
  }
  const nodes = [
    fakeEl({ 'data-i18n': 'hi' }),
    fakeEl({ 'data-i18n-title': 'hi' }),
    fakeEl({ 'data-i18n-placeholder': 'hi' }),
    fakeEl({ 'data-i18n-label': 'hi' }),
  ];
  const root = {
    querySelectorAll(sel) {
      const name = sel.slice(1, -1);
      return nodes.filter((n) => Object.prototype.hasOwnProperty.call(n.attrs, name));
    },
  };
  applyTo(root, { hi: 'Hello' });
  t.check('data-i18n sets textContent', nodes[0].textContent === 'Hello', nodes[0].textContent);
  t.check('data-i18n-title sets title', nodes[1].attrs.title === 'Hello', String(nodes[1].attrs.title));
  t.check(
    'data-i18n-placeholder sets placeholder',
    nodes[2].attrs.placeholder === 'Hello',
    String(nodes[2].attrs.placeholder),
  );
  t.check(
    'data-i18n-label sets aria-label',
    nodes[3].attrs['aria-label'] === 'Hello',
    String(nodes[3].attrs['aria-label']),
  );
  applyTo(root, {});
  t.check('missing key is visible', nodes[0].textContent === 'hi', nodes[0].textContent);

  t.section('applyDirection');

  const html = { lang: '', dir: '', attrs: {} };
  html.setAttribute = (name, value) => { html.attrs[name] = value; };
  applyDirection({ documentElement: html }, 'ar');
  t.check('arabic sets lang=ar', html.lang === 'ar', html.lang);
  t.check('arabic sets dir=rtl', html.dir === 'rtl', html.dir);
  applyDirection({ documentElement: html }, 'en');
  t.check('english sets lang=en', html.lang === 'en', html.lang);
  t.check('english sets dir=ltr', html.dir === 'ltr', html.dir);

  t.section('en vs ar copy');

  const en = json('_locales/en/messages.json');
  const ar = json('_locales/ar/messages.json');
  // Language names stay in their own language in both files.
  const allowSame = new Set(['settingsLocaleEn', 'settingsLocaleAr']);
  for (const key of Object.keys(en)) {
    if (!(key in ar)) continue;
    if (allowSame.has(key)) continue;
    t.check(
      `${key} differs between en and ar`,
      en[key].message !== ar[key].message,
      JSON.stringify({ en: en[key].message, ar: ar[key].message }),
    );
  }
}
