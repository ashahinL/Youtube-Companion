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
          if (msg && msg.type === 'audioMode.boot' && Object.prototype.hasOwnProperty.call(opts, 'bootReply')) {
            return Promise.resolve(opts.bootReply);
          }
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
      } else if (data.method === 'queueSnapshot') {
        result = Object.prototype.hasOwnProperty.call(opts, 'snapshotResult')
          ? opts.snapshotResult
          : { listId: '', ids: [], playing: '' };
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
function timeoutStub(extraFast, hold) {
  const delays = [];
  const rows = new Map();
  let seq = 1;
  const fired = { 1500: 0 };
  function setTimeout(fn, ms) {
    delays.push(ms);
    const id = seq++;
    const row = { ms, cleared: false, fn: fn };
    rows.set(id, row);
    if (!hold) {
      const wait = ms === 60000 || (extraFast && ms === 1500) ? 0 : ms;
      row.realId = globalThis.setTimeout(function () {
        if (row.cleared) return;
        if (ms === 1500) fired[1500] += 1;
        fn();
      }, wait);
    }
    return id;
  }
  function clearTimeout(id) {
    const row = rows.get(id);
    if (!row) return;
    row.cleared = true;
    if (row.realId != null) globalThis.clearTimeout(row.realId);
  }
  function fire(ms) {
    for (const row of rows.values()) {
      if (row.cleared || row.ms !== ms) continue;
      row.cleared = true;
      row.fn();
    }
  }
  return { delays, fired, setTimeout, clearTimeout, fire };
}

async function flush() {
  for (let i = 0; i < 40; i++) await Promise.resolve();
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
  t.check('no extra keys', Object.keys(good).join(',') === 'seq,listId,ids,playing,titles,cleared', Object.keys(good).join(','));
  t.check(
    'titles for kept ids are empty objects when the bridge sent none',
    good.titles[A] && good.titles[A].t === '' && good.titles[A].ct === ''
      && good.titles[B] && Object.keys(good.titles).join(',') === [A, B].join(',')
      && good.cleared === false,
    JSON.stringify(good.titles),
  );

  const bare = clean({ listId: 'TLPQ', ids: [], playing: '' }, 1);
  t.check('list id may be just TLPQ', bare.listId === 'TLPQ', bare.listId);

  const badList = clean({ listId: 'playlist', ids: [A, B], playing: A, set: 'public' }, 3);
  t.check('bad listId clears the ids', badList.listId === '' && sameIds(badList.ids, []), JSON.stringify(badList));
  t.check('bad listId still has no extra keys', Object.keys(badList).join(',') === 'seq,listId,ids,playing,titles,cleared');
  t.check('bad listId drops titles', Object.keys(badList.titles).length === 0, JSON.stringify(badList.titles));

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

  const longTitle = 'n'.repeat(250);
  const titled = clean({
    listId: 'TLPQabc',
    ids: [A, 'short', B],
    playing: A,
    titles: {
      [A]: { t: 'Alpha', ct: 'Ann', extra: 'no' },
      [B]: { t: longTitle, ct: 12 },
      [C]: { t: 'dropped', ct: 'nope' },
    },
    cleared: true,
  }, 8);
  t.check(
    'titles stay only for kept ids',
    Object.keys(titled.titles).join(',') === [A, B].join(',')
      && titled.titles[A].t === 'Alpha'
      && titled.titles[A].ct === 'Ann'
      && Object.keys(titled.titles[A]).join(',') === 't,ct',
    JSON.stringify(titled.titles),
  );
  t.check(
    'a long title is clipped and a non-string channel is dropped',
    titled.titles[B].t === longTitle.slice(0, 200) && titled.titles[B].ct === '',
    JSON.stringify(titled.titles[B]),
  );
  t.check('cleared is kept only when it is true', titled.cleared === true, String(titled.cleared));
  const notCleared = clean({ listId: 'TLPQabc', ids: [A], playing: '', cleared: 1 }, 6);
  t.check('a non-true cleared is false', notCleared.cleared === false, String(notCleared.cleared));

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
      && turnedOn.snapshot.onWatch === true
      && turnedOn.snapshot.cleared === false
      && Object.keys(turnedOn.snapshot).join(',') === 'seq,onWatch,listId,ids,playing,titles,cleared'
      && typeof turnedOn.snapshot.seq === 'number',
    JSON.stringify(turnedOn),
  );

  watched.pageEvent({ listId: 'TLPQabc', ids: [A, 'bad'], playing: 'nope', set: 'public' });
  watched.pageEvent({ listId: 'nope', ids: [C], playing: C });
  const shots = snapshots(watched.sent);
  t.check('two events send two snapshots', shots.length === 2, String(shots.length));
  t.check(
    'the first event is cleaned and newer than the reply',
    shots[0] && shots[0].listId === 'TLPQabc' && sameIds(shots[0].ids, [A]) && shots[0].playing === A
      && shots[0].onWatch === true
      && shots[0].seq > turnedOn.snapshot.seq
      && Object.keys(shots[0]).join(',') === 'type,seq,onWatch,listId,ids,playing,titles,cleared',
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

  t.section('snapshot from the tab');
  const fallback = bootPage({
    watchResult: { listId: 'TLPQabc', ids: [], playing: '', titles: {} },
  });
  const fallbackReply = await fallback.ask({ type: 'queue.watch', on: true });
  t.check(
    'an empty playing falls back to the watch URL',
    fallbackReply && fallbackReply.snapshot
      && fallbackReply.snapshot.playing === A
      && fallbackReply.snapshot.onWatch === true,
    JSON.stringify(fallbackReply),
  );

  const home = bootPage({ href: 'https://www.youtube.com/' });
  const homeReply = await home.ask({ type: 'queue.watch', on: true });
  t.check(
    'the home page is not a watch page',
    homeReply && homeReply.snapshot
      && homeReply.snapshot.onWatch === false
      && homeReply.snapshot.playing === '',
    JSON.stringify(homeReply),
  );

  t.section('watch on boot');
  const bootReady = bootPage({
    bootReply: { ok: true, queueWatch: true },
    watchResult: { listId: 'TLPQabc', ids: [A], playing: '', titles: { [A]: { t: 'Alpha', ct: 'Ann' } } },
  });
  await flush();
  const bootWatch = bootReady.calls.filter((row) => row[0] === 'queueWatch');
  const bootShots = snapshots(bootReady.sent);
  t.check('boot with queueWatch calls the bridge with true', bootWatch.length === 1 && bootWatch[0][1] === true, JSON.stringify(bootWatch));
  t.check(
    'a list on boot sends one snapshot at once',
    bootShots.length === 1
      && bootShots[0].listId === 'TLPQabc'
      && sameIds(bootShots[0].ids, [A])
      && bootShots[0].playing === A
      && bootShots[0].onWatch === true
      && bootShots[0].titles[A].t === 'Alpha',
    JSON.stringify(bootShots),
  );

  const bootEventClock = timeoutStub(false, true);
  const bootEvent = bootPage({
    bootReply: { ok: true, queueWatch: true },
    watchResult: { listId: '', ids: [], playing: '' },
    setTimeout: bootEventClock.setTimeout,
    clearTimeout: bootEventClock.clearTimeout,
  });
  await flush();
  t.check('an empty list on boot sends nothing yet', snapshots(bootEvent.sent).length === 0, String(snapshots(bootEvent.sent).length));
  bootEvent.pageEvent({ listId: 'TLPQabc', ids: [B], playing: B });
  t.check('the next queueChanged sends one snapshot', snapshots(bootEvent.sent).length === 1 && snapshots(bootEvent.sent)[0].playing === B, JSON.stringify(snapshots(bootEvent.sent)));
  bootEventClock.fire(4000);
  await flush();
  t.check('that queueChanged cancels the boot timer', snapshots(bootEvent.sent).length === 1, String(snapshots(bootEvent.sent).length));

  const bootTimerClock = timeoutStub(false, true);
  const bootTimer = bootPage({
    bootReply: { ok: true, queueWatch: true },
    watchResult: { listId: '', ids: [], playing: '' },
    snapshotResult: { listId: 'TLPQabc', ids: [C], playing: '' },
    setTimeout: bootTimerClock.setTimeout,
    clearTimeout: bootTimerClock.clearTimeout,
  });
  await flush();
  t.check('no event yet means no snapshot', snapshots(bootTimer.sent).length === 0, String(snapshots(bootTimer.sent).length));
  t.check('the boot wait is 4000 ms', bootTimerClock.delays.indexOf(4000) !== -1, JSON.stringify(bootTimerClock.delays));
  bootTimerClock.fire(4000);
  await flush();
  const timed = snapshots(bootTimer.sent);
  const snapCalls = bootTimer.calls.filter((row) => row[0] === 'queueSnapshot');
  t.check(
    'the boot timer sends one fresh snapshot',
    timed.length === 1
      && snapCalls.length === 1
      && snapCalls[0].length === 1
      && timed[0].listId === 'TLPQabc'
      && sameIds(timed[0].ids, [C])
      && timed[0].playing === A
      && timed[0].onWatch === true,
    JSON.stringify({ timed: timed, calls: bootTimer.calls }),
  );

  const bootOff = bootPage({ bootReply: { ok: true } });
  await flush();
  t.check(
    'boot without queueWatch does not call the bridge',
    bootOff.calls.every((row) => row[0] !== 'queueWatch'),
    JSON.stringify(bootOff.calls),
  );
}
