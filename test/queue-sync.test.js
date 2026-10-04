/**
 * Up next ⇄ YouTube queue sync. Hand-built ids, a seeded round trip,
 * the races that overwrite a list copy, and random delivery schedules.
 */

import {
  QUEUE_SYNC_CAP,
  PENDING_TTL_MS,
  diffOps,
  applyOps,
  createSyncState,
  outbound,
  inbound,
} from '../src/lib/queue-sync.js';

function id(n) {
  return `v${String(n).padStart(10, '0')}`;
}

function same(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomList(rng, pool) {
  const n = Math.floor(rng() * 13);
  const copy = pool.slice();
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (copy.length - i));
    const tmp = copy[i];
    copy[i] = copy[j];
    copy[j] = tmp;
  }
  return copy.slice(0, n);
}

function editList(list, rng, pool) {
  const roll = rng();
  if (list.length && roll < 0.15) return [];
  if (roll < 0.45 && list.length < 12) {
    const choices = pool.filter((v) => !list.includes(v));
    if (!choices.length) return list.slice();
    const v = choices[Math.floor(rng() * choices.length)];
    const slot = Math.floor(rng() * (list.length + 1)) - 1;
    const after = slot < 0 ? null : list[slot];
    return applyOps(list, [{ op: 'add', v, after }]);
  }
  if (list.length && roll < 0.7) {
    const v = list[Math.floor(rng() * list.length)];
    return applyOps(list, [{ op: 'remove', v }]);
  }
  if (list.length >= 2) {
    const from = Math.floor(rng() * list.length);
    let slot = Math.floor(rng() * list.length) - 1;
    const v = list[from];
    if (slot === from) slot = from === 0 ? -1 : from - 1;
    const after = slot < 0 ? null : list[slot];
    if (after === v) return list.slice();
    return applyOps(list, [{ op: 'move', v, after }]);
  }
  return list.slice();
}

function settle(up, page, state, now) {
  // Anything still pending after the wire is drained was never applied, or
  // was applied and then undone. Expiry is what sends it again.
  now += PENDING_TTL_MS + 1;
  for (let round = 0; round < 10; round++) {
    const out = outbound(state, up, now);
    state = out.state;
    if (out.ops.length) page = applyOps(page, out.ops);
    const inn = inbound(state, page, now);
    state = inn.state;
    if (inn.ops.length) up = applyOps(up, inn.ops);
    if (same(up, page) && state.pending.length === 0 && !out.ops.length && !inn.ops.length) {
      return { up, page, state, settled: true, rounds: round + 1 };
    }
    now += 1;
  }
  return { up, page, state, settled: false, rounds: 10 };
}

export default async function run(t) {
  const A = id(1);
  const B = id(2);
  const C = id(3);
  const D = id(4);
  const E = id(5);
  const X = id(6);
  const Y = id(7);
  const pool = [];
  for (let n = 1; n <= 20; n++) pool.push(id(n));

  t.section('diffOps and applyOps');

  t.check('cap is 100', QUEUE_SYNC_CAP === 100);
  t.check('pending ttl is 10s', PENDING_TTL_MS === 10000);

  t.check('equal lists are no ops', diffOps([A, B], [A, B]).length === 0);
  t.check('both empty are no ops', diffOps([], []).length === 0);

  const addTop = diffOps([A, B], [X, A, B]);
  t.check('add at top', addTop.length === 1 && addTop[0].op === 'add' && addTop[0].v === X && addTop[0].after === null, JSON.stringify(addTop));
  t.check('add at top applies', same(applyOps([A, B], addTop), [X, A, B]));

  const addMid = diffOps([A, B], [A, X, B]);
  t.check('add in the middle', addMid.length === 1 && addMid[0].op === 'add' && addMid[0].after === A, JSON.stringify(addMid));
  t.check('add in the middle applies', same(applyOps([A, B], addMid), [A, X, B]));

  const addEnd = diffOps([A, B], [A, B, X]);
  t.check('add at end', addEnd.length === 1 && addEnd[0].op === 'add' && addEnd[0].after === B, JSON.stringify(addEnd));
  t.check('add at end applies', same(applyOps([A, B], addEnd), [A, B, X]));

  const removed = diffOps([A, B, C], [A, C]);
  t.check('remove one', removed.length === 1 && removed[0].op === 'remove' && removed[0].v === B, JSON.stringify(removed));
  t.check('remove applies', same(applyOps([A, B, C], removed), [A, C]));

  const cleared = diffOps([A, B], []);
  t.check('clear is the only op', cleared.length === 1 && cleared[0].op === 'clear' && Object.keys(cleared[0]).length === 1, JSON.stringify(cleared));
  t.check('clear applies', same(applyOps([A, B, C], cleared), []));
  t.check('empty to empty is not a clear', diffOps([], []).length === 0);

  const dragUp = diffOps([A, B, C, D], [A, D, B, C]);
  t.check(
    'drag up is one move',
    dragUp.length === 1 && dragUp[0].op === 'move' && dragUp[0].v === D && dragUp[0].after === A,
    JSON.stringify(dragUp),
  );
  t.check('drag up applies', same(applyOps([A, B, C, D], dragUp), [A, D, B, C]));

  const dragDown = diffOps([A, B, C, D], [B, C, D, A]);
  t.check(
    'drag down is one move',
    dragDown.length === 1 && dragDown[0].op === 'move' && dragDown[0].v === A && dragDown[0].after === D,
    JSON.stringify(dragDown),
  );
  t.check('drag down applies', same(applyOps([A, B, C, D], dragDown), [B, C, D, A]));

  const dragMid = diffOps([A, B, C, D], [A, C, B, D]);
  t.check('drag one place is one move', dragMid.length === 1 && dragMid[0].op === 'move', JSON.stringify(dragMid));

  const reversed = diffOps([A, B, C, D], [D, C, B, A]);
  t.check(
    'reverse moves every row but one',
    reversed.length === 3 && reversed.every((op) => op.op === 'move'),
    JSON.stringify(reversed),
  );
  t.check('reverse applies', same(applyOps([A, B, C, D], reversed), [D, C, B, A]));

  const mixed = diffOps([A, B, C, D], [C, A, E]);
  const removeCount = mixed.filter((op) => op.op === 'remove').length;
  const firstChange = mixed.findIndex((op) => op.op !== 'remove');
  t.check('mixed removes come first', firstChange === removeCount && removeCount === 2, JSON.stringify(mixed));
  t.check('mixed removes B and D', mixed.filter((op) => op.op === 'remove').map((op) => op.v).join() === [B, D].join());
  t.check('mixed adds E', mixed.some((op) => op.op === 'add' && op.v === E));
  t.check('mixed applies', same(applyOps([A, B, C, D], mixed), [C, A, E]));

  const dupFrom = [A, A, 'short', B, B];
  const dupTo = [B, 'nope', B, C, A];
  t.check(
    'duplicates and invalid ids are dropped before the diff',
    same(applyOps(dupFrom, diffOps(dupFrom, dupTo)), [B, C, A]),
  );
  t.check('non-array from is empty', same(applyOps(null, diffOps(null, [A])), [A]));
  t.check('non-array to clears', diffOps([A], null).length === 1 && diffOps([A], null)[0].op === 'clear');

  const frozen = [A, B];
  const frozenOps = [{ op: 'remove', v: A }];
  applyOps(frozen, frozenOps);
  diffOps(frozen, [B]);
  t.check('applyOps leaves the list in place', frozen[0] === A && frozen[1] === B && frozen.length === 2);
  t.check('applyOps leaves ops in place', frozenOps.length === 1 && frozenOps[0].v === A && frozenOps[0].op === 'remove');

  t.check('add of an id already there is a no-op', same(applyOps([A, B], [{ op: 'add', v: A, after: null }]), [A, B]));
  t.check('remove of an absent id is a no-op', same(applyOps([A], [{ op: 'remove', v: B }]), [A]));
  t.check('move of an absent id is a no-op', same(applyOps([A], [{ op: 'move', v: B, after: null }]), [A]));
  t.check(
    'unknown after places at the end',
    same(applyOps([A, B], [{ op: 'add', v: C, after: D }]), [A, B, C]),
  );
  t.check(
    'unknown op shapes are ignored',
    same(applyOps([A], [null, 1, { op: 'nope' }, { op: 'add' }, { op: 'move', v: 'short', after: null }, A]), [A]),
  );
  t.check('ops that are not a list leave the sanitized list', same(applyOps([A, A, 'bad'], null), [A]));

  const full = [];
  for (let n = 1; n <= QUEUE_SYNC_CAP; n++) full.push(id(n));
  const extra = id(QUEUE_SYNC_CAP + 1);
  t.check('add past the cap is a no-op', same(applyOps(full, [{ op: 'add', v: extra, after: null }]), full));
  t.check(
    'a move still works at the cap',
    same(applyOps(full, [{ op: 'move', v: id(QUEUE_SYNC_CAP), after: null }]), [id(QUEUE_SYNC_CAP), ...full.slice(0, -1)]),
  );
  const tooLong = full.concat([extra]);
  t.check(
    'a list past the cap keeps the first 100',
    same(applyOps(tooLong, []), full),
  );

  t.section('round trip');

  const rng = mulberry32(0x515EED);
  let tripFails = 0;
  let firstTrip = '';
  for (let n = 0; n < 2000; n++) {
    const a = randomList(rng, pool);
    const b = randomList(rng, pool);
    const got = applyOps(a, diffOps(a, b));
    if (!same(got, b)) {
      tripFails += 1;
      if (!firstTrip) firstTrip = `${a.join(',')} -> ${b.join(',')} got ${got.join(',')}`;
    }
  }
  t.check('2000 random diffs apply back to the target', tripFails === 0, firstTrip || String(tripFails));

  t.section('races');

  // 1. Our add, then a stale snapshot that does not have it yet.
  {
    let state = createSyncState([A]);
    const before = structuredClone(state);
    let up = [A, X];
    const sent = outbound(state, up, 1000);
    t.check('outbound does not mutate state', same(state.shadow, before.shadow) && state.pending.length === 0);
    state = sent.state;
    t.check('add is sent', sent.ops.length === 1 && sent.ops[0].op === 'add' && sent.ops[0].v === X, JSON.stringify(sent.ops));
    const stale = inbound(state, [A], 1001);
    state = stale.state;
    up = applyOps(up, stale.ops);
    t.check('stale snapshot keeps the add', same(up, [A, X]) && stale.ops.length === 0, JSON.stringify(up));
    t.check('stale snapshot leaves the add in flight', state.pending.length === 1);
    const echo = inbound(state, [A, X], 1002);
    t.check('echo is an ack', echo.ops.length === 0 && echo.state.pending.length === 0);
    t.check('echo shadow is the page', same(echo.state.shadow, [A, X]));
  }

  // 2. Our remove, stale snapshot still has the row.
  {
    let state = createSyncState([A, B]);
    let up = [A];
    const sent = outbound(state, up, 2000);
    state = sent.state;
    const stale = inbound(state, [A, B], 2001);
    up = applyOps(up, stale.ops);
    t.check('stale snapshot does not bring B back', same(up, [A]) && stale.ops.length === 0, JSON.stringify({ up, ops: stale.ops }));
    const echo = inbound(stale.state, [A], 2002);
    t.check('remove echo acks', echo.ops.length === 0 && echo.state.pending.length === 0);
  }

  // 3. Both sides move before either message lands.
  {
    let state = createSyncState([A, B, C, D]);
    let up = [D, A, B, C];
    let page = [A, B, C, D];
    const sent = outbound(state, up, 3000);
    state = sent.state;
    page = [B, C, D, A];
    const seen = inbound(state, page, 3001);
    state = seen.state;
    up = applyOps(up, seen.ops);
    page = applyOps(page, sent.ops);
    const landed = inbound(state, page, 3002);
    state = landed.state;
    up = applyOps(up, landed.ops);
    const again = outbound(state, up, 3003);
    state = again.state;
    if (again.ops.length) {
      page = applyOps(page, again.ops);
      const inn = inbound(state, page, 3004);
      state = inn.state;
      up = applyOps(up, inn.ops);
    }
    t.check('concurrent moves meet', same(up, page), JSON.stringify({ up, page }));
  }

  // 4. Page adds Y while our add of X is in flight.
  {
    let state = createSyncState([A]);
    let up = [A, X];
    let page = [A];
    const sent = outbound(state, up, 4000);
    state = sent.state;
    page = [A, Y];
    const seen = inbound(state, page, 4001);
    state = seen.state;
    up = applyOps(up, seen.ops);
    t.check('in flight add keeps X and takes Y', up.includes(X) && up.includes(Y), up.join(','));
    const back = outbound(state, up, 4002);
    t.check(
      'outbound after that inbound does not send Y',
      !back.ops.some((op) => op.v === Y),
      JSON.stringify(back.ops),
    );
    state = back.state;
    page = applyOps(page, sent.ops);
    if (back.ops.length) page = applyOps(page, back.ops);
    const landed = inbound(state, page, 4003);
    up = applyOps(up, landed.ops);
    t.check('both sides have X and Y', same(up, page) && up.includes(X) && up.includes(Y), JSON.stringify({ up, page }));
  }

  // 5. Page clears while our add is in flight. Last change wins.
  {
    let state = createSyncState([A]);
    let up = [A, X];
    let page = [A];
    const sent = outbound(state, up, 5000);
    state = sent.state;
    page = [];
    const seen = inbound(state, page, 5001);
    state = seen.state;
    up = applyOps(up, seen.ops);
    t.check('page clear wipes Up next', seen.ops.length === 1 && seen.ops[0].op === 'clear' && up.length === 0, JSON.stringify(seen.ops));
    page = applyOps(page, sent.ops);
    const landed = inbound(state, page, 5002);
    state = landed.state;
    up = applyOps(up, landed.ops);
    const done = settle(up, page, state, 5002);
    t.check(
      'clear wins once the in-flight add lands',
      done.settled && done.up.length === 0 && same(done.up, done.page) && done.state.pending.length === 0,
      JSON.stringify({ up: done.up, page: done.page, pending: done.state.pending.length, settled: done.settled }),
    );
  }

  // 6. The page never applies our op. After the ttl, outbound sends it again.
  {
    let state = createSyncState([A]);
    const sent = outbound(state, [A, X], 6000);
    state = sent.state;
    const held = outbound(state, [A, X], 6000 + PENDING_TTL_MS);
    t.check('pending still live at the ttl', held.ops.length === 0 && held.state.pending.length === 1);
    const resent = outbound(state, [A, X], 6000 + PENDING_TTL_MS + 1);
    t.check(
      'expired pending is sent again',
      resent.ops.length === 1 && resent.ops[0].op === 'add' && resent.ops[0].v === X && resent.state.pending.length === 1,
      JSON.stringify(resent.ops),
    );
  }

  t.section('convergence');

  let convFails = 0;
  let firstConv = '';
  for (let trial = 0; trial < 500; trial++) {
    const rand = mulberry32(0xC0FFEE + trial);
    const start = randomList(rand, pool);
    let up = start.slice();
    let page = start.slice();
    let state = createSyncState(start);
    const toPage = [];
    const toUs = [];
    let now = 1000000;
    const steps = 20 + Math.floor(rand() * 21);
    for (let s = 0; s < steps; s++) {
      now += 1;
      const kind = rand();
      if (kind < 0.34) {
        const next = editList(up, rand, pool);
        if (!same(next, up)) {
          up = next;
          const out = outbound(state, up, now);
          state = out.state;
          if (out.ops.length) toPage.push(out.ops);
        }
      } else if (kind < 0.62) {
        const next = editList(page, rand, pool);
        if (!same(next, page)) {
          page = next;
          toUs.push(page.slice());
        }
      } else if (kind < 0.82 && toPage.length) {
        const i = Math.floor(rand() * toPage.length);
        const ops = toPage.splice(i, 1)[0];
        page = applyOps(page, ops);
        toUs.push(page.slice());
      } else if (toUs.length) {
        const i = Math.floor(rand() * toUs.length);
        const snap = toUs.splice(i, 1)[0];
        const inn = inbound(state, snap, now);
        state = inn.state;
        up = applyOps(up, inn.ops);
      }
    }
    let guard = 0;
    while ((toPage.length || toUs.length) && guard < 5000) {
      guard += 1;
      if (toPage.length) {
        page = applyOps(page, toPage.shift());
        toUs.push(page.slice());
      } else {
        const inn = inbound(state, toUs.shift(), now);
        state = inn.state;
        up = applyOps(up, inn.ops);
      }
    }
    const done = settle(up, page, state, now);
    if (!done.settled || !same(done.up, done.page) || done.state.pending.length) {
      convFails += 1;
      if (!firstConv) {
        firstConv = `trial ${trial} up=${done.up.join(',')} page=${done.page.join(',')} pending=${done.state.pending.length} shadow=${done.state.shadow.join(',')}`;
      }
    }
  }
  t.check('500 random schedules converge', convFails === 0, firstConv || String(convFails));
}
