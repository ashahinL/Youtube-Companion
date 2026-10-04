/**
 * Pure sync between Up next and one YouTube queue.
 * Lists are mirrored as add, remove, move and clear ops so a stale
 * snapshot cannot overwrite an edit that is still in flight.
 */

export const QUEUE_SYNC_CAP = 100;
export const PENDING_TTL_MS = 10000;

const ID_RE = /^[A-Za-z0-9_-]{11}$/;

function sanitize(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const id of list) {
    if (typeof id !== 'string' || !ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= QUEUE_SYNC_CAP) break;
  }
  return out;
}

function sameList(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function cloneOp(op) {
  if (op.op === 'clear') return { op: 'clear' };
  if (op.op === 'remove') return { op: 'remove', v: op.v };
  return { op: op.op, v: op.v, after: op.after };
}

// Rows already in a longest increasing run of their old positions stay.
// One drag is then a single move: every other row is still in order.
function lisAnchors(items) {
  const piles = [];
  const prev = new Array(items.length).fill(-1);
  for (let i = 0; i < items.length; i++) {
    const pos = items[i].pos;
    let lo = 0;
    let hi = piles.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (items[piles[mid]].pos < pos) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = piles[lo - 1];
    if (lo === piles.length) piles.push(i);
    else piles[lo] = i;
  }
  const keep = new Set();
  for (let k = piles.length ? piles[piles.length - 1] : -1; k >= 0; k = prev[k]) {
    keep.add(items[k].id);
  }
  return keep;
}

export function diffOps(from, to) {
  const source = sanitize(from);
  const target = sanitize(to);
  if (sameList(source, target)) return [];
  if (target.length === 0) return [{ op: 'clear' }];

  const targetSet = new Set(target);
  const sourceSet = new Set(source);
  const ops = [];
  for (const id of source) {
    if (!targetSet.has(id)) ops.push({ op: 'remove', v: id });
  }

  const surviving = source.filter((id) => targetSet.has(id));
  const pos = new Map();
  for (let i = 0; i < surviving.length; i++) pos.set(surviving[i], i);

  const existing = [];
  for (const id of target) {
    if (pos.has(id)) existing.push({ id, pos: pos.get(id) });
  }
  const anchors = lisAnchors(existing);

  let after = null;
  for (const id of target) {
    if (anchors.has(id)) {
      after = id;
      continue;
    }
    ops.push(sourceSet.has(id)
      ? { op: 'move', v: id, after }
      : { op: 'add', v: id, after });
    after = id;
  }
  return ops;
}

function place(list, v, after) {
  if (after === null) return [v, ...list];
  const at = list.indexOf(after);
  if (at < 0) return [...list, v];
  const next = list.slice();
  next.splice(at + 1, 0, v);
  return next;
}

export function applyOps(list, ops) {
  let next = sanitize(list);
  if (!Array.isArray(ops)) return next;
  for (const op of ops) {
    if (!op || typeof op !== 'object') continue;
    if (op.op === 'clear') {
      next = [];
      continue;
    }
    if (typeof op.v !== 'string' || !ID_RE.test(op.v)) continue;
    if (op.op === 'remove') {
      const at = next.indexOf(op.v);
      if (at < 0) continue;
      next = next.slice();
      next.splice(at, 1);
      continue;
    }
    if (op.op === 'add') {
      if (next.includes(op.v) || next.length >= QUEUE_SYNC_CAP) continue;
      next = place(next, op.v, op.after);
      continue;
    }
    if (op.op === 'move') {
      const at = next.indexOf(op.v);
      if (at < 0) continue;
      const without = next.slice();
      without.splice(at, 1);
      next = place(without, op.v, op.after);
    }
  }
  return next;
}

function dropExpired(pending, now) {
  if (!pending.length || typeof now !== 'number' || !Number.isFinite(now)) return pending;
  for (const entry of pending) {
    if (typeof entry.at === 'number' && now - entry.at > PENDING_TTL_MS) {
      return pending.filter((item) => (
        typeof item.at !== 'number' || now - item.at <= PENDING_TTL_MS
      ));
    }
  }
  return pending;
}

function shadowOf(state) {
  const shadow = sanitize(state.shadow);
  return sameList(shadow, state.shadow) ? state.shadow : shadow;
}

// Batches are walked in send order. One that does not change this
// snapshot is already reflected, so it is acked. Later batches are
// replayed on the snapshot: that is where those ops will land, and two
// inserts after one row then meet in one order.
function foldPending(page, pending) {
  let cur = page;
  let index = 0;
  while (index < pending.length) {
    const next = applyOps(cur, pending[index].ops);
    if (!sameList(next, cur)) break;
    index += 1;
  }
  const out = [];
  for (let j = index; j < pending.length; j++) {
    cur = applyOps(cur, pending[j].ops);
    out.push({ expect: cur, ops: pending[j].ops, at: pending[j].at });
  }
  return { pending: out, predict: cur };
}

function matchIndex(pending, page) {
  for (let i = pending.length - 1; i >= 0; i--) {
    if (sameList(pending[i].expect, page)) return i;
  }
  return -1;
}

export function createSyncState(pageIds = []) {
  return { shadow: sanitize(pageIds), pending: [] };
}

export function outbound(state, upNext, now) {
  const pending = dropExpired(state.pending, now);
  const base = pending.length ? pending[pending.length - 1].expect : state.shadow;
  const ops = diffOps(base, upNext);
  if (!ops.length) {
    if (pending === state.pending) return { state, ops };
    return { state: { shadow: state.shadow, pending }, ops };
  }
  return {
    state: {
      shadow: state.shadow,
      pending: [...pending, { expect: sanitize(upNext), ops: ops.map(cloneOp), at: now }],
    },
    ops,
  };
}

export function inbound(state, pageIds, now) {
  const pending0 = dropExpired(state.pending, now);
  const page = sanitize(pageIds);
  const shadow = shadowOf(state);

  const matched = matchIndex(pending0, page);
  if (matched >= 0) {
    return {
      state: { shadow: page, pending: pending0.slice(matched + 1) },
      ops: [],
    };
  }

  // A clear on the page wins over an add still in flight. Expects keep
  // the row that add will insert on the empty queue. Wiping them would
  // make that landing look like a new page edit, and the add would stick.
  if (page.length === 0 && shadow.length > 0) {
    return {
      state: { shadow: page, pending: foldPending(page, pending0).pending },
      ops: [{ op: 'clear' }],
    };
  }

  const folded = foldPending(page, pending0);
  const base = pending0.length ? pending0[pending0.length - 1].expect : shadow;
  const theirs = diffOps(base, folded.predict);
  if (
    !theirs.length
    && pending0 === state.pending
    && shadow === state.shadow
    && sameList(page, shadow)
    && folded.pending.length === pending0.length
    && folded.pending.every((entry, i) => sameList(entry.expect, pending0[i].expect))
  ) {
    return { state, ops: [] };
  }
  return {
    state: { shadow: page, pending: folded.pending },
    ops: theirs,
  };
}
