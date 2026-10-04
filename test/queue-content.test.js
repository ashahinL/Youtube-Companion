/**
 * Content-script side of the watch-page queue: snapshot cleaning,
 * queue.watch / queue.ops, and queueChanged while watching.
 * Loads the real content.js in node:vm. No network.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const coreSrc = read('src/content/core.js');
const contentSrc = read('src/content/content.js');

const PAGE = 'https://www.youtube.com';
const A = 'aaaaaaaaaaa';
const B = 'bbbbbbbbbbb';
const C = 'ccccccccccc';

function vid(n) {
  return n.toString(36).padStart(11, 'a');
}

function bootPage(opts) {
  opts = opts || {};
  const listeners = [];
  const calls = [];
  const posts = [];
  const sent = [];
  const video = {
    currentTime: 10,
    duration: 100,
    paused: true,
    ended: false,
    playbackRate: 1,
    volume: 0.5,
    muted: false,
    currentSrc: 'https://rr.example/video.mp4',
  };
  const moviePlayer = {
    id: 'movie_player',
    querySelector(sel) {
      if (sel === 'video.html5-main-video' || sel === 'video') return video;
      return null;
    },
  };
  const nodesById = { movie_player: moviePlayer };
  const ownerEl = opts.owner
    ? {
      querySelector(sel) {
        return sel === 'yt-avatar-stack-view-model' && opts.owner.collab ? {} : null;
      },
      querySelectorAll(sel) {
        if (sel !== 'a') return [];
        return (opts.owner.links || []).map((link) => ({
          textContent: link.text || '',
          getAttribute(name) { return name === 'href' ? link.href || null : null; },
        }));
      },
    }
    : null;
  const box = { win: null, listeners: [] };
  const sandbox = {
    __ytcHarness: true,
    URL,
    AbortController,
    setTimeout: opts.setTimeout || setTimeout,
    clearTimeout: opts.clearTimeout || clearTimeout,
    setInterval,
    clearInterval,
    crypto: globalThis.crypto,
    location: {
      href: opts.href || 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
      pathname: '/watch',
    },
    navigator: { language: 'en' },
    chrome: {
      runtime: {
        id: 'test-id',
        getURL(p) { return 'chrome-extension://test/' + p; },
        onMessage: { addListener(fn) { listeners.push(fn); } },
        sendMessage(msg) {
          sent.push(msg);
          return Promise.resolve({ ok: true, shortcut: '' });
        },
      },
      storage: {
        local: { async get() { return {}; }, async set() {} },
        onChanged: { addListener() {}, removeListener() {} },
      },
    },
    document: {
      documentElement: { dataset: {} },
      head: {},
      title: 'A lecture - YouTube',
      getElementById(id) { return nodesById[id] || null; },
      querySelector(sel) {
        if (ownerEl && sel === 'ytd-watch-metadata ytd-video-owner-renderer') return ownerEl;
        if (opts.flexyVideo && sel === 'ytd-watch-flexy') {
          return { getAttribute(name) { return name === 'video-id' ? opts.flexyVideo : null; } };
        }
        return null;
      },
      querySelectorAll() { return []; },
      createElement() { return {}; },
      addEventListener() {},
    },
    addEventListener(type, fn) {
      if (type === 'message') box.listeners.push(fn);
    },
    postMessage(data) {
      posts.push(data);
      if (data && data.dir === 'adopt') {
        const event = {
          source: box.win,
          origin: PAGE,
          data: { type: data.type, dir: 'ready' },
        };
        for (let i = 0; i < box.listeners.length; i++) box.listeners[i](event);
        return;
      }
      if (!data || data.dir !== 'request') return;
      calls.push([data.method].concat(Array.isArray(data.args) ? data.args : []));
      if (opts.silent) return;
      if (data.method === 'queueOps' && opts.opsSilent) return;
      let result = true;
      if (data.method === 'queueWatch') {
        result = Object.prototype.hasOwnProperty.call(opts, 'watchResult')
          ? opts.watchResult
          : { listId: 'TLPQabc', ids: [], playing: '' };
      } else if (data.method === 'queueOps') {
        result = opts.opsResult;
      } else if (data.method === 'collaborators') {
        result = opts.collaborators;
      }
      const event = {
        source: box.win,
        origin: PAGE,
        data: {
          type: data.type,
          dir: 'response',
          id: data.id,
          ok: opts.bridgeRefuses !== true,
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

  function pageEvent(snapshot) {
    let token = '';
    for (let i = 0; i < posts.length; i++) {
      if (posts[i] && posts[i].dir === 'adopt') token = posts[i].type;
    }
    const event = {
      source: box.win,
      origin: PAGE,
      data: { type: token, dir: 'event', event: 'queueChanged', snapshot: snapshot },
    };
    for (let i = 0; i < box.listeners.length; i++) box.listeners[i](event);
  }

  return { sandbox, calls, posts, sent, ask, pageEvent };
}

function snapshots(sent) {
  return sent.filter((msg) => msg && msg.type === 'queue.snapshot');
}

function sameIds(got, want) {
  return Array.isArray(got) && got.length === want.length && got.every((id, i) => id === want[i]);
}

// Runs a 60s bridge timeout on the next turn. Records every delay so a
// normal player call can be told apart from a queue edit.
function timeoutStub(extraFast) {
  const delays = [];
  const rows = new Map();
  let seq = 1;
  const fired = { 1500: 0 };
  function setTimeout(fn, ms) {
    delays.push(ms);
    const id = seq++;
    const row = { ms, cleared: false };
    rows.set(id, row);
    const wait = ms === 60000 || (extraFast && ms === 1500) ? 0 : ms;
    const realId = globalThis.setTimeout(function () {
      if (row.cleared) return;
      if (ms === 1500) fired[1500] += 1;
      fn();
    }, wait);
    row.realId = realId;
    return id;
  }
  function clearTimeout(id) {
    const row = rows.get(id);
    if (!row) return;
    row.cleared = true;
    globalThis.clearTimeout(row.realId);
  }
  return { delays, fired, setTimeout, clearTimeout };
}

export default async function run(t) {
  const harness = bootPage();
  const clean = harness.sandbox.AudioModeContent.cleanQueueSnapshot;
  const good = clean({
    listId: 'TLPQabc',
    ids: [A, B],
    playing: A,
    set: 'public',
  }, 7);

  t.section('cleanQueueSnapshot');
  t.check('good snapshot is kept', good.listId === 'TLPQabc' && sameIds(good.ids, [A, B]) && good.playing === A, JSON.stringify(good));
  t.check('seq is the one passed', good.seq === 7, String(good.seq));
  t.check('no extra keys', Object.keys(good).join(',') === 'seq,listId,ids,playing', Object.keys(good).join(','));

  const bare = clean({ listId: 'TLPQ', ids: [], playing: '' }, 1);
  t.check('list id may be just TLPQ', bare.listId === 'TLPQ', bare.listId);

  const badList = clean({ listId: 'playlist', ids: [A, B], playing: A, set: 'public' }, 3);
  t.check('bad listId clears the ids', badList.listId === '' && sameIds(badList.ids, []), JSON.stringify(badList));
  t.check('bad listId still has no extra keys', Object.keys(badList).join(',') === 'seq,listId,ids,playing');

  const longId = 'TLPQ' + 'a'.repeat(61);
  const tooLong = clean({ listId: longId, ids: [A], playing: '' }, 4);
  t.check('over-long listId is dropped', tooLong.listId === '' && sameIds(tooLong.ids, []), tooLong.listId);

  const messy = clean({
    listId: 'TLPQabc',
    ids: [A, 'short', B, A, 12, C + 'x', B],
    playing: 'nope',
  }, 5);
  t.check('bad ids and repeats are dropped', sameIds(messy.ids, [A, B]), JSON.stringify(messy.ids));
  t.check('bad playing is empty', messy.playing === '', messy.playing);

  const many = [];
  for (let i = 0; i < 150; i++) many.push(vid(i));
  const capped = clean({ listId: 'TLPQabc', ids: many, playing: A }, 9);
  t.check('150 ids keep the first 100', capped.ids.length === 100 && capped.ids[0] === vid(0) && capped.ids[99] === vid(99), String(capped.ids.length));

  const fromNull = clean(null, 2);
  const fromString = clean('nope', 2);
  t.check('null is an empty snapshot', fromNull.listId === '' && sameIds(fromNull.ids, []) && fromNull.playing === '' && fromNull.seq === 2, JSON.stringify(fromNull));
  t.check('a string is an empty snapshot', fromString.listId === '' && sameIds(fromString.ids, []) && fromString.playing === '', JSON.stringify(fromString));

  t.section('queue.watch');
  const quiet = bootPage();
  const before = snapshots(quiet.sent).length;
  quiet.pageEvent({ listId: 'TLPQabc', ids: [A], playing: A, set: 'public' });
  t.check('an event before watch sends nothing', snapshots(quiet.sent).length === before, String(snapshots(quiet.sent).length));

  const watched = bootPage({
    watchResult: { listId: 'TLPQabc', ids: [A, 'nope', A], playing: B, set: 'public' },
  });
  const turnedOn = await watched.ask({ type: 'queue.watch', on: true });
  const watchCall = watched.calls.filter((row) => row[0] === 'queueWatch');
  t.check('watch on calls the bridge with true', watchCall.length === 1 && watchCall[0][1] === true, JSON.stringify(watchCall));
  t.check(
    'watch on replies with a cleaned snapshot',
    turnedOn && turnedOn.ok === true && turnedOn.snapshot
      && turnedOn.snapshot.listId === 'TLPQabc'
      && sameIds(turnedOn.snapshot.ids, [A])
      && turnedOn.snapshot.playing === B
      && Object.keys(turnedOn.snapshot).join(',') === 'seq,listId,ids,playing'
      && typeof turnedOn.snapshot.seq === 'number',
    JSON.stringify(turnedOn),
  );

  watched.pageEvent({ listId: 'TLPQabc', ids: [A, 'bad'], playing: 'nope', set: 'public' });
  watched.pageEvent({ listId: 'nope', ids: [C], playing: C });
  const shots = snapshots(watched.sent);
  t.check('two events send two snapshots', shots.length === 2, String(shots.length));
  t.check(
    'the first event is cleaned and newer than the reply',
    shots[0] && shots[0].listId === 'TLPQabc' && sameIds(shots[0].ids, [A]) && shots[0].playing === ''
      && shots[0].seq > turnedOn.snapshot.seq
      && Object.keys(shots[0]).join(',') === 'type,seq,listId,ids,playing',
    JSON.stringify(shots[0]),
  );
  t.check('event seqs rise', shots[1] && shots[1].seq > shots[0].seq, JSON.stringify(shots.map((s) => s.seq)));
  t.check('a bad listId on an event clears its ids', shots[1] && shots[1].listId === '' && sameIds(shots[1].ids, []), JSON.stringify(shots[1]));

  const turnedOff = await watched.ask({ type: 'queue.watch', on: false });
  const offCalls = watched.calls.filter((row) => row[0] === 'queueWatch');
  t.check('watch off calls the bridge with false', offCalls.length === 2 && offCalls[1][1] === false, JSON.stringify(offCalls));
  t.check('watch off replies ok without a snapshot', turnedOff && turnedOff.ok === true && !Object.prototype.hasOwnProperty.call(turnedOff, 'snapshot'), JSON.stringify(turnedOff));
  watched.pageEvent({ listId: 'TLPQabc', ids: [A], playing: A });
  t.check('an event after watch off sends nothing', snapshots(watched.sent).length === 2, String(snapshots(watched.sent).length));

  const invalidWatch = bootPage();
  const badOn = await invalidWatch.ask({ type: 'queue.watch', on: 'yes' });
  t.check('a non-boolean on is invalid', badOn && badOn.ok === false && badOn.error === 'invalid', JSON.stringify(badOn));
  t.check('invalid watch does not call the bridge', invalidWatch.calls.length === 0, JSON.stringify(invalidWatch.calls));

  t.section('queue.ops');
  const ops = [{ op: 'add', id: A }, { op: 'move', from: 0, to: 1 }];
  const opsPage = bootPage({
    opsResult: { listId: 'TLPQabc', ids: [B, A, 'nope'], playing: A, set: 'public' },
  });
  const opsReply = await opsPage.ask({ type: 'queue.ops', ops: ops });
  const opsCall = opsPage.calls.filter((row) => row[0] === 'queueOps');
  t.check('ops calls the bridge with that array', opsCall.length === 1 && opsCall[0][1] === ops, JSON.stringify(opsCall));
  t.check(
    'ops replies with the cleaned snapshot',
    opsReply && opsReply.ok === true && opsReply.snapshot
      && opsReply.snapshot.listId === 'TLPQabc'
      && sameIds(opsReply.snapshot.ids, [B, A])
      && opsReply.snapshot.playing === A
      && typeof opsReply.snapshot.seq === 'number',
    JSON.stringify(opsReply),
  );

  const emptyOps = bootPage();
  const emptyReply = await emptyOps.ask({ type: 'queue.ops', ops: [] });
  t.check('an empty batch is invalid', emptyReply && emptyReply.ok === false && emptyReply.error === 'invalid', JSON.stringify(emptyReply));
  const tooMany = [];
  for (let i = 0; i < 101; i++) tooMany.push({ op: 'add' });
  const tooManyReply = await emptyOps.ask({ type: 'queue.ops', ops: tooMany });
  t.check('101 ops is invalid', tooManyReply && tooManyReply.error === 'invalid', JSON.stringify(tooManyReply));
  const notArray = await emptyOps.ask({ type: 'queue.ops', ops: 'add' });
  t.check('a non-array is invalid', notArray && notArray.error === 'invalid', JSON.stringify(notArray));
  t.check('invalid ops do not call the bridge', emptyOps.calls.length === 0, JSON.stringify(emptyOps.calls));

  const refused = bootPage({ bridgeRefuses: true, opsResult: { listId: 'TLPQabc', ids: [A], playing: '' } });
  const refusedReply = await refused.ask({ type: 'queue.ops', ops: [{ op: 'add', id: A }] });
  t.check('a refused batch is failed', refusedReply && refusedReply.ok === false && refusedReply.error === 'failed', JSON.stringify(refusedReply));
  t.check('a refused batch still called the bridge', refused.calls.some((row) => row[0] === 'queueOps'), JSON.stringify(refused.calls));

  const clock = timeoutStub(false);
  const silentOps = bootPage({
    opsSilent: true,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  const started = Date.now();
  const silentReply = await silentOps.ask({ type: 'queue.ops', ops: [{ op: 'add', id: A }] });
  const waited = Date.now() - started;
  t.check('a silent batch fails', silentReply && silentReply.ok === false && silentReply.error === 'failed', JSON.stringify(silentReply));
  t.check('the silent batch used the 60s timeout', clock.delays.indexOf(60000) !== -1, JSON.stringify(clock.delays));
  t.check('the silent batch did not wait 60s', waited < 5000, String(waited));

  t.section('other bridge calls');
  const short = timeoutStub(true);
  const playerPage = bootPage({
    silent: true,
    owner: { collab: true, links: [{ text: 'A and B' }] },
    flexyVideo: A,
    setTimeout: short.setTimeout,
    clearTimeout: short.clearTimeout,
  });
  const playerStarted = Date.now();
  const playerReply = await playerPage.ask({ type: 'audioMode.player' });
  const playerWaited = Date.now() - playerStarted;
  t.check(
    'a player read still times out at 1500ms',
    playerReply && playerReply.ok === true
      && short.delays.indexOf(1500) !== -1
      && short.delays.indexOf(60000) === -1
      && short.fired[1500] >= 1
      && playerPage.calls.some((row) => row[0] === 'collaborators'),
    JSON.stringify({ delays: short.delays, fired: short.fired[1500], reply: playerReply, calls: playerPage.calls }),
  );
  t.check('the player read did not wait 60s', playerWaited < 5000, String(playerWaited));
}
