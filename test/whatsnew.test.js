/**
 * What's new page, and the two ways the popup offers it. Text and file
 * assertions only — there is no DOM here, so the page script is not imported.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PAGE_SHOTS } from '../scripts/shots.js';
import { WHATS_NEW_VERSION, showWhatsNew } from '../src/lib/view.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export default async function run(t) {
  const html = read('src/whatsnew/whatsnew.html');
  const css = read('src/whatsnew/whatsnew.css');
  const js = read('src/whatsnew/whatsnew.js');
  const worker = read('src/background/service-worker.js');
  const popupHtml = read('src/popup/popup.html');
  const popupCss = read('src/popup/popup.css');
  const popupJs = read('src/popup/popup.js');
  const en = JSON.parse(read('_locales/en/messages.json'));
  const ar = JSON.parse(read('_locales/ar/messages.json'));

  t.section('the page');

  t.check('the popup opens this page', popupJs.includes("'src/whatsnew/whatsnew.html'"));
  t.check('three illustrated features', (html.match(/<li class="feature">/g) || []).length === 3);
  t.check(
    'each feature has a picture the script fills',
    ['shot-player', 'shot-feeds', 'shot-watchlist']
      .every((id) => html.includes(`id="${id}"`) && js.includes(`'${id}'`)),
  );
  t.check('the short list has nine lines', (html.match(/data-i18n="whatsNewMore(?!Title)/g) || []).length === 9);
  t.check('the page has the language select', /id="whatsnew-locale"/.test(html) && js.includes("'whatsnew-locale'"));
  t.check('the page loads the boot script before its stylesheet', (() => {
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    const bootAt = head.indexOf('<script src="../lib/theme-boot.js">');
    const cssAt = head.indexOf('<link rel="stylesheet"');
    return bootAt >= 0 && cssAt > bootAt;
  })());
  t.check(
    'the page loads one module script',
    /<script type="module" src="whatsnew\.js"><\/script>/.test(html)
      && (html.match(/<script\b/g) || []).length === 2,
  );

  const links = [...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]);
  t.check(
    'the changelog is the only outside link',
    JSON.stringify(links) === JSON.stringify(['https://github.com/ashahinL/Youtube-Companion/blob/main/CHANGELOG.md']),
    JSON.stringify(links),
  );
  t.check(
    'it opens without handing this page over',
    (html.match(/target="_blank"\s+rel="noopener noreferrer"/g) || []).length === links.length,
  );
  t.check('nothing else is loaded from another origin', !/(src|href)="https?:/.test(html.replace(/href="https:\/\/github\.com[^"]*"/g, '')));

  // Without this the browser paints light-page scrollbars on a dark page.
  const darkRoot = css.slice(css.indexOf(':root {'), css.indexOf('@media (prefers-color-scheme: light)'));
  const lightRoot = css.slice(css.indexOf('@media (prefers-color-scheme: light)'));
  t.check('the dark theme declares color-scheme: dark', /color-scheme:\s*dark/.test(darkRoot));
  t.check('the light theme declares color-scheme: light', /color-scheme:\s*light/.test(lightRoot));
  const boot = read('src/lib/theme-boot.js');
  t.check(
    'the boot script reads the stored choice synchronously',
    /localStorage\.getItem\(['"]companion\.theme['"]\)/.test(boot),
  );
  t.check(
    'every localStorage touch sits inside try/catch',
    boot.indexOf('try') >= 0
      && boot.indexOf('try') < boot.indexOf('localStorage')
      && boot.lastIndexOf('localStorage') < boot.lastIndexOf('catch'),
  );
  const forced = css.match(/:root\[data-theme='light'\]\s*\{[^}]*\}/);
  t.check(
    'forced light carries the light tokens',
    !!forced && /--bg:\s*#ffffff/.test(forced[0]) && /color-scheme:\s*light/.test(forced[0]),
    forced ? forced[0].slice(0, 120) : 'missing',
  );
  t.check(
    'a light OS still defers to a forced dark',
    /@media\s*\(prefers-color-scheme:\s*light\)\s*\{[^}]*:root:not\(\[data-theme='dark'\]\)/.test(css),
  );
  const sysLight = css.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{[^}]*:root:not\(\[data-theme='dark'\]\)\s*\{[^}]*\}/);
  t.check(
    'the OS-light block still declares color-scheme: light',
    !!sysLight && /color-scheme:\s*light/.test(sysLight[0]) && /--bg:\s*#ffffff/.test(sysLight[0]),
    sysLight ? sysLight[0].slice(0, 120) : 'missing',
  );
  t.check('the page applies the stored theme on load', js.includes('applyTheme(theme)'));
  t.check(
    'the theme comes from settings, next to the locale',
    js.includes('state?.settings?.ui?.theme') && js.includes('state?.settings?.ui?.locale'),
  );
  t.check('the body paints its own background', /body\s*\{[^}]*background:\s*var\(--bg\)/.test(css));
  t.check('the two columns stack on a narrow window', /@media \(max-width: 720px\)[\s\S]{0,200}grid-template-columns:\s*minmax\(0, 1fr\)/.test(css));

  t.section('one picture set per language');

  const files = PAGE_SHOTS.map((shot) => shot.file);
  t.check(
    'every scene is rendered in English and Arabic',
    JSON.stringify(files) === JSON.stringify([
      'player', 'feeds', 'watchlist', 'player-ar', 'feeds-ar', 'watchlist-ar',
    ]),
    JSON.stringify(files),
  );
  for (const file of files) {
    const rel = `src/whatsnew/img/${file}.png`;
    t.check(`${rel} exists`, fs.existsSync(path.join(ROOT, rel)));
  }
  t.check('the shots land inside the packaged page', read('scripts/shots.js').includes("'src/whatsnew/img'"));
  // A frame carrying the note would put a picture of the note on the page the
  // note points at, and into every store and site screenshot besides.
  t.check(
    'no rendered frame carries the note',
    read('scripts/shots/demo.js').includes(`whatsNewSeen: '${WHATS_NEW_VERSION}'`)
      && read('scripts/shots/stub.js').includes('whatsNewSeen:'),
  );
  t.check(
    'an Arabic reader gets the Arabic pictures',
    /locale === 'ar' \? '-ar' : ''/.test(js),
  );

  t.section('words');

  const attrKeys = [...html.matchAll(/data-i18n(?:-title|-label|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  const scriptKeys = [...js.matchAll(/'(whatsNew[A-Z]\w+)'/g)].map((m) => m[1]);
  const popupKeys = [...popupJs.matchAll(/'(whatsNew[A-Z]\w+)'/g)].map((m) => m[1]);
  const keys = new Set([...attrKeys, ...scriptKeys, ...popupKeys]);
  t.check('the page and the popup name some strings', keys.size >= 25, String(keys.size));
  for (const key of keys) {
    t.check(`${key} is in en and ar`, key in en && key in ar);
  }
  t.check(
    'the heading carries the release',
    en.whatsNewTitle.message.includes('$RELEASE$') && ar.whatsNewTitle.message.includes('$RELEASE$'),
  );
  t.check('the Arabic page is really Arabic', /[؀-ۿ]/.test(ar.whatsNewImportBody.message));

  t.section('offered once, reopened on purpose');

  t.check('showWhatsNew offers an unseen release', showWhatsNew('', '2.0') === true);
  t.check('and a release seen under another number', showWhatsNew('1.1', '2.0') === true);
  t.check('but not the one already seen', showWhatsNew('2.0', '2.0') === false);
  t.check('junk counts as unseen', showWhatsNew(undefined, '2.0') === true && showWhatsNew(7, '2.0') === true);
  t.check('nothing is offered without a release', showWhatsNew('', '') === false);
  t.check('the release is a plain string', typeof WHATS_NEW_VERSION === 'string' && WHATS_NEW_VERSION.length > 0);
  t.check(
    'the release is not read from the manifest',
    !/WHATS_NEW_VERSION[^\n]*manifest/.test(read('src/lib/view.js')),
  );

  t.check(
    'the note sits above the panels, not inside a tab',
    popupHtml.indexOf('id="whats-new"') > popupHtml.indexOf('</nav>')
      && popupHtml.indexOf('id="whats-new"') < popupHtml.indexOf('<section id="audio"'),
  );
  t.check('the note is announced once', /id="whats-new"[^>]*role="status"/.test(popupHtml));
  t.check(
    'the note both opens and dismisses',
    /id="whats-new-open"[^>]*type="button"/.test(popupHtml)
      && /id="whats-new-close"[^>]*type="button"/.test(popupHtml),
  );
  t.check('the note starts hidden', /id="whats-new"[^>]*hidden/.test(popupHtml));
  t.check(
    'both buttons acknowledge the release',
    /whats-new-open'\)\?\.addEventListener\('click', \(\) => \{\s*openWhatsNew\(\);/.test(popupJs)
      && /whats-new-close'\)\?\.addEventListener\('click', \(\) => \{\s*void markWhatsNewSeen\(\);/.test(popupJs),
  );
  t.check('reading the page acknowledges it too', js.includes("type: 'whatsNew.seen'"));
  t.check('Settings can reopen it whatever was dismissed', /id="settings-whats-new"/.test(popupHtml)
    && popupJs.includes("'settings-whats-new'"));
  t.check(
    'the note reads as news, not as an error',
    /\.whats-new\s*\{[^}]*border-inline-start:\s*3px solid var\(--accent\)/.test(popupCss)
      && !/\.whats-new\s*\{[^}]*banner--error/.test(popupCss),
  );
  t.check('the note stays one line', /\.whats-new__open\s*\{[^}]*white-space:\s*nowrap/.test(popupCss)
    && /\.whats-new__open\s*\{[^}]*text-overflow:\s*ellipsis/.test(popupCss));

  t.section('the worker');

  t.check('a fresh install has missed nothing', /reason !== 'install'\) return;[\s\S]{0,320}writeWhatsNewSeen\(WHATS_NEW_VERSION\)/.test(worker));
  t.check('nothing opens a tab on update', !/reason === 'update'/.test(worker));
  t.check('the state carries the flag', /whatsNewSeen/.test(worker) && /readWhatsNewSeen\(\)/.test(worker));
  t.check(
    'the flag is not in backups',
    /delete cloned\.whatsNewSeen;/.test(read('src/lib/backup.js')),
  );
}
