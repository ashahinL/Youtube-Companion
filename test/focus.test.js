/**
 * Focus kept on the same row control across a list redraw, driven with
 * small fake elements.
 */

import { focusSpot, restoreFocusSpot } from '../src/lib/focus.js';

const FOCUSABLE_TAGS = new Set(['button', 'a', 'input', 'select', 'textarea']);

function el(tag, className = '', kids = []) {
  const node = {
    tag,
    className,
    dataset: {},
    parentNode: null,
    children: [],
    focused: 0,
    focus() { node.focused += 1; state.active = node; },
    contains(other) {
      for (let n = other; n; n = n.parentNode) if (n === node) return true;
      return false;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const kid of n.children) {
          if (sel === '.menu__toggle' ? kid.className.split(/\s+/).includes('menu__toggle') : FOCUSABLE_TAGS.has(kid.tag)) out.push(kid);
          walk(kid);
        }
      };
      walk(node);
      return out;
    },
    querySelector(sel) { return node.querySelectorAll(sel)[0] || null; },
  };
  for (const kid of kids) {
    kid.parentNode = node;
    node.children.push(kid);
  }
  return node;
}

const state = { active: null };

function row(key) {
  const open = el('button', 'feed-row__open');
  const channel = el('button', 'feed-row__channel');
  const item = el('button', 'menu__item');
  const menu = el('div', 'menu', [el('button', 'icon-btn menu__toggle'), el('div', 'menu__list', [item])]);
  const r = el('div', 'feed-row', [open, el('div', 'feed-row__body', [channel]), menu]);
  r.dataset.rowKey = key;
  return { r, open, channel, item };
}

function list(rows) {
  return el('div', 'list', rows.map((x) => x.r));
}

export default async function run(t) {
  t.section('focus across a redraw');

  const before = [row('a'), row('b'), row('c')];
  const listEl = list(before);
  const spot = focusSpot(listEl, before[1].channel);
  t.check('the spot names the row and the control', spot?.key === 'b' && spot.index === 1, JSON.stringify(spot));

  const after = [row('c'), row('b'), row('a')];
  listEl.children = after.map((x) => { x.r.parentNode = listEl; return x.r; });
  t.check('focus returns to the same control on the same row', restoreFocusSpot(listEl, spot) && state.active === after[1].channel);

  const menuSpot = focusSpot(listEl, after[0].item);
  const redrawn = [row('c')];
  listEl.children = redrawn.map((x) => { x.r.parentNode = listEl; return x.r; });
  restoreFocusSpot(listEl, menuSpot);
  t.check(
    'focus inside a ⋯ menu comes back to that row\'s ⋯ button',
    state.active?.className === 'icon-btn menu__toggle' && redrawn[0].r.contains(state.active),
  );

  const goneSpot = focusSpot(listEl, redrawn[0].open);
  listEl.children = [];
  state.active = null;
  t.check('a row that is gone moves nothing', restoreFocusSpot(listEl, goneSpot) === false && state.active === null);

  const outside = el('button');
  t.check('focus outside the list is not a spot', focusSpot(listEl, outside) === null);
  t.check('no focus is not a spot', focusSpot(listEl, null) === null && restoreFocusSpot(listEl, null) === false);
}
