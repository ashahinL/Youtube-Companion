/**
 * Audio-mode engine: bridge message validation, quality pick, overlay
 * presets, audioStats writes, and the keyboard command's tab targeting.
 * Loads classic scripts in node:vm the way Chrome will. No network.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { installChromeMock } from './helpers/chrome-mock.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const coreSrc = read('src/content/core.js');
const injectSrc = read('src/content/inject.js');
const contentSrc = read('src/content/content.js');
const overlayCss = read('src/content/overlay.css');

const PAGE = 'https://www.youtube.com';

function loadBridge(player) {
  const posts = [];
  const sandbox = {
    URL,
    addEventListener(type, fn) {
      if (!this._listeners) this._listeners = [];
      this._listeners.push({ type, fn });
    },
    postMessage(data, origin) {
      posts.push({ data, origin });
    },
    document: {
      getElementById(id) {
        return id === 'movie_player' ? player : null;
      },
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(injectSrc, sandbox, { filename: 'src/content/inject.js' });
  // vm wraps the sandbox; the script's `window` is that wrapper, not the
  // original object, so event.source must be the same reference it closed over.
  const win = vm.runInContext('globalThis', sandbox);
  function fire(event) {
    const list = sandbox._listeners || win._listeners || [];
    for (const { type, fn } of list) {
      if (type === 'message') fn(event);
    }
  }
  return { sandbox, win, fire, posts, bridge: sandbox.AudioModeBridge };
}

function loadEngine(chrome) {
  const sandbox = { URL, chrome };
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'src/content/core.js' });
  vm.runInContext(contentSrc, sandbox, { filename: 'src/content/content.js' });
  return {
    sandbox,
    core: sandbox.AudioModeCore,
    engine: sandbox.AudioModeContent,
  };
}

function req(over) {
  return Object.assign({
    source: null,
    origin: PAGE,
    data: {
      type: 'ytc-audio-bridge',
      dir: 'request',
      id: 1,
      method: 'getPlaybackQuality',
      args: [],
    },
  }, over);
}

export default async function run(t) {
  t.section('bridge message shape');

  const calls = [];
  const player = {
    getPlaybackQuality() {
      calls.push(['getPlaybackQuality']);
      return 'hd720';
    },
    getAvailableQualityLevels() {
      calls.push(['getAvailableQualityLevels']);
      return ['hd1080', 'hd720', 'tiny'];
    },
    setPlaybackQuality(q) {
      calls.push(['setPlaybackQuality', q]);
    },
    setPlaybackQualityRange(a, b) {
      calls.push(['setPlaybackQualityRange', a, b]);
    },
    addEventListener() {},
  };
  const { fire, posts, sandbox, win, bridge } = loadBridge(player);

  t.check('inject.js attaches AudioModeBridge', !!bridge);
  t.check('bridge type is namespaced', bridge.BRIDGE_TYPE === 'ytc-audio-bridge', String(bridge.BRIDGE_TYPE));

  function reset() {
    calls.length = 0;
    posts.length = 0;
  }

  reset();
  fire(req({ source: win }));
  t.check('valid getPlaybackQuality calls the player', calls.length === 1 && calls[0][0] === 'getPlaybackQuality', JSON.stringify(calls));
  t.check('valid request posts a namespaced response', posts[0]?.data?.type === 'ytc-audio-bridge' && posts[0]?.data?.dir === 'response', JSON.stringify(posts[0]));
  t.check('valid request is ok with the player result', posts[0]?.data?.ok === true && posts[0]?.data?.result === 'hd720', JSON.stringify(posts[0]?.data));
  t.check('response is targeted at youtube.com', posts[0]?.origin === PAGE, String(posts[0]?.origin));

  reset();
  fire(req({ source: win, origin: 'https://evil.com' }));
  t.check('wrong origin does not call the player', calls.length === 0, JSON.stringify(calls));
  t.check('wrong origin does not post a response', posts.length === 0, String(posts.length));

  reset();
  fire(req({ source: {}, origin: PAGE }));
  t.check('wrong source does not call the player', calls.length === 0, JSON.stringify(calls));

  reset();
  fire(req({ source: win, data: { type: 'other', dir: 'request', id: 1, method: 'getPlaybackQuality', args: [] } }));
  t.check('wrong type does not call the player', calls.length === 0, JSON.stringify(calls));

  reset();
  fire(req({ source: win, data: { type: 'ytc-audio-bridge', dir: 'response', id: 1, method: 'getPlaybackQuality', args: [] } }));
  t.check('response-shaped messages are not treated as requests', calls.length === 0, JSON.stringify(calls));

  reset();
  fire(req({ source: win, data: 'getPlaybackQuality' }));
  t.check('non-object data does not throw and does not call', calls.length === 0, JSON.stringify(calls));

  reset();
  fire(req({ source: win, data: null }));
  t.check('null data does not throw and does not call', calls.length === 0);

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 1, method: 'eval', args: ['1+1'] },
  }));
  t.check('unknown method does not call the player', calls.length === 0, JSON.stringify(calls));

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 1, method: 'setVolume', args: [50] },
  }));
  t.check('non-allowlisted player method is rejected', calls.length === 0, JSON.stringify(calls));

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 1, method: 'setPlaybackQuality', args: ['tiny'] },
  }));
  t.check('valid setPlaybackQuality is forwarded', calls.length === 1 && calls[0][1] === 'tiny', JSON.stringify(calls));

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 2, method: 'setPlaybackQualityRange', args: ['tiny', 'tiny'] },
  }));
  t.check(
    'valid setPlaybackQualityRange is forwarded in order',
    calls.length === 1 && calls[0][0] === 'setPlaybackQualityRange' && calls[0][1] === 'tiny' && calls[0][2] === 'tiny',
    JSON.stringify(calls),
  );

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 3, method: 'setPlaybackQualityRange', args: ['tiny'] },
  }));
  t.check('wrong arity is rejected', calls.length === 0, JSON.stringify(calls));

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 4, method: 'setPlaybackQuality', args: ['not-a-quality'] },
  }));
  t.check('unknown quality string is rejected', calls.length === 0, JSON.stringify(calls));

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 5, method: 'getPlaybackQuality' },
  }));
  t.check('missing args array is rejected', calls.length === 0, JSON.stringify(calls));

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: '1', method: 'getPlaybackQuality', args: [] },
  }));
  t.check('non-number id is rejected', calls.length === 0, JSON.stringify(calls));

  reset();
  let threw = false;
  const throwing = {
    getPlaybackQuality() { throw new Error('boom'); },
    addEventListener() {},
  };
  const boom = loadBridge(throwing);
  try {
    boom.fire(req({ source: boom.win }));
  } catch (err) {
    threw = true;
  }
  t.check('player throw does not escape into the page', threw === false);
  t.check(
    'player throw posts ok: false',
    boom.posts[0]?.data?.ok === false && boom.posts[0]?.data?.dir === 'response',
    JSON.stringify(boom.posts[0]),
  );

  reset();
  const missing = loadBridge(null);
  missing.fire(req({ source: missing.win }));
  t.check(
    'missing player posts ok: false and does not throw',
    missing.posts[0]?.data?.ok === false && missing.posts[0]?.data?.error === 'no player',
    JSON.stringify(missing.posts[0]),
  );

  t.check('isAllowedCall accepts tiny/tiny range', bridge.isAllowedCall('setPlaybackQualityRange', ['tiny', 'tiny']) === true);
  t.check('isAllowedCall rejects a third arg', bridge.isAllowedCall('setPlaybackQualityRange', ['tiny', 'tiny', 'tiny']) === false);
  t.check('isAllowedCall rejects auto as a get arg', bridge.isAllowedCall('getPlaybackQuality', ['auto']) === false);
  t.check('readRequest returns null for a foreign origin', bridge.readRequest(req({ source: sandbox, origin: 'https://evil.com' }), sandbox) === null);

  t.section('quality decision');

  const mock = installChromeMock();
  const { engine, core } = loadEngine(globalThis.chrome);

  t.check('picks tiny when it is offered', engine.pickAudioQuality(['hd1080', 'hd720', 'small', 'tiny']) === 'tiny');
  t.check('falls back to small when tiny is absent', engine.pickAudioQuality(['hd1080', 'hd720', 'small']) === 'small');
  t.check('tiny wins when both tiny and small are offered', engine.pickAudioQuality(['small', 'tiny']) === 'tiny');
  t.check('asks for tiny when the list is empty', engine.pickAudioQuality([]) === 'tiny');
  t.check('asks for tiny when the list is missing', engine.pickAudioQuality(undefined) === 'tiny');
  t.check('asks for tiny when the list is null', engine.pickAudioQuality(null) === 'tiny');
  t.check('accepts a comma-separated string of levels', engine.pickAudioQuality('hd1080,hd720,small') === 'small');
  t.check('does not treat medium as audio quality', engine.pickAudioQuality(['medium', 'large', 'hd720']) === 'tiny');

  t.section('preset lookup');

  t.check('midnight is the default for missing names', engine.lookupPreset(undefined).name === 'midnight');
  t.check('midnight is the default for unknown names', engine.lookupPreset('neon').name === 'midnight', JSON.stringify(engine.lookupPreset('neon')));
  t.check('midnight from-stop', engine.lookupPreset('midnight').from === '#0f0f14');
  t.check('midnight to-stop', engine.lookupPreset('midnight').to === '#1e1e28');
  t.check('slate from-stop', engine.lookupPreset('slate').from === '#17171f');
  t.check('slate to-stop', engine.lookupPreset('slate').to === '#3a3a48');
  t.check('ember from-stop', engine.lookupPreset('ember').from === '#14080a');
  t.check('ember to-stop', engine.lookupPreset('ember').to === '#8c1220');
  t.check('amber from-stop', engine.lookupPreset('amber').from === '#141007');
  t.check('amber to-stop', engine.lookupPreset('amber').to === '#8a6210');
  t.check('forest from-stop', engine.lookupPreset('forest').from === '#081410');
  t.check('forest to-stop', engine.lookupPreset('forest').to === '#14763a');
  t.check('sunset from-stop', engine.lookupPreset('sunset').from === '#96630d');
  t.check('sunset to-stop', engine.lookupPreset('sunset').to === '#7a1020');
  t.check('preset names are case-insensitive', engine.lookupPreset('Forest').name === 'forest');

  const expectedStops = {
    midnight: ['#0f0f14', '#1e1e28'],
    slate: ['#17171f', '#3a3a48'],
    ember: ['#14080a', '#8c1220'],
    amber: ['#141007', '#8a6210'],
    forest: ['#081410', '#14763a'],
    sunset: ['#96630d', '#7a1020'],
  };
  for (const [name, [from, to]] of Object.entries(expectedStops)) {
    t.check(`overlay.css declares ${name} from ${from}`, overlayCss.includes(from));
    t.check(`overlay.css declares ${name} to ${to}`, overlayCss.includes(to));
  }
  t.check('overlay.css scopes rules to #ytc-audio-overlay', overlayCss.includes('#ytc-audio-overlay'));

  t.section('overlay look from settings');

  t.check(
    'missing settings uses the midnight preset',
    engine.overlayLookFromSettings(null).kind === 'preset'
      && engine.overlayLookFromSettings(null).preset === 'midnight',
    JSON.stringify(engine.overlayLookFromSettings(null)),
  );
  t.check(
    'slate preset is honoured',
    engine.overlayLookFromSettings({ audio: { preset: 'slate' } }).preset === 'slate',
  );
  const img = engine.overlayLookFromSettings({
    audio: { backgroundType: 'image', imageUrl: 'https://example.com/bg.jpg' },
  });
  t.check('https image URL is accepted', img.kind === 'image' && img.url === 'https://example.com/bg.jpg', JSON.stringify(img));
  const badImg = engine.overlayLookFromSettings({
    audio: { backgroundType: 'image', imageUrl: 'javascript:alert(1)' },
  });
  t.check('javascript image URL falls back to a preset', badImg.kind === 'preset', JSON.stringify(badImg));
  const custom = engine.overlayLookFromSettings({
    audio: { preset: 'custom', customColor: '#112233' },
  });
  t.check('custom hex colour is accepted', custom.kind === 'color' && custom.color === '#112233', JSON.stringify(custom));
  t.check('sanitizeHex rejects a CSS injection', engine.sanitizeHex('#fff; background: url(') === null);
  t.check('sanitizeHex accepts 3-digit hex', engine.sanitizeHex('#abc') === '#aabbcc');

  t.section('audioStats');

  t.check('stats key is audioStats, not settings', engine.AUDIO_STATS_KEY === 'audioStats');

  const day = new Date(2026, 8, 13, 15, 0, 0);
  const key = core.dayKey(day);
  const merged = engine.mergeAudioStats(null, { listened: 10, active: 12 }, day);
  t.check('merge writes listened under the local day key', merged.listened[key] === 10, JSON.stringify(merged));
  t.check('merge writes active under the local day key', merged.active[key] === 12, JSON.stringify(merged));

  const again = engine.mergeAudioStats(merged, { listened: 5, active: 3 }, day);
  t.check('merge accumulates listened', again.listened[key] === 15, JSON.stringify(again.listened));
  t.check('merge accumulates active', again.active[key] === 15, JSON.stringify(again.active));
  t.check('merge does not mutate the previous object', merged.listened[key] === 10, String(merged.listened[key]));

  const oldDay = new Date(2026, 5, 1, 12, 0, 0);
  const withOld = engine.mergeAudioStats(
    { listened: { '2026-01-01': 99 }, active: { '2026-01-01': 99 } },
    { listened: 1, active: 1 },
    oldDay,
  );
  t.check(
    'merge drops entries past the 90-day window',
    withOld.listened['2026-01-01'] === undefined && withOld.active['2026-01-01'] === undefined,
    JSON.stringify(withOld),
  );

  const emptyDelta = engine.mergeAudioStats(merged, { listened: 0, active: 0 }, day);
  t.check('zero delta does not invent a new day key on an empty add', emptyDelta.listened[key] === 10);

  await engine.persistAudioStats({ listened: 20, active: 30 }, day);
  const stored = await globalThis.chrome.storage.local.get(['audioStats', 'settings']);
  t.check(
    'persist writes under audioStats',
    stored.audioStats?.listened?.[key] === 20 && stored.audioStats?.active?.[key] === 30,
    JSON.stringify(stored.audioStats),
  );
  t.check('persist does not write settings', stored.settings === undefined, JSON.stringify(stored.settings));

  await engine.persistAudioStats({ listened: 4, active: 6 }, day);
  const stored2 = await globalThis.chrome.storage.local.get('audioStats');
  t.check(
    'persist accumulates on a second write',
    stored2.audioStats?.listened?.[key] === 24 && stored2.audioStats?.active?.[key] === 36,
    JSON.stringify(stored2.audioStats),
  );

  const skipped = await engine.persistAudioStats({ listened: 0, active: 0 }, day);
  t.check('persist skips a zero delta', skipped === null);

  t.check(
    'engine and bridge share a message type',
    engine.BRIDGE_TYPE === bridge.BRIDGE_TYPE,
    `${engine.BRIDGE_TYPE} vs ${bridge.BRIDGE_TYPE}`,
  );

  mock.restore();

  t.section('keyboard command targets the active tab');

  const cmdMock = installChromeMock();
  try {
    const { handleCommand } = await import('../src/background/service-worker.js');

    cmdMock.messagesSent.length = 0;
    await handleCommand('toggle-audio-mode', { id: 7, url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' });
    t.check(
      'uses the tab Chrome passed with the command',
      cmdMock.messagesSent.length === 1 && cmdMock.messagesSent[0].tabId === 7,
      JSON.stringify(cmdMock.messagesSent),
    );
    t.check(
      'payload is audioMode.toggle',
      cmdMock.messagesSent[0].message?.type === 'audioMode.toggle',
      JSON.stringify(cmdMock.messagesSent[0].message),
    );

    cmdMock.messagesSent.length = 0;
    await handleCommand('something-else', { id: 7 });
    t.check('ignores a different command name', cmdMock.messagesSent.length === 0, JSON.stringify(cmdMock.messagesSent));

    cmdMock.messagesSent.length = 0;
    cmdMock.activeTab = { id: 11, url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' };
    await handleCommand('toggle-audio-mode');
    t.check(
      'falls back to the active tab in the current window',
      cmdMock.messagesSent.length === 1 && cmdMock.messagesSent[0].tabId === 11,
      JSON.stringify(cmdMock.messagesSent),
    );

    cmdMock.messagesSent.length = 0;
    cmdMock.activeTab = null;
    await handleCommand('toggle-audio-mode');
    t.check('does nothing when there is no active tab', cmdMock.messagesSent.length === 0, JSON.stringify(cmdMock.messagesSent));
  } finally {
    cmdMock.restore();
  }
}
