/**
 * Watch-page queue bridge: snapshot, batched edits, and queueChanged.
 * The fake page follows the measured yt-action behaviour in docs/youtube.md.
 * Loads src/content/inject.js in node:vm. No network.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const injectSrc = fs.readFileSync(path.join(ROOT, 'src/content/inject.js'), 'utf8');

const PAGE = 'https://www.youtube.com';
const TOKEN = 'ab'.repeat(32);
const PLAY = 'jNQXAC9IVRw';
const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';
const D = 'ddddddddddd';
const LIST = 'TLPQtestlist0001';

function makeClock() {
  let now = 0;
  let next = 1;
  const timers = [];

  function setTimeout(fn, ms) {
    const id = next++;
    const delay = typeof ms === 'number' && ms > 0 ? ms : 0;
    timers.push({ id, fn, delay, at: now + delay, done: false });
    return id;
  }

  function clearTimeout(id) {
    for (let i = 0; i < timers.length; i++) {
      if (timers[i].id === id) timers[i].done = true;
    }
  }

  function runDue() {
    while (true) {
      let best = -1;
      for (let i = 0; i < timers.length; i++) {
        const timer = timers[i];
        if (timer.done || timer.at > now) continue;
        if (best === -1 || timer.at < timers[best].at || (timer.at === timers[best].at && timer.id < timers[best].id)) {
          best = i;
        }
      }
      if (best === -1) break;
      timers[best].done = true;
      timers[best].fn();
    }
  }

  function advance(ms) {
    now += ms;
    runDue();
  }

  return {
    setTimeout,
    clearTimeout,
    runDue,
    advance,
    timers,
    now: function () { return now; },
  };
}

function loadQueue(opts) {
  const posts = [];
  const trace = [];
  const clock = makeClock();
  let setN = 0;
  const panels = [];
  const server = [];
  let listId = '';
  let dropSignals = false;

  function nextSet() {
    setN += 1;
    const body = String(setN).padStart(15, '0');
    return ('s' + body).slice(0, 16);
  }

  const panel = {
    data: {},
    rows: [],
    querySelectorAll(sel) {
      return sel === 'ytd-playlist-panel-video-renderer' ? this.rows : [];
    },
    dispatchEvent(ev) {
      handleAction(ev);
    },
  };

  const app = {
    dispatchEvent(ev) {
      handleAction(ev);
    },
  };

  const listeners = [];
  const document = {
    addEventListener(type, fn) {
      listeners.push({ type, fn });
    },
    removeEventListener(type, fn) {
      for (let i = listeners.length - 1; i >= 0; i--) {
        if (listeners[i].type === type && listeners[i].fn === fn) listeners.splice(i, 1);
      }
    },
    dispatchEvent(ev) {
      const list = listeners.slice();
      for (let i = 0; i < list.length; i++) {
        if (list[i].type === ev.type) list[i].fn(ev);
      }
      return true;
    },
    querySelector(sel) {
      return sel === 'ytd-app' ? app : null;
    },
    querySelectorAll(sel) {
      return sel === 'ytd-playlist-panel-renderer' ? panels : [];
    },
    getElementById() {
      return null;
    },
  };

  function fireDoc(type, detail) {
    document.dispatchEvent({ type: type, detail: detail || null });
  }

  function later(fn) {
    clock.setTimeout(fn, 0);
  }

  function playingRow() {
    return { data: { videoId: PLAY } };
  }

  function queuedRow(item) {
    return { data: { videoId: item.v, playlistSetVideoId: item.set } };
  }

  function showQueue(ids) {
    server.length = 0;
    for (let i = 0; i < ids.length; i++) server.push({ v: ids[i], set: nextSet() });
    listId = LIST;
    panel.data = { playlistId: listId };
    panel.rows = [playingRow()];
    for (let i = 0; i < server.length; i++) panel.rows.push(queuedRow(server[i]));
    if (panels.indexOf(panel) === -1) panels.push(panel);
  }

  function hideQueue() {
    panels.length = 0;
    server.length = 0;
    listId = '';
    panel.rows = [];
    panel.data = {};
  }

  function copyServerToPanel() {
    panel.rows = [playingRow()];
    for (let i = 0; i < server.length; i++) panel.rows.push(queuedRow(server[i]));
    panel.data = { playlistId: listId };
    if (listId && panels.indexOf(panel) === -1) panels.push(panel);
  }

  function appendQueued(v) {
    const item = { v: v, set: nextSet() };
    server.push(item);
    if (!listId) {
      listId = LIST;
      panel.data = { playlistId: listId };
      panel.rows = [playingRow()];
      if (panels.indexOf(panel) === -1) panels.push(panel);
    }
    panel.rows.push(queuedRow(item));
  }

  function moveServer(setVideoId, predSet, succSet) {
    let from = -1;
    for (let i = 0; i < server.length; i++) {
      if (server[i].set === setVideoId) from = i;
    }
    if (from === -1) return;
    const item = server.splice(from, 1)[0];
    if (predSet) {
      let at = -1;
      for (let i = 0; i < server.length; i++) {
        if (server[i].set === predSet) at = i;
      }
      if (at === -1) return;
      server.splice(at + 1, 0, item);
      return;
    }
    let at = -1;
    for (let i = 0; i < server.length; i++) {
      if (server[i].set === succSet) at = i;
    }
    if (at === -1) return;
    server.splice(at, 0, item);
  }

  function readAdd(detail) {
    const args = detail && detail.args;
    const cmd = args && args[0] && args[0].addToPlaylistCommand;
    if (!cmd || cmd.openMiniplayer !== false) return '';
    if (cmd.listType !== 'PLAYLIST_EDIT_LIST_TYPE_QUEUE') return '';
    if (!Array.isArray(cmd.videoIds) || cmd.videoIds[0] !== cmd.videoId) return '';
    const create = cmd.onCreateListCommand;
    const endpoint = create && create.createPlaylistServiceEndpoint;
    const meta = create && create.commandMetadata && create.commandMetadata.webCommandMetadata;
    if (!endpoint || endpoint.params !== 'CAQ%3D') return '';
    if (!meta || meta.apiUrl !== '/youtubei/v1/playlist/create' || meta.sendPost !== true) return '';
    return typeof cmd.videoId === 'string' ? cmd.videoId : '';
  }

  function readEdit(detail) {
    const args = detail && detail.args;
    const body = args && args[1];
    const meta = body && body.commandMetadata && body.commandMetadata.webCommandMetadata;
    const endpoint = body && body.playlistEditEndpoint;
    if (!meta || meta.sendPost !== true || meta.apiUrl !== '/youtubei/v1/browse/edit_playlist') return null;
    if (!endpoint || endpoint.playlistId !== listId || !Array.isArray(endpoint.actions)) return null;
    return endpoint;
  }

  function handleAction(ev) {
    const detail = ev && ev.detail;
    const name = detail && detail.actionName;
    if (!name) return;
    trace.push(name);
    if (dropSignals) return;
    if (name === 'yt-add-to-playlist-command') {
      const v = readAdd(detail);
      if (!v) return;
      appendQueued(v);
      later(function () { fireDoc('yt-playlist-data-updated'); });
      return;
    }
    if (name === 'yt-service-request') {
      const endpoint = readEdit(detail);
      const action = endpoint && endpoint.actions[0];
      if (!action) return;
      if (action.action === 'ACTION_REMOVE_VIDEO') {
        if (endpoint.params !== 'CAE%3D') return;
        server.splice(0, server.length, ...server.filter(function (item) {
          return item.set !== action.setVideoId;
        }));
      } else if (action.action === 'ACTION_MOVE_VIDEO_AFTER') {
        moveServer(action.setVideoId, action.movedSetVideoIdPredecessor, '');
      } else if (action.action === 'ACTION_MOVE_VIDEO_BEFORE') {
        moveServer(action.setVideoId, '', action.movedSetVideoIdSuccessor);
      } else {
        return;
      }
      later(function () {
        fireDoc('yt-action', { actionName: 'yt-update-playlist-action' });
      });
      return;
    }
    if (name === 'yt-refresh-playlist-command') {
      const refresh = detail.args && detail.args[0] && detail.args[0].refreshPlaylistCommand;
      if (!refresh || refresh.listId !== listId) return;
      copyServerToPanel();
      later(function () { fireDoc('yt-playlist-data-updated'); });
      return;
    }
    if (name === 'yt-end-playlist-command') {
      const end = detail.args && detail.args[0] && detail.args[0].endPlaylistCommand;
      if (!end || end.listId !== listId || end.closeListPanel !== true) return;
      if (end.listType !== 'PLAYLIST_EDIT_LIST_TYPE_QUEUE') return;
      server.length = 0;
      listId = '';
      panel.rows = [];
      panel.data = {};
      later(function () { fireDoc('yt-playlist-data-updated'); });
    }
  }

  function CustomEvent(type, init) {
    this.type = type;
    this.detail = init && init.detail;
    this.bubbles = !!(init && init.bubbles);
    this.composed = !!(init && init.composed);
  }

  const sandbox = {
    URL,
    Promise,
    CustomEvent,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    __ytcHarness: true,
    document,
    postMessage(data, origin) {
      posts.push({ data, origin });
      if (data && data.dir === 'response') trace.push('response:' + data.id);
    },
    addEventListener(type, fn) {
      if (!this._listeners) this._listeners = [];
      this._listeners.push({ type, fn });
    },
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(injectSrc, sandbox, { filename: 'src/content/inject.js' });
  const win = vm.runInContext('globalThis', sandbox);

  function fire(event) {
    let stopped = false;
    const ev = event || {};
    ev.stopImmediatePropagation = function () { stopped = true; };
    const list = sandbox._listeners || win._listeners || [];
    for (const item of list) {
      if (stopped) break;
      if (item.type === 'message') item.fn(ev);
    }
  }

  function adopt(token) {
    fire({
      source: win,
      origin: PAGE,
      data: { type: token || TOKEN, dir: 'adopt' },
    });
  }

  function request(method, args, id) {
    fire({
      source: win,
      origin: PAGE,
      data: { type: TOKEN, dir: 'request', id: id, method: method, args: args },
    });
  }

  async function settle() {
    for (let i = 0; i < 80; i++) {
      await Promise.resolve();
      clock.runDue();
    }
  }

  if (!opts || opts.queued) showQueue((opts && opts.queued) || [A, B]);

  return {
    sandbox,
    win,
    fire,
    posts,
    trace,
    clock,
    adopt,
    request,
    settle,
    bridge: sandbox.AudioModeBridge,
    showQueue,
    hideQueue,
    fireDoc,
    panel,
    panels,
    server,
    app,
    setDropSignals(on) { dropSignals = on; },
    listId: function () { return listId; },
    serverIds: function () { return server.map(function (item) { return item.v; }); },
  };
}

function responses(posts) {
  const out = [];
  for (let i = 0; i < posts.length; i++) {
    if (posts[i].data && posts[i].data.dir === 'response') out.push(posts[i].data);
  }
  return out;
}

function events(posts) {
  const out = [];
  for (let i = 0; i < posts.length; i++) {
    if (posts[i].data && posts[i].data.dir === 'event') out.push(posts[i].data);
  }
  return out;
}

function hasKey(value, key) {
  if (!value || typeof value !== 'object') return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (hasKey(value[i], key)) return true;
    }
    return false;
  }
  const keys = Object.keys(value);
  for (let i = 0; i < keys.length; i++) {
    if (hasKey(value[keys[i]], key)) return true;
  }
  return false;
}

function idsOf(message) {
  const snap = message && message.result;
  return snap && snap.ids ? snap.ids.slice() : null;
}

export default async function run(t) {
  t.section('queue snapshot');

  const page = loadQueue({ queued: [A, B, C] });
  page.adopt(TOKEN);
  page.posts.length = 0;
  const direct = page.bridge.readQueueSnapshot();
  t.check(
    'snapshot ids leave out the playing row',
    direct.playing === PLAY && JSON.stringify(direct.ids) === JSON.stringify([A, B, C]) && direct.listId === LIST,
    JSON.stringify(direct),
  );
  t.check('snapshot has no playlistSetVideoId', hasKey(direct, 'playlistSetVideoId') === false);

  page.request('queueSnapshot', [], 1);
  const snapReply = responses(page.posts)[0];
  t.check(
    'queueSnapshot is answered with that snapshot',
    snapReply && snapReply.ok === true && JSON.stringify(snapReply.result) === JSON.stringify(direct),
    JSON.stringify(snapReply),
  );
  t.check(
    'a snapshot reply never carries playlistSetVideoId',
    hasKey(snapReply, 'playlistSetVideoId') === false,
  );

  page.hideQueue();
  t.check(
    'no panel is an empty snapshot',
    JSON.stringify(page.bridge.readQueueSnapshot()) === JSON.stringify({ listId: '', ids: [], playing: '', titles: {} }),
  );

  const other = {
    data: { playlistId: 'PLnotthequeue1' },
    rows: [{ data: { videoId: A, playlistSetVideoId: 's000000000000001' } }],
    querySelectorAll(sel) {
      return sel === 'ytd-playlist-panel-video-renderer' ? this.rows : [];
    },
    dispatchEvent() {},
  };
  page.panels.push(other);
  t.check(
    'a panel whose id is not TLPQ is ignored',
    JSON.stringify(page.bridge.readQueueSnapshot()) === JSON.stringify({ listId: '', ids: [], playing: '', titles: {} }),
  );
  page.panels.length = 0;
  page.showQueue([A]);
  page.panels.unshift(other);
  t.check(
    'the TLPQ panel is the one that is read',
    JSON.stringify(page.bridge.readQueueSnapshot().ids) === JSON.stringify([A]),
  );

  const titledPage = loadQueue({ queued: [A, B, C, D] });
  const longTitle = 'n'.repeat(300);
  const titledRows = titledPage.panel.rows;
  titledRows[1].data.title = { simpleText: '  Alpha  ', runs: [{ text: 'Nope' }] };
  titledRows[1].data.shortBylineText = { runs: [{ text: ' Ann ' }] };
  titledRows[2].data.title = { runs: [{ text: 'Be' }, { text: 'ta' }] };
  titledRows[2].data.longBylineText = { runs: [{ text: ' Bob ' }] };
  titledRows[3].data.title = { simpleText: longTitle };
  titledRows[3].data.shortBylineText = { runs: [{ text: 'Cee' }] };
  const titled = titledPage.bridge.readQueueSnapshot();
  t.check(
    'titles keep simpleText, joined runs, a missing row, and a 200-character clip',
    titled.titles[A].t === 'Alpha' && titled.titles[A].ct === 'Ann'
      && titled.titles[B].t === 'Beta' && titled.titles[B].ct === 'Bob'
      && titled.titles[C].t === longTitle.slice(0, 200) && titled.titles[C].ct === 'Cee'
      && titled.titles[D].t === '' && titled.titles[D].ct === ''
      && Object.keys(titled.titles).join(',') === [A, B, C, D].join(','),
    JSON.stringify(titled.titles),
  );
  t.check('a titled snapshot has no playlistSetVideoId', hasKey(titled, 'playlistSetVideoId') === false, JSON.stringify(titled));

  t.section('queue ops');

  async function runOps(loaded, ops, id) {
    loaded.posts.length = 0;
    loaded.trace.length = 0;
    loaded.request('queueOps', [ops], id || 1);
    await loaded.settle();
    return responses(loaded.posts);
  }

  const addPage = loadQueue({ queued: [A, B] });
  addPage.adopt(TOKEN);
  let got = await runOps(addPage, [{ op: 'add', v: C }]);
  t.check(
    'add appends on the snapshot',
    got.length === 1 && got[0].ok === true && JSON.stringify(idsOf(got[0])) === JSON.stringify([A, B, C]),
    JSON.stringify(got[0]),
  );
  t.check('a batch without clear says cleared false', got[0] && got[0].result && got[0].result.cleared === false, JSON.stringify(got[0] && got[0].result));
  t.check(
    'add does not refresh',
    addPage.trace.indexOf('yt-refresh-playlist-command') === -1,
    JSON.stringify(addPage.trace),
  );
  t.check('add reply has no playlistSetVideoId', hasKey(got[0], 'playlistSetVideoId') === false);

  const placed = loadQueue({ queued: [A, B] });
  placed.adopt(TOKEN);
  got = await runOps(placed, [{ op: 'add', v: C, after: A }]);
  t.check(
    'add with after lands after that row',
    got.length === 1 && JSON.stringify(idsOf(got[0])) === JSON.stringify([A, C, B]),
    JSON.stringify({ ids: idsOf(got[0]), server: placed.serverIds(), trace: placed.trace }),
  );
  t.check(
    'add with after refreshes once',
    placed.trace.filter(function (name) { return name === 'yt-refresh-playlist-command'; }).length === 1,
    JSON.stringify(placed.trace),
  );

  const empty = loadQueue({ queued: null });
  empty.hideQueue();
  empty.adopt(TOKEN);
  got = await runOps(empty, [{ op: 'add', v: C }]);
  t.check(
    'add on an empty page creates the queue',
    got.length === 1 && got[0].result.listId === LIST && JSON.stringify(idsOf(got[0])) === JSON.stringify([C]) && got[0].result.playing === PLAY,
    JSON.stringify(got[0]),
  );

  const dup = loadQueue({ queued: [A, B] });
  dup.adopt(TOKEN);
  got = await runOps(dup, [{ op: 'add', v: A }]);
  t.check(
    'add of a queued id does nothing',
    got.length === 1
      && JSON.stringify(idsOf(got[0])) === JSON.stringify([A, B])
      && dup.trace.indexOf('yt-add-to-playlist-command') === -1,
    JSON.stringify({ ids: idsOf(got[0]), trace: dup.trace }),
  );

  const moved = loadQueue({ queued: [A, B, C] });
  moved.adopt(TOKEN);
  got = await runOps(moved, [{ op: 'move', v: C, after: A }]);
  t.check(
    'move after a row is the snapshot after refresh',
    JSON.stringify(idsOf(got[0])) === JSON.stringify([A, C, B]) && JSON.stringify(moved.serverIds()) === JSON.stringify([A, C, B]),
    JSON.stringify({ ids: idsOf(got[0]), server: moved.serverIds() }),
  );

  const top = loadQueue({ queued: [A, B, C] });
  top.adopt(TOKEN);
  got = await runOps(top, [{ op: 'move', v: C, after: null }]);
  t.check(
    'move to the top is the snapshot after refresh',
    JSON.stringify(idsOf(got[0])) === JSON.stringify([C, A, B]),
    JSON.stringify({ ids: idsOf(got[0]), server: top.serverIds() }),
  );

  const removed = loadQueue({ queued: [A, B, C] });
  removed.adopt(TOKEN);
  got = await runOps(removed, [{ op: 'remove', v: B }]);
  t.check(
    'remove is the snapshot after refresh',
    JSON.stringify(idsOf(got[0])) === JSON.stringify([A, C]) && JSON.stringify(removed.serverIds()) === JSON.stringify([A, C]),
    JSON.stringify({ ids: idsOf(got[0]), server: removed.serverIds() }),
  );

  const cleared = loadQueue({ queued: [A, B] });
  cleared.adopt(TOKEN);
  got = await runOps(cleared, [{ op: 'clear' }]);
  t.check(
    'clear empties the snapshot',
    got.length === 1 && JSON.stringify(got[0].result) === JSON.stringify({ listId: '', ids: [], playing: '', titles: {}, cleared: true }),
    JSON.stringify(got[0]),
  );

  const batch = loadQueue({ queued: [A, B, C] });
  batch.adopt(TOKEN);
  got = await runOps(batch, [
    { op: 'remove', v: B },
    { op: 'move', v: C, after: null },
    { op: 'add', v: D },
  ]);
  const refreshes = batch.trace.filter(function (name) { return name === 'yt-refresh-playlist-command'; });
  t.check(
    'a remove, move and add batch ends in the server order',
    JSON.stringify(idsOf(got[0])) === JSON.stringify([C, A, D]),
    JSON.stringify({ ids: idsOf(got[0]), server: batch.serverIds(), trace: batch.trace }),
  );
  t.check('that batch refreshes once', refreshes.length === 1, JSON.stringify(batch.trace));

  const serial = loadQueue({ queued: [A] });
  serial.adopt(TOKEN);
  serial.posts.length = 0;
  serial.trace.length = 0;
  serial.request('queueOps', [[{ op: 'add', v: B }]], 1);
  serial.request('queueOps', [[{ op: 'add', v: C }]], 2);
  await serial.settle();
  const both = responses(serial.posts);
  const responseAt = serial.trace.indexOf('response:1');
  const secondAdd = serial.trace.indexOf('yt-add-to-playlist-command', responseAt + 1);
  t.check(
    'two queueOps requests run one after the other',
    both.length === 2
      && both[0].id === 1
      && JSON.stringify(idsOf(both[0])) === JSON.stringify([A, B])
      && both[1].id === 2
      && JSON.stringify(idsOf(both[1])) === JSON.stringify([A, B, C])
      && serial.trace[0] === 'yt-add-to-playlist-command'
      && responseAt !== -1
      && secondAdd > responseAt,
    JSON.stringify({ trace: serial.trace, both: both }),
  );

  t.section('a quiet page');

  const quiet = loadQueue({ queued: [A, B] });
  quiet.adopt(TOKEN);
  quiet.setDropSignals(true);
  quiet.posts.length = 0;
  const started = Date.now();
  quiet.request('queueOps', [[{ op: 'remove', v: B }]], 7);
  await quiet.settle();
  const armed = quiet.clock.timers.filter(function (timer) { return timer.delay === 5000 && !timer.done; });
  t.check('the wait is armed for 5000 ms', armed.length === 1, JSON.stringify(quiet.clock.timers));
  quiet.clock.advance(4999);
  t.check('4999 ms does not finish the wait', responses(quiet.posts).length === 0 && armed[0].done === false);
  quiet.clock.advance(1);
  await quiet.settle();
  // The remove was sent, so the batch still refreshes, and that wait is quiet too.
  quiet.clock.advance(5000);
  await quiet.settle();
  const quietReply = responses(quiet.posts);
  t.check(
    'a missed signal is not an error and the batch finishes',
    quietReply.length === 1 && quietReply[0].ok === true && quietReply[0].error == null && JSON.stringify(idsOf(quietReply[0])) === JSON.stringify([A, B]),
    JSON.stringify(quietReply[0]),
  );
  t.check('the give-up did not wait in real time', Date.now() - started < 1000, String(Date.now() - started));

  t.section('isAllowedCall');

  const gate = page.bridge;
  t.check('zero ops is rejected', gate.isAllowedCall('queueOps', [[]]) === false);
  t.check('101 ops is rejected', gate.isAllowedCall('queueOps', [Array(101).fill({ op: 'clear' })]) === false);
  t.check('100 ops is accepted', gate.isAllowedCall('queueOps', [Array(100).fill({ op: 'clear' })]) === true);
  t.check('a bad id is rejected', gate.isAllowedCall('queueOps', [[{ op: 'add', v: 'short' }]]) === false);
  t.check('an unknown op is rejected', gate.isAllowedCall('queueOps', [[{ op: 'nope' }]]) === false);
  t.check('an extra key is rejected', gate.isAllowedCall('queueOps', [[{ op: 'clear', extra: 1 }]]) === false);
  t.check('after: 5 is rejected', gate.isAllowedCall('queueOps', [[{ op: 'add', v: A, after: 5 }]]) === false);
  t.check('a non-boolean queueWatch is rejected', gate.isAllowedCall('queueWatch', ['yes']) === false);
  t.check('queueWatch true is accepted', gate.isAllowedCall('queueWatch', [true]) === true);
  t.check('add, remove, move and clear are accepted',
    gate.isAllowedCall('queueOps', [[{ op: 'add', v: A }]]) === true
    && gate.isAllowedCall('queueOps', [[{ op: 'add', v: A, after: null }]]) === true
    && gate.isAllowedCall('queueOps', [[{ op: 'add', v: A, after: B }]]) === true
    && gate.isAllowedCall('queueOps', [[{ op: 'remove', v: A }]]) === true
    && gate.isAllowedCall('queueOps', [[{ op: 'move', v: A, after: null }]]) === true
    && gate.isAllowedCall('queueOps', [[{ op: 'clear' }]]) === true);

  t.section('queue watch');

  const watch = loadQueue({ queued: [A] });
  watch.adopt(TOKEN);
  watch.posts.length = 0;
  watch.request('queueWatch', [true], 1);
  const watchReply = responses(watch.posts)[0];
  t.check(
    'queueWatch true answers with the snapshot',
    watchReply && watchReply.ok === true && JSON.stringify(watchReply.result.ids) === JSON.stringify([A]),
    JSON.stringify(watchReply),
  );
  watch.server.push({ v: B, set: 's000000000000099' });
  watch.panel.rows.push({ data: { videoId: B, playlistSetVideoId: 's000000000000099' } });
  watch.fireDoc('yt-playlist-data-updated');
  watch.clock.advance(149);
  t.check('the change is held for the debounce', events(watch.posts).length === 0, JSON.stringify(events(watch.posts)));
  watch.clock.advance(1);
  const changed = events(watch.posts);
  t.check(
    'yt-playlist-data-updated posts one queueChanged',
    changed.length === 1 && changed[0].event === 'queueChanged' && JSON.stringify(changed[0].snapshot.ids) === JSON.stringify([A, B]),
    JSON.stringify(changed),
  );
  t.check('queueChanged has no playlistSetVideoId', hasKey(changed[0], 'playlistSetVideoId') === false);
  watch.fireDoc('yt-playlist-data-updated');
  watch.clock.advance(150);
  t.check('an unchanged snapshot posts nothing', events(watch.posts).length === 1, JSON.stringify(events(watch.posts)));
  watch.request('queueWatch', [false], 2);
  watch.panel.rows.push({ data: { videoId: C, playlistSetVideoId: 's000000000000098' } });
  watch.fireDoc('yt-playlist-data-updated');
  watch.clock.advance(150);
  t.check('queueWatch false stops the events', events(watch.posts).length === 1, JSON.stringify(events(watch.posts)));

  const pageClear = loadQueue({ queued: [A, B] });
  pageClear.adopt(TOKEN);
  pageClear.posts.length = 0;
  pageClear.request('queueWatch', [true], 1);
  await pageClear.settle();
  pageClear.posts.length = 0;
  pageClear.hideQueue();
  pageClear.fireDoc('yt-action', { actionName: 'yt-end-playlist-command' });
  pageClear.clock.advance(150);
  const clearEvents = events(pageClear.posts);
  t.check(
    'a page Clear posts one queueChanged with cleared true',
    clearEvents.length === 1
      && clearEvents[0].event === 'queueChanged'
      && clearEvents[0].snapshot
      && clearEvents[0].snapshot.cleared === true
      && clearEvents[0].snapshot.listId === ''
      && JSON.stringify(clearEvents[0].snapshot.ids) === '[]',
    JSON.stringify(clearEvents),
  );
  t.check('that Clear post has no playlistSetVideoId', hasKey(clearEvents[0], 'playlistSetVideoId') === false);
  pageClear.showQueue([B]);
  pageClear.fireDoc('yt-playlist-data-updated');
  pageClear.clock.advance(150);
  const afterClear = events(pageClear.posts);
  t.check(
    'the next queueChanged has cleared false',
    afterClear.length === 2
      && afterClear[1].snapshot.cleared === false
      && JSON.stringify(afterClear[1].snapshot.ids) === JSON.stringify([B]),
    JSON.stringify(afterClear),
  );

  t.section('adoption');

  const stranger = loadQueue({ queued: [A] });
  stranger.fire({
    source: stranger.win,
    origin: PAGE,
    data: { type: TOKEN, dir: 'request', id: 1, method: 'queueSnapshot', args: [] },
  });
  t.check(
    'a token that never adopted is ignored',
    stranger.posts.length === 0,
    JSON.stringify(stranger.posts),
  );
}
