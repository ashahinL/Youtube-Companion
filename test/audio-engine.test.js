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
import { resolveLocale as libResolveLocale } from '../src/lib/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const coreSrc = read('src/content/core.js');
const injectSrc = read('src/content/inject.js');
const contentSrc = read('src/content/content.js');
const overlayCss = read('src/content/overlay.css');

const PAGE = 'https://www.youtube.com';

function loadBridge(player, opts) {
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
  if (!opts || opts.harness !== false) sandbox.__ytcHarness = true;
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

function loadEngine(chrome, opts) {
  const sandbox = { URL, chrome };
  if (!opts || opts.harness !== false) sandbox.__ytcHarness = true;
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

function makeEl(tag) {
  const kids = [];
  const attrs = {};
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    innerHTML: '',
    textContent: '',
    parentNode: null,
    style: {
      backgroundImage: '',
      setProperty() {},
      removeProperty() {},
    },
    dataset: {},
    setAttribute(k, v) { attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null; },
    removeAttribute(k) { delete attrs[k]; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    appendChild(child) {
      child.parentNode = node;
      kids.push(child);
      return child;
    },
    removeChild(child) {
      const i = kids.indexOf(child);
      if (i >= 0) kids.splice(i, 1);
      child.parentNode = null;
      return child;
    },
    addEventListener() {},
  };
  return node;
}

async function loadSession(opts) {
  const chrome = globalThis.chrome;
  const calls = [];
  let reported = opts.quality;
  const video = {
    currentTime: 0,
    paused: false,
    ended: false,
    addEventListener() {},
  };
  const moviePlayer = makeEl('div');
  moviePlayer.id = 'movie_player';
  moviePlayer.querySelector = function (sel) {
    if (sel === 'video.html5-main-video' || sel === 'video') return video;
    return null;
  };

  const nodesById = { movie_player: moviePlayer };
  const html = { dataset: {}, appendChild() { return arguments[0]; } };
  const head = {
    appendChild(el) {
      if (typeof el.onload === 'function') el.onload();
      return el;
    },
  };

  const box = { win: null, listeners: [] };
  const sandbox = {
    __ytcHarness: true,
    URL,
    chrome,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    location: { href: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
    navigator: { language: 'en-US' },
    document: {
      documentElement: html,
      head,
      getElementById(id) { return nodesById[id] || null; },
      createElement(tag) {
        const el = makeEl(tag);
        Object.defineProperty(el, 'id', {
          get() { return el._id || ''; },
          set(v) {
            if (el._id) delete nodesById[el._id];
            el._id = v;
            if (v) nodesById[v] = el;
          },
        });
        return el;
      },
      addEventListener() {},
    },
    addEventListener(type, fn) {
      if (type === 'message') box.listeners.push(fn);
    },
    postMessage(data) {
      if (!data || data.dir !== 'request') return;
      calls.push([data.method].concat(Array.isArray(data.args) ? data.args : []));
      let result;
      if (data.method === 'getPlaybackQuality') result = reported;
      else if (data.method === 'getAvailableQualityLevels') {
        result = ['hd2160', 'hd1440', 'hd1080', 'hd720', 'large', 'medium', 'small', 'tiny'];
      } else if (data.method === 'setPlaybackQuality') {
        reported = data.args && data.args[0];
      }
      const event = {
        source: box.win,
        origin: PAGE,
        data: {
          type: data.type,
          dir: 'response',
          id: data.id,
          ok: true,
          result: result,
        },
      };
      for (let i = 0; i < box.listeners.length; i++) box.listeners[i](event);
    },
  };
  sandbox.window = undefined;
  vm.createContext(sandbox);
  box.win = vm.runInContext('globalThis', sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'src/content/core.js' });
  vm.runInContext(contentSrc, sandbox, { filename: 'src/content/content.js' });
  return {
    engine: sandbox.AudioModeContent,
    calls,
    async restoreLastQuality() {
      const sets = calls.filter((c) => c[0] === 'setPlaybackQuality');
      return sets.length ? sets[sets.length - 1][1] : undefined;
    },
  };
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
    playVideo() {
      calls.push(['playVideo']);
    },
    pauseVideo() {
      calls.push(['pauseVideo']);
    },
    seekTo(time) {
      calls.push(['seekTo', time]);
    },
    setPlaybackRate(rate) {
      calls.push(['setPlaybackRate', rate]);
    },
    setVolume(n) {
      calls.push(['setVolume', n]);
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
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 1, method: 'mute', args: [] },
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

  t.section('player writes on the bridge');

  t.check('playVideo with no args is allowed', bridge.isAllowedCall('playVideo', []) === true);
  t.check('playVideo with an arg is refused', bridge.isAllowedCall('playVideo', [1]) === false);
  t.check('pauseVideo with no args is allowed', bridge.isAllowedCall('pauseVideo', []) === true);
  t.check('pauseVideo with an arg is refused', bridge.isAllowedCall('pauseVideo', [0]) === false);

  t.check('seekTo 0 is allowed', bridge.isAllowedCall('seekTo', [0]) === true);
  t.check('seekTo 12.5 is allowed', bridge.isAllowedCall('seekTo', [12.5]) === true);
  t.check('seekTo negative is refused', bridge.isAllowedCall('seekTo', [-1]) === false);
  t.check('seekTo Infinity is refused', bridge.isAllowedCall('seekTo', [Infinity]) === false);
  t.check('seekTo NaN is refused', bridge.isAllowedCall('seekTo', [NaN]) === false);
  t.check('seekTo a string is refused', bridge.isAllowedCall('seekTo', ['5']) === false);
  t.check('seekTo extra arg is refused', bridge.isAllowedCall('seekTo', [5, true]) === false);
  t.check('seekTo missing args is refused', bridge.isAllowedCall('seekTo', []) === false);

  for (const rate of [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]) {
    t.check(`setPlaybackRate ${rate} is allowed`, bridge.isAllowedCall('setPlaybackRate', [rate]) === true);
  }
  t.check('setPlaybackRate 1.1 is refused', bridge.isAllowedCall('setPlaybackRate', [1.1]) === false);
  t.check('setPlaybackRate 0 is refused', bridge.isAllowedCall('setPlaybackRate', [0]) === false);
  t.check('setPlaybackRate 3 is refused', bridge.isAllowedCall('setPlaybackRate', [3]) === false);
  t.check('setPlaybackRate a string is refused', bridge.isAllowedCall('setPlaybackRate', ['1']) === false);
  t.check('setPlaybackRate extra arg is refused', bridge.isAllowedCall('setPlaybackRate', [1, 1]) === false);
  t.check('setPlaybackRate missing args is refused', bridge.isAllowedCall('setPlaybackRate', []) === false);

  t.check('setVolume 0 is allowed', bridge.isAllowedCall('setVolume', [0]) === true);
  t.check('setVolume 50 is allowed', bridge.isAllowedCall('setVolume', [50]) === true);
  t.check('setVolume 100 is allowed', bridge.isAllowedCall('setVolume', [100]) === true);
  t.check('setVolume 50.5 is refused', bridge.isAllowedCall('setVolume', [50.5]) === false);
  t.check('setVolume -1 is refused', bridge.isAllowedCall('setVolume', [-1]) === false);
  t.check('setVolume 101 is refused', bridge.isAllowedCall('setVolume', [101]) === false);
  t.check('setVolume a string is refused', bridge.isAllowedCall('setVolume', ['50']) === false);
  t.check('setVolume extra arg is refused', bridge.isAllowedCall('setVolume', [50, true]) === false);
  t.check('setVolume missing args is refused', bridge.isAllowedCall('setVolume', []) === false);

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 8, method: 'playVideo', args: [] },
  }));
  t.check('valid playVideo is forwarded', calls.length === 1 && calls[0][0] === 'playVideo', JSON.stringify(calls));

  reset();
  fire(req({
    source: win,
    data: { type: 'ytc-audio-bridge', dir: 'request', id: 9, method: 'setVolume', args: [50] },
  }));
  t.check('valid setVolume is forwarded', calls.length === 1 && calls[0][0] === 'setVolume' && calls[0][1] === 50, JSON.stringify(calls));

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

  t.section('restore quality');

  t.check('hd1080 is restored as captured', engine.restorableQuality('hd1080', 'hd720') === 'hd1080');
  t.check('hd720 is restored as captured', engine.restorableQuality('hd720', 'hd1080') === 'hd720');
  t.check('hd2160 is restored as captured', engine.restorableQuality('hd2160', 'hd720') === 'hd2160');
  t.check('medium is restored as captured', engine.restorableQuality('medium', 'hd720') === 'medium');
  t.check('auto is restored as captured', engine.restorableQuality('auto', 'hd720') === 'auto');
  t.check('tiny falls back', engine.restorableQuality('tiny', 'hd720') === 'hd720');
  t.check('small falls back', engine.restorableQuality('small', 'hd720') === 'hd720');
  t.check('missing capture falls back', engine.restorableQuality(undefined, 'hd720') === 'hd720');
  t.check('unrecognised capture falls back', engine.restorableQuality('nope', 'hd720') === 'hd720');
  t.check('tiny uses a configured fallback', engine.restorableQuality('tiny', 'hd1080') === 'hd1080');
  t.check(
    'tiny with a bad fallback uses hd720',
    engine.restorableQuality('tiny', 'nope') === 'hd720',
  );
  t.check(
    'missing settings fallback is hd720',
    engine.restoreFallbackFromSettings(null) === 'hd720',
  );
  t.check(
    'settings.audio.restoreQuality is honoured as fallback',
    engine.restoreFallbackFromSettings({ audio: { restoreQuality: 'hd2160' } }) === 'hd2160',
  );
  t.check(
    'unknown settings.audio.restoreQuality falls back to hd720',
    engine.restoreFallbackFromSettings({ audio: { restoreQuality: 'nope' } }) === 'hd720',
  );

  t.section('restore quality through a session');

  async function runRestoreSession(quality, settings) {
    await globalThis.chrome.storage.local.clear();
    if (settings) await globalThis.chrome.storage.local.set({ settings });
    const sess = await loadSession({ quality });
    try {
      await sess.engine.enable();
      await sess.engine.disable();
      return sess;
    } catch (err) {
      try { await sess.engine.disable(); } catch (err2) { /* swallow */ }
      throw err;
    }
  }

  const capturedHd = await runRestoreSession('hd1080');
  t.check(
    'a session that captured hd1080 restores to hd1080',
    (await capturedHd.restoreLastQuality()) === 'hd1080',
    JSON.stringify(capturedHd.calls),
  );

  const capturedTiny = await runRestoreSession('tiny');
  t.check(
    'a session that captured tiny restores to the fallback',
    (await capturedTiny.restoreLastQuality()) === 'hd720',
    JSON.stringify(capturedTiny.calls),
  );

  const capturedSmall = await runRestoreSession('small');
  t.check(
    'a session that captured small restores to the fallback',
    (await capturedSmall.restoreLastQuality()) === 'hd720',
    JSON.stringify(capturedSmall.calls),
  );

  const capturedTinyCustom = await runRestoreSession('tiny', { audio: { restoreQuality: 'hd2160' } });
  t.check(
    'a tiny capture uses settings.audio.restoreQuality as fallback',
    (await capturedTinyCustom.restoreLastQuality()) === 'hd2160',
    JSON.stringify(capturedTinyCustom.calls),
  );

  await globalThis.chrome.storage.local.clear();

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
  t.check(
    'overlay z-index stays 10 so player controls remain above it',
    /z-index:\s*10;/.test(overlayCss),
  );

  const cssRules = overlayCss.replace(/\/\*[\s\S]*?\*\//g, '');
  t.check(
    'overlay rules do not use rem (YouTube html is 10px)',
    !/[0-9.]rem\b/.test(cssRules),
    cssRules.match(/[^\n]*[0-9.]rem[^\n]*/g) && cssRules.match(/[^\n]*[0-9.]rem[^\n]*/g).join('\n'),
  );
  t.check('icon max is 52px', /clamp\(\s*28px,\s*10vmin,\s*52px\s*\)/.test(cssRules));
  t.check(
    'title max is 21.6px',
    /clamp\(\s*13\.6px,\s*2\.2vmin \+ 6\.4px,\s*21\.6px\s*\)/.test(cssRules),
  );
  t.check(
    'button max is 15.2px',
    /clamp\(\s*11\.2px,\s*1\.6vmin \+ 5\.6px,\s*15\.2px\s*\)/.test(cssRules),
  );
  t.check('vmin halves are unchanged', cssRules.includes('10vmin') && cssRules.includes('2.2vmin') && cssRules.includes('1.6vmin'));
  t.check(
    'container title-hide breakpoint is px',
    cssRules.includes('max-width: 224px') && cssRules.includes('max-height: 144px'),
  );
  t.check(
    'container exit-hide breakpoint is px',
    cssRules.includes('max-width: 112px') && cssRules.includes('max-height: 80px'),
  );

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

  t.section('overlay copy');

  const enMessages = JSON.parse(read('_locales/en/messages.json'));
  const arMessages = JSON.parse(read('_locales/ar/messages.json'));

  const localeCases = [
    ['en', 'ar'],
    ['ar', 'en'],
    ['auto', 'ar'],
    ['auto', 'ar-EG'],
    ['auto', 'en'],
    ['auto', 'en-GB'],
    ['auto', 'fr'],
    ['auto', undefined],
    ['auto', ''],
    [undefined, 'ar-EG'],
  ];
  for (const [setting, nav] of localeCases) {
    t.check(
      `content resolveLocale(${JSON.stringify(setting)}, ${JSON.stringify(nav)}) matches lib/i18n.js`,
      engine.resolveLocale(setting, nav) === libResolveLocale(setting, nav),
      `${engine.resolveLocale(setting, nav)} vs ${libResolveLocale(setting, nav)}`,
    );
  }

  t.check(
    'settings.ui.locale en wins over an Arabic browser',
    engine.localeFromSettings({ ui: { locale: 'en' } }, 'ar') === 'en',
  );
  t.check(
    'settings.ui.locale ar wins over an English browser',
    engine.localeFromSettings({ ui: { locale: 'ar' } }, 'en-US') === 'ar',
  );
  t.check(
    'auto follows navigator ar-EG',
    engine.localeFromSettings({ ui: { locale: 'auto' } }, 'ar-EG') === 'ar',
  );
  t.check(
    'missing settings follow the navigator',
    engine.localeFromSettings(null, 'ar') === 'ar'
      && engine.localeFromSettings(null, 'en-GB') === 'en',
  );

  const enUnbound = engine.overlayCopy({ ui: { locale: 'en' } }, enMessages, '', 'en');
  t.check('en title is Audio-only playback', enUnbound.title === 'Audio-only playback', enUnbound.title);
  t.check('en unbound exit is Exit audio mode', enUnbound.exit === 'Exit audio mode', enUnbound.exit);
  t.check('en unbound is ltr', enUnbound.dir === 'ltr' && enUnbound.locale === 'en');
  t.check(
    'en unbound exit does not print Alt+Shift+A',
    !enUnbound.exit.includes('Alt+Shift+A'),
    enUnbound.exit,
  );
  t.check(
    'en unbound exit does not print a key combination',
    !/\S\+\S/.test(enUnbound.exit),
    enUnbound.exit,
  );

  const enBound = engine.overlayCopy({ ui: { locale: 'en' } }, enMessages, 'Ctrl+Shift+Y', 'en');
  t.check(
    'en bound exit names the real shortcut',
    enBound.exit === 'Press Ctrl+Shift+Y to exit',
    enBound.exit,
  );
  t.check(
    'en bound exit does not print a different combination',
    !enBound.exit.includes('Alt+Shift+A'),
    enBound.exit,
  );

  const enWhitespace = engine.overlayCopy({ ui: { locale: 'en' } }, enMessages, '   ', 'en');
  t.check(
    'whitespace shortcut is treated as unbound',
    enWhitespace.exit === 'Exit audio mode',
    enWhitespace.exit,
  );
  t.check(
    'null shortcut is treated as unbound',
    engine.overlayCopy({ ui: { locale: 'en' } }, enMessages, null, 'en').exit === 'Exit audio mode',
  );
  t.check(
    'missing shortcut property is treated as unbound',
    engine.boundShortcut(undefined) === '' && engine.exitLabel(enMessages, undefined) === 'Exit audio mode',
  );

  const arUnbound = engine.overlayCopy({ ui: { locale: 'ar' } }, arMessages, '', 'en-US');
  t.check(
    'explicit ar is rtl even if the browser is en',
    arUnbound.dir === 'rtl' && arUnbound.locale === 'ar',
    JSON.stringify(arUnbound),
  );
  t.check('ar title is تشغيل الصوت فقط', arUnbound.title === 'تشغيل الصوت فقط', arUnbound.title);
  t.check('ar unbound exit is خروج من وضع الصوت', arUnbound.exit === 'خروج من وضع الصوت', arUnbound.exit);

  const arBound = engine.overlayCopy({ ui: { locale: 'ar' } }, arMessages, 'Alt+Shift+A', 'en');
  t.check(
    'ar bound exit includes the real shortcut',
    arBound.exit === 'اضغط Alt+Shift+A للخروج',
    arBound.exit,
  );
  t.check(
    'auto + ar-EG uses Arabic copy',
    engine.overlayCopy({ ui: { locale: 'auto' } }, arMessages, '', 'ar-EG').locale === 'ar'
      && engine.overlayCopy({ ui: { locale: 'auto' } }, arMessages, '', 'ar-EG').dir === 'rtl',
  );

  t.section('audioStats');

  t.check('stats key is audioStats, not settings', engine.AUDIO_STATS_KEY === 'audioStats');

  const day = new Date(2026, 8, 13, 15, 0, 0);
  const key = core.dayKey(day);
  const merged = engine.mergeAudioStats(null, { listened: 10, active: 12 }, day);
  t.check('merge writes listened under the local day key', merged.listened[key] === 10, JSON.stringify(merged));
  t.check('merge writes active under the local day key', merged.active[key] === 12, JSON.stringify(merged));
  t.check(
    'merge seeds totals from the day maps when they are missing',
    merged.totals?.listened === 10 && merged.totals?.active === 12,
    JSON.stringify(merged.totals),
  );

  const again = engine.mergeAudioStats(merged, { listened: 5, active: 3 }, day);
  t.check('merge accumulates listened', again.listened[key] === 15, JSON.stringify(again.listened));
  t.check('merge accumulates active', again.active[key] === 15, JSON.stringify(again.active));
  t.check(
    'merge accumulates totals',
    again.totals?.listened === 15 && again.totals?.active === 15,
    JSON.stringify(again.totals),
  );
  t.check('merge does not mutate the previous object', merged.listened[key] === 10, String(merged.listened[key]));
  t.check('merge does not mutate previous totals', merged.totals.listened === 10, String(merged.totals.listened));

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
  t.check(
    'totals survive pruning when seeded from a record with no totals',
    withOld.totals?.listened === 100 && withOld.totals?.active === 100,
    JSON.stringify(withOld.totals),
  );

  const withKeptTotals = engine.mergeAudioStats(
    {
      listened: { '2026-01-01': 99 },
      active: { '2026-01-01': 99 },
      totals: { listened: 500, active: 700 },
    },
    { listened: 1, active: 1 },
    oldDay,
  );
  t.check(
    'existing totals keep going after the day maps prune',
    withKeptTotals.listened['2026-01-01'] === undefined
      && withKeptTotals.totals?.listened === 501
      && withKeptTotals.totals?.active === 701,
    JSON.stringify(withKeptTotals),
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
  t.check(
    'persist writes never-pruned totals',
    stored.audioStats?.totals?.listened === 20 && stored.audioStats?.totals?.active === 30,
    JSON.stringify(stored.audioStats?.totals),
  );
  t.check('persist does not write settings', stored.settings === undefined, JSON.stringify(stored.settings));

  await engine.persistAudioStats({ listened: 4, active: 6 }, day);
  const stored2 = await globalThis.chrome.storage.local.get('audioStats');
  t.check(
    'persist accumulates on a second write',
    stored2.audioStats?.listened?.[key] === 24 && stored2.audioStats?.active?.[key] === 36,
    JSON.stringify(stored2.audioStats),
  );
  t.check(
    'persist accumulates totals on a second write',
    stored2.audioStats?.totals?.listened === 24 && stored2.audioStats?.totals?.active === 36,
    JSON.stringify(stored2.audioStats?.totals),
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

    const { handleMessage } = await import('../src/background/service-worker.js');

    cmdMock.commandList = [{ name: 'toggle-audio-mode', shortcut: 'Alt+Shift+A' }];
    const bound = await handleMessage({ type: 'audioMode.shortcut' });
    t.check(
      'worker returns the bound shortcut',
      bound.ok === true && bound.shortcut === 'Alt+Shift+A',
      JSON.stringify(bound),
    );

    cmdMock.commandList = [{ name: 'toggle-audio-mode', shortcut: '' }];
    const unbound = await handleMessage({ type: 'audioMode.shortcut' });
    t.check(
      'worker returns an empty shortcut when Chrome assigned none',
      unbound.ok === true && unbound.shortcut === '',
      JSON.stringify(unbound),
    );
    t.check(
      'unbound reply is not a suggested_key fallback',
      unbound.shortcut !== 'Alt+Shift+A',
      JSON.stringify(unbound),
    );

    cmdMock.commandList = [{ name: 'toggle-audio-mode', shortcut: '   ' }];
    const blank = await handleMessage({ type: 'audioMode.shortcut' });
    t.check(
      'whitespace-only binding is returned empty',
      blank.ok === true && blank.shortcut === '',
      JSON.stringify(blank),
    );

    cmdMock.commandList = [
      { name: 'other', shortcut: 'Ctrl+K' },
      { name: 'toggle-audio-mode', shortcut: 'Ctrl+Shift+Y' },
    ];
    const picked = await handleMessage({ type: 'audioMode.shortcut' });
    t.check(
      'worker picks toggle-audio-mode out of the command list',
      picked.ok === true && picked.shortcut === 'Ctrl+Shift+Y',
      JSON.stringify(picked),
    );

    cmdMock.commandList = [{ name: 'other', shortcut: 'Ctrl+K' }];
    const missing = await handleMessage({ type: 'audioMode.shortcut' });
    t.check(
      'missing toggle-audio-mode is an empty shortcut, not another command',
      missing.ok === true && missing.shortcut === '',
      JSON.stringify(missing),
    );

    cmdMock.commandList = [{ name: 'toggle-audio-mode' }];
    const noField = await handleMessage({ type: 'audioMode.shortcut' });
    t.check(
      'command with no shortcut field is empty',
      noField.ok === true && noField.shortcut === '',
      JSON.stringify(noField),
    );

    const originalGetAll = globalThis.chrome.commands.getAll;
    globalThis.chrome.commands.getAll = async () => {
      throw new Error('commands unavailable');
    };
    const threw = await handleMessage({ type: 'audioMode.shortcut' });
    t.check(
      'getAll throw is an empty shortcut, not ok:false',
      threw.ok === true && threw.shortcut === '',
      JSON.stringify(threw),
    );
    globalThis.chrome.commands.getAll = originalGetAll;

    delete globalThis.chrome.commands.getAll;
    const noFn = await handleMessage({ type: 'audioMode.shortcut' });
    t.check(
      'missing getAll is an empty shortcut',
      noFn.ok === true && noFn.shortcut === '',
      JSON.stringify(noFn),
    );
  } finally {
    cmdMock.restore();
  }

  t.section('suite APIs stay off the page global');

  const quietBridge = loadBridge(player, { harness: false });
  t.check('inject.js does not attach AudioModeBridge without the harness', quietBridge.bridge === undefined);
  t.check('double-install guard is set without the API object', quietBridge.sandbox.__ytcAudioBridgeInstalled === true);
  const listenersOnce = (quietBridge.sandbox._listeners || quietBridge.win._listeners || []).length;
  vm.runInContext(injectSrc, quietBridge.sandbox, { filename: 'src/content/inject.js' });
  const listenersTwice = (quietBridge.sandbox._listeners || quietBridge.win._listeners || []).length;
  t.check(
    'second inject.js is a no-op when the API object is absent',
    listenersTwice === listenersOnce && listenersOnce === 1,
    String(listenersTwice),
  );

  const quietEngine = loadEngine(undefined, { harness: false });
  t.check('content.js does not attach AudioModeContent without the harness', quietEngine.engine === undefined);
  t.check(
    'core.js still attaches AudioModeCore (content.js reads it in the isolated world)',
    !!quietEngine.core && typeof quietEngine.core.dayKey === 'function',
  );

  t.section('overlay parent');

  const container = { className: 'html5-video-container' };
  const moviePlayer = {
    querySelector(sel) {
      return sel === '.html5-video-container' ? container : null;
    },
  };
  const overlayBox = {
    __ytcHarness: true,
    URL,
    chrome: {},
    document: {
      getElementById(id) {
        return id === 'movie_player' ? moviePlayer : null;
      },
    },
  };
  vm.createContext(overlayBox);
  vm.runInContext(coreSrc, overlayBox, { filename: 'src/content/core.js' });
  vm.runInContext(contentSrc, overlayBox, { filename: 'src/content/content.js' });
  t.check(
    'overlay hangs off #movie_player, not .html5-video-container',
    overlayBox.AudioModeContent.findOverlayParent() === moviePlayer,
  );

  t.section('boot beacon, no bridge');

  const html = { dataset: {} };
  const injected = [];
  html.appendChild = function (el) {
    injected.push(el);
    return el;
  };
  const head = {
    appendChild(el) {
      injected.push(el);
      return el;
    },
  };
  const bootBox = {
    __ytcHarness: true,
    URL,
    chrome: {
      runtime: {
        id: 'test-id',
        getURL(p) { return 'chrome-extension://test/' + p; },
        onMessage: { addListener() {} },
      },
    },
    document: {
      documentElement: html,
      head,
      createElement(tag) {
        return { tagName: tag, src: '', parentNode: null, onload: null, onerror: null };
      },
      getElementById() { return null; },
    },
    addEventListener() {},
  };
  bootBox.window = bootBox;
  vm.createContext(bootBox);
  vm.runInContext(coreSrc, bootBox, { filename: 'src/content/core.js' });
  vm.runInContext(contentSrc, bootBox, { filename: 'src/content/content.js' });
  t.check('boot sets the DOM beacon', html.dataset.amBeacon === 'loaded', String(html.dataset.amBeacon));
  t.check('boot does not inject the MAIN-world bridge', injected.length === 0, String(injected.length));

  t.section('audioMode.state');

  const stateListeners = [];
  const stateBox = {
    __ytcHarness: true,
    URL,
    chrome: {
      runtime: {
        id: 'test-id',
        getURL(p) { return 'chrome-extension://test/' + p; },
        onMessage: {
          addListener(fn) { stateListeners.push(fn); },
        },
      },
    },
    document: {
      documentElement: { dataset: {} },
      head: { appendChild() {} },
      createElement() { return {}; },
      getElementById() { return null; },
    },
    addEventListener() {},
  };
  stateBox.window = stateBox;
  vm.createContext(stateBox);
  vm.runInContext(coreSrc, stateBox, { filename: 'src/content/core.js' });
  vm.runInContext(contentSrc, stateBox, { filename: 'src/content/content.js' });
  t.check('boot registers an onMessage listener', stateListeners.length === 1, String(stateListeners.length));

  const stateReplies = [];
  const stateRet = stateListeners[0](
    { type: 'audioMode.state' },
    {},
    (r) => { stateReplies.push(r); },
  );
  t.check(
    'state reports off without changing it',
    stateReplies.length === 1 && stateReplies[0].ok === true && stateReplies[0].on === false,
    JSON.stringify(stateReplies[0]),
  );
  t.check('state reply is synchronous', stateRet !== true, String(stateRet));

  const otherReplies = [];
  const otherRet = stateListeners[0](
    { type: 'nope' },
    {},
    (r) => { otherReplies.push(r); },
  );
  t.check('unknown message is ignored', otherReplies.length === 0 && otherRet === undefined);

  const toggleReplies = [];
  const toggleRet = stateListeners[0](
    { type: 'audioMode.toggle' },
    {},
    (r) => { toggleReplies.push(r); },
  );
  t.check('toggle is still async', toggleRet === true, String(toggleRet));

  t.section('audioMode.player and audioMode.control');

  function bootPage(opts) {
    opts = opts || {};
    const listeners = [];
    const injected = [];
    const calls = [];
    const video = opts.noVideo
      ? null
      : {
        currentTime: opts.currentTime != null ? opts.currentTime : 10,
        duration: opts.duration != null ? opts.duration : 100,
        paused: opts.paused !== false,
        ended: false,
        playbackRate: opts.playbackRate != null ? opts.playbackRate : 1,
        volume: opts.volume != null ? opts.volume : 0.5,
        muted: !!opts.muted,
      };
    const moviePlayer = opts.noPlayer ? null : makeEl('div');
    if (moviePlayer) {
      moviePlayer.id = 'movie_player';
      moviePlayer.querySelector = function (sel) {
        if (video && (sel === 'video.html5-main-video' || sel === 'video')) return video;
        return null;
      };
    }
    const nodesById = {};
    if (moviePlayer) nodesById.movie_player = moviePlayer;
    const html = { dataset: {}, appendChild(el) { injected.push(el); return el; } };
    const head = {
      appendChild(el) {
        injected.push(el);
        el.parentNode = head;
        if (typeof el.onload === 'function') el.onload();
        return el;
      },
      removeChild(el) {
        el.parentNode = null;
        return el;
      },
    };
    const channelEl = opts.channel ? { textContent: opts.channel } : null;
    const box = { win: null, listeners: [] };
    const sandbox = {
      __ytcHarness: true,
      URL,
      AbortController,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      location: { href: opts.href || 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
      navigator: { language: 'en' },
      chrome: {
        runtime: {
          id: 'test-id',
          getURL(p) { return 'chrome-extension://test/' + p; },
          onMessage: { addListener(fn) { listeners.push(fn); } },
          sendMessage() { return Promise.resolve({ ok: true, shortcut: '' }); },
        },
        storage: {
          local: { async get() { return {}; }, async set() {} },
          onChanged: { addListener() {}, removeListener() {} },
        },
      },
      document: {
        documentElement: html,
        head,
        title: opts.title || 'A lecture - YouTube',
        getElementById(id) { return nodesById[id] || null; },
        querySelector(sel) {
          if (opts.channelThrows) throw new Error('boom');
          if (channelEl && /channel-name/.test(sel)) return channelEl;
          return null;
        },
        createElement(tag) {
          if (tag === 'script') {
            return { tagName: 'script', src: '', parentNode: null, onload: null, onerror: null };
          }
          return makeEl(tag);
        },
        addEventListener() {},
      },
      addEventListener(type, fn) {
        if (type === 'message') box.listeners.push(fn);
      },
      postMessage(data) {
        if (!data || data.dir !== 'request') return;
        calls.push([data.method].concat(Array.isArray(data.args) ? data.args : []));
        const event = {
          source: box.win,
          origin: PAGE,
          data: { type: data.type, dir: 'response', id: data.id, ok: true, result: true },
        };
        for (let i = 0; i < box.listeners.length; i++) box.listeners[i](event);
      },
    };
    sandbox.window = undefined;
    vm.createContext(sandbox);
    box.win = vm.runInContext('globalThis', sandbox);
    vm.runInContext(coreSrc, sandbox, { filename: 'src/content/core.js' });
    vm.runInContext(contentSrc, sandbox, { filename: 'src/content/content.js' });
    function ask(msg) {
      return new Promise((resolve) => {
        let settled = false;
        const ret = listeners[0](msg, {}, (r) => {
          settled = true;
          resolve(r);
        });
        if (ret !== true && !settled) resolve(undefined);
      });
    }
    return { listeners, injected, calls, video, ask };
  }

  const noPlayerPage = bootPage({ noPlayer: true, noVideo: true });
  const missingRead = await noPlayerPage.ask({ type: 'audioMode.player' });
  t.check(
    'player read with no player is ok: false',
    missingRead && missingRead.ok === false && missingRead.on === false,
    JSON.stringify(missingRead),
  );
  t.check('player read does not inject the bridge', noPlayerPage.injected.length === 0, String(noPlayerPage.injected.length));

  const missingWrite = await noPlayerPage.ask({ type: 'audioMode.control', action: 'play' });
  t.check(
    'player write with no player is ok: false',
    missingWrite && missingWrite.ok === false,
    JSON.stringify(missingWrite),
  );
  t.check('a refused write does not inject the bridge', noPlayerPage.injected.length === 0, String(noPlayerPage.injected.length));

  const live = bootPage({
    title: '(3) A lecture - YouTube',
    channel: 'Ada',
    currentTime: 15,
    duration: 120,
    paused: true,
    playbackRate: 1.5,
    volume: 0.4,
    muted: false,
  });
  const liveRead = await live.ask({ type: 'audioMode.player' });
  t.check('player read with a video is ok', liveRead && liveRead.ok === true, JSON.stringify(liveRead));
  t.check('player read reports paused', liveRead.paused === true);
  t.check('player read reports currentTime', liveRead.currentTime === 15, String(liveRead.currentTime));
  t.check('player read reports duration', liveRead.duration === 120, String(liveRead.duration));
  t.check('player read reports playbackRate', liveRead.playbackRate === 1.5, String(liveRead.playbackRate));
  t.check('player read reports volume 0-100', liveRead.volume === 40, String(liveRead.volume));
  t.check('player read reports muted', liveRead.muted === false);
  t.check('player read strips the tab title', liveRead.title === 'A lecture', liveRead.title);
  t.check('player read reports the channel', liveRead.channel === 'Ada', liveRead.channel);
  t.check('player read reports the video id', liveRead.videoId === 'aaaaaaaaaaa', liveRead.videoId);
  t.check('player read still does not inject', live.injected.length === 0, String(live.injected.length));

  const thrown = bootPage({ channelThrows: true });
  const thrownRead = await thrown.ask({ type: 'audioMode.player' });
  t.check(
    'channel lookup failure is an empty string, not a throw',
    thrownRead && thrownRead.ok === true && thrownRead.channel === '',
    JSON.stringify(thrownRead),
  );

  const play = await live.ask({ type: 'audioMode.control', action: 'play' });
  t.check('play is ok', play && play.ok === true, JSON.stringify(play));
  t.check(
    'play goes through the bridge as playVideo',
    live.calls.some((c) => c[0] === 'playVideo'),
    JSON.stringify(live.calls),
  );
  t.check('the first write injects the bridge', live.injected.length > 0, String(live.injected.length));

  const pause = await live.ask({ type: 'audioMode.control', action: 'pause' });
  t.check('pause is ok', pause && pause.ok === true);
  t.check('pause goes through the bridge as pauseVideo', live.calls.some((c) => c[0] === 'pauseVideo'), JSON.stringify(live.calls));

  const seek = await live.ask({ type: 'audioMode.control', action: 'seek', time: 20 });
  t.check('seek is ok', seek && seek.ok === true);
  t.check(
    'seek goes through the bridge as seekTo',
    live.calls.some((c) => c[0] === 'seekTo' && c[1] === 20),
    JSON.stringify(live.calls),
  );

  const speed = await live.ask({ type: 'audioMode.control', action: 'speed', rate: 1.25 });
  t.check('speed is ok', speed && speed.ok === true);
  t.check(
    'speed goes through the bridge as setPlaybackRate',
    live.calls.some((c) => c[0] === 'setPlaybackRate' && c[1] === 1.25),
    JSON.stringify(live.calls),
  );

  const volume = await live.ask({ type: 'audioMode.control', action: 'volume', volume: 75 });
  t.check('volume is ok', volume && volume.ok === true);
  t.check(
    'volume goes through the bridge as setVolume',
    live.calls.some((c) => c[0] === 'setVolume' && c[1] === 75),
    JSON.stringify(live.calls),
  );

  const badAction = await live.ask({ type: 'audioMode.control', action: 'explode' });
  t.check('a malformed action is refused', badAction && badAction.ok === false, JSON.stringify(badAction));

  const badSeek = await live.ask({ type: 'audioMode.control', action: 'seek', time: -1 });
  t.check('a negative seek is refused', badSeek && badSeek.ok === false, JSON.stringify(badSeek));

  const badSpeed = await live.ask({ type: 'audioMode.control', action: 'speed', rate: 3 });
  t.check('an unknown speed is refused', badSpeed && badSpeed.ok === false, JSON.stringify(badSpeed));

  const badVolume = await live.ask({ type: 'audioMode.control', action: 'volume', volume: 50.5 });
  t.check('a non-integer volume is refused', badVolume && badVolume.ok === false, JSON.stringify(badVolume));
}
