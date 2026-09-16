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
  const viewJs = fs.readFileSync(path.join(ROOT, 'src/lib/view.js'), 'utf8');
  const worker = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));

  t.section('tabs');

  const tabButtons = [...html.matchAll(/<button\b[^>]*>/gi)]
    .map((m) => attrs(m[0]))
    .filter((a) => a.role === 'tab');
  t.check('has exactly four role="tab" buttons', tabButtons.length === 4, String(tabButtons.length));

  const dataTabs = tabButtons.map((a) => a['data-tab']);
  t.check(
    'tab order is audio, feeds, watchlist, settings',
    dataTabs.join() === 'audio,feeds,watchlist,settings',
    JSON.stringify(dataTabs),
  );
  for (const name of ['audio', 'feeds', 'watchlist', 'settings']) {
    t.check(`has a tab with data-tab="${name}"`, dataTabs.includes(name), JSON.stringify(dataTabs));
  }

  const audioTab = tabButtons.find((a) => a['data-tab'] === 'audio') || {};
  const feedsTab = tabButtons.find((a) => a['data-tab'] === 'feeds') || {};
  t.check(
    'Audio is selected at rest',
    audioTab.class === 'tab tab--active'
      && audioTab['aria-selected'] === 'true'
      && audioTab.tabindex === '0',
    JSON.stringify(audioTab),
  );
  t.check(
    'Feeds is not selected at rest',
    feedsTab.class === 'tab'
      && feedsTab['aria-selected'] === 'false'
      && feedsTab.tabindex === '-1',
    JSON.stringify(feedsTab),
  );

  t.section('panels');

  const panels = [...html.matchAll(/<[^>]*\brole="tabpanel"[^>]*>/gi)].map((m) => attrs(m[0]));
  t.check(
    'audio panel is first',
    panels[0]?.id === 'audio',
    JSON.stringify(panels.map((p) => p.id)),
  );
  for (const name of ['audio', 'feeds', 'watchlist', 'settings']) {
    t.check(
      `has a tabpanel whose id is ${name}`,
      panels.some((p) => p.id === name),
      JSON.stringify(panels.map((p) => p.id)),
    );
  }
  const audioPanelTag = html.match(/<section\b[^>]*\bid="audio"[^>]*>/);
  t.check(
    'audio panel is visible at rest',
    !!audioPanelTag && !/\bhidden\b/.test(audioPanelTag[0]),
    audioPanelTag ? audioPanelTag[0] : 'missing',
  );
  const feedsPanelTag = html.match(/<section\b[^>]*\bid="feeds"[^>]*>/);
  t.check(
    'feeds panel is hidden at rest',
    !!feedsPanelTag && /\bhidden\b/.test(feedsPanelTag[0]),
    feedsPanelTag ? feedsPanelTag[0] : 'missing',
  );

  t.section('app bar');

  const barAt = html.indexOf('class="appbar"');
  const navAt = html.indexOf('<nav class="tabs"');
  t.check('an app bar exists', barAt >= 0);
  t.check('the app bar sits above the tabs', barAt >= 0 && navAt > barAt, `${barAt} ${navAt}`);
  t.check(
    'the app bar shows the extension name, not a hardcoded string',
    /<h1[^>]*\bdata-i18n="appName"/.test(html),
  );
  t.check('the app bar is styled', /\.appbar\s*\{/.test(css) && /\.appbar__name\s*\{/.test(css));

  t.section('watchlist');

  const watchlist = html.match(/<section\b[^>]*\bid="watchlist"[^>]*>[\s\S]*?<\/section>/);
  t.check('watchlist panel exists', !!watchlist);
  const w = watchlist ? watchlist[0] : '';
  t.check('has add input', /id="watchlist-input"/.test(w));
  t.check('has add button', /id="watchlist-add-btn"/.test(w));
  t.check('has list container', /id="watchlist-list"/.test(w));
  t.check('has a clear control', /id="watchlist-clear"/.test(w));
  t.check('has a local-filter count', /id="watchlist-count"/.test(w));
  t.check(
    'Undo comes after the list, where it shows',
    w.indexOf('id="watchlist-list"') >= 0 && w.indexOf('id="watchlist-undo"') > w.indexOf('id="watchlist-list"'),
  );
  t.check(
    'Undo is pinned to the bottom of the popup',
    /\.undo-row\s*\{[^}]*position:\s*fixed[^}]*inset-block-end:\s*0/.test(css),
  );
  t.check('the pinned Undo leaves room under the last row', /\.panel:has\(\.undo-row:not\(\[hidden\]\)\)\s*\{[^}]*padding-block-end/.test(css));
  t.check(
    'focusing Undo after a remove does not scroll the list away',
    /watchlist-undo-btn'\)\?\.focus\(\{ preventScroll: true \}\)/.test(js),
  );
  t.check(
    'a favourite row is marked, not left to sort order alone',
    /ch\.favorite/.test(js) && /channel-row__fav/.test(js) && /channel-row__fav\s*\{/.test(css),
  );
  t.check(
    'the favourite mark carries an accessible name',
    /channel-row__fav[\s\S]{0,240}watchlistFavorite/.test(js),
  );
  t.check(
    'the title keeps its own row so it can still ellipsis beside the mark',
    /channel-row__name/.test(js) && /\.channel-row__name\s*\{[^}]*display:\s*flex/.test(css),
  );
  const watchEmptyTag = html.match(/<[^>]*\bid="watchlist-empty"[^>]*>/);
  t.check(
    'watchlist-empty starts hidden',
    !!watchEmptyTag && /\bhidden\b/.test(watchEmptyTag[0]),
    watchEmptyTag ? watchEmptyTag[0] : 'missing',
  );
  t.check('has no YouTube search-results list', !/id="watchlist-results"/.test(w));
  t.check(
    'popup does not search YouTube by name',
    !/searchChannels/.test(js) && !/runSearch/.test(js),
  );
  t.check('typed Add only fires for a channel ref', /isChannelRef\(input\)/.test(js));
  t.check(
    'already-listed handle disables Add rather than erroring',
    /listedMatch\(input,\s*view\.channels,\s*view\.feed\)/.test(js) && /watchlistOnList/.test(js),
  );
  t.check('the box filters the local watchlist', /matchesWatchlist\(ch,\s*q\)/.test(viewJs));
  t.check(
    'Add stays available when the box is empty',
    /addable = !q \|\|/.test(viewJs),
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
    'menu mutes and unmutes a channel\'s alerts',
    /watchlistMuteAdd/.test(js) && /watchlistMuteRemove/.test(js) && /type:\s*'setMuted'/.test(js),
  );
  t.check('a muted row says so', /ch\.muted\)[\s\S]{0,80}watchlistMuted'/.test(js));
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
    '⋯ is a menu button',
    /aria-haspopup',\s*'menu'/.test(js) && /aria-expanded/.test(js),
  );
  t.check(
    'the ⋯ popup is role=menu with menuitem children',
    /setAttribute\(\s*'role',\s*'menu'/.test(js)
      && /setAttribute\(\s*'role',\s*'menuitem'/.test(js),
  );
  t.check(
    '⋯ keyboard wrapping lives in view.js',
    /menuNavIndex/.test(js) && /export function menuNavIndex/.test(viewJs),
  );
  t.check(
    'opening ⋯ with Enter/Space/ArrowDown focuses the first item',
    /menuItems\(list\)\[0\]\?\.focus/.test(js)
      && /event\.key !== 'ArrowDown'/.test(js),
  );
  t.check(
    'ArrowUp/ArrowDown/Home/End move ⋯ menu focus through menuNavIndex',
    /function onChannelMenuKeydown[\s\S]{0,700}menuNavIndex\(event\.key/.test(js)
      && /event\.key !== 'Home'/.test(js)
      && /event\.key !== 'End'/.test(js),
  );
  t.check(
    'Escape on the ⋯ menu returns focus to the button',
    /function onChannelMenuKeydown[\s\S]{0,400}closeAllMenus\(\{\s*restoreFocus:\s*true\s*\}\)/.test(js),
  );
  t.check(
    'Tab closes the ⋯ menu',
    /function onChannelMenuKeydown[\s\S]{0,80}event\.key === 'Tab'[\s\S]{0,40}closeAllMenus\(\)/.test(js),
  );
  t.check(
    'Escape closes an open menu before the sheet',
    /if \(closeAllMenus\(\{\s*restoreFocus:\s*true\s*\}\)\)/.test(js),
  );
  t.check(
    'menu flip class exists in CSS and JS',
    /menu__list--above/.test(css) && /menu__list--above/.test(js),
  );
  const flipRule = css.match(/\.menu__list--above\s*\{[^}]*\}/);
  t.check('menu flip rule exists', !!flipRule, 'missing .menu__list--above');
  t.check(
    'menu flip uses inset-block-end',
    !!flipRule && /inset-block-end:\s*calc\(100% \+ 4px\)/.test(flipRule[0]),
    flipRule ? flipRule[0] : '',
  );
  t.check(
    'menu flip clears inset-block-start',
    !!flipRule && /inset-block-start:\s*auto/.test(flipRule[0]),
    flipRule ? flipRule[0] : '',
  );
  t.check(
    'menu measures after the list is visible',
    /getBoundingClientRect/.test(js) && /innerHeight/.test(js),
  );

  t.section('feeds');

  const feeds = html.match(/<section\b[^>]*\bid="feeds"[^>]*>[\s\S]*?<\/section>/);
  t.check('feeds panel exists', !!feeds);
  const f = feeds ? feeds[0] : '';
  t.check('has filter input', /id="feed-filter"/.test(f));
  t.check('has add button', /id="feed-add-btn"/.test(f));
  t.check('has a clear control', /id="feed-clear"/.test(f));
  t.check('has a local-filter count', /id="feed-count"/.test(f));
  t.check('has refresh control', /id="feed-refresh"/.test(f));
  t.check(
    'refresh sits on the last-check row',
    /id="feed-status"[\s\S]*id="feed-last-poll"[\s\S]*id="feed-refresh"/.test(f),
  );
  t.check(
    'the add box does not hold the refresh control',
    !/<form\b[^>]*id="feed-add-form"[\s\S]*?id="feed-refresh"[\s\S]*?<\/form>/.test(f),
  );
  t.check('has list container', /id="feed-list"/.test(f));
  t.check('typed Feeds Add only fires for a channel ref', /submitAdd\(filter\.value,\s*'feeds'\)/.test(js));
  t.check(
    'already-listed channel disables Feeds Add rather than erroring',
    /listedMatch\(q,\s*channels,\s*feed\)/.test(viewJs) && /watchlistOnList/.test(js),
  );
  t.check('the box filters the local feed', /matchesFeedFilter\(item,/.test(viewJs));
  t.check(
    'Feeds Add stays available when the box is empty',
    /addable = !q \|\| \(isChannelRef\(q\) && !onList\)/.test(viewJs),
  );
  t.check(
    'empty Feeds Add reads the focused tab',
    /submitAdd\(filter\.value,\s*'feeds'\)/.test(js) && /watchlistNoCurrentTab/.test(js),
  );
  t.check('Feeds Add sends addChannel', /type:\s*'addChannel'/.test(js));
  t.check('a successful add shows channelAdded', /channelAdded/.test(js) && /banner--ok/.test(html));
  t.check(
    'and names the channel it added',
    /t\('channelAdded', \[isolate\(ch\.title \|\| ch\.handle \|\| ch\.id \|\| ''\)\]\)/.test(js) && /\$NAME\$/.test(en.channelAdded.message),
  );
  t.check(
    'reload hides while its spinner runs',
    /refreshBtn\.hidden = sweeping/.test(js) && /refreshBtn\.hidden = locked/.test(js),
  );
  t.check(
    'render treats pollState.running as sweeping',
    (js.match(/view\.sweeping \|\| !!view\.pollState\?\.running/g) || []).length >= 2,
  );
  t.check(
    'requestSweep does not assign pollState.running into view.sweeping',
    !/view\.sweeping\s*=\s*[^\n]*pollState/.test(js),
  );
  t.check('has a favourites-only checkbox', /id="feed-favorites-only"/.test(f));
  t.check(
    'favourites-only writes feed.favoritesOnly',
    /feed\.favoritesOnly/.test(js) && /favOnly/.test(js),
  );
  t.check(
    'the channel sheet does not use favourites-only',
    /visibleFeedItems\(\s*view\.feed,\s*!!view\.settings\?\.feed\?\.showShorts\s*\)\s*\.filter\(\s*\(item\)\s*=>\s*item\.c === ch\.id\s*\)/.test(js),
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
  const feedEmptyTag = html.match(/<[^>]*\bid="feed-empty-no-channels"[^>]*>/);
  t.check(
    'feed-empty-no-channels starts hidden',
    !!feedEmptyTag && /\bhidden\b/.test(feedEmptyTag[0]),
    feedEmptyTag ? feedEmptyTag[0] : 'missing',
  );

  t.section('audio');

  const audio = html.match(/<section\b[^>]*\bid="audio"[^>]*>[\s\S]*?<\/section>/);
  t.check('audio panel exists', !!audio);
  const a = audio ? audio[0] : '';
  t.check('has the master toggle', /id="audio-toggle"/.test(a));
  t.check('has the page notice', /id="audio-page-notice"/.test(a));
  t.check(
    'page notice starts hidden',
    /<p[^>]*\bid="audio-page-notice"[^>]*\bhidden\b/.test(a),
  );
  t.check('has restore-quality select', /id="audio-restore-quality"/.test(a));
  t.check(
    'restore quality is bound to settings.audio.restoreQuality',
    /data-setting="audio.restoreQuality"/.test(a),
  );
  const restoreSelect = a.match(/<select\b[^>]*\bid="audio-restore-quality"[\s\S]*?<\/select>/);
  const qualityValues = [...(restoreSelect ? restoreSelect[0] : '').matchAll(/<option\b[^>]*\bvalue="([^"]+)"/g)].map((m) => m[1]);
  t.check(
    'restore quality offers the ten PLAYBACK_QUALITIES',
    qualityValues.slice().sort().join() === 'auto,hd1080,hd1440,hd2160,hd720,highres,large,medium,small,tiny',
    JSON.stringify(qualityValues),
  );
  t.check('hd720 is selected in markup', /<option\b[^>]*\bvalue="hd720"[^>]*\bselected\b/.test(a));
  t.check('has a shortcut hint', /id="audio-shortcut"/.test(a));
  t.check(
    'popup loads core.js as a classic script before the module',
    /<script src="\.\.\/content\/core\.js"><\/script>\s*<script type="module" src="popup\.js">/.test(html),
  );
  t.check('has the open-tab picker', /id="audio-picker"/.test(a));
  t.check(
    'picker starts hidden',
    /<div[^>]*\bid="audio-picker"[^>]*\bhidden\b/.test(a),
  );
  t.check('has the player card', /id="audio-player"/.test(a));
  t.check('player has a seek bar', /id="audio-seek"/.test(a));
  t.check(
    'seek bar has a translated accessible name',
    /id="audio-seek"[\s\S]{0,240}data-i18n-label="audioSeek"/.test(a),
  );
  t.check('audioSeek exists in en', 'audioSeek' in en);
  t.check(
    'audioSeekValue speaks elapsed of duration',
    'audioSeekValue' in en
      && /\$CURRENT\$/.test(en.audioSeekValue.message)
      && /\$DURATION\$/.test(en.audioSeekValue.message),
  );
  t.check(
    'seek bar keeps aria-valuetext in sync',
    /function setSeekValueText/.test(js)
      && /aria-valuetext/.test(js)
      && /audioSeekValue/.test(js)
      && /setSeekValueText\(seek, shown, duration\)/.test(js)
      && /setSeekValueText\(seek, shown, Number\(seek\.max\)\)/.test(js),
  );
  t.check(
    'player has back, play and forward',
    /id="audio-back"/.test(a) && /id="audio-play"/.test(a) && /id="audio-forward"/.test(a),
  );
  t.check(
    'seek bar and skip buttons stay LTR in RTL',
    /audio-player__timeline"[^>]*\bdir="ltr"/.test(a)
      && /audio-player__transport"[^>]*\bdir="ltr"/.test(a),
  );
  t.check(
    'skip buttons size to their label inside the transport row',
    /\.audio-player__transport\s+#audio-back[\s\S]{0,80}#audio-forward[\s\S]{0,200}width:\s*auto/.test(css)
      && /\.audio-player__transport\s+#audio-back[\s\S]{0,200}padding-inline:/.test(css),
  );
  t.check(
    'other icon buttons stay 28px',
    /\.icon-btn\s*\{[\s\S]{0,80}width:\s*28px/.test(css),
  );
  t.check(
    'the three transport buttons share one height',
    /\.audio-player__transport\s+\.icon-btn\s*\{[\s\S]{0,60}height:\s*32px/.test(css)
      && /\.audio-player__play\s*\{[\s\S]{0,60}height:\s*32px/.test(css),
  );
  t.check(
    'has statistics cards',
    /id="audio-stat-used"/.test(a)
      && /id="audio-stat-saved"/.test(a)
      && /id="audio-stat-listened"/.test(a)
      && /id="audio-stat-active"/.test(a),
  );
  t.check('disabled settings-select is dimmed', /\.settings-select:disabled/.test(css));
  t.check(
    'empty shortcut uses audioShortcutNone',
    /audioShortcutNone/.test(js),
  );
  t.check(
    'bound shortcut uses audioShortcutBound',
    /audioShortcutBound/.test(js),
  );
  t.check(
    'shortcut hint does not invent Alt+Shift+A when empty',
    /audioShortcutNone/.test(js) && !/audioShortcutNone[\s\S]{0,80}Alt\+Shift\+A/.test(js),
  );
  t.check(
    'clicking the shortcut hint opens chrome://extensions/shortcuts',
    /chrome:\/\/extensions\/shortcuts/.test(js),
  );
  t.check(
    'popup reads the player with audioMode.player',
    /audioMode\.player/.test(js),
  );
  t.check(
    'popup toggles with audioMode.toggle',
    /audioMode\.toggle/.test(js),
  );
  t.check(
    'popup writes the player with audioMode.control',
    /audioMode\.control/.test(js),
  );
  t.check(
    'tabs.sendMessage is caught so a missing content script cannot reject unhandled',
    /function sendToTab/.test(js) && /catch\s*\{/.test(js),
  );
  t.check(
    'Watchlist still opens via activate(tab-watchlist)',
    /getElementById\('tab-watchlist'\)/.test(js) && /activate\(tab\)/.test(js),
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
    'settings-audio',
    'settings-backup',
  ];
  for (const id of groupIds) {
    t.check(`has settings group ${id}`, new RegExp(`id="${id}"`).test(s), id);
  }
  t.check(
    'look group has the open-feed-in-audio-mode checkbox',
    /data-setting="audio.openFeedInAudioMode"/.test(s),
  );
  t.check('look group has a background-type select', /data-setting="audio.backgroundType"/.test(s));
  const presets = [...s.matchAll(/\bdata-preset="([^"]+)"/g)].map((m) => m[1]);
  t.check(
    'look group has the six presets',
    presets.join() === 'midnight,slate,ember,amber,forest,sunset',
    JSON.stringify(presets),
  );
  t.check('look group has a custom colour picker', /id="audio-custom-color"/.test(s));
  t.check('look group has an image URL field', /id="audio-image-url"/.test(s));
  t.check('look group has an Apply control', /id="audio-image-apply"/.test(s));
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

  t.check('backup group has a Clear watchlist button', /id="settings-clear"[^>]*data-i18n="settingsClear"/.test(s));
  const clearRow = s.match(/<div id="settings-clear-confirm"[^>]*>[\s\S]*?<\/div>/);
  t.check('clearing asks first, inline and hidden until asked', !!clearRow && /\bhidden\b/.test(clearRow[0].split('>')[0]));
  t.check(
    'the confirm row has Remove all and Cancel',
    !!clearRow && /id="settings-clear-yes"/.test(clearRow[0]) && /id="settings-clear-cancel"/.test(clearRow[0]),
  );
  t.check('the prompt names how many channels go', /t\('settingsClearPrompt', \[String\(view\.channels\.length\)\]\)/.test(js));
  t.check('Clear is disabled with nothing to clear', /clearBtn\.disabled = locked \|\| view\.channels\.length === 0/.test(js));
  t.check(
    'only Remove all sends clearChannels',
    /settings-clear-yes'\)\.addEventListener\('click', \(\) => \{\s*void clearWatchlist\(\);/.test(js)
      && (js.match(/type: 'clearChannels'/g) || []).length === 1
      && /async function clearWatchlist\(\) \{[\s\S]{0,200}type: 'clearChannels'/.test(js),
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
  t.check('popup.js imports view.js', /from ['"]\.\.\/lib\/view\.js['"]/.test(js));
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
    'sheet has a problem sentence with a Retry button',
    /id="channel-sheet-problem"[\s\S]{0,240}id="channel-sheet-problem-text"[\s\S]{0,240}id="channel-sheet-retry"/.test(html),
  );
  t.check('Retry sweeps only that channel', /channel-sheet-retry[\s\S]{0,160}onlyId:\s*view\.sheetId/.test(js));
  t.check('a failed row shows translated text, not the worker\'s English', !/lastError\.message/.test(js));
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
    /visibleFeedItems\(\s*view\.feed,\s*!!view\.settings\?\.feed\?\.showShorts\s*\)\s*\.filter/.test(js),
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
  t.check(
    'sheet traps Tab inside the panel',
    /function trapSheetTab/.test(js)
      && /function sheetFocusables/.test(js)
      && /sheet__panel/.test(js),
  );
  t.check(
    'sheet focusables are queried on the key, not cached',
    /function trapSheetTab/.test(js) && /sheetFocusables\(\)/.test(js),
  );
  t.check(
    'watchlist opener sets data-channel-id',
    /channel-row__main[\s\S]{0,120}dataset\.channelId/.test(js),
  );
  t.check(
    'feed opener sets data-channel-id',
    /feed-row__channel[\s\S]{0,120}dataset\.channelId/.test(js),
  );
  t.check(
    'closing the sheet restores focus to the opener',
    /function closeChannelSheet/.test(js) && /focusSheetOpener/.test(js),
  );
  t.check(
    'missing opener falls back to the active tab',
    /function focusSheetOpener/.test(js)
      && /getAttribute\(\s*'aria-selected'\s*\)/.test(js),
  );

  t.section('follow card');

  const audioPanel = html.slice(html.indexOf('<section id="audio"'), html.indexOf('</section>', html.indexOf('<section id="audio"')));
  t.check('the Follow card sits in the Audio tab', /id="follow-card"/.test(audioPanel));
  t.check(
    'it comes before the audio mode switch',
    audioPanel.indexOf('id="follow-card"') >= 0 && audioPanel.indexOf('id="follow-card"') < audioPanel.indexOf('class="audio-head"'),
  );
  t.check('it starts hidden', /id="follow-card"[^>]*\bhidden\b/.test(html));
  t.check('Follow adds through the worker', /async function followChannel[\s\S]{0,1200}type:\s*'addChannel'/.test(js));
  t.check('each channel gets its own row in a list', /id="follow-card-list"/.test(html) && /function followRow/.test(js));
  t.check(
    'follow list is labelled by the card label',
    /id="follow-card-list"[^>]*aria-labelledby="follow-card-label"/.test(html),
  );
  const followFnStart = js.indexOf('async function followChannel');
  const followFn = followFnStart >= 0 ? js.slice(followFnStart, followFnStart + 1800) : '';
  t.check(
    'Follow buttons are not built from the global busy flag',
    /followActionState\(follow\.rows/.test(js)
      && !/function followRow[\s\S]{0,500}view\.busy/.test(js)
      && !/btn\.disabled = view\.busy/.test(js),
  );
  t.check(
    'Follow is not gated on view.busy and does not take withBusy',
    /async function followChannel/.test(followFn) && !/view\.busy/.test(followFn) && !/withBusy/.test(followFn),
    followFn.slice(0, 200),
  );
  t.check(
    'several Follow rows can wait at once',
    /followPending\.includes\(input\)/.test(followFn)
      && /followPending = \[\.\.\.view\.followPending, input\]/.test(followFn),
  );
  t.check(
    'a Follow error is drawn on that row',
    /follow-card__error/.test(js) && /follow-card__error/.test(css),
  );
  t.check(
    'Watchlist Add no longer waits under withBusy',
    /async function addChannel[\s\S]{0,400}view\.adding = true/.test(js)
      && !/async function addChannel[\s\S]{0,200}withBusy/.test(js),
  );
  t.check(
    'Undo no longer waits under withBusy',
    /async function undoRemove[\s\S]{0,200}view\.undoing = true/.test(js)
      && !/async function undoRemove[\s\S]{0,200}withBusy/.test(js),
  );
  t.check(
    'a storage write of channels or the feed redraws the open tab',
    /storage\.onChanged\.addListener[\s\S]{0,900}changes\.channels[\s\S]{0,900}changes\.feed/.test(js),
  );
  t.check(
    'a merge that would pass the cap uses settingsImportTooMany',
    /backupImportMessage/.test(js) && /formatBackupNotice/.test(js)
      && /settingsImportTooMany/.test(viewJs),
  );
  t.check(
    'the check mark is named in the reader\'s language',
    /function followCheck[\s\S]{0,240}aria-label',\s*t\('followingChannel'\)/.test(js),
  );
  t.check('the player card marks followed channels too', /renderPlayerChannels\(channelEl,/.test(js));
  t.check(
    'a redraw keeps focus on a Follow button',
    /card\.dataset\.sig !== sig/.test(js) && /\[data-input=/.test(js),
  );

  t.section('support sheet');

  const appbarSupport = html.match(/<button\b[^>]*\bid="appbar-support"[^>]*>/);
  t.check('the app bar holds #appbar-support', !!appbarSupport, 'missing');
  t.check(
    '#appbar-support has an i18n label',
    !!appbarSupport && /data-i18n-label="supportOpen"/.test(appbarSupport[0]),
    appbarSupport ? appbarSupport[0] : 'missing',
  );

  const backupAt = html.indexOf('id="settings-backup"');
  const settingsSupportAt = html.indexOf('id="settings-support"');
  const footerAt = html.indexOf('class="settings-footer"');
  t.check('has #settings-support', settingsSupportAt >= 0);
  t.check(
    '#settings-support sits after #settings-backup and before the footer',
    backupAt >= 0 && settingsSupportAt > backupAt && footerAt > settingsSupportAt,
    `${backupAt} ${settingsSupportAt} ${footerAt}`,
  );

  t.check('has support sheet overlay', /id="support-sheet"/.test(html));
  t.check(
    'support sheet is a dialog overlay',
    /id="support-sheet"[\s\S]*?role="dialog"/.test(html),
  );
  t.check('support sheet has a close control', /id="support-sheet-close"/.test(html));
  t.check('support sheet has a methods container', /id="support-methods"/.test(html));
  t.check(
    'popup.js imports from ../lib/support.js',
    /from\s+['"]\.\.\/lib\/support\.js['"]/.test(js),
  );
  t.check(
    'copy uses navigator.clipboard.writeText',
    /navigator\.clipboard\.writeText/.test(js),
  );
  t.check('support sheet never uses execCommand', !/\bexecCommand\s*\(/.test(js));
  t.check('support sheet never uses alert(', !/\balert\s*\(/.test(js));
  t.check('support sheet never uses confirm(', !/\bconfirm\s*\(/.test(js));

  t.section('a big feed stays fast');

  const renderBody = (js.match(/\nfunction render\(\) \{[\s\S]*?\n\}/) || [''])[0];
  t.check(
    'render draws only the open tab',
    /openTabName\(\)/.test(renderBody)
      && /if \(open === 'feeds'\) renderFeeds/.test(renderBody)
      && /if \(open === 'watchlist'\) renderWatchlist/.test(renderBody)
      && !/^\s*renderFeeds\(locale\);$/m.test(renderBody),
    renderBody,
  );
  t.check('opening a tab draws it', /panel\.hidden = panel\.id !== name;[\s\S]{0,120}render\(\);/.test(js));
  t.check('the feed is drawn 50 rows at a time', /const FEED_PAGE = 50;/.test(js) && /shown\.slice\(0, feedLimit\)/.test(js));
  t.check('a new query or filter starts again at one page', /pageKey !== feedPageKey[\s\S]{0,80}feedLimit = FEED_PAGE/.test(js));
  t.check(
    'more rows come from a button that scrolling also triggers',
    /id="feed-more"[^>]*hidden/.test(html) && /new IntersectionObserver/.test(js) && /showMoreFeed\(\)/.test(js),
  );
  t.check('thumbnails and avatars load lazily', (js.match(/img\.loading = 'lazy';/g) || []).length >= 2);
  t.check(
    'a feed row is not a focusable container',
    !/row\.tabIndex\s*=\s*0/.test(js),
  );
  t.check(
    'the feed video action is a real button covering thumb and title',
    /openBtn\.className = 'feed-row__open'/.test(js)
      && /openBtn\.type = 'button'/.test(js)
      && /row\.appendChild\(openBtn\)/.test(js)
      && /\.feed-row__open\s*\{[^}]*position:\s*absolute/.test(css)
      && /\.feed-row__open\s*\{[^}]*inset:\s*0/.test(css),
  );
  t.check(
    'the feed channel button is a sibling of the video action, not nested in it',
    /row\.appendChild\(openBtn\)/.test(js)
      && /row\.appendChild\(thumb\)/.test(js)
      && /row\.appendChild\(body\)/.test(js)
      && /chBtn\.className = 'feed-row__channel'/.test(js)
      && !/openBtn\.appendChild/.test(js),
  );
  t.check(
    'Tab hits the video action before the channel name',
    (() => {
      const openAt = js.indexOf('row.appendChild(openBtn)');
      const thumbAt = js.indexOf('row.appendChild(thumb)');
      const chAt = js.indexOf("chBtn.className = 'feed-row__channel'");
      return openAt >= 0 && thumbAt > openAt && chAt > thumbAt;
    })(),
  );
  t.check(
    'Enter on the video action is the button click',
    /openBtn\.addEventListener\('click',\s*\(\) => openFeedItem\(item, modes\.row\)\)/.test(js)
      && !/event\.target !== row/.test(js),
  );
  t.check(
    'title fade is to right in LTR and to left in RTL',
    /\.audio-player__title-wrap\s*\{[^}]*linear-gradient\(to right/.test(css)
      && /:dir\(rtl\)[\s\S]{0,120}linear-gradient\(to left/.test(css)
      && /\[dir="rtl"\][\s\S]{0,120}linear-gradient\(to left/.test(css),
  );

  t.section('sleep timer');

  const sleepSelect = html.match(/<select\b[^>]*\bid="audio-sleep"[^>]*>[\s\S]*?<\/select>/);
  t.check('the player card has a sleep timer', !!sleepSelect);
  t.check(
    'it offers off, 15, 30 and 60 minutes',
    ['0', '15', '30', '60'].every((v) => new RegExp(`<option value="${v}"`).test(sleepSelect?.[0] || '')),
  );
  t.check('a pick is sent to the tab', /audio-sleep[\s\S]{0,160}controlTarget\('sleep', \{ minutes: Number\(el\.value\) \}\)/.test(js));
  t.check('a running timer shows the minutes left', /sleepMinutesLeft\(player\?\.sleepAt/.test(js) && /audioSleepLeft/.test(js));

  t.section('keyboard shortcuts in Settings');

  const keysGroup = html.match(/<fieldset\b[^>]*\bid="settings-keys"[^>]*>[\s\S]*?<\/fieldset>/);
  t.check('Settings has a keyboard shortcuts group', !!keysGroup);
  t.check(
    'it shows the popup and audio mode keys',
    /id="settings-key-popup"/.test(keysGroup?.[0] || '') && /id="settings-key-audio"/.test(keysGroup?.[0] || ''),
  );
  t.check(
    'a key Chrome did not bind reads as not set',
    /view\.popupShortcut/.test(js) && /settingsKeyNone/.test(js),
  );
  t.check('Change opens the browser\'s shortcut page', /settings-keys-change[\s\S]{0,120}chrome:\/\/extensions\/shortcuts/.test(js));

  t.section('message types');

  const sent = [...js.matchAll(/\btype:\s*['"]([\w.]+)['"]/g)].map((m) => m[1]);
  const implemented = new Set([...worker.matchAll(/case\s+['"]([\w.]+)['"]/g)].map((m) => m[1]));
  const contentTypes = new Set([
    'audioMode.state',
    'audioMode.toggle',
    'audioMode.player',
    'audioMode.control',
  ]);
  t.check('popup sends at least one message', sent.length > 0, String(sent.length));
  t.check(
    'popup sends openInAudioMode',
    sent.includes('openInAudioMode'),
    sent.join(','),
  );
  for (const type of sent) {
    if (contentTypes.has(type)) {
      t.check(
        `popup message type "${type}" is sent to the tab, not the worker`,
        /tabs\.sendMessage/.test(js) && js.includes(type),
      );
      continue;
    }
    t.check(
      `popup message type "${type}" is implemented by the worker`,
      implemented.has(type),
      [...implemented].join(','),
    );
  }
  for (const type of ['updateSettings', 'importBackup', 'audioMode.shortcut']) {
    t.check(
      `worker implements "${type}"`,
      implemented.has(type),
      [...implemented].join(','),
    );
  }

  t.section('swatch colours match the overlay');

  const overlayCss = fs.readFileSync(path.join(ROOT, 'src/content/overlay.css'), 'utf8');
  function audioStops(src) {
    const out = {};
    const re = /--ytc-audio-([a-z]+)-(from|to)\s*:\s*(#[0-9a-fA-F]{6})/g;
    let m;
    while ((m = re.exec(src))) out[`${m[1]}-${m[2]}`] = m[3].toLowerCase();
    return out;
  }
  const overlayStops = audioStops(overlayCss);
  const popupStops = audioStops(css);
  const stopNames = [
    'midnight-from', 'midnight-to',
    'slate-from', 'slate-to',
    'ember-from', 'ember-to',
    'amber-from', 'amber-to',
    'forest-from', 'forest-to',
    'sunset-from', 'sunset-to',
  ];
  t.check(
    'overlay.css declares all six preset stops',
    stopNames.every((name) => overlayStops[name]),
    JSON.stringify(overlayStops),
  );
  t.check(
    'popup.css declares all six preset stops',
    stopNames.every((name) => popupStops[name]),
    JSON.stringify(popupStops),
  );
  for (const name of stopNames) {
    t.check(
      `popup.css ${name} matches overlay.css`,
      popupStops[name] === overlayStops[name],
      `${popupStops[name]} vs ${overlayStops[name]}`,
    );
  }
  t.check('overlay.css angle is 165deg', /--ytc-audio-angle:\s*165deg/.test(overlayCss));
  t.check('popup.css angle is 165deg', /--ytc-audio-angle:\s*165deg/.test(css));
}
