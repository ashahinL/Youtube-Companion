/**
 * Group chips on YouTube's subscriptions page. Loads the classic content
 * script in node:vm the way Chrome will, against a fake DOM. No network.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import {
  fold,
  normalizeGroupName,
  groupNamesInList,
  channelInGroup,
  resolvedFeedGroup,
  handleKey,
} from '../src/lib/view.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const coreSrc = read('src/content/core.js');
const contentSrc = read('src/content/content.js');
const overlayCss = read('src/content/overlay.css');

function relink(parent) {
  const kids = parent.childNodes;
  for (let i = 0; i < kids.length; i++) kids[i].nextSibling = kids[i + 1] || null;
}

function createEl(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: '',
    textContent: '',
    type: '',
    parentNode: null,
    nextSibling: null,
    style: {},
    attrs: {},
    _classes: new Set(),
    childNodes: [],
    listeners: [],
  };
  node.classList = {
    contains(name) { return node._classes.has(name); },
    add(name) { node._classes.add(name); },
    remove(name) { node._classes.delete(name); },
  };
  Object.defineProperty(node, 'className', {
    get() { return [...node._classes].join(' '); },
    set(value) {
      node._classes = new Set(String(value || '').split(/\s+/).filter(Boolean));
    },
  });
  Object.defineProperty(node, 'children', {
    get() { return node.childNodes.filter((child) => child.nodeType === 1); },
  });
  Object.defineProperty(node, 'firstChild', {
    get() { return node.childNodes[0] || null; },
  });
  Object.defineProperty(node, 'lastChild', {
    get() { return node.childNodes[node.childNodes.length - 1] || null; },
  });
  Object.defineProperty(node, 'offsetHeight', {
    get() {
      const n = parseFloat(node.style.height);
      return Number.isFinite(n) ? n : 0;
    },
  });
  node.setAttribute = function (name, value) {
    node.attrs[name] = String(value);
    if (name === 'id') node.id = String(value);
  };
  node.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(node.attrs, name) ? node.attrs[name] : null;
  };
  node.removeAttribute = function (name) { delete node.attrs[name]; };
  node.addEventListener = function (type, fn) { node.listeners.push({ type, fn }); };
  node.insertBefore = function (child, before) {
    if (child.parentNode && typeof child.parentNode.removeChild === 'function') {
      child.parentNode.removeChild(child);
    }
    child.parentNode = node;
    const index = before ? node.childNodes.indexOf(before) : -1;
    if (index < 0) node.childNodes.push(child);
    else node.childNodes.splice(index, 0, child);
    relink(node);
    return child;
  };
  node.appendChild = function (child) { return node.insertBefore(child, null); };
  node.removeChild = function (child) {
    const index = node.childNodes.indexOf(child);
    if (index >= 0) node.childNodes.splice(index, 1);
    if (child.parentNode === node) child.parentNode = null;
    relink(node);
    return child;
  };
  node.querySelector = function () { return null; };
  return node;
}

function section(label) {
  const el = createEl('ytd-rich-section-renderer');
  el.textContent = label;
  return el;
}

function continuation() {
  return createEl('ytd-continuation-item-renderer');
}

function card(opts) {
  const el = createEl('ytd-rich-item-renderer');
  const href = opts && opts.href ? opts.href : '';
  const text = opts && opts.text != null ? opts.text : '';
  const metaText = opts && opts.metaText != null ? opts.metaText : text;
  const link = {
    nodeType: 1,
    tagName: 'A',
    textContent: text,
    getAttribute(name) { return name === 'href' ? href : null; },
  };
  const meta = {
    nodeType: 1,
    tagName: 'A',
    textContent: metaText,
    getAttribute(name) { return name === 'href' ? href : null; },
  };
  el.querySelector = function (sel) {
    if (!href) return null;
    if (sel === 'yt-content-metadata-view-model a[href^="/@"]') return meta;
    if (sel === 'a[href^="/@"]') return link;
    return null;
  };
  return el;
}

function hidden(el) {
  return !!(el && el.classList && el.classList.contains('ytc-subs-hidden'));
}

const enPack = {
  subsGroupsAll: 'All',
  subsGroupsLabel: 'Groups',
  subsGroupsMatch: '$1 of the loaded videos match this group. Scroll to load more.',
  subsGroupsMatchOne: '$1 of the loaded videos matches this group. Scroll to load more.',
};
const arPack = {
  subsGroupsAll: 'الكل',
  subsGroupsLabel: 'المجموعات',
  subsGroupsMatch: 'من الفيديوهات المحمّلة، $1 في هذه المجموعة. مرّر لتحميل المزيد.',
  subsGroupsMatchOne: 'من الفيديوهات المحمّلة، $1 في هذه المجموعة. مرّر لتحميل المزيد.',
};

function partMatches(el, part) {
  const match = /^([a-z0-9-]+)(?:\[([a-z0-9-]+)="([^"]*)"\])?$/i.exec(part);
  if (!match || !el || el.nodeType !== 1) return false;
  if (String(el.tagName).toUpperCase() !== match[1].toUpperCase()) return false;
  if (match[2] && el.getAttribute(match[2]) !== match[3]) return false;
  return true;
}

function queryDescendant(root, selector) {
  const parts = String(selector || '').trim().split(/\s+/).filter(Boolean);
  function collect(node, part, out) {
    const kids = node.childNodes || [];
    for (let i = 0; i < kids.length; i++) {
      const child = kids[i];
      if (!child || child.nodeType !== 1) continue;
      if (partMatches(child, part)) out.push(child);
      collect(child, part, out);
    }
  }
  let roots = [root];
  for (let i = 0; i < parts.length; i++) {
    const next = [];
    for (let r = 0; r < roots.length; r++) collect(roots[r], parts[i], next);
    if (!next.length) return null;
    if (i === parts.length - 1) return next[0];
    roots = next;
  }
  return null;
}

function makeBrowse(subtype, hidden) {
  const browse = createEl('ytd-browse');
  browse.setAttribute('page-subtype', subtype);
  if (hidden) browse.setAttribute('hidden', '');
  const grid = createEl('ytd-rich-grid-renderer');
  const contents = createEl('div');
  contents.id = 'contents';
  grid.appendChild(contents);
  browse.appendChild(grid);
  return { browse, grid, contents };
}

function loadApi() {
  const sandbox = { __ytcHarness: true, URL };
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'src/content/core.js' });
  vm.runInContext(contentSrc, sandbox, { filename: 'src/content/content.js' });
  return sandbox.AudioModeContent;
}

function loadPage(store, opts) {
  const built = [];
  const observed = [];
  const winListeners = [];
  function FakeMO(cb) {
    this.cb = cb;
    built.push(this);
    this.observe = (target, options) => {
      this.target = target;
      this.options = options;
      observed.push(this);
    };
    this.disconnect = () => { this.disconnected = true; };
  }
  const docListeners = [];
  const home = makeBrowse('home', true);
  const subs = makeBrowse('subscriptions', false);
  const body = createEl('body');
  body.appendChild(home.browse);
  body.appendChild(subs.browse);
  const contents = subs.contents;
  const grid = subs.grid;
  const doc = {
    documentElement: createEl('html'),
    body,
    scrollingElement: { scrollHeight: opts && opts.scrollHeight != null ? opts.scrollHeight : 400 },
    createElement: createEl,
    addEventListener(type, fn) { docListeners.push({ type, fn }); },
    getElementById(id) {
      const walk = (node) => {
        if (!node) return null;
        if (node.id === id) return node;
        const kids = node.childNodes || [];
        for (let i = 0; i < kids.length; i++) {
          const found = walk(kids[i]);
          if (found) return found;
        }
        return null;
      };
      return walk(doc.body);
    },
    querySelector(sel) {
      return queryDescendant(body, sel);
    },
  };
  const sandbox = {
    __ytcHarness: true,
    URL,
    innerHeight: opts && opts.innerHeight != null ? opts.innerHeight : 800,
    location: { pathname: (opts && opts.path) || '/feed/subscriptions' },
    navigator: { language: (opts && opts.language) || 'en-US' },
    document: doc,
    MutationObserver: FakeMO,
    chrome: {
      storage: {
        local: {
          get() {
            return Promise.resolve({
              channels: store.channels || [],
              settings: store.settings || null,
              subsPageGroup: store.subsPageGroup || '',
            });
          },
          set(items) {
            store.writes.push(items);
            Object.assign(store, items);
            return Promise.resolve();
          },
        },
      },
      runtime: {
        sendMessage(msg) {
          if (msg && msg.type === 'audioMode.boot') {
            return Promise.resolve({ locale: 'en', overlay: enPack, overlays: { en: enPack, ar: arPack } });
          }
          return Promise.resolve(null);
        },
      },
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = (type, fn) => { winListeners.push({ type, fn }); };
  sandbox.removeEventListener = (type, fn) => {
    const index = winListeners.findIndex((entry) => entry.type === type && entry.fn === fn);
    if (index >= 0) winListeners.splice(index, 1);
  };
  vm.createContext(sandbox);
  vm.runInContext(coreSrc, sandbox, { filename: 'src/content/core.js' });
  vm.runInContext(contentSrc, sandbox, { filename: 'src/content/content.js' });
  return {
    api: sandbox.AudioModeContent,
    contents,
    grid,
    homeContents: home.contents,
    homeGrid: home.grid,
    doc,
    built,
    observed,
    winListeners,
    store,
    sandbox,
  };
}

function chipButtons(doc) {
  const row = doc.getElementById('ytc-subs-groups');
  if (!row || !row.firstChild) return [];
  return [...row.firstChild.children];
}

function noteOf(doc) {
  const row = doc.getElementById('ytc-subs-groups');
  if (!row) return null;
  return [...row.children].find((el) => el.classList.contains('ytc-subs-groups__note')) || null;
}

const channels = [
  { id: '1', handle: '@mkbhd', title: 'Marques Brownlee', groups: ['Tech'] },
  { id: '2', handle: '', title: 'Quiet Name', groups: ['Tech'] },
  { id: '3', handle: '@music', title: 'Music Box', groups: ['Music'] },
  { id: '4', handle: '@titled', title: 'Do Not Use Title', groups: ['Tech'] },
];

export default async function run(t) {
  t.section('copied helpers match view.js');

  const api = loadApi();
  const handles = ['@MKBHD', 'MKBHD', '@', '', null, 'ﬁle', '@قناة'];
  for (const value of handles) {
    t.check(
      `handleKey ${JSON.stringify(value)}`,
      api.handleKey(value) === handleKey(value),
      api.handleKey(value),
    );
  }
  const folds = ['Music', 'MUSIC', 'ﬁ', '  ', '', null, 'إب'];
  for (const value of folds) {
    t.check(`fold ${JSON.stringify(value)}`, api.fold(value) === fold(value), api.fold(value));
  }
  const rawNames = ['  Foo   Bar  ', '', null, 'abcdefghijklmnopqrstuvwxyz', '😀'.repeat(25), 12];
  for (const value of rawNames) {
    t.check(
      `normalizeGroupName ${JSON.stringify(value)}`,
      api.normalizeGroupName(value) === normalizeGroupName(value),
      api.normalizeGroupName(value),
    );
  }
  const listed = [
    { handle: '@MKBHD', title: 'Marques', groups: ['Music', 'music', ' News ', '', 4] },
    { handle: '', title: 'Beta', groups: ['ب', 'ا', 'Podcasts'] },
    { groups: 'nope' },
    { groups: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] },
  ];
  for (const locale of ['en', 'ar', undefined, 'fr']) {
    t.check(
      `groupNamesInList ${String(locale)}`,
      JSON.stringify(api.groupNamesInList(listed, locale)) === JSON.stringify(groupNamesInList(listed, locale)),
      JSON.stringify(api.groupNamesInList(listed, locale)),
    );
  }
  for (const name of ['Music', 'MUSIC', 'news', 'Podcasts', 'missing', '   ', null]) {
    t.check(
      `channelInGroup ${JSON.stringify(name)}`,
      api.channelInGroup(listed[0], name) === channelInGroup(listed[0], name),
    );
    t.check(
      `resolvedFeedGroup ${JSON.stringify(name)}`,
      api.resolvedFeedGroup(listed, name) === resolvedFeedGroup(listed, name),
      api.resolvedFeedGroup(listed, name),
    );
  }

  t.section('matching');

  const box = loadApi();
  const latest = section('Latest');
  const mkbhd = card({ href: '/@MKBHD', text: 'Not The Title', metaText: '' });
  const quiet = card({ href: '/@nohandle', text: '', metaText: '  quiet name  ' });
  const music = card({ href: '/@Music', text: 'Music Box' });
  const titled = card({ href: '/@someoneelse', text: 'Do Not Use Title' });
  const bare = card({});
  bare.classList.add('kept');
  const older = section('Older');
  const nobody = card({ href: '/@nobody', text: 'Nope' });
  const sentinel = continuation();
  const emptyShelf = section('Empty');
  const contents = createEl('div');
  contents.id = 'contents';
  for (const el of [emptyShelf, music, latest, mkbhd, quiet, titled, bare, older, nobody, sentinel]) {
    contents.appendChild(el);
  }
  const before = contents.children.length;

  const filtered = box.renderSubsContents(contents, channels, 'TECH', 0, enPack);
  t.check('a lowercase group resolves to its spelling', filtered.group === 'Tech', filtered.group);
  t.check('handle match shows the card', !hidden(mkbhd));
  t.check('empty handle falls back to the title', !hidden(quiet));
  t.check('a handle outside the group is hidden', hidden(music));
  t.check('a stored handle does not fall back to the title', hidden(titled));
  t.check('a card with no channel link is hidden', hidden(bare));
  t.check('a divider with no visible card after it is hidden', hidden(emptyShelf));
  t.check('a divider with a visible card after it stays', !hidden(latest));
  t.check('a later divider with only hidden cards is hidden', hidden(older));
  t.check('the continuation sentinel is not given our class', !hidden(sentinel));
  t.check('filtering does not remove nodes', contents.children.length === before, String(contents.children.length));
  t.check('an existing class is left in place', bare.classList.contains('kept'));
  t.check('hiding does not write an inline display', mkbhd.style.display == null || mkbhd.style.display === '');

  const restored = box.renderSubsContents(contents, channels, '', 3, enPack);
  t.check('All clears the filter', restored.filtered === false && restored.group === '');
  t.check(
    'All removes every class we added',
    [emptyShelf, music, latest, mkbhd, quiet, titled, bare, older, nobody, sentinel].every((el) => !hidden(el)),
  );
  t.check('All leaves a class it did not add', bare.classList.contains('kept'));
  t.check('All does not remove YouTube nodes', contents.children.length === before && contents.children.includes(sentinel));

  t.section('brake');

  t.check('twelve visible cards are enough', box.subsBrakeDue(12, 0) === true);
  t.check('eleven cards and nine rounds keep loading', box.subsBrakeDue(11, 9) === false);
  t.check('ten rounds stop the burst', box.subsBrakeDue(1, 10) === true);
  t.check('spacer fills the page out to two viewports', box.subsSpacerPx(400, 800) === 1200);
  t.check('a page already two viewports tall needs no spacer', box.subsSpacerPx(2000, 800) === 0);
  t.check('no viewport means no spacer', box.subsSpacerPx(400, 0) === 0);

  const brakeDoc = {
    documentElement: createEl('html'),
    scrollingElement: { scrollHeight: 400 },
    createElement: createEl,
  };
  const brakeBox = {
    __ytcHarness: true,
    URL,
    innerHeight: 800,
    document: brakeDoc,
  };
  brakeBox.window = brakeBox;
  vm.createContext(brakeBox);
  vm.runInContext(coreSrc, brakeBox, { filename: 'src/content/core.js' });
  vm.runInContext(contentSrc, brakeBox, { filename: 'src/content/content.js' });
  const brakeApi = brakeBox.AudioModeContent;
  const shelf = createEl('div');
  const one = card({ href: '/@mkbhd', text: 'Marques' });
  const end = continuation();
  shelf.appendChild(one);
  shelf.appendChild(end);
  const held = brakeApi.renderSubsContents(shelf, channels, 'Tech', 10, enPack);
  const spacer = shelf.children.find((el) => el.classList.contains('ytc-subs-spacer'));
  t.check('ten rounds say how many videos matched', held.brake === true && /1 of the loaded videos matches/.test(held.note), held.note);
  t.check('the spacer sits in front of the sentinel', !!spacer && spacer.nextSibling === end);
  t.check('the spacer is about two viewports tall', spacer && spacer.style.height === '1200px', spacer && spacer.style.height);
  const cleared = brakeApi.renderSubsContents(shelf, channels, '', 10, enPack);
  t.check(
    'clearing the filter removes the spacer',
    cleared.brake === false
      && !shelf.children.some((el) => el.classList.contains('ytc-subs-spacer'))
      && !hidden(one),
  );

  const many = createEl('div');
  for (let i = 0; i < 12; i++) many.appendChild(card({ href: '/@mkbhd', text: 'Marques' }));
  many.appendChild(continuation());
  const full = brakeApi.renderSubsContents(many, channels, 'Tech', 0, enPack);
  t.check(
    'twelve matches brake without the quiet line',
    full.brake === true && full.visible === 12 && full.note === '',
    JSON.stringify(full),
  );

  t.check(
    'the quiet line is translated',
    brakeApi.subsMatchNote(enPack, 1) === '1 of the loaded videos matches this group. Scroll to load more.'
      && brakeApi.subsMatchNote(enPack, 4) === '4 of the loaded videos match this group. Scroll to load more.'
      && brakeApi.subsMatchNote(arPack, 1) === 'من الفيديوهات المحمّلة، 1 في هذه المجموعة. مرّر لتحميل المزيد.'
      && brakeApi.subsMatchNote(arPack, 4) === 'من الفيديوهات المحمّلة، 4 في هذه المجموعة. مرّر لتحميل المزيد.',
    brakeApi.subsMatchNote(enPack, 1) + ' / ' + brakeApi.subsMatchNote(arPack, 4),
  );

  t.section('on the page');

  const store = {
    channels,
    settings: { feed: { group: 'Music' }, ui: { locale: 'en' } },
    subsPageGroup: 'Tech',
    writes: [],
  };
  const page = loadPage(store);
  const pageLatest = section('Latest');
  const pageTech = card({ href: '/@mkbhd', text: 'Marques' });
  const pageMusic = card({ href: '/@music', text: 'Music Box' });
  const pageEnd = continuation();
  const homeCard = card({ href: '/@music', text: 'Home music' });
  page.homeContents.appendChild(homeCard);
  page.contents.appendChild(pageLatest);
  page.contents.appendChild(pageTech);
  page.contents.appendChild(pageMusic);
  page.contents.appendChild(pageEnd);
  await page.api.refreshSubsGroups();

  const buttons = chipButtons(page.doc);
  t.check(
    'chips are All, then the groups in list order',
    buttons.map((btn) => btn.textContent).join('|') === 'All|Music|Tech',
    buttons.map((btn) => btn.textContent).join('|'),
  );
  t.check(
    'the remembered group is pressed, not the popup feed group',
    buttons[0].getAttribute('aria-pressed') === 'false'
      && buttons[1].getAttribute('aria-pressed') === 'false'
      && buttons[2].getAttribute('aria-pressed') === 'true'
      && store.settings.feed.group === 'Music',
  );
  t.check('a matching card stays', !hidden(pageTech) && !hidden(pageLatest));
  t.check('a card outside the group is hidden', hidden(pageMusic));
  t.check(
    'contents is watched for new cards',
    page.observed.length === 1 && page.observed[0].target === page.contents && page.observed[0].options.childList === true,
    String(page.observed.length),
  );
  const row = page.doc.getElementById('ytc-subs-groups');
  t.check(
    'the row sits immediately before the grid contents',
    !!row && row.nextSibling === page.contents && row.parentNode === page.grid,
  );
  t.check(
    'the row is named Groups',
    !!row && row.firstChild && row.firstChild.getAttribute('aria-label') === 'Groups',
    row && row.firstChild && row.firstChild.getAttribute('aria-label'),
  );
  t.check(
    'chips land in the subscriptions grid and Home is left alone',
    !!row
      && row.parentNode === page.grid
      && !hidden(homeCard)
      && ![...page.homeGrid.children].some((el) => el.id === 'ytc-subs-groups'),
  );
  t.check('chip text is the group name', buttons[1].textContent === 'Music');

  const foreign = { nodeType: 1, id: '', classList: { contains() { return false; } } };
  const ours = { nodeType: 1, id: '', classList: { contains(name) { return name === 'ytc-subs-spacer'; } } };
  for (let i = 0; i < 9; i++) page.observed[0].cb([{ addedNodes: [foreign] }]);
  const early = noteOf(page.doc);
  t.check('nine shelves do not show the quiet line yet', !!early && early.getAttribute('hidden') != null);
  page.observed[0].cb([{ addedNodes: [ours] }]);
  t.check('our spacer is not another round', noteOf(page.doc).getAttribute('hidden') != null);
  page.observed[0].cb([{ addedNodes: [foreign] }]);
  const late = noteOf(page.doc);
  const pageSpacer = [...page.contents.children].find((el) => el.classList.contains('ytc-subs-spacer'));
  t.check(
    'the tenth shelf names the matches and asks for a scroll',
    !!late && late.getAttribute('hidden') == null && /1 of the loaded videos matches/.test(late.textContent),
    late && late.textContent,
  );
  t.check('the brake spacer is in front of the sentinel', !!pageSpacer && pageSpacer.nextSibling === pageEnd);
  // The fake document does not grow when the spacer does, so hand it the
  // height a real layout would report (content plus the spacer) first.
  page.doc.scrollingElement.scrollHeight = 400 + (pageSpacer ? pageSpacer.offsetHeight : 0);
  const resize = page.winListeners.find((entry) => entry.type === 'resize');
  page.sandbox.innerHeight = 500;
  if (resize) resize.fn();
  t.check(
    'a resize remeasures the spacer',
    typeof resize?.fn === 'function' && pageSpacer && pageSpacer.style.height === '600px',
    pageSpacer && pageSpacer.style.height,
  );

  const musicBtn = buttons.find((btn) => btn.getAttribute('data-group') === 'Music');
  const click = musicBtn.listeners.find((entry) => entry.type === 'click');
  click.fn({ preventDefault() {}, stopPropagation() {} });
  t.check(
    'picking a chip stores its own key',
    store.subsPageGroup === 'Music' && store.settings.feed.group === 'Music' && store.writes.every((item) => !('settings' in item)),
    JSON.stringify(store.writes),
  );
  t.check('the picked chip is pressed', musicBtn.getAttribute('aria-pressed') === 'true');
  t.check('the new group shows its cards', !hidden(pageMusic) && hidden(pageTech));
  t.check(
    'changing the chip removes the spacer',
    ![...page.contents.children].some((el) => el.classList.contains('ytc-subs-spacer')),
  );

  page.location = null;
  // Path lives on the sandbox. Reaching it: syncSubsPage reads root.location.
  // Replace pathname by mutating the location object the sandbox was given.
  store._path = '/watch';

  t.section('setting off, no groups, and leaving the page');

  const offStore = {
    channels,
    settings: { feed: { groupsOnYouTube: false }, ui: { locale: 'en' } },
    subsPageGroup: 'Tech',
    writes: [],
  };
  const off = loadPage(offStore);
  const offCard = card({ href: '/@mkbhd', text: 'Marques' });
  off.contents.appendChild(offCard);
  await off.api.refreshSubsGroups();
  t.check('the switch off builds no chips', off.doc.getElementById('ytc-subs-groups') == null);
  t.check('the switch off hides nothing', !hidden(offCard));
  t.check('the switch off installs no observer', off.built.length === 0, String(off.built.length));

  const missingStore = {
    channels,
    settings: { feed: { groupsOnYouTube: 0 }, ui: { locale: 'en' } },
    writes: [],
  };
  const missing = loadPage(missingStore);
  missing.contents.appendChild(card({ href: '/@mkbhd', text: 'Marques' }));
  await missing.api.refreshSubsGroups();
  t.check('groupsOnYouTube 0 is off', missing.doc.getElementById('ytc-subs-groups') == null && missing.built.length === 0);

  const emptyStore = {
    channels: [{ id: '9', handle: '@solo', title: 'Solo', groups: [] }],
    settings: { ui: { locale: 'en' } },
    writes: [],
  };
  const empty = loadPage(emptyStore);
  const solo = card({ href: '/@solo', text: 'Solo' });
  empty.contents.appendChild(solo);
  await empty.api.refreshSubsGroups();
  t.check('no groups leaves the page untouched', empty.doc.getElementById('ytc-subs-groups') == null && !hidden(solo) && empty.built.length === 0);

  const arStore = {
    channels,
    settings: { ui: { locale: 'ar' } },
    subsPageGroup: '',
    writes: [],
  };
  const ar = loadPage(arStore, { language: 'en-US' });
  ar.contents.appendChild(card({ href: '/@mkbhd', text: 'Marques' }));
  await ar.api.refreshSubsGroups();
  const arRow = ar.doc.getElementById('ytc-subs-groups');
  const arButtons = chipButtons(ar.doc);
  t.check(
    'Arabic puts All first and sets the row direction',
    !!arRow
      && arRow.getAttribute('dir') === 'rtl'
      && arButtons[0].textContent === 'الكل'
      && arRow.firstChild.getAttribute('aria-label') === 'المجموعات'
      && arButtons.map((btn) => btn.textContent).slice(1).join('|') === groupNamesInList(channels, 'ar').join('|'),
    arButtons.map((btn) => btn.textContent).join('|'),
  );

  const gone = loadPage({
    channels,
    settings: { ui: { locale: 'en' } },
    subsPageGroup: 'Tech',
    writes: [],
  });
  const goneCard = card({ href: '/@music', text: 'Music Box' });
  goneCard.classList.add('ytc-subs-hidden');
  gone.contents.appendChild(section('Latest'));
  gone.contents.appendChild(goneCard);
  await gone.api.refreshSubsGroups();
  t.check('a group hides the card while the page is open', hidden(goneCard));

  const leave = loadPage({
    channels,
    settings: { ui: { locale: 'en' } },
    subsPageGroup: 'Tech',
    writes: [],
  }, { path: '/watch' });
  const leaveCard = card({ href: '/@music', text: 'Music Box' });
  leaveCard.classList.add('ytc-subs-hidden');
  leave.contents.appendChild(leaveCard);
  await leave.api.refreshSubsGroups();
  t.check(
    'leaving the subscriptions page restores the cards and drops the row',
    !hidden(leaveCard) && leave.doc.getElementById('ytc-subs-groups') == null && leave.built.length === 0,
  );

  t.section('stylesheet');

  t.check(
    'the hidden class is the one the stylesheet hides',
    overlayCss.includes('ytd-rich-item-renderer.ytc-subs-hidden')
      && overlayCss.includes('ytd-rich-section-renderer.ytc-subs-hidden')
      && /ytd-rich-item-renderer\.ytc-subs-hidden[\s\S]*display:\s*none\s*!important/.test(overlayCss),
  );
  t.check('dark and light chips are both styled', /html\[dark\][\s\S]*ytc-subs-groups__chip/.test(overlayCss));
  t.check(
    'the selected chip uses the purple accent',
    /--ytc-subs-accent:\s*#7c5cf0/.test(overlayCss)
      && /background:\s*var\(--ytc-subs-accent\)/.test(overlayCss),
  );
  const blockStart = contentSrc.indexOf('const SUBS_PAGE_GROUP_KEY');
  const blockEnd = contentSrc.indexOf('function boot()');
  const block = contentSrc.slice(blockStart, blockEnd);
  t.check('the filter does not scroll the window', !/scrollTo|scrollIntoView|scrollBy/.test(block));
  t.check('chip labels are not written with innerHTML', !/innerHTML/.test(block));
  t.check('the filter does not message the worker', !/sendMessage/.test(block));
  t.check(
    'chip copy is not hard-coded',
    !block.includes('الكل') && !block.includes('Scroll to load more') && block.includes('overlayPackFor'),
  );
}
