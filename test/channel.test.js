/**
 * Channel window. Text and file-existence assertions, plus the worker's
 * one-window-per-channel behaviour against the chrome mock. There is no
 * DOM here, so channel.js is never imported.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installChromeMock } from './helpers/chrome-mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHANNEL = path.join(ROOT, 'src/channel');

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
  const html = fs.readFileSync(path.join(CHANNEL, 'channel.html'), 'utf8');
  const css = fs.readFileSync(path.join(CHANNEL, 'channel.css'), 'utf8');
  const js = fs.readFileSync(path.join(CHANNEL, 'channel.js'), 'utf8');
  const worker = fs.readFileSync(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
  const en = JSON.parse(fs.readFileSync(path.join(ROOT, '_locales/en/messages.json'), 'utf8'));

  t.section('assets');

  t.check('references channel.css', /href="channel\.css"/.test(html));
  t.check('references channel.js', /src="channel\.js"/.test(html));
  t.check('channel.css exists', fs.existsSync(path.join(CHANNEL, 'channel.css')));
  t.check('channel.js exists', fs.existsSync(path.join(CHANNEL, 'channel.js')));

  t.section('i18n');

  const keys = [...html.matchAll(/data-i18n="([^"]+)"/g)].map((m) => m[1]);
  t.check('channel.html has data-i18n keys', keys.length > 0, String(keys.length));
  for (const key of keys) {
    t.check(`data-i18n="${key}" exists in en`, key in en);
  }

  t.section('channel.js rules');

  t.check('no confirm(', !/\bconfirm\s*\(/.test(js));
  t.check('no alert(', !/\balert\s*\(/.test(js));
  t.check('no prompt(', !/\bprompt\s*\(/.test(js));
  t.check('no direct fetch(', !/\bfetch\s*\(/.test(js));
  t.check('no innerHTML', !/\binnerHTML/.test(js));
  t.check('no outerHTML', !/\bouterHTML/.test(js));
  t.check('no insertAdjacentHTML', !/insertAdjacentHTML/.test(js));
  t.check(
    'does not pass ageText through relativeTime',
    !/relativeTime\s*\(\s*[^)]*ageText/.test(js) && !/relativeTime\s*\(\s*item\./.test(js),
  );
  t.check('renders ageText as given', /item\.ageText/.test(js));

  t.section('channel.css colours');

  const rest = stripColorRoots(css);
  const hex = rest.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  t.check(
    'no hex colour outside :root / prefers-color-scheme',
    hex.length === 0,
    JSON.stringify(hex),
  );

  t.section('message types');

  const sent = [...js.matchAll(/\btype:\s*['"](\w+)['"]/g)].map((m) => m[1]);
  const implemented = new Set([...worker.matchAll(/case\s+['"](\w+)['"]/g)].map((m) => m[1]));
  t.check('channel window sends at least one message', sent.length > 0, String(sent.length));
  for (const type of sent) {
    t.check(
      `channel message type "${type}" is implemented by the worker`,
      implemented.has(type),
      [...implemented].join(','),
    );
  }

  t.section('one window per channel');

  const previousChrome = globalThis.chrome;
  const mock = installChromeMock();
  try {
    const { handleMessage, onChannelWindowRemoved } = await import(
      '../src/background/service-worker.js'
    );

    const CID = 'UCwindowTest1';

    const first = await handleMessage({ type: 'openChannelWindow', id: CID });
    t.check('first open reports ok', first.ok === true, JSON.stringify(first));
    t.check(
      'first open calls windows.create once',
      mock.windowsCreated.length === 1,
      String(mock.windowsCreated.length),
    );
    const created = mock.windowsCreated[0];
    t.check(
      'create url is the channel page with cid',
      typeof created.url === 'string'
        && created.url.includes('src/channel/channel.html')
        && created.url.includes(`cid=${CID}`),
      String(created.url),
    );
    t.check('create type is popup', created.type === 'popup', String(created.type));
    t.check('create width comes from settings', created.width === 480, String(created.width));
    t.check('create height comes from settings', created.height === 760, String(created.height));
    t.check('first open did not call windows.update', mock.windowsUpdated.length === 0, String(mock.windowsUpdated.length));

    const second = await handleMessage({ type: 'openChannelWindow', id: CID });
    t.check('second open reports ok', second.ok === true, JSON.stringify(second));
    t.check(
      'second open does not create another window',
      mock.windowsCreated.length === 1,
      String(mock.windowsCreated.length),
    );
    t.check(
      'second open focuses the existing window',
      mock.windowsUpdated.length === 1
        && mock.windowsUpdated[0].id === created.id
        && mock.windowsUpdated[0].focused === true,
      JSON.stringify(mock.windowsUpdated),
    );

    mock.fireWindowRemoved(created.id);
    onChannelWindowRemoved(created.id);
    const third = await handleMessage({ type: 'openChannelWindow', id: CID });
    t.check('third open after close reports ok', third.ok === true, JSON.stringify(third));
    t.check(
      'closing forgets the mapping so the third open creates again',
      mock.windowsCreated.length === 2,
      String(mock.windowsCreated.length),
    );
    t.check(
      'third open is a new window id',
      mock.windowsCreated[1].id !== created.id,
      String(mock.windowsCreated[1]?.id),
    );

    const missing = await handleMessage({ type: 'openChannelWindow' });
    t.check(
      'missing id is ok: false',
      missing.ok === false && missing.error === 'missing id',
      JSON.stringify(missing),
    );
  } finally {
    mock.restore();
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
}
