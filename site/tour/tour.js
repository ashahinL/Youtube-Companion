/**
 * The tour page: a landing view of chapter cards, a player that plays the
 * steps in scenes.js on a 1280×720 stage, and a Read view of the same
 * text. The stage is a browser window drawn in HTML; the popup on it is the
 * real one, app/popup.html, answered by scripts/tour/stub-tour.js.
 *
 * Every motion on the stage runs on one clock. Animation frames advance it
 * while the tour plays, pause stops it and speed scales it. A recorder takes
 * it over with `__tour.clock.drive()` and then `__tour.clock.advance(ms)`
 * once per frame.
 */

import { CHAPTERS } from './scenes.js';

const W = 1280;
const H = 720;
// Where the popup hangs on the stage: under the toolbar icon, right edges level.
const POPUP = { left: 764, top: 80 };
const CARD_MS = 2000;
const SPEEDS = [1, 1.5, 2];
const RECORD = new URLSearchParams(location.search).get('record') === '1';
// The share of the stage height a 'popup' framing fills.
const CAMERA_FILL = 0.9;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const HANG = new Promise(() => {});

const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
const easeOut = (k) => 1 - Math.pow(1 - k, 3);
const linear = (k) => k;
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'html') el.innerHTML = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function clockText(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const msText = (ms) => clockText(Math.round(ms / 1000));
const chapterMs = (ch) => ch.steps.reduce((sum, step) => sum + step.ms, 0);
const totalMs = () => CHAPTERS.reduce((sum, ch) => sum + chapterMs(ch), 0);

/* ---- the clock --------------------------------------------------------- */

class Clock {
  constructor() {
    this.now = 0;
    this.speed = 1;
    this.paused = true;
    this.instant = false;
    this.driven = false;
    this.epoch = 0;
    this.timers = [];
    this.tweens = [];
    this.ticks = new Set();
  }

  // An instant wait still yields a task, so the popup can draw between the
  // actions of a step that is being jumped to its end.
  wait(ms) {
    const epoch = this.epoch;
    if (this.instant) {
      return new Promise((resolve) => setTimeout(resolve, 0)).then(() => (epoch === this.epoch ? undefined : HANG));
    }
    return new Promise((resolve) => this.timers.push({ at: this.now + Math.max(0, ms), resolve }));
  }

  tween(ms, fn, ease = easeInOut) {
    if (this.instant || ms <= 0) {
      fn(1);
      return this.wait(0);
    }
    fn(0);
    return new Promise((resolve) => this.tweens.push({ from: this.now, ms, fn, ease, resolve }));
  }

  advance(ms) {
    this.now += ms;
    for (const tw of this.tweens.slice()) {
      const k = Math.min(1, (this.now - tw.from) / tw.ms);
      tw.fn(tw.ease(k));
      if (k >= 1) {
        this.tweens.splice(this.tweens.indexOf(tw), 1);
        tw.resolve();
      }
    }
    this.timers.sort((a, b) => a.at - b.at);
    while (this.timers.length && this.timers[0].at <= this.now) this.timers.shift().resolve();
    for (const fn of this.ticks) fn(this.now);
  }

  // Waits and tweens from before a jump never resolve, so a step that was
  // left halfway stops where it was.
  reset() {
    this.epoch += 1;
    this.timers = [];
    this.tweens = [];
    this.instant = false;
  }

  drive() {
    this.driven = true;
  }
}

const clock = new Clock();
let lastFrame = null;
function frame(t) {
  if (!clock.driven) {
    const dt = lastFrame == null ? 0 : Math.min(100, t - lastFrame);
    if (!clock.paused) clock.advance(dt * clock.speed);
  }
  lastFrame = t;
  requestAnimationFrame(frame);
}

// Real-time polling for something the popup draws after an action. Only
// waiting on the popup goes through here; timing never does.
function poll(test, ms = 5000) {
  const epoch = clock.epoch;
  const start = performance.now();
  return new Promise((resolve) => {
    (function again() {
      if (epoch !== clock.epoch) return;
      let hit = null;
      try {
        hit = test();
      } catch {
        hit = null;
      }
      if (hit || performance.now() - start > ms) {
        resolve(hit || null);
        return;
      }
      setTimeout(again, 30);
    })();
  });
}

/* ---- icons ------------------------------------------------------------- */

const ICON = {
  back: '<svg viewBox="0 0 20 20"><path d="M12.5 4 6.5 10l6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fwd: '<svg viewBox="0 0 20 20"><path d="m7.5 4 6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  reload: '<svg viewBox="0 0 20 20"><path d="M15.5 10a5.5 5.5 0 1 1-1.6-3.9M15.5 3.5v3.2h-3.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  tune: '<svg viewBox="0 0 20 20"><path d="M4 7h7M14 7h2M4 13h2M9 13h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="12.5" cy="7" r="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="7.5" cy="13" r="1.6" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>',
  star: '<svg viewBox="0 0 20 20"><path d="m10 3.2 2 4.3 4.6.5-3.4 3.1 1 4.6L10 13.4l-4.2 2.3 1-4.6L3.4 8l4.6-.5z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg>',
  pieces: '<svg viewBox="0 0 20 20"><rect x="3.5" y="3.5" width="5.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="11" y="3.5" width="5.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="11" width="5.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="11" y="11" width="5.5" height="5.5" rx="1.2" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>',
  more: '<svg viewBox="0 0 20 20"><circle cx="10" cy="4.5" r="1.5" fill="currentColor"/><circle cx="10" cy="10" r="1.5" fill="currentColor"/><circle cx="10" cy="15.5" r="1.5" fill="currentColor"/></svg>',
  download: '<svg viewBox="0 0 20 20"><path d="M10 3.5v9M6 9l4 4 4-4M4.5 16.5h11" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M6 2.5h8l5 5v14H6z" fill="#eef0f4" stroke="#9aa1ad" stroke-width="1.2"/><path d="M14 2.5v5h5" fill="none" stroke="#9aa1ad" stroke-width="1.2"/><text x="12.5" y="18" font-size="5.2" font-family="system-ui" font-weight="700" text-anchor="middle" fill="#6d4ae8">JSON</text></svg>',
  menu: '<svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m15 15 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  play: '<svg viewBox="0 0 24 24"><path d="M8 5.5v13l10-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M6 6v12l8.5-6zM16 6h2.5v12H16z" fill="currentColor"/></svg>',
  volume: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 6v12l-4.5-3.5H4z" fill="currentColor"/><path d="M15 9a4 4 0 0 1 0 6M17.5 6.5a7.5 7.5 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M6 18l1.8-1.8M16.2 7.8 18 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  full: '<svg viewBox="0 0 24 24"><path d="M5 9V5h4M15 5h4v4M19 15v4h-4M9 19H5v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
  headphones: '<svg viewBox="0 0 48 48"><path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M8 24a16 16 0 0 1 32 0"/><path fill="currentColor" d="M8 24v8.5A4.5 4.5 0 0 0 12.5 37h2A3.5 3.5 0 0 0 18 33.5V27a3 3 0 0 0-3-3H8z"/><path fill="currentColor" d="M40 24v8.5A4.5 4.5 0 0 1 35.5 37h-2A3.5 3.5 0 0 1 30 33.5V27a3 3 0 0 1 3-3h7z"/></svg>',
  cursor: '<svg viewBox="0 0 28 28" width="28" height="28"><path d="M5 3.5v18.2l4.8-4.4 3.2 7.2 3.3-1.5-3.1-7h6.6z" fill="#fff" stroke="#17141f" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  close: '<svg viewBox="0 0 20 20"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>',
};

const icon = (name, cls = '') => h('span', { class: `ic ${cls}`.trim(), 'aria-hidden': 'true', html: ICON[name] });

/* ---- demo data for the page mocks -------------------------------------- */

function demo() {
  return globalThis.SHOTS_DEMO || { channels: [], feed: [] };
}

function channelOf(id) {
  return demo().channels.find((ch) => ch.id === id) || null;
}

function videoOf(v) {
  return demo().feed.find((row) => row.v === v) || null;
}

const thumb = (v, size = 'hq') => `https://i.ytimg.com/vi/${v}/${size}default.jpg`;

function viewsText(n) {
  if (!n) return '';
  if (n >= 1e6) return `${Math.round(n / 1e5) / 10}M views`;
  if (n >= 1e3) return `${Math.round(n / 100) / 10}K views`;
  return `${n} views`;
}

function agoText(at) {
  const hours = Math.max(1, Math.round((Date.now() - at) / 3.6e6));
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/* ---- the stage --------------------------------------------------------- */

function createStage(root) {
  const S = { clock };
  let scale = 1;

  const tabTitle = h('span', { class: 'win-tab__title' }, 'YouTube');
  const address = h('span', { class: 'omni__url' }, 'youtube.com');
  const badge = h('span', { class: 'ext__badge', hidden: true });
  const extBtn = h('span', { class: 'tb ext' }, h('img', { src: 'app/icons/icon32.png', alt: '', width: 20, height: 20 }), badge);
  const dlBtn = h('span', { class: 'tb dl-btn', hidden: true }, icon('download'));
  const chromeBar = h('div', { class: 'win-top' },
    h('div', { class: 'win-tabs' },
      h('div', { class: 'win-tab' }, h('span', { class: 'win-tab__fav' }), tabTitle, icon('close', 'win-tab__x')),
      h('span', { class: 'win-tabs__plus' }, '+'),
      h('span', { class: 'win-ctl' }, h('i', { class: 'win-ctl__min' }), h('i', { class: 'win-ctl__max' }), icon('close', 'win-ctl__x'))),
    h('div', { class: 'win-bar' },
      h('span', { class: 'tb' }, icon('back')), h('span', { class: 'tb tb--off' }, icon('fwd')), h('span', { class: 'tb' }, icon('reload')),
      h('div', { class: 'omni' }, icon('tune', 'omni__tune'), address, icon('star', 'omni__star')),
      dlBtn, extBtn, h('span', { class: 'tb' }, icon('pieces')), h('span', { class: 'tb' }, h('span', { class: 'win-me' })), h('span', { class: 'tb' }, icon('more'))));
  const pageEl = h('div', { class: 'pg' });
  const win = h('div', { class: 'win' }, chromeBar, pageEl);

  const frames = ['tour-a', 'tour-b'].map((name) => h('iframe', { class: 'pop__frame', name, title: 'Companion for YouTube popup', tabindex: '-1' }));
  // A closed popup stays laid out (visibility, not display), so its lazy
  // thumbnails load before it opens.
  const pop = h('div', { class: 'pop is-closed' }, ...frames);
  let front = frames[0];

  const spot = h('div', { class: 'spot' });
  const cursorEl = h('div', { class: 'cur', html: ICON.cursor });
  const layer = h('div', { class: 'fx' });
  // The camera moves everything in `cam`. The chapter card, the outro and a
  // recording's caption sit outside it and never move.
  const cam = h('div', { class: 'cam' }, win, pop, layer, spot, cursorEl);
  const over = h('div', { class: 'over' });
  const stage = h('div', { class: 'stage', inert: true, 'aria-hidden': 'true' }, cam, over);
  root.append(stage);
  S.el = stage;
  S.toolbarIcon = extBtn;

  S.fit = (s) => {
    scale = s;
    stage.style.transform = `scale(${s})`;
  };

  S.wait = (ms) => clock.wait(ms);
  S.tween = (ms, fn, ease) => clock.tween(ms, fn, ease);

  /* geometry */

  // Rectangles are in stage pixels before the camera, the space the cursor,
  // the highlight and the camera itself are placed in. A popup element's own
  // rectangle ignores every transform outside its frame.
  S.rect = (el) => {
    const r = el.getBoundingClientRect();
    if (el.ownerDocument === document) {
      const sr = stage.getBoundingClientRect();
      const k = scale * view.z;
      return { x: ((r.left - sr.left) / scale - view.x) / view.z, y: ((r.top - sr.top) / scale - view.y) / view.z, w: r.width / k, h: r.height / k };
    }
    return { x: POPUP.left + r.left, y: POPUP.top + r.top, w: r.width, h: r.height };
  };

  /* the camera */

  const view = { z: 1, x: 0, y: 0 };
  const POPUP_BOX = { x: POPUP.left, y: POPUP.top, w: 400, h: 600 };

  function frameOf(target) {
    const boxes = (Array.isArray(target) ? target : [target])
      .map((t) => (t === 'popup' ? POPUP_BOX : t && typeof t.getBoundingClientRect === 'function' ? S.rect(t) : null))
      .filter(Boolean);
    if (!boxes.length) return { z: 1, x: 0, y: 0 };
    const x0 = Math.min(...boxes.map((b) => b.x));
    const y0 = Math.min(...boxes.map((b) => b.y));
    const x1 = Math.max(...boxes.map((b) => b.x + b.w));
    const y1 = Math.max(...boxes.map((b) => b.y + b.h));
    const z = clamp(Math.min((W * 0.94) / (x1 - x0), (H * CAMERA_FILL) / (y1 - y0)), 1, 3);
    // Pan to the middle of the frame, but never past the stage's edge.
    return {
      z,
      x: clamp(W / 2 - ((x0 + x1) / 2) * z, W - W * z, 0),
      y: clamp(H / 2 - ((y0 + y1) / 2) * z, H - H * z, 0),
    };
  }

  S.camera = {
    // 'page' is the whole stage; 'popup' fills CAMERA_FILL of the stage
    // height with the popup; a list frames all of its elements (and
    // 'popup') together.
    focus(target, ms = 800) {
      const goal = target === 'page' ? { z: 1, x: 0, y: 0 } : frameOf(target);
      const from = { ...view };
      return clock.tween(REDUCED ? 0 : ms, (k) => {
        view.z = from.z + (goal.z - from.z) * k;
        view.x = from.x + (goal.x - from.x) * k;
        view.y = from.y + (goal.y - from.y) * k;
        cam.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.z})`;
      });
    },
    get view() {
      return { ...view };
    },
  };

  S.point = (target, at = [0.5, 0.5]) => {
    if (!target) return null;
    // Popup elements come from another realm, so instanceof Node is no test.
    if (typeof target.getBoundingClientRect !== 'function') return target;
    const r = S.rect(target);
    return { x: r.x + r.w * at[0], y: r.y + r.h * at[1] };
  };

  /* the cursor */

  const cursor = {
    x: 980,
    y: 430,
    place(x, y) {
      cursorEl.hidden = false;
      this.x = x;
      this.y = y;
      cursorEl.style.transform = `translate(${x - 5}px, ${y - 3}px)`;
    },
    async moveTo(target, { at, ms } = {}) {
      const p = S.point(target, at);
      if (!p) return;
      cursorEl.hidden = false;
      const dist = Math.hypot(p.x - this.x, p.y - this.y);
      const dur = REDUCED ? 0 : (ms ?? clamp(300 + dist * 0.6, 350, 950));
      const fx = this.x;
      const fy = this.y;
      await clock.tween(dur, (k) => this.place(fx + (p.x - fx) * k, fy + (p.y - fy) * k));
    },
    async click(target, opts = {}) {
      await this.moveTo(opts.aim || target, opts);
      await clock.wait(110);
      press();
      await clock.wait(90);
      target?.click?.();
      await clock.wait(240);
    },
    hide() {
      cursorEl.hidden = true;
    },
  };
  S.cursor = cursor;
  cursor.place(cursor.x, cursor.y);

  function press() {
    cursorEl.classList.add('is-down');
    clock.wait(140).then(() => cursorEl.classList.remove('is-down'));
    if (REDUCED || clock.instant) return;
    const ring = h('div', { class: 'ripple' });
    ring.style.left = `${cursor.x}px`;
    ring.style.top = `${cursor.y}px`;
    layer.append(ring);
    clock.tween(480, (k) => {
      ring.style.transform = `translate(-50%, -50%) scale(${0.3 + 1.2 * k})`;
      ring.style.opacity = String(1 - k);
    }, easeOut).then(() => ring.remove());
  }

  /* input */

  S.type = async (el, text) => {
    const view = el.ownerDocument.defaultView;
    el.value = '';
    for (const ch of text) {
      el.value += ch;
      el.dispatchEvent(new view.Event('input', { bubbles: true }));
      await clock.wait(75);
    }
  };

  S.choose = async (select, value) => {
    await cursor.moveTo(select);
    await clock.wait(110);
    press();
    await clock.wait(260);
    select.value = value;
    select.dispatchEvent(new select.ownerDocument.defaultView.Event('change', { bubbles: true }));
    await clock.wait(300);
  };

  // Pointer events, the way the popup's own list reorders: mouse button 1
  // held on the handle, moved to the target row, released.
  S.drag = async (handle, target, { ms = 1000 } = {}) => {
    await cursor.moveTo(handle);
    const view = handle.ownerDocument.defaultView;
    const from = handle.getBoundingClientRect();
    const to = target.getBoundingClientRect();
    const x = from.left + from.width / 2;
    const y0 = from.top + from.height / 2;
    const y1 = to.top + Math.min(8, to.height / 4);
    const fire = (type, y) => handle.dispatchEvent(new view.PointerEvent(type, {
      pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0, buttons: type === 'pointerup' ? 0 : 1,
      clientX: x, clientY: y, bubbles: true, cancelable: true, composed: true,
    }));
    await clock.wait(120);
    press();
    try {
      fire('pointerdown', y0);
    } catch {
      return;
    }
    await clock.wait(150);
    await clock.tween(ms, (k) => {
      const y = y0 + (y1 - y0) * k;
      fire('pointermove', y);
      cursor.place(POPUP.left + x, POPUP.top + y);
    });
    await clock.wait(120);
    fire('pointerup', y1);
    await clock.wait(400);
  };

  /* highlight */

  S.spot = async (el, { pad = 6 } = {}) => {
    if (!el) return;
    const r = S.rect(el);
    Object.assign(spot.style, {
      left: `${r.x - pad}px`, top: `${r.y - pad}px`, width: `${r.w + pad * 2}px`, height: `${r.h + pad * 2}px`,
    });
    await clock.tween(220, (k) => { spot.style.opacity = String(k); }, linear);
  };

  S.spotOff = () => clock.tween(180, (k) => { spot.style.opacity = String(1 - k); }, linear);

  /* window chrome */

  S.address = (url, title) => {
    address.textContent = url.replace(/^https:\/\/(www\.)?/, '');
    if (title) tabTitle.textContent = title;
  };

  S.badge = (text) => {
    badge.hidden = !text;
    badge.textContent = text || '';
  };

  /* the popup */

  let loads = 0;
  const TAB_OF = { player: 'tab-audio', audio: 'tab-audio', queue: 'tab-audio', follow: 'tab-audio', feeds: 'tab-feeds', groups: 'tab-feeds', watchlist: 'tab-watchlist', sheet: 'tab-watchlist', settings: 'tab-settings' };
  const popup = {
    isOpen: false,
    get doc() {
      return front.contentDocument;
    },
    $(sel) {
      return front.contentDocument?.querySelector(sel) || null;
    },
    $$(sel) {
      return [...(front.contentDocument?.querySelectorAll(sel) || [])];
    },
    find(sel, test) {
      return poll(() => popup.$$(sel).find((el) => !test || test(el)));
    },
    stub() {
      return front.contentWindow?.__tourStub || null;
    },
    // Loads the step's popup into the hidden frame and swaps it in once it
    // has drawn, so moving between steps never shows an empty popup.
    async load(params, { open = true } = {}) {
      const back = frames.find((f) => f !== front);
      const query = new URLSearchParams({ theme: 'light', locale: 'en', scene: 'none', ...params, n: String(++loads) });
      const epoch = clock.epoch;
      const mark = new RegExp(`[?&]n=${loads}(&|$)`);
      // A frame's own about:blank can fire load late; wait for this page's.
      await new Promise((resolve) => {
        const onLoad = () => {
          let href = '';
          try {
            href = back.contentWindow.location.href;
          } catch {
            href = '';
          }
          if (!mark.test(href)) return;
          back.removeEventListener('load', onLoad);
          resolve();
        };
        back.addEventListener('load', onLoad);
        back.src = `app/popup.html?${query}`;
      });
      const doc = back.contentDocument;
      const wantTab = TAB_OF[query.get('scene')];
      await poll(() => doc.body && !doc.body.classList.contains('is-opening')
        && doc.querySelector(wantTab ? `#${wantTab}[aria-selected="true"]` : '[role="tab"][aria-selected="true"]'));
      await new Promise((resolve) => setTimeout(resolve, 120));
      if (epoch !== clock.epoch) return HANG;
      back.classList.add('is-front');
      front.classList.remove('is-front');
      const old = front;
      front = back;
      old.src = 'about:blank';
      popup.show(open);
      const stub = popup.stub();
      if (stub) {
        page.syncPlayer(stub.player());
        page.syncQueue(stub.queue());
      }
      return undefined;
    },
    show(open) {
      popup.isOpen = open;
      stage.classList.toggle('is-popup', open);
      pop.classList.toggle('is-closed', !open);
      pop.style.opacity = '1';
      pop.style.transform = 'none';
    },
    async open() {
      popup.isOpen = true;
      stage.classList.add('is-popup');
      pop.classList.remove('is-closed');
      await clock.tween(REDUCED ? 0 : 170, (k) => {
        pop.style.opacity = String(k);
        pop.style.transform = `translateY(${(1 - k) * -8}px)`;
      }, easeOut);
    },
    async close() {
      if (!popup.isOpen) return;
      popup.isOpen = false;
      await clock.tween(REDUCED ? 0 : 120, (k) => { pop.style.opacity = String(1 - k); }, linear);
      if (popup.isOpen) return;
      pop.classList.add('is-closed');
      stage.classList.remove('is-popup');
    },
    // Scrolls the popup (or the scroll box holding `el`) until `el` is in
    // view, a quarter of the way down.
    async reveal(el, { ms = 650 } = {}) {
      if (!el) return;
      const view = el.ownerDocument.defaultView;
      let box = el.parentElement;
      while (box && box !== el.ownerDocument.body) {
        const oy = view.getComputedStyle(box).overflowY;
        if ((oy === 'auto' || oy === 'scroll') && box.scrollHeight > box.clientHeight) break;
        box = box.parentElement;
      }
      if (!box || box === el.ownerDocument.body) box = el.ownerDocument.scrollingElement;
      const top = box === el.ownerDocument.scrollingElement ? 0 : box.getBoundingClientRect().top;
      const height = box === el.ownerDocument.scrollingElement ? view.innerHeight : box.clientHeight;
      const r = el.getBoundingClientRect();
      if (r.top >= top + 4 && r.bottom <= top + height - 4) return;
      const from = box.scrollTop;
      const to = clamp(from + r.top - top - height * 0.25, 0, box.scrollHeight - box.clientHeight);
      await clock.tween(REDUCED ? 0 : ms, (k) => { box.scrollTop = from + (to - from) * k; });
    },
    async scrollTo(y, { ms = 900 } = {}) {
      const box = popup.doc.scrollingElement;
      const from = box.scrollTop;
      const to = clamp(y, 0, box.scrollHeight - box.clientHeight);
      await clock.tween(REDUCED ? 0 : ms, (k) => { box.scrollTop = from + (to - from) * k; });
    },
  };
  S.popup = popup;

  window.addEventListener('tour:popup', (event) => {
    const msg = event.detail || {};
    if (msg.frame && msg.frame !== front.name) return;
    if (msg.type === 'close') popup.close();
    else if (msg.type === 'player') page.syncPlayer(msg.player);
    else if (msg.type === 'queue') page.syncQueue(msg.queue);
    else if (msg.type === 'download') S.download(msg.name, msg.size);
  });

  /* the YouTube-like page */

  const page = createPage(S, pageEl);
  S.page = page;
  clock.ticks.add(() => page.tick());

  /* the desktop alert */

  let note = null;
  S.notify = async ({ title, body, buttons = [] }) => {
    note?.remove();
    note = h('div', { class: 'ntf' },
      h('div', { class: 'ntf__app' }, h('img', { src: 'app/icons/icon32.png', alt: '', width: 16, height: 16 }), h('span', {}, 'Companion for YouTube'), icon('more', 'ntf__more'), icon('close', 'ntf__x')),
      h('div', { class: 'ntf__main' },
        h('img', { class: 'ntf__icon', src: 'app/icons/icon128.png', alt: '', width: 48, height: 48 }),
        h('div', {}, h('div', { class: 'ntf__title' }, title), h('div', { class: 'ntf__body' }, body))),
      h('div', { class: 'ntf__btns' }, buttons.map((label) => h('span', { class: 'ntf__btn' }, label))));
    layer.append(note);
    await clock.tween(REDUCED ? 0 : 420, (k) => {
      note.style.transform = `translateX(${(1 - k) * 400}px)`;
      note.style.opacity = String(Math.min(1, k * 2));
    }, easeOut);
  };
  S.notifyButton = (i) => note?.querySelectorAll('.ntf__btn')[i] || null;
  S.unnotify = async () => {
    const el = note;
    if (!el) return;
    note = null;
    await clock.tween(REDUCED ? 0 : 300, (k) => {
      el.style.transform = `translateX(${k * 400}px)`;
      el.style.opacity = String(1 - k);
    }, easeInOut);
    el.remove();
  };

  /* the download bubble Export leaves */

  let bubble = null;
  S.download = (name, size) => {
    bubble?.remove();
    dlBtn.hidden = false;
    const kb = size ? `${Math.max(1, Math.round(size / 1024))} KB · ` : '';
    bubble = h('div', { class: 'dlb' },
      h('div', { class: 'dlb__head' }, 'Recent downloads'),
      h('div', { class: 'dlb__row' }, h('span', { class: 'dlb__file', html: ICON.file }),
        h('div', {}, h('div', { class: 'dlb__name' }, name || 'youtube-companion.json'), h('div', { class: 'dlb__meta' }, `${kb}Done`))));
    layer.append(bubble);
    clock.tween(REDUCED ? 0 : 200, (k) => {
      bubble.style.opacity = String(k);
      bubble.style.transform = `translateY(${(1 - k) * -6}px)`;
    }, easeOut);
  };

  /* full-stage cards */

  let card = null;
  S.card = (chapter, index) => {
    card?.remove();
    card = h('div', { class: 'card-in' },
      h('img', { src: 'app/icons/icon128.png', alt: '', width: 72, height: 72 }),
      h('div', { class: 'card-in__k' }, `Chapter ${index + 1} of ${CHAPTERS.length}`),
      h('div', { class: 'card-in__t' }, chapter.title));
    over.append(card);
  };
  S.uncard = async () => {
    const el = card;
    card = null;
    if (!el) return;
    await clock.tween(300, (k) => { el.style.opacity = String(1 - k); }, linear);
    el.remove();
  };

  let outro = null;
  S.outro = async () => {
    outro?.remove();
    outro = h('div', { class: 'outro' },
      h('img', { src: 'app/icons/icon128.png', alt: '', width: 112, height: 112 }),
      h('div', { class: 'outro__name' }, 'Companion for YouTube'),
      h('div', { class: 'outro__line' }, 'Free · No account · Nothing leaves your device'),
      h('div', { class: 'outro__stores' }, h('span', { class: 'outro__store' }, 'Chrome Web Store'), h('span', { class: 'outro__store' }, 'Microsoft Edge Add-ons')));
    over.append(outro);
    await clock.tween(REDUCED ? 0 : 700, (k) => {
      outro.style.opacity = String(k);
      outro.style.transform = `scale(${0.97 + 0.03 * k})`;
    }, easeOut);
  };

  const recCap = h('div', { class: 'reccap', hidden: true }, h('div', { class: 'reccap__t' }), h('div', { class: 'reccap__p' }));
  stage.append(recCap);
  S.recordCaption = (step) => {
    recCap.hidden = false;
    recCap.firstChild.textContent = step.title;
    recCap.lastChild.textContent = step.caption;
  };

  // Everything a step may have left on the stage that its setup does not
  // put back. The page, the popup and the cursor are each setup's to say.
  S.reset = () => {
    spot.style.opacity = '0';
    layer.querySelectorAll('.ripple').forEach((el) => el.remove());
    note?.remove();
    note = null;
    bubble?.remove();
    bubble = null;
    dlBtn.hidden = true;
    outro?.remove();
    outro = null;
    cursorEl.classList.remove('is-down');
    S.badge('');
  };

  return S;
}

/* ---- the page mocks ---------------------------------------------------- */

function createPage(S, el) {
  const state = { kind: '', v: '', t: 0, at: 0, paused: true, rate: 1, duration: 0, audio: false, queue: [], queuePanel: false };
  let parts = {};

  const header = () => h('div', { class: 'yt-head' },
    icon('menu', 'yt-head__menu'),
    h('div', { class: 'yt-search' }, h('span', { class: 'yt-search__box' }, 'Search'), h('span', { class: 'yt-search__btn' }, icon('search'))),
    h('span', { class: 'yt-head__me' }));

  function videoInfo(v) {
    const row = videoOf(v);
    const ch = row ? channelOf(row.c) : null;
    return { v, title: row?.t || '', channel: ch?.title || '', avatar: ch?.avatar || '', views: row?.vw || 0, at: row?.at || 0, duration: row?.d || 0 };
  }

  function related() {
    return demo().feed.filter((row) => row.k === 'video' && row.v !== state.v).slice(0, 6).map((row) => {
      const ch = channelOf(row.c);
      return h('div', { class: 'yt-rel' },
        h('img', { class: 'yt-rel__img', src: thumb(row.v, 'mq'), alt: '' }),
        h('div', {}, h('div', { class: 'yt-rel__t' }, row.t), h('div', { class: 'yt-rel__m' }, ch?.title || ''), h('div', { class: 'yt-rel__m' }, `${viewsText(row.vw)} · ${agoText(row.at)}`)));
    });
  }

  const page = {
    $(sel) {
      return el.querySelector(sel);
    },

    watch({ v, t = 0, paused = true, audio = false, queuePanel = false } = {}) {
      const info = videoInfo(v);
      Object.assign(state, { kind: 'watch', v, t, at: S.clock.now, paused, audio, rate: 1, duration: info.duration, queuePanel });
      const time = h('span', { class: 'yt-ctl__time' });
      const fill = h('i', { class: 'yt-bar__fill' });
      const playIc = h('span', { class: 'yt-ctl__play' });
      const quality = h('span', { class: 'yt-quality', hidden: true }, '144p');
      const shot = h('img', { class: 'yt-player__img', src: thumb(v), alt: '' });
      const cover = h('div', { class: 'yt-audio', hidden: true },
        icon('headphones', 'yt-audio__ic'), h('p', { class: 'yt-audio__t' }, 'Audio-only playback'), h('span', { class: 'yt-audio__exit' }, 'Exit audio mode'));
      const title = h('h1', { class: 'yt-title' }, info.title);
      const avatar = h('img', { class: 'yt-owner__img', src: info.avatar, alt: '' });
      const owner = h('div', { class: 'yt-owner__name' }, info.channel);
      const facts = h('div', { class: 'yt-owner__facts' }, info.views ? `${viewsText(info.views)} · ${agoText(info.at)}` : '');
      const queueBox = h('div', { class: 'yt-queue', hidden: !queuePanel },
        h('div', { class: 'yt-queue__head' }, h('div', { class: 'yt-queue__t' }, 'Queue'), h('div', { class: 'yt-queue__n' })),
        h('div', { class: 'yt-queue__list' }));
      el.replaceChildren(header(), h('div', { class: `yt-watch${queuePanel ? ' has-queue' : ''}` },
        h('div', { class: 'yt-main' },
          h('div', { class: 'yt-player' }, shot, cover,
            h('div', { class: 'yt-ctl' },
              h('div', { class: 'yt-bar' }, fill),
              h('div', { class: 'yt-ctl__row' }, playIc, icon('next'), icon('volume'), time, h('span', { class: 'yt-ctl__gap' }), quality, icon('gear'), icon('full')))),
          title,
          h('div', { class: 'yt-owner' }, avatar, h('div', {}, owner, facts))),
        h('div', { class: 'yt-side' }, queueBox, h('div', { class: 'yt-side__rel' }, related()))));
      parts = { time, fill, playIc, quality, shot, cover, title, avatar, owner, facts, queueBox };
      S.address(`https://www.youtube.com/watch?v=${v}`, `${info.title} - YouTube`);
      page.paint();
    },

    syncPlayer(p) {
      if (state.kind !== 'watch' || !p || !p.ok) return;
      if (p.videoId && p.videoId !== state.v) {
        const info = videoInfo(p.videoId);
        state.v = p.videoId;
        parts.shot.src = thumb(p.videoId);
        parts.title.textContent = p.title || info.title;
        parts.owner.textContent = p.channel || info.channel;
        parts.facts.textContent = info.views ? `${viewsText(info.views)} · ${agoText(info.at)}` : '';
        const ch = demo().channels.find((c) => c.title === p.channel);
        if (ch) parts.avatar.src = ch.avatar;
        S.address(`https://www.youtube.com/watch?v=${p.videoId}`, `${p.title || info.title} - YouTube`);
        page.syncQueue(state.queue);
      }
      Object.assign(state, {
        t: Number(p.currentTime) || 0, at: S.clock.now, paused: p.paused !== false,
        rate: Number(p.playbackRate) || 1, duration: Number(p.duration) || state.duration, audio: !!p.on,
      });
      page.paint();
    },

    // YouTube's queue panel: the playing video, then Up next.
    syncQueue(queue) {
      state.queue = Array.isArray(queue) ? queue.slice() : [];
      if (state.kind !== 'watch' || !parts.queueBox) return;
      const info = videoInfo(state.v);
      const rows = [{ v: state.v, t: parts.title.textContent || info.title, ct: parts.owner.textContent }, ...state.queue.filter((q) => q.v !== state.v)];
      const list = parts.queueBox.querySelector('.yt-queue__list');
      const before = [...list.children].map((row) => row.dataset.v);
      const samePlaying = before[0] === state.v;
      list.replaceChildren(...rows.map((row, i) => h('div', { class: `yt-q${i === 0 ? ' is-playing' : ''}`, 'data-v': row.v },
        h('span', { class: 'yt-q__n' }, i === 0 ? '▸' : String(i + 1)),
        h('img', { class: 'yt-q__img', src: thumb(row.v, 'mq'), alt: '' }),
        h('div', { class: 'yt-q__text' }, h('div', { class: 'yt-q__t' }, row.t), h('div', { class: 'yt-q__c' }, row.ct || '')))));
      parts.queueBox.querySelector('.yt-queue__n').textContent = `1 / ${rows.length}`;
      // A row that moved or arrived flashes, so the mirror reads at a glance.
      [...list.children].forEach((row, i) => {
        if (samePlaying && i > 0 && before[i] !== row.dataset.v) {
          S.clock.tween(REDUCED ? 0 : 1200, (k) => { row.style.backgroundColor = `rgba(109, 74, 232, ${0.22 * (1 - k)})`; }, linear);
        }
      });
    },

    now() {
      const t = state.paused ? state.t : state.t + ((S.clock.now - state.at) / 1000) * state.rate;
      return state.duration ? Math.min(state.duration, t) : t;
    },

    paint() {
      if (state.kind !== 'watch') return;
      parts.playIc.innerHTML = state.paused ? ICON.play : ICON.pause;
      parts.cover.hidden = !state.audio;
      parts.quality.hidden = !state.audio;
      page.tick();
    },

    tick() {
      if (state.kind !== 'watch' || !parts.time) return;
      const t = page.now();
      parts.time.textContent = `${clockText(t)} / ${clockText(state.duration)}`;
      parts.fill.style.width = `${state.duration ? (100 * t) / state.duration : 0}%`;
    },

    subs() {
      state.kind = 'subs';
      const groups = [...new Set(demo().channels.flatMap((ch) => ch.groups || []))].sort();
      const chips = h('div', { class: 'ytc-chips', role: 'group' },
        ['', ...groups].map((name) => h('span', { class: 'ytc-chip', 'data-group': name, 'aria-pressed': name ? 'false' : 'true', onclick: () => page.subsChoose(name) }, name || 'All')));
      const cards = demo().feed.filter((row) => row.k === 'video').slice(0, 8).map((row) => {
        const ch = channelOf(row.c);
        return h('div', { class: 'yt-card', 'data-groups': (ch?.groups || []).join('|') },
          h('img', { class: 'yt-card__img', src: thumb(row.v, 'mq'), alt: '' }),
          h('div', { class: 'yt-card__body' }, h('img', { class: 'yt-card__av', src: ch?.avatar || '', alt: '' }),
            h('div', {}, h('div', { class: 'yt-card__t' }, row.t), h('div', { class: 'yt-card__m' }, ch?.title || ''), h('div', { class: 'yt-card__m' }, `${viewsText(row.vw)} · ${agoText(row.at)}`))));
      });
      el.replaceChildren(header(), h('div', { class: 'yt-subs' },
        h('div', { class: 'yt-subs__head' }, h('h2', {}, 'Latest'), h('span', { class: 'yt-subs__manage' }, 'Manage')),
        chips, h('div', { class: 'yt-grid' }, cards)));
      parts = {};
      S.address('https://www.youtube.com/feed/subscriptions', 'Subscriptions - YouTube');
    },

    subsChoose(name) {
      el.querySelectorAll('.ytc-chip').forEach((chip) => chip.setAttribute('aria-pressed', chip.dataset.group === name ? 'true' : 'false'));
      el.querySelectorAll('.yt-card').forEach((card) => {
        card.hidden = !!name && !card.dataset.groups.split('|').includes(name);
      });
    },

    // The extension's own scan screen over /feed/channels.
    scan(stateName, data = {}) {
      state.kind = 'scan';
      parts = {};
      let body;
      if (stateName === 'pick') {
        body = [
          h('h2', { class: 'scan__title' }, 'Choose an account'),
          h('div', { class: 'scan__picker' }, (data.accounts || []).map((acc, i) => h('div', { class: 'scan__row', 'data-account': String(i) },
            h('span', { class: 'scan__av', style: `background:${acc.color}` }, acc.name[0]),
            h('div', { class: 'scan__rowtext' }, h('div', { class: 'scan__name' }, acc.name), h('div', { class: 'scan__detail' }, `${acc.count} channels`)),
            h('span', { class: 'scan__btn' }, 'Scan')))),
        ];
      } else if (stateName === 'scanning') {
        parts.count = h('span', { class: 'scan__num' }, '0');
        body = [
          h('span', { class: 'scan__spin' }),
          h('h2', { class: 'scan__title' }, 'Scanning your channels'),
          h('p', { class: 'scan__sub' }, 'Do not close this tab'),
          h('div', { class: 'scan__count' }, parts.count, h('span', { class: 'scan__sub' }, 'channels found')),
        ];
      } else {
        body = [
          h('h2', { class: 'scan__title' }, `Added ${data.added} channels`),
          h('p', { class: 'scan__sub' }, `${data.skipped} were already on your list`),
          h('span', { class: 'scan__done' }, 'Done'),
        ];
      }
      el.replaceChildren(h('div', { class: 'scan' }, body));
    },

    scanCount(n) {
      if (parts.count) parts.count.textContent = String(n);
    },
  };
  return page;
}

/* ---- the page around the stage ---------------------------------------- */

const views = {
  landing: document.getElementById('landing'),
  watch: document.getElementById('watch'),
  read: document.getElementById('doc-view'),
};

let stage = null;
const ui = {};

function setView(name) {
  for (const [key, el] of Object.entries(views)) el.hidden = key !== name;
  document.getElementById('v-watch').setAttribute('aria-pressed', String(name !== 'read'));
  document.getElementById('v-read').setAttribute('aria-pressed', String(name === 'read'));
  if (name !== 'watch' && player.playing) player.pause();
  if (name === 'watch') fit();
  window.scrollTo(0, 0);
}

function renderLanding() {
  const hero = h('section', { class: 'hero' },
    h('div', {},
      h('div', { class: 'eyebrow' }, `Product tour · ${msText(totalMs())}`),
      h('h1', {}, 'Your YouTube channels, without an account'),
      h('p', {}, 'Seven short chapters show Companion for YouTube at work: following channels, the merged feed, alerts, audio mode, Up next, YouTube’s own Subscriptions page and your settings. Watch it play, or read it as a page.'),
      h('div', { class: 'ctas' },
        h('button', { type: 'button', class: 'btn btn--pri', onclick: () => start(0, 0, true) }, '▶ Play the tour'),
        h('button', { type: 'button', class: 'btn', onclick: () => showRead() }, '☰ Read it instead'))),
    h('div', { class: 'hero__fig' }, h('img', { src: '../images/home-feeds.png', width: 400, height: 600, alt: 'The Feeds tab of the popup, with new videos from every followed channel in one list.' })));
  const cards = h('div', { class: 'cards' }, CHAPTERS.map((ch, i) => h('button', { type: 'button', class: 'ccard', onclick: () => start(i, 0, true) },
    h('div', { class: 'ccard__thumb' }, h('span', { class: 'ccard__n' }, String(i + 1)), h('span', { class: 'ccard__play', 'aria-hidden': 'true', html: ICON.play })),
    h('div', { class: 'ccard__body' },
      h('div', { class: 'ccard__meta' }, h('span', {}, `Chapter ${i + 1}`), h('span', {}, `${msText(chapterMs(ch))} · ${ch.steps.length} step${ch.steps.length === 1 ? '' : 's'}`)),
      h('h3', {}, ch.title),
      h('p', {}, ch.blurb)))));
  views.landing.replaceChildren(hero, h('section', { class: 'part' }, h('h2', { class: 'part__h' }, 'Chapters'), cards),
    h('footer', { class: 'foot' }, 'Companion for YouTube is not affiliated with, endorsed by or sponsored by YouTube or Google. YouTube is a trademark of Google LLC.'));
}

function renderRead() {
  const parts = CHAPTERS.map((ch, i) => h('section', { class: 'doc__ch', id: `read-${i + 1}` },
    h('div', { class: 'doc__head' },
      h('h2', {}, h('span', { class: 'doc__n' }, `${i + 1}`), ch.title),
      h('button', { type: 'button', class: 'btn btn--sm', onclick: () => start(i, 0, true) }, `▶ Watch · ${msText(chapterMs(ch))}`)),
    h('div', { class: `doc__body${ch.image ? ' has-img' : ''}` },
      h('ol', { class: 'doc__steps' }, ch.steps.map((step) => h('li', {}, h('h3', {}, step.title), h('p', {}, step.caption)))),
      ch.image ? h('img', { class: 'doc__img', src: ch.image.src, alt: ch.image.alt, width: 400, height: 600, loading: 'lazy' }) : null)));
  views.read.replaceChildren(h('div', { class: 'doc' },
    h('h1', {}, 'Companion for YouTube — a 3-minute tour'),
    h('p', { class: 'doc__lede' }, 'The same tour as text: every chapter and every step, in the order the video plays them.'),
    parts));
}

function renderWatch() {
  const rail = h('nav', { class: 'rail', 'aria-label': 'Chapters' });
  const crumbN = h('span', { class: 'crumb__n' });
  const heading = h('h1', {});
  const wrap = h('div', { class: 'stagewrap', role: 'img' });
  const prog = h('div', { class: 'prog', role: 'tablist', 'aria-label': 'Steps' });
  const stepNo = h('div', { class: 'stepno' });
  const capTitle = h('h2', {});
  const capText = h('p', {});
  const btn = (p, label, text, cls = '') => h('button', { type: 'button', class: `cb ${cls}`.trim(), 'data-p': p, 'aria-label': label, title: label }, text);
  const prev = btn('prev', 'Previous step', '‹');
  const play = btn('play', 'Play', '▶ Play', 'cb--pri');
  const next = btn('next', 'Next step', '›');
  const speed = btn('speed', 'Playback speed', '1×', 'cb--sp');
  const full = btn('full', 'Full screen', '', 'cb--full');
  full.innerHTML = ICON.full;
  const main = h('section', { class: 'main' },
    h('div', { class: 'phead' },
      h('div', {}, h('div', { class: 'crumb' }, h('button', { type: 'button', class: 'btn btn--sm', 'data-p': 'home' }, '← All chapters'), crumbN), heading),
      h('button', { type: 'button', class: 'btn btn--sm', 'data-p': 'read' }, '☰ Read this chapter')),
    wrap, prog,
    h('div', { class: 'cap' },
      h('div', { class: 'capt', 'aria-live': 'polite' }, stepNo, capTitle, capText),
      h('div', { class: 'ctlw' }, h('div', { class: 'ctl' }, prev, play, next, speed, full),
        h('div', { class: 'kh' }, h('kbd', {}, 'Space'), ' play / pause · ', h('kbd', {}, '←'), h('kbd', {}, '→'), ' steps · ', h('kbd', {}, 'F'), ' full screen'))));
  views.watch.replaceChildren(h('div', { class: 'player' }, rail, main));
  Object.assign(ui, { rail, crumbN, heading, wrap, prog, stepNo, capTitle, capText, prev, play, next, speed, full, main });

  rail.append(...CHAPTERS.map((ch, i) => h('button', { type: 'button', class: 'ritem', 'data-ch': String(i), onclick: () => player.go(i, 0, { play: true }) },
    h('span', { class: 'ritem__ic' }, String(i + 1)), h('span', { class: 'ritem__nm' }, ch.title), h('span', { class: 'ritem__d' }, msText(chapterMs(ch))))));

  main.addEventListener('click', (event) => {
    const p = event.target.closest('[data-p]')?.dataset.p;
    if (p === 'home') showLanding();
    else if (p === 'read') showRead(player.ci);
    else if (p === 'prev') player.step(-1);
    else if (p === 'next') player.step(1);
    else if (p === 'play') player.toggle();
    else if (p === 'speed') cycleSpeed();
    else if (p === 'full') toggleFull();
  });
  prog.addEventListener('click', (event) => {
    const seg = event.target.closest('[data-seg]');
    if (seg) player.go(player.ci, Number(seg.dataset.seg), { play: player.playing });
  });

  stage = createStage(wrap);
  new ResizeObserver(fit).observe(wrap);
  document.addEventListener('fullscreenchange', () => {
    main.classList.toggle('theater', document.fullscreenElement === main);
    fit();
  });
}

function fit() {
  if (!stage) return;
  if (RECORD) {
    const s = Math.min(innerWidth / W, innerHeight / H);
    ui.wrap.style.width = `${W * s}px`;
    ui.wrap.style.height = `${H * s}px`;
    stage.fit(s);
    return;
  }
  if (!ui.wrap.clientWidth) return;
  const theater = ui.main.classList.contains('theater');
  ui.wrap.style.width = theater ? `${Math.max(320, Math.min(ui.main.clientWidth - 48, (innerHeight - 200) * (W / H)))}px` : '';
  const s = ui.wrap.clientWidth / W;
  ui.wrap.style.height = `${Math.round(H * s)}px`;
  stage.fit(s);
}

function showStep(ci, si) {
  const ch = CHAPTERS[ci];
  const step = ch.steps[si];
  ui.crumbN.textContent = `Chapter ${ci + 1} of ${CHAPTERS.length} · ${msText(chapterMs(ch))}`;
  ui.heading.textContent = ch.title;
  ui.wrap.setAttribute('aria-label', `Animated walkthrough of “${ch.title}”. The caption under it describes each step.`);
  ui.stepNo.textContent = `Step ${si + 1} of ${ch.steps.length}`;
  ui.capTitle.textContent = step.title;
  ui.capText.textContent = step.caption;
  const keepFocus = ui.prog.contains(document.activeElement);
  ui.prog.replaceChildren(...ch.steps.map((s, j) => h('button', {
    type: 'button', class: `seg${j < si ? ' done' : ''}`, role: 'tab', 'data-seg': String(j),
    'aria-selected': String(j === si), tabindex: j === si ? '0' : '-1', 'aria-label': `Step ${j + 1}: ${s.title}`,
  }, h('span', {}, h('i', {})))));
  if (keepFocus) ui.prog.querySelector('[aria-selected="true"]')?.focus();
  ui.rail.querySelectorAll('.ritem').forEach((item, i) => {
    item.classList.toggle('on', i === ci);
    item.classList.toggle('done', i < ci);
    if (i === ci) item.setAttribute('aria-current', 'true');
    else item.removeAttribute('aria-current');
  });
  ui.prev.disabled = ci === 0 && si === 0;
  ui.next.disabled = ci === CHAPTERS.length - 1 && si === ch.steps.length - 1;
  if (RECORD) stage.recordCaption(step);
  else history.replaceState(null, '', `#${ci + 1}-${si + 1}`);
}

function setFill(k) {
  const bar = ui.prog?.querySelectorAll('.seg i')[player.si];
  if (bar) bar.style.width = `${clamp(k, 0, 1) * 100}%`;
}

function playLabel() {
  const ended = player.phase === 'done';
  ui.play.textContent = ended ? '↻ Replay' : player.playing ? '❚❚ Pause' : '▶ Play';
  ui.play.setAttribute('aria-label', ended ? 'Replay' : player.playing ? 'Pause' : 'Play');
}

/* ---- the player -------------------------------------------------------- */

const player = {
  ci: 0,
  si: 0,
  playing: false,
  phase: 'idle',
  stepStart: 0,

  async go(ci, si, { play }) {
    clock.reset();
    const epoch = clock.epoch;
    const ch = CHAPTERS[ci];
    const step = ch.steps[si];
    Object.assign(this, { ci, si, playing: play, phase: 'setup' });
    clock.paused = !play;
    showStep(ci, si);
    setFill(0);
    playLabel();
    stage.reset();
    const withCard = RECORD && si === 0;
    if (withCard) stage.card(ch, ci);
    clock.instant = true;
    try {
      await step.setup(stage);
    } catch (err) {
      console.error(err);
    }
    if (epoch !== clock.epoch) return;
    clock.instant = !play;
    if (withCard) {
      await clock.wait(CARD_MS);
      await stage.uncard();
    }
    this.phase = 'run';
    this.stepStart = clock.now;
    try {
      await step.run(stage);
    } catch (err) {
      console.error(err);
    }
    if (epoch !== clock.epoch) return;
    clock.instant = false;
    if (!play) {
      this.phase = 'end';
      setFill(1);
      return;
    }
    this.phase = 'hold';
    await clock.wait(Math.max(0, step.ms - (clock.now - this.stepStart)));
    if (epoch !== clock.epoch) return;
    const next = neighbour(ci, si, 1);
    if (next) {
      this.go(next[0], next[1], { play: true });
      return;
    }
    this.phase = 'done';
    this.playing = false;
    clock.paused = true;
    setFill(1);
    playLabel();
    if (RECORD) window.__tourDone = true;
  },

  toggle() {
    if (this.phase === 'done') return this.go(0, 0, { play: true });
    if (this.phase === 'end' || this.phase === 'idle') return this.go(this.ci, this.si, { play: true });
    this.playing = !this.playing;
    clock.paused = !this.playing;
    playLabel();
    return undefined;
  },

  pause() {
    this.playing = false;
    clock.paused = true;
    playLabel();
  },

  step(dir) {
    const to = neighbour(this.ci, this.si, dir);
    if (to) this.go(to[0], to[1], { play: this.playing });
  },
};

function neighbour(ci, si, dir) {
  const flat = CHAPTERS.flatMap((ch, i) => ch.steps.map((_, j) => [i, j]));
  const at = flat.findIndex(([i, j]) => i === ci && j === si);
  return flat[at + dir] || null;
}

clock.ticks.add(() => {
  if (player.phase === 'run' || player.phase === 'hold') {
    setFill((clock.now - player.stepStart) / CHAPTERS[player.ci].steps[player.si].ms);
  }
});

function cycleSpeed() {
  const next = SPEEDS[(SPEEDS.indexOf(clock.speed) + 1) % SPEEDS.length];
  setSpeed(next);
  try {
    localStorage.setItem('tour.speed', String(next));
  } catch {
    // the speed then resets on the next visit
  }
}

function setSpeed(value) {
  clock.speed = SPEEDS.includes(value) ? value : 1;
  ui.speed.textContent = `${clock.speed}×`;
  ui.speed.setAttribute('aria-label', `Playback speed ${clock.speed}×`);
}

function toggleFull() {
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  else ui.main.requestFullscreen?.().catch(() => {});
}

/* ---- routes ------------------------------------------------------------ */

function start(ci, si, play) {
  setView('watch');
  player.go(ci, si, { play });
}

function showLanding() {
  setView('landing');
  history.replaceState(null, '', location.pathname + location.search);
}

function showRead(ci) {
  setView('read');
  history.replaceState(null, '', '#read');
  if (ci != null) document.getElementById(`read-${ci + 1}`)?.scrollIntoView();
}

function route() {
  const m = location.hash.match(/^#(\d+)-(\d+)$/);
  if (m) {
    const ci = clamp(Number(m[1]) - 1, 0, CHAPTERS.length - 1);
    const si = clamp(Number(m[2]) - 1, 0, CHAPTERS[ci].steps.length - 1);
    if (player.ci === ci && player.si === si && player.phase !== 'idle' && !views.watch.hidden) return;
    start(ci, si, false);
  } else if (location.hash === '#read') {
    setView('read');
  } else {
    setView('landing');
  }
}

document.addEventListener('keydown', (event) => {
  if (views.watch.hidden || event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.target.closest?.('input, textarea, select, [contenteditable]')) return;
  // A focused button already answers Space with its own click.
  if (event.key === ' ' && event.target.closest?.('button, a')) return;
  if (event.key === ' ') player.toggle();
  else if (event.key === 'ArrowLeft') player.step(-1);
  else if (event.key === 'ArrowRight') player.step(1);
  else if (event.key === 'f' || event.key === 'F') toggleFull();
  else return;
  event.preventDefault();
});

/* ---- boot -------------------------------------------------------------- */

document.getElementById('total').textContent = `${msText(totalMs())} total`;
document.getElementById('home').addEventListener('click', showLanding);
document.getElementById('v-watch').addEventListener('click', () => (player.phase === 'idle' ? setView('landing') : setView('watch')));
document.getElementById('v-read').addEventListener('click', () => showRead());
window.addEventListener('hashchange', route);
window.addEventListener('resize', fit);

renderLanding();
renderRead();
renderWatch();
try {
  setSpeed(Number(localStorage.getItem('tour.speed')) || 1);
} catch {
  setSpeed(1);
}
requestAnimationFrame(frame);

// The chapter card covers the caption, so a recording skips that stretch.
function tourNow() {
  const step = CHAPTERS[player.ci]?.steps[player.si];
  const card = RECORD && player.si === 0 && player.phase === 'setup';
  return {
    chapter: player.ci,
    step: player.si,
    title: card || !step ? '' : step.title,
    caption: card || !step ? '' : step.caption,
  };
}

window.__tour = { clock, player, stage, chapters: CHAPTERS, now: tourNow };

if (RECORD) {
  document.body.classList.add('record');
  setSpeed(1);
  start(0, 0, true);
} else {
  route();
}
