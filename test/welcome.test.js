/**
 * Welcome page and the popup's way to it. Text and file assertions only —
 * there is no DOM here, so neither page script is imported.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

export default async function run(t) {
  const html = read('src/welcome/welcome.html');
  const css = read('src/welcome/welcome.css');
  const js = read('src/welcome/welcome.js');
  const worker = read('src/background/service-worker.js');
  const popupHtml = read('src/popup/popup.html');
  const popupJs = read('src/popup/popup.js');
  const en = JSON.parse(read('_locales/en/messages.json'));
  const ar = JSON.parse(read('_locales/ar/messages.json'));

  t.section('the page');

  t.check('the worker opens this page', worker.includes("'src/welcome/welcome.html'") && fs.existsSync(path.join(ROOT, 'src/welcome/welcome.html')));
  t.check('three numbered steps', (html.match(/<li class="step"/g) || []).length === 3);
  t.check('the import step can be linked to', /<li class="step" id="import">/.test(html));
  t.check('the file picker takes a CSV', /id="welcome-import-file"[^>]*accept="\.csv,text\/csv"/.test(html));
  t.check('the import result is announced', /id="welcome-import-status"[^>]*role="status"/.test(html));
  t.check('the page loads the boot script before its stylesheet', (() => {
    const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
    const bootAt = head.indexOf('<script src="../lib/theme-boot.js">');
    const cssAt = head.indexOf('<link rel="stylesheet"');
    return bootAt >= 0 && cssAt > bootAt;
  })());
  t.check('the page loads one module script', /<script type="module" src="welcome\.js"><\/script>/.test(html) && (html.match(/<script\b/g) || []).length === 2);

  const links = [...html.matchAll(/href="(https?:[^"]+)"/g)].map((m) => m[1]);
  t.check(
    'the only outside links are Google Takeout and the issues page',
    JSON.stringify(links) === JSON.stringify(['https://takeout.google.com/', 'https://github.com/ashahinL/Youtube-Companion/issues']),
    JSON.stringify(links),
  );
  t.check('outside links open without handing this page over', (html.match(/target="_blank"\s+rel="noopener noreferrer"/g) || []).length === links.length);

  t.section('words');

  const attrKeys = [...html.matchAll(/data-i18n(?:-title|-label|-placeholder)?="([^"]+)"/g)].map((m) => m[1]);
  const scriptKeys = [...js.matchAll(/'(welcome[A-Z]\w+)'/g)].map((m) => m[1]);
  for (const key of new Set([...attrKeys, ...scriptKeys])) {
    t.check(`${key} is in en and ar`, key in en && key in ar);
  }
  t.check('every import error has its own sentence', ['welcomeImportEmpty', 'welcomeImportTooBig', 'welcomeImportTooMany'].every((key) => js.includes(`'${key}'`)));
  t.check('the language follows the extension setting', /applyDirection\(document, locale\)/.test(js) && /type: 'updateSettings'/.test(js));

  t.section('what it does');

  t.check('the worker reads the file, not the page', /type: 'importTakeout'/.test(js) && !/parseTakeoutCsv/.test(js));
  t.check('the page never fetches', !/\bfetch\(/.test(js));
  t.check('a large pick is refused before it is read', /takeoutSizeError\(file\.size\)[\s\S]{0,200}return;[\s\S]{0,400}file\.text\(\)/.test(js));
  t.check('a successful import asks for a check', /welcomeImportAdded[\s\S]{0,300}type: 'sweep'/.test(js));
  t.check(
    'already running after import is not an error',
    /already running/.test(js) && /welcomeImportFailed/.test(js)
      && js.indexOf("res.error === 'already running'") > js.indexOf("type: 'sweep'"),
  );
  t.check(
    'slow down after import uses its own sentence',
    /slow down/.test(js) && /welcomeImportSlowDown/.test(js) && /welcomeImportSlowDownSkipped/.test(js),
  );
  t.check(
    'welcomeImportSlowDown is in en and ar',
    'welcomeImportSlowDown' in en && 'welcomeImportSlowDown' in ar
      && 'welcomeImportSlowDownSkipped' in en && 'welcomeImportSlowDownSkipped' in ar,
  );
  t.check(
    'no bound key uses the same empty-shortcut words as the popup',
    /audioShortcutNone/.test(js) && 'audioShortcutNone' in en && 'audioShortcutNone' in ar,
  );
  t.check('the shortcut lines stay visible when Chrome bound nothing', /\.hidden = false/.test(js) && !/\.hidden = !keys/.test(js));
  t.check(
    'only the over-limit import error names the cap',
    /error === 'count'/.test(js) && /MAX_TAKEOUT_CHANNELS/.test(js),
  );
  t.check('pinning is detected from the toolbar setting', /getUserSettings\(\)/.test(js) && /isOnToolbar/.test(js));

  t.section('looks');

  t.check('dark and light colours', /:root\s*\{[^}]*--bg:/.test(css) && /prefers-color-scheme: light/.test(css));
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
  t.check('the steps use logical sides for right-to-left', /padding-inline-start/.test(css) && !/padding-left|margin-left|\bleft:/.test(css));
  t.check('keyboard focus is visible', /\.btn:focus-visible/.test(css));

  t.section('Player tab name');

  t.check(
    'the popup tab is named Player, not Audio',
    en.tabAudio.message === 'Player'
      && ar.tabAudio.message === 'مشغّل'
      && /data-i18n="tabAudio"[^>]*>\s*Player\s*</.test(popupHtml)
      && !/data-i18n="tabAudio"[^>]*>\s*Audio\s*</.test(popupHtml),
    JSON.stringify({ en: en.tabAudio.message, ar: ar.tabAudio.message }),
  );

  t.section('from the popup');

  for (const id of ['feed-import-youtube', 'watchlist-import-youtube', 'settings-import-youtube']) {
    const tag = popupHtml.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`));
    t.check(`${id} exists and is marked for the import`, !!tag && /data-import-youtube/.test(tag[0]) && /data-i18n="importFromYouTube"/.test(tag[0]));
  }
  t.check('the buttons open the import step of the welcome page', /\[data-import-youtube\][\s\S]{0,200}welcome\/welcome\.html#import/.test(popupJs));
  t.check('the popup still never reads a Takeout file itself', !/importTakeout/.test(popupJs));

  t.section('the uninstall page');

  const siteHtml = read('site/uninstall.html');
  const siteJs = read('site/uninstall.js');
  const pages = read('.github/workflows/pages.yml');
  const pageUrl = (worker.match(/const UNINSTALL_PAGE = '([^']+)'/) || [])[1] || '';
  t.check(
    'the worker points at the page this repository publishes',
    pageUrl === 'https://ashahinl.github.io/Youtube-Companion/uninstall.html' && fs.existsSync(path.join(ROOT, 'site', path.basename(pageUrl))),
    pageUrl,
  );
  t.check('the site is published from main only', /branches: \[main\]/.test(pages) && /path: site\n/.test(pages));
  const siteLoads = [...siteHtml.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  t.check('it loads nothing from anywhere else', JSON.stringify(siteLoads) === JSON.stringify(['uninstall.js']), JSON.stringify(siteLoads));
  t.check('it sends nothing by itself', !/\bfetch\(|XMLHttpRequest|sendBeacon|new Image/.test(siteJs));
  t.check(
    'it offers Chrome and Edge store links',
    /chromewebstore\.google\.com\/detail\/hpajekcplhidhjidohfmebpeianbhcgd/.test(siteHtml)
      && /microsoftedge\.microsoft\.com\/addons\/detail\/companion-for-youtube\/neaandgimpffglakmlbmmkmmmlahibfh/.test(siteHtml)
      && /data-text="storeChrome"/.test(siteHtml)
      && /data-text="storeEdge"/.test(siteHtml),
  );
  t.check('its answers go to a GitHub issue the person posts', /github\.com\/ashahinL\/Youtube-Companion\/issues\/new/.test(siteJs) && /window\.open\(/.test(siteJs));
  t.check('a version that is not a version is dropped', /\^\\d\+\(\\\.\\d\+\)\{0,3\}\$/.test(siteJs));
  const siteKeys = [...siteHtml.matchAll(/data-text="([^"]+)"/g)].map((m) => m[1]);
  const textBlock = (lang) => (siteJs.match(new RegExp(`${lang}: \\{([\\s\\S]*?)\\n    \\}`)) || [])[1] || '';
  for (const lang of ['en', 'ar']) {
    const missing = siteKeys.filter((key) => !new RegExp(`\\b${key}:`).test(textBlock(lang)));
    t.check(`every sentence has ${lang} words`, siteKeys.length > 10 && missing.length === 0, JSON.stringify(missing));
  }

  t.section('the home page');

  const homeHtml = read('site/index.html');
  const homeJs = read('site/index.js');
  const shotsJs = read('scripts/shots.js');
  t.check('the page exists', fs.existsSync(path.join(ROOT, 'site/index.html')) && fs.existsSync(path.join(ROOT, 'site/index.js')));
  const homeLoads = [...homeHtml.matchAll(/<(?:script|link|img)\b[^>]*\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  const homeAllowed = (href) => href === 'index.js'
    || href.startsWith('images/')
    || href === 'https://ashahinl.github.io/Youtube-Companion/';
  t.check('it loads nothing from another origin', homeLoads.length > 0 && homeLoads.every(homeAllowed), JSON.stringify(homeLoads));
  t.check('it sends nothing by itself', !/\bfetch\(|XMLHttpRequest|sendBeacon|new Image/.test(homeJs));
  t.check(
    'it links both stores and the repo',
    /chromewebstore\.google\.com\/detail\/hpajekcplhidhjidohfmebpeianbhcgd/.test(homeHtml)
      && /microsoftedge\.microsoft\.com\/addons\/detail\/companion-for-youtube\/neaandgimpffglakmlbmmkmmmlahibfh/.test(homeHtml)
      && /href="https:\/\/github\.com\/ashahinL\/Youtube-Companion"/.test(homeHtml),
  );
  const homeKeys = [
    ...[...homeHtml.matchAll(/data-text="([^"]+)"/g)].map((m) => m[1]),
    ...[...homeHtml.matchAll(/data-src="([^"]+)"/g)].map((m) => m[1]),
  ];
  const homeText = (lang) => (homeJs.match(new RegExp(`${lang}: \\{([\\s\\S]*?)\\n    \\}`)) || [])[1] || '';
  for (const lang of ['en', 'ar']) {
    const missing = homeKeys.filter((key) => !new RegExp(`\\b${key}:`).test(homeText(lang)));
    t.check(`every sentence has ${lang} words`, homeKeys.length > 10 && missing.length === 0, JSON.stringify(missing));
  }
  const usedShots = [...new Set([
    ...homeHtml.matchAll(/images\/([a-z0-9.-]+\.png)/g),
    ...homeJs.matchAll(/images\/([a-z0-9.-]+\.png)/g),
  ].map((m) => m[1]))].sort();
  const siteShotBlock = (shotsJs.match(/const SITE_SHOTS = \[([\s\S]*?)\];/) || [])[1] || '';
  const writtenShots = [...new Set([
    ...[...siteShotBlock.matchAll(/name: '([^']+)'/g)].map((m) => `${m[1]}.png`),
    ...[...shotsJs.matchAll(/site\/images\/([a-z0-9.-]+\.png)/g)].map((m) => m[1]),
  ])].sort();
  t.check(
    'every image is one shots.js writes',
    usedShots.length > 0 && JSON.stringify(usedShots) === JSON.stringify(writtenShots),
    JSON.stringify({ usedShots, writtenShots }),
  );
  const docsBlock = (shotsJs.match(/const DOCS_SHOTS = \[([\s\S]*?)\];/) || [])[1] || '';
  const docsScenes = new Set([...docsBlock.matchAll(/scene: '([^']+)'/g)].map((m) => m[1]));
  const siteScenes = [...siteShotBlock.matchAll(/scene: '([^']+)'/g)].map((m) => m[1]);
  t.check(
    'site shots reuse existing scenes',
    siteScenes.length > 0 && siteScenes.every((s) => docsScenes.has(s)),
    JSON.stringify(siteScenes),
  );
  const homeCss = (homeHtml.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || '';
  t.check('layout uses logical CSS', !/(^|[^-])(?:left|right)\s*:/.test(homeCss));
  t.check(
    'it is indexable',
    !/noindex/.test(homeHtml)
      && /<meta name="description" content="[^"]+"/.test(homeHtml)
      && /<link rel="canonical" href="https:\/\/ashahinl\.github\.io\/Youtube-Companion\/"/.test(homeHtml)
      && /property="og:title"/.test(homeHtml)
      && /property="og:description"/.test(homeHtml)
      && /property="og:image"/.test(homeHtml)
      && /property="og:url"/.test(homeHtml)
      && /name="twitter:card"/.test(homeHtml),
  );
}
