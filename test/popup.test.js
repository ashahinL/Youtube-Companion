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

  t.section('feeds');

  const feeds = html.match(/<section\b[^>]*\bid="feeds"[^>]*>[\s\S]*?<\/section>/);
  t.check('feeds panel exists', !!feeds);
  const f = feeds ? feeds[0] : '';
  t.check('has filter input', /id="feed-filter"/.test(f));
  t.check('has refresh control', /id="feed-refresh"/.test(f));
  t.check('has list container', /id="feed-list"/.test(f));

  const emptyIds = [...f.matchAll(/id="(feed-empty-[^"]+)"/g)].map((m) => m[1]);
  t.check(
    'has three empty-state elements',
    emptyIds.length === 3,
    JSON.stringify(emptyIds),
  );
  t.check(
    'empty states are distinct',
    new Set(emptyIds).size === 3 &&
      emptyIds.includes('feed-empty-no-channels') &&
      emptyIds.includes('feed-empty-no-items') &&
      emptyIds.includes('feed-empty-filter'),
    JSON.stringify(emptyIds),
  );

  t.section('i18n');

  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  for (const key of keys) {
    t.check(`data-i18n="${key}" exists in en`, key in en);
  }

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
}
