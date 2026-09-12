/**
 * Popup shell. Text and file-existence assertions only — there is no DOM
 * here, so popup.js is never imported.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const POPUP = path.join(ROOT, 'src/popup');

function attrs(tag) {
  const out = {};
  for (const m of tag.matchAll(/([\w:-]+)="([^"]*)"/g)) out[m[1]] = m[2];
  return out;
}

function stripColorRoots(css) {
  let i = 0;
  let out = '';
  const n = css.length;
  while (i < n) {
    const slice = css.slice(i);
    const media = slice.match(/^@media\s*\(prefers-color-scheme:[^{]*\{/);
    const root = slice.match(/^:root\s*\{/);
    if (media || root) {
      const open = (media || root)[0].length;
      let depth = 1;
      let j = i + open;
      while (j < n && depth) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      i = j;
      continue;
    }
    out += css[i];
    i++;
  }
  return out;
}

export default async function run(t) {
  const html = fs.readFileSync(path.join(POPUP, 'popup.html'), 'utf8');
  const css = fs.readFileSync(path.join(POPUP, 'popup.css'), 'utf8');
  const js = fs.readFileSync(path.join(POPUP, 'popup.js'), 'utf8');
  const worker = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));

  t.section('tabs');

  const tabButtons = [...html.matchAll(/<button\b[^>]*>/gi)]
    .map((m) => attrs(m[0]))
    .filter((a) => a.role === 'tab');
  t.check('has exactly three role="tab" buttons', tabButtons.length === 3, String(tabButtons.length));

  const dataTabs = tabButtons.map((a) => a['data-tab']);
  for (const name of ['feeds', 'watchlist', 'settings']) {
    t.check(`has a tab with data-tab="${name}"`, dataTabs.includes(name), JSON.stringify(dataTabs));
  }

  t.section('panels');

  const panels = [...html.matchAll(/<[^>]*\brole="tabpanel"[^>]*>/gi)].map((m) => attrs(m[0]));
  for (const name of ['feeds', 'watchlist', 'settings']) {
    t.check(
      `has a tabpanel whose id is ${name}`,
      panels.some((p) => p.id === name),
      JSON.stringify(panels.map((p) => p.id)),
    );
  }

  t.section('watchlist');

  const watchlist = html.match(/<section\b[^>]*\bid="watchlist"[^>]*>[\s\S]*?<\/section>/);
  t.check('watchlist panel exists', !!watchlist);
  const w = watchlist ? watchlist[0] : '';
  t.check('has add input', /id="watchlist-input"/.test(w));
  t.check('has add button', /id="watchlist-add-btn"/.test(w));
  t.check('has list container', /id="watchlist-list"/.test(w));
  t.check('has a clear control', /id="watchlist-clear"/.test(w));
  t.check('has a local-filter count', /id="watchlist-count"/.test(w));
  t.check('has no YouTube search-results list', !/id="watchlist-results"/.test(w));
  t.check(
    'popup does not search YouTube by name',
    !/searchChannels/.test(js) && !/runSearch/.test(js),
  );
  t.check('typed Add only fires for a channel ref', /isChannelRef\(input\)/.test(js));
  t.check(
    'already-listed handle disables Add rather than erroring',
    /listedMatch\(input,\s*view\.channels\)/.test(js) && /watchlistOnList/.test(js),
  );
  t.check('the box filters the local watchlist', /matchesWatchlist\(ch,\s*q\)/.test(js));
  t.check(
    'Add stays available when the box is empty',
    /addable = !q \|\|/.test(js),
  );
  t.check(
    'empty Add reads the focused tab',
    /tabs\.query\s*\(\s*\{[^}]*active:\s*true/.test(js) && /watchlistNoCurrentTab/.test(js),
  );

  t.section('watchlist row menu');

  t.check('row actions are a ⋯ menu', /menu__toggle/.test(js) && /⋯/.test(js));
  t.check('menu can favourite a channel', /watchlistFavoriteAdd/.test(js));
  t.check(
    'menu unfavourites when already a favourite',
    /watchlistFavoriteRemove/.test(js),
  );
  t.check('menu remove is a danger item', /menu__item--danger/.test(js));
  t.check(
    'menu remove calls removeChannel with no extra confirm',
    /removeChannel\(\s*ch\.id\s*\)/.test(js) && !/pendingRemoveId/.test(js),
  );
  t.check('no star favourite button', !/['"]★['"]/.test(js));
  t.check(
    'no inline remove-confirm copy',
    !/watchlistRemovePrompt/.test(js)
      && !/watchlistRemoveConfirm/.test(js)
      && !/watchlistRemoveCancel/.test(js),
  );
  t.check('a click outside closes the menu', /addEventListener\(\s*'click'\s*,\s*closeAllMenus/.test(js));
  t.check(
    'Escape closes an open menu before the sheet',
    /if \(closeAllMenus\(\)\)/.test(js),
  );

  t.section('feeds');

  const feeds = html.match(/<section\b[^>]*\bid="feeds"[^>]*>[\s\S]*?<\/section>/);
  t.check('feeds panel exists', !!feeds);
  const f = feeds ? feeds[0] : '';
  t.check('has filter input', /id="feed-filter"/.test(f));
  t.check('has refresh control', /id="feed-refresh"/.test(f));
  t.check('has list container', /id="feed-list"/.test(f));
  t.check('has a favourites-only checkbox', /id="feed-favorites-only"/.test(f));
  t.check(
    'favourites-only writes feed.favoritesOnly',
    /feed\.favoritesOnly/.test(js) && /favOnly/.test(js),
  );
  t.check(
    'the channel sheet does not use favourites-only',
    /visibleFeedItems\(\)\s*\.filter\(\s*\(item\)\s*=>\s*item\.c === ch\.id\s*\)/.test(js),
  );

  const emptyIds = [...f.matchAll(/id="(feed-empty-[^"]+)"/g)].map((m) => m[1]);
  t.check(
    'has four empty-state elements',
    emptyIds.length === 4,
    JSON.stringify(emptyIds),
  );
  t.check(
    'empty states are distinct',
    new Set(emptyIds).size === 4 &&
      emptyIds.includes('feed-empty-no-channels') &&
      emptyIds.includes('feed-empty-no-items') &&
      emptyIds.includes('feed-empty-filter') &&
      emptyIds.includes('feed-empty-favorites'),
    JSON.stringify(emptyIds),
  );

  t.section('settings');

  const settings = html.match(/<section\b[^>]*\bid="settings"[^>]*>[\s\S]*?<\/section>/);
  t.check('settings panel exists', !!settings);
  const s = settings ? settings[0] : '';
  const groupIds = [
    'settings-notifications',
    'settings-checking',
    'settings-feed',
    'settings-language',
    'settings-backup',
  ];
  for (const id of groupIds) {
    t.check(`has settings group ${id}`, new RegExp(`id="${id}"`).test(s), id);
  }
  t.check('import offers merge', /id="settings-import-merge"/.test(s));
  t.check('import offers replace', /id="settings-import-replace"/.test(s));
  t.check(
    'replace has a separate confirm control',
    /id="settings-import-replace-confirm"/.test(s),
  );
  t.check(
    'merge and replace are distinct controls',
    /id="settings-import-merge"/.test(s)
      && /id="settings-import-replace"/.test(s)
      && /id="settings-import-replace-confirm"/.test(s),
  );

  t.section('i18n');

  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  for (const key of keys) {
    t.check(`data-i18n="${key}" exists in en`, key in en);
  }
  const titleKeys = [...html.matchAll(/data-i18n-title="([^"]+)"/g)].map((m) => m[1]);
  for (const key of titleKeys) {
    t.check(`data-i18n-title="${key}" exists in en`, key in en);
  }
  const phKeys = [...html.matchAll(/data-i18n-placeholder="([^"]+)"/g)].map((m) => m[1]);
  for (const key of phKeys) {
    t.check(`data-i18n-placeholder="${key}" exists in en`, key in en);
  }
  const labelKeys = [...html.matchAll(/data-i18n-label="([^"]+)"/g)].map((m) => m[1]);
  for (const key of labelKeys) {
    t.check(`data-i18n-label="${key}" exists in en`, key in en);
  }
  t.check('popup.js imports i18n.js', /from ['"]\.\.\/lib\/i18n\.js['"]/.test(js));
  t.check(
    'relativeTime is passed the active locale',
    /relativeTime\([^;]*\blocale\b/.test(js),
  );
  t.check(
    'compactCount is passed the active locale',
    /compactCount\([^;]*\blocale\b/.test(js),
  );
  t.check(
    'absoluteTime is passed the active locale',
    /absoluteTime\([^;]*\blocale\b/.test(js),
  );

  const arrowIdx = js.indexOf("event.key !== 'ArrowLeft'");
  t.check('has tab arrow handler', arrowIdx >= 0);
  const arrowEnd = arrowIdx >= 0 ? js.indexOf('activate(next)', arrowIdx) : -1;
  const arrowBlock = arrowIdx >= 0 && arrowEnd >= 0
    ? js.slice(arrowIdx, arrowEnd + 'activate(next)'.length)
    : '';
  t.check(
    'tab arrows read direction from computed style',
    /getComputedStyle\s*\(\s*document\.documentElement\s*\)\.direction/.test(arrowBlock),
    arrowBlock.slice(0, 240),
  );
  t.check(
    'tab arrows do not take direction from the locale',
    !/\blocale\b/.test(arrowBlock),
    arrowBlock,
  );

  t.section('assets');

  t.check('references popup.css', /href="popup\.css"/.test(html));
  t.check('references popup.js', /src="popup\.js"/.test(html));
  t.check('popup.css exists', fs.existsSync(path.join(POPUP, 'popup.css')));
  t.check('popup.js exists', fs.existsSync(path.join(POPUP, 'popup.js')));

  t.section('popup.js rules');

  t.check('no confirm(', !/\bconfirm\s*\(/.test(js));
  t.check('no alert(', !/\balert\s*\(/.test(js));
  t.check('no prompt(', !/\bprompt\s*\(/.test(js));
  t.check('no direct fetch(', !/\bfetch\s*\(/.test(js));
  // Channel and video titles are untrusted remote text. They reach the DOM
  // through textContent only; an innerHTML assignment would make them markup.
  t.check('no innerHTML assignment', !/\.innerHTML\s*(=|\+=)/.test(js));
  t.check('no insertAdjacentHTML', !/insertAdjacentHTML/.test(js));
  t.check('no outerHTML assignment', !/\.outerHTML\s*(=|\+=)/.test(js));

  t.section('popup.css colours');

  const rest = stripColorRoots(css);
  const hex = rest.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  t.check(
    'no hex colour outside :root / prefers-color-scheme',
    hex.length === 0,
    JSON.stringify(hex),
  );

  const physical = [
    ['left', /(?:^|[\s;{])left\s*:/m],
    ['right', /(?:^|[\s;{])right\s*:/m],
    ['margin-left', /margin-left\s*:/],
    ['margin-right', /margin-right\s*:/],
    ['padding-left', /padding-left\s*:/],
    ['padding-right', /padding-right\s*:/],
    ['text-align: left', /text-align\s*:\s*left/],
    ['text-align: right', /text-align\s*:\s*right/],
    ['border-left', /border-left(?:-[\w]+)?\s*:/],
    ['border-right', /border-right(?:-[\w]+)?\s*:/],
    ['translateX', /translateX\s*\(/],
  ];
  for (const [name, re] of physical) {
    t.check(`popup.css has no ${name}`, !re.test(css));
  }

  const rootBlocks = [];
  {
    const re = /:root\s*\{/g;
    let m;
    while ((m = re.exec(css))) {
      let depth = 1;
      let j = m.index + m[0].length;
      while (j < css.length && depth) {
        if (css[j] === '{') depth++;
        else if (css[j] === '}') depth--;
        j++;
      }
      rootBlocks.push(css.slice(m.index, j));
    }
  }
  t.check('has dark and light :root blocks', rootBlocks.length >= 2, String(rootBlocks.length));
  const darkRoot = rootBlocks[0] || '';
  const lightRoot = rootBlocks[1] || '';
  for (const name of ['--tag-live', '--tag-premiere', '--tag-short']) {
    t.check(`dark :root declares ${name}`, darkRoot.includes(`${name}:`), darkRoot.includes(name) ? name : 'missing');
    t.check(`light :root declares ${name}`, lightRoot.includes(`${name}:`), lightRoot.includes(name) ? name : 'missing');
  }

  t.section('channel sheet');

  t.check('has channel sheet overlay', /id="channel-sheet"/.test(html));
  t.check(
    'sheet is a dialog overlay',
    /id="channel-sheet"[\s\S]*?role="dialog"/.test(html),
  );
  t.check('sheet has a close control', /id="channel-sheet-close"/.test(html));
  t.check('sheet has a refresh control', /id="channel-sheet-refresh"/.test(html));
  t.check('sheet has a video list', /id="channel-sheet-videos"/.test(html));
  t.check(
    'watchlist row opens the channel sheet by id',
    /openChannelSheet\(\s*ch\.id\s*\)/.test(js),
  );
  t.check(
    'feed channel name opens the channel sheet by id',
    /openChannelSheet\(\s*channel\.id\s*\)/.test(js),
  );
  t.check(
    'sheet refresh sweeps only that channel',
    /onlyId:\s*view\.sheetId/.test(js),
  );
  t.check(
    'sheet lists stored feed items for that channel',
    /visibleFeedItems\(\)\s*\.filter/.test(js),
  );
  t.check(
    'does not open a detached channel window',
    !/openChannelWindow/.test(js) && !/windows\.create/.test(js),
  );
  const openFn = js.match(/function openChannelSheet\s*\(\s*id\s*\)\s*\{[\s\S]*?\n\}/);
  t.check(
    'opening the sheet does not send a worker message',
    !!openFn && !/\bsend\s*\(/.test(openFn[0]),
    openFn ? openFn[0].slice(0, 240) : 'missing function',
  );
  t.check(
    'Escape closes the sheet',
    /event\.key !== 'Escape'/.test(js) && /closeChannelSheet/.test(js),
  );
  t.check(
    'sheet is position fixed',
    /\.sheet\s*\{[^}]*position:\s*fixed/.test(css),
  );

  t.section('message types');

  const sent = [...js.matchAll(/\btype:\s*['"](\w+)['"]/g)].map((m) => m[1]);
  const implemented = new Set([...worker.matchAll(/case\s+['"](\w+)['"]/g)].map((m) => m[1]));
  t.check('popup sends at least one message', sent.length > 0, String(sent.length));
  for (const type of sent) {
    t.check(
      `popup message type "${type}" is implemented by the worker`,
      implemented.has(type),
      [...implemented].join(','),
    );
  }
  for (const type of ['updateSettings', 'importBackup']) {
    t.check(
      `worker implements "${type}"`,
      implemented.has(type),
      [...implemented].join(','),
    );
  }
}
