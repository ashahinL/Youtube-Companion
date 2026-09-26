/**
 * Keeps keyboard focus on the same row control when a list is drawn again.
 * A check writes the channel list and feed several times, and each write
 * redraws the open tab from scratch; without this a keyboard or screen
 * reader user is sent back to the top of the page each time.
 *
 * Rows carry `data-row-key`. Works on any element with the DOM methods
 * used below, so the suite can drive it without a browser.
 */

const FOCUSABLE = 'button, a[href], input, select, textarea, [tabindex]';

function rowOf(el, list) {
  let node = el;
  while (node && node !== list) {
    if (node.dataset && node.dataset.rowKey != null && node.parentNode === list) return node;
    node = node.parentNode;
  }
  return null;
}

function insideMenu(el, row) {
  let node = el;
  while (node && node !== row) {
    if (typeof node.className === 'string' && node.className.split(/\s+/).includes('menu')) return true;
    node = node.parentNode;
  }
  return false;
}

/** Where focus sits in `list`, or null when it is elsewhere. */
export function focusSpot(list, active) {
  if (!list || !active || active === list || !list.contains(active)) return null;
  const row = rowOf(active, list);
  if (!row) return null;
  const key = row.dataset.rowKey;
  // A redraw closes an open ⋯ menu; its button is the place to come back to.
  if (insideMenu(active, row)) return { key, selector: '.menu__toggle', index: 0 };
  const index = Array.from(row.querySelectorAll(FOCUSABLE)).indexOf(active);
  return { key, selector: '', index: Math.max(0, index) };
}

/** Focus the same control on the row with the same key, if it is still drawn. */
export function restoreFocusSpot(list, spot) {
  if (!list || !spot) return false;
  const row = Array.from(list.children || []).find((el) => el.dataset && el.dataset.rowKey === spot.key);
  if (!row) return false;
  const target = spot.selector
    ? row.querySelector(spot.selector)
    : row.querySelectorAll(FOCUSABLE)[spot.index] || row.querySelector(FOCUSABLE);
  if (!target || typeof target.focus !== 'function') return false;
  target.focus({ preventScroll: true });
  return true;
}
