/**
 * Reads one All-subscriptions HTML page: which signed-in account it is,
 * how many subscribed rows the first page carries, whether more pages
 * follow, and that account's picture. Pure: no chrome, no DOM, no fetch.
 * The content script cannot import this file, so it keeps the same
 * functions; the suite checks the two copies against the same fixtures.
 */

const AVATAR_HOSTS = {
  'yt3.ggpht.com': true,
  'yt3.googleusercontent.com': true,
};

const EMPTY_PAGE = {
  sessionIndex: null,
  subscribed: 0,
  continuation: false,
  avatar: '',
};

function sessionIndexIn(html) {
  const match = /["']SESSION_INDEX["']\s*:\s*"?(\d+)"?/.exec(html);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function assignmentAt(html) {
  const forms = [
    /var\s+ytInitialData\s*=\s*/g,
    /window\[\s*["']ytInitialData["']\s*\]\s*=\s*/g,
  ];
  let best = -1;
  let end = -1;
  for (let f = 0; f < forms.length; f++) {
    forms[f].lastIndex = 0;
    const match = forms[f].exec(html);
    if (!match) continue;
    if (best === -1 || match.index < best) {
      best = match.index;
      end = match.index + match[0].length;
    }
  }
  return end;
}

function jsonEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function ytInitialDataIn(html) {
  const start = assignmentAt(html);
  if (start < 0 || html[start] !== '{') return null;
  const end = jsonEnd(html, start);
  if (end < 0) return null;
  try {
    return JSON.parse(html.slice(start, end));
  } catch {
    return null;
  }
}

function avatarUrlOk(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if (!raw) return '';
  if (raw.startsWith('//')) raw = `https:${raw}`;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return '';
  }
  if (url.protocol !== 'https:' || !AVATAR_HOSTS[url.hostname]) return '';
  return url.href;
}

function bestThumbnail(thumbs) {
  if (!Array.isArray(thumbs)) return '';
  let best = '';
  let bestWidth = -1;
  for (let i = 0; i < thumbs.length; i++) {
    const thumb = thumbs[i];
    const url = avatarUrlOk(thumb && thumb.url);
    if (!url) continue;
    const width = Number(thumb && thumb.width);
    const rank = Number.isFinite(width) ? width : 0;
    if (!best || rank >= bestWidth) {
      best = url;
      bestWidth = rank;
    }
  }
  return best;
}

function accountAvatar(data) {
  const buttons = data
    && data.topbar
    && data.topbar.desktopTopbarRenderer
    && data.topbar.desktopTopbarRenderer.topbarButtons;
  if (!Array.isArray(buttons)) return '';
  for (let i = 0; i < buttons.length; i++) {
    const menu = buttons[i] && buttons[i].topbarMenuButtonRenderer;
    if (!menu || !menu.avatar) continue;
    return bestThumbnail(menu.avatar.thumbnails);
  }
  return '';
}

function countRows(node, acc) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) countRows(node[i], acc);
    return;
  }
  const row = node.channelRenderer;
  if (row && typeof row === 'object') {
    const button = row.subscriptionButton;
    if (button && button.subscribed === true) acc.subscribed += 1;
  }
  if (node.continuationItemRenderer) acc.continuation = true;
  const keys = Object.keys(node);
  for (let i = 0; i < keys.length; i++) countRows(node[keys[i]], acc);
}

/**
 * { sessionIndex, subscribed, continuation, avatar }.
 * sessionIndex is null when the page does not say. avatar is '' unless
 * the topbar picture is on a YouTube avatar host. subscribed counts the
 * first page only; continuation means that count is a lower bound.
 */
export function parseSubscriptionsHtml(html) {
  if (typeof html !== 'string' || !html) return { ...EMPTY_PAGE };
  try {
    const data = ytInitialDataIn(html);
    const acc = { subscribed: 0, continuation: false };
    if (data) countRows(data, acc);
    return {
      sessionIndex: sessionIndexIn(html),
      subscribed: acc.subscribed,
      continuation: acc.continuation,
      avatar: data ? accountAvatar(data) : '',
    };
  } catch {
    return { ...EMPTY_PAGE };
  }
}

/**
 * One fetched page, in order from authuser=0. Returns false when this
 * page is not the next account: past the last account YouTube answers
 * 200 with SESSION_INDEX 0 again (docs/youtube.md).
 */
export function takeAccountPage(accounts, html) {
  const list = accounts;
  if (!Array.isArray(list) || list.length >= 10) return false;
  const parsed = parseSubscriptionsHtml(html);
  if (!parsed || parsed.sessionIndex !== list.length) return false;
  list.push({
    index: list.length,
    subscribed: parsed.subscribed,
    continuation: parsed.continuation === true,
    avatar: parsed.avatar || '',
  });
  return true;
}
