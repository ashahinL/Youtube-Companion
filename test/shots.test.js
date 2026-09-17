/**
 * Shot lists, demo snapshot rules, and store-frame size checks.
 * No browser, no network.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import {
  DOCS_SHOTS,
  STORE_SHOTS,
  SITE_SHOTS,
  STORE_FRAME_MIN_RATIO,
  assertStoreFrameBytes,
} from '../scripts/shots.js';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';
import {
  sanitizeChannelGroups,
  GROUP_MAX_PER_CHANNEL,
  GROUP_MAX_DISTINCT,
  isNewSince,
  followView,
} from '../src/lib/view.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function loadDemo() {
  const sandbox = { Date };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(read('scripts/shots/demo.js'), sandbox);
  return sandbox.SHOTS_DEMO;
}

function applySceneNames(stubSrc) {
  const fn = stubSrc.match(/function applyScene\(name\) \{[\s\S]*?\n  \}/);
  return fn ? [...fn[0].matchAll(/name === '([^']+)'/g)].map((m) => m[1]) : [];
}

export default async function run(t) {
  const stubSrc = read('scripts/shots/stub.js');
  const scenes = new Set(applySceneNames(stubSrc));
  const asked = [...DOCS_SHOTS, ...SITE_SHOTS].map((shot) => shot.scene);

  t.section('scenes');

  t.check('applyScene is in the stub', scenes.size > 0);
  for (const scene of new Set(asked)) {
    t.check(`applyScene knows ${scene}`, scenes.has(scene), JSON.stringify([...scenes]));
  }
  t.check('audio still names the player scene', scenes.has('audio') && scenes.has('player'));
  t.check('groups and follow scenes exist', scenes.has('groups') && scenes.has('follow'));
  const readyFn = (stubSrc.match(/function whenPopupReady\([\s\S]*?\n  \}/) || [])[0] || '';
  t.check(
    'whenPopupReady waits for the opening choice',
    /is-opening/.test(readyFn) && !/audio-title/.test(readyFn),
    readyFn.slice(0, 200),
  );

  t.section('store and docs lists');

  t.check(
    'the store set is the six 2.0 frames',
    STORE_SHOTS.map((s) => s.name).join()
      === 'screenshot-1-feeds,screenshot-2-player,screenshot-3-groups,screenshot-4-watchlist,screenshot-5-sheet,screenshot-6-arabic',
  );
  const docsImgs = new Set(DOCS_SHOTS.map((s) => `${s.name}.png`));
  for (const shot of STORE_SHOTS) {
    t.check(`${shot.name} uses a docs image`, docsImgs.has(shot.img), shot.img);
  }
  for (const shot of SITE_SHOTS) {
    t.check(`site ${shot.name} reuses a docs scene`, DOCS_SHOTS.some((d) => d.scene === shot.scene), shot.scene);
  }

  t.section('demo snapshot');

  const demo = loadDemo();
  t.check(
    'demo settings match DEFAULT_SETTINGS',
    JSON.stringify(demo.defaultSettings) === JSON.stringify(DEFAULT_SETTINGS),
  );
  t.check('feed.group is in the demo settings', demo.defaultSettings?.feed?.group === '');

  const channels = demo.channels || [];
  t.check('six demo channels', channels.length === 6, String(channels.length));
  let twoGroup = 0;
  const distinct = new Set();
  for (const ch of channels) {
    const groups = sanitizeChannelGroups(ch.groups);
    t.check(
      `${ch.title} groups pass sanitizeChannelGroups`,
      JSON.stringify(groups) === JSON.stringify(ch.groups || []),
      JSON.stringify(ch.groups),
    );
    t.check(`${ch.title} is within the per-channel cap`, groups.length <= GROUP_MAX_PER_CHANNEL);
    if (groups.length >= 2) twoGroup += 1;
    for (const name of groups) distinct.add(name);
  }
  t.check('at least one channel is in two groups', twoGroup >= 1, String(twoGroup));
  t.check(
    'distinct groups are within the list cap',
    distinct.size > 0 && distinct.size <= GROUP_MAX_DISTINCT,
    String(distinct.size),
  );

  const seenAt = demo.pollState?.lastSeenAt;
  const feed = demo.feed || [];
  const newRows = feed.filter((item) => isNewSince(item, seenAt));
  t.check('lastSeenAt is a real time', Number(seenAt) > 0, String(seenAt));
  t.check(
    'at least one and not all feed rows are new',
    newRows.length >= 1 && newRows.length < feed.length,
    `${newRows.length} of ${feed.length}`,
  );

  t.section('follow scene is honest');

  const coreSrc = read('src/content/core.js');
  const coreBox = { URL };
  vm.createContext(coreBox);
  vm.runInContext(coreSrc, coreBox, { filename: 'src/content/core.js' });
  const followTab = {
    url: 'https://www.youtube.com/@vsauce',
    title: 'Vsauce - YouTube',
  };
  const card = followView({
    tab: followTab,
    page: { ok: false, on: false },
    channels,
    feed,
    core: coreBox.AudioModeCore,
  });
  t.check(
    'a Vsauce channel page shows the Follow card against the demo list',
    card.show === true && card.kind === 'channel' && card.rows[0]?.name === 'Vsauce' && card.rows[0]?.followed === false,
    JSON.stringify(card),
  );

  t.section('empty store frame');

  t.check('the cut is half the median', STORE_FRAME_MIN_RATIO === 0.5, String(STORE_FRAME_MIN_RATIO));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-shot-bytes-'));
  try {
    const bigA = path.join(dir, 'a.png');
    const bigB = path.join(dir, 'b.png');
    const tiny = path.join(dir, 'tiny.png');
    fs.writeFileSync(bigA, Buffer.alloc(400_000));
    fs.writeFileSync(bigB, Buffer.alloc(410_000));
    fs.writeFileSync(tiny, Buffer.alloc(10_000));
    let threw = '';
    try {
      assertStoreFrameBytes([bigA, bigB, tiny]);
    } catch (err) {
      threw = String(err.message || err);
    }
    t.check('a far-smaller frame fails', threw.length > 0, threw);
    t.check('the failure names the file', threw.includes(tiny), threw);
    t.check('similar sizes pass', (() => {
      assertStoreFrameBytes([bigA, bigB]);
      return true;
    })());
    t.check('a single file is not compared', (() => {
      assertStoreFrameBytes([tiny]);
      return true;
    })());
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
