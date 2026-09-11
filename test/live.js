#!/usr/bin/env node
/**
 * Opt-in end-to-end check against the real youtube.com. Not part of `npm test`:
 * it needs the network and it depends on channels that keep uploading, so a
 * failure here can mean YouTube changed OR that a channel went quiet.
 *
 * Run with: npm run test:live
 */

import { installChromeMock } from './helpers/chrome-mock.js';

installChromeMock();
globalThis.chrome.notifications ??= { create: async () => {}, onClicked: { addListener() {} } };

const worker = await import('../src/background/service-worker.js');
const send = (msg) => worker.handleMessage(msg);

let failures = 0;
const ok = (label, pass, detail = '') => {
  if (!pass) failures++;
  console.log(`  ${pass ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
};

console.log('\nadding channels');
const byHandle = await send({ type: 'addChannel', input: '@mkbhd' });
ok('@handle resolves and adds', byHandle.ok, byHandle.ok ? byHandle.channel.title : byHandle.error);
ok('id is the real channel id', byHandle.channel?.id === 'UCBJycsmduvYEL83R_U4JriQ', byHandle.channel?.id);
ok('header brought an avatar', !!byHandle.channel?.avatar);

const byUrl = await send({ type: 'addChannel', input: 'https://www.youtube.com/@veritasium' });
ok('full URL resolves and adds', byUrl.ok, byUrl.ok ? byUrl.channel.title : byUrl.error);

const dup = await send({ type: 'addChannel', input: '@mkbhd' });
ok('a duplicate is refused', !dup.ok && dup.error === 'already added', dup.error);

const junk = await send({ type: 'addChannel', input: 'https://example.com/nope' });
ok('a non-channel URL is refused', !junk.ok, junk.error);

console.log('\nthe feed');
const state = await send({ type: 'getState' });
ok('both channels stored', state.channels.length === 2, String(state.channels.length));
ok('feed filled from both', state.feed.length > 20, String(state.feed.length));
ok('items are newest first', state.feed.every((it, i, a) => i === 0 || a[i - 1].at >= it.at));
ok('every item carries a channel that exists',
  state.feed.every((it) => state.channels.some((c) => c.id === it.c)));

const kinds = new Set(state.feed.map((it) => it.k));
ok('classifier ran on every item', !state.feed.some((it) => !it.k), [...kinds].join(','));
ok('shorts were detected', kinds.has('short'), 'kinds: ' + [...kinds].join(','));
ok('normal videos carry a duration', state.feed.filter((i) => i.k === 'video').every((i) => i.d > 0));

console.log('\nthe silent seed');
ok('every seeded id is marked notified',
  state.pollState.notified.length >= state.feed.length,
  `${state.pollState.notified.length} marked, ${state.feed.length} items`);
ok('channels are flagged seeded', state.channels.every((c) => c.seeded));

console.log('\nsearch');
const hits = await send({ type: 'searchChannels', query: 'fireship' });
ok('search returns channels', Array.isArray(hits) && hits.length > 0, `${hits.length} hits`);
ok('ids are unique', new Set(hits.map((h) => h.id)).size === hits.length);
ok('handles came through', hits.every((h) => !h.handle || h.handle.startsWith('@')));
ok('already-added channels are marked', hits.every((h) => typeof h.inList === 'boolean'));

console.log(`\n${failures ? `${failures} FAILED` : 'all live checks passed'}\n`);
process.exit(failures ? 1 : 0);
