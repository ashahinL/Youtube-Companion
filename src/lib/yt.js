/**
 * The YouTube wire seam. Every public endpoint this extension talks to, and
 * every parser for those responses, lives here. Callers inject `fetch` so the
 * suite can run against fixtures with no network.
 */

const YT_ORIGIN = 'https://www.youtube.com';
const INNERTUBE = `${YT_ORIGIN}/youtubei/v1`;

// The version youtube.com itself sent on 2026-09-14 (docs/youtube.md). An old
// one still answers today, but it is the first thing YouTube can stop serving,
// so ship day refreshes it (RELEASING.md).
const INNERTUBE_CONTEXT = {
  context: {
    client: {
      clientName: 'WEB',
      clientVersion: '2.20260911.01.00',
      hl: 'en',
      gl: 'US',
    },
  },
};

// Videos-tab browse. The channel header (title, handle, avatar, subscribers)
// is on this same payload, and its rows stand in for a failing feed.
const BROWSE_VIDEOS_TAB_PARAMS = 'EgZ2aWRlb3PyBgQKAjoA';

// The channel feed always carries its 15 newest entries.
const FEED_WINDOW = 15;

const THUMB_SIZES = new Set(['default', 'mq', 'hq', 'sd', 'maxres']);
const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
const VIDEO_ID_RE = /^[\w-]{11}$/;

const YT_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
]);

// Where channel avatars are served from (docs/youtube.md). PRIVACY.md names
// these hosts; an avatar anywhere else would be a request the policy denies.
const AVATAR_HOSTS = new Set(['yt3.ggpht.com', 'yt3.googleusercontent.com']);

/**
 * @typedef {'network' | 'http' | 'parse'} YtErrorKind
 */

export class YtError extends Error {
  /**
   * @param {YtErrorKind} kind
   * @param {string} endpoint
   * @param {number} [status]
   */
  constructor(kind, endpoint, status) {
    super(messageFor(kind, endpoint, status));
    this.name = 'YtError';
    this.kind = kind;
    this.endpoint = endpoint;
    if (kind === 'http') this.status = status;
  }
}

const PUSHBACK_STATUS = 429;

/**
 * YouTube asking this IP to slow down. Not measured here: Google answers a
 * throttled client with 429, or redirects it to its /sorry/ captcha page,
 * which fetch follows — so the landing URL counts as much as the status.
 * Carrying on past it is how a user ends up solving captchas on youtube.com.
 */
export function isPushback(err) {
  return err instanceof YtError && err.kind === 'http' && err.status === PUSHBACK_STATUS;
}

/**
 * Origin: chrome-extension://… on Innertube is a 403, not a 429. One
 * dead video must stay a per-video miss; a pile of these is the rewrite
 * rule missing, and looks like a frozen feed if the sweep carries on.
 */
export function isInnertubeForbidden(err) {
  return err instanceof YtError
    && err.kind === 'http'
    && err.status === 403
    && (err.endpoint === 'player' || err.endpoint === 'browse');
}

function landedOnBlockPage(res) {
  if (res.status === PUSHBACK_STATUS) return true;
  if (!res.url) return false;
  try {
    const url = new URL(res.url);
    return /(^|\.)google\.com$/.test(url.hostname) && url.pathname.startsWith('/sorry');
  } catch {
    return false;
  }
}

function messageFor(kind, endpoint, status) {
  if (kind === 'http') return `${endpoint} failed (${status})`;
  if (kind === 'network') return `${endpoint} network error`;
  return `${endpoint} parse error`;
}

function asJson(input, endpoint) {
  if (typeof input === 'string') {
    try {
      input = JSON.parse(input);
    } catch {
      throw new YtError('parse', endpoint);
    }
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new YtError('parse', endpoint);
  }
  return input;
}

function walk(node, visit) {
  if (node == null || typeof node !== 'object') return;
  visit(node);
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else {
    for (const v of Object.values(node)) walk(v, visit);
  }
}

function ytText(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node !== 'object') return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  if (typeof node.content === 'string') return node.content;
  if (Array.isArray(node.runs)) return node.runs.map((r) => r.text || '').join('');
  if (node.text) return ytText(node.text);
  if (node.accessibility?.accessibilityData?.label) {
    return String(node.accessibility.accessibilityData.label);
  }
  return '';
}

function absUrl(url) {
  if (!url) return '';
  if (url.startsWith('//')) return `https:${url}`;
  return url;
}

function pickThumbUrl(thumbs, preferredWidth) {
  if (!Array.isArray(thumbs) || thumbs.length === 0) return '';
  if (preferredWidth) {
    const hit = thumbs.find((t) => t && t.width === preferredWidth && t.url);
    if (hit) return absUrl(hit.url);
  }
  for (let i = thumbs.length - 1; i >= 0; i--) {
    if (thumbs[i]?.url) return absUrl(thumbs[i].url);
  }
  return '';
}

function decodeEntities(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function tagText(block, tag) {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = block.match(re);
  return m ? decodeEntities(m[1].trim()) : '';
}

function tagAttrs(block, tag) {
  const re = new RegExp(`<${tag}\\b([^>]*)/?>`, 'i');
  const m = block.match(re);
  return m ? m[1] : '';
}

function attr(attrs, name) {
  const re = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i');
  const m = String(attrs).match(re);
  return m ? (m[1] ?? m[2] ?? '') : '';
}

function asChannelId(raw) {
  if (!raw) return '';
  const s = String(raw).trim();
  const direct = s.match(/(UC[\w-]{22})/);
  if (direct) return direct[1];
  const stripped = s.replace(/^yt:channel:/, '');
  if (/^[\w-]{22}$/.test(stripped)) return `UC${stripped}`;
  return '';
}

function innertubeUrl(method) {
  return `${INNERTUBE}/${method}?prettyPrint=false`;
}

async function innertubePost(method, extra, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(innertubeUrl(method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...INNERTUBE_CONTEXT, ...extra }),
      // Cookie-free on purpose. A logged-in YouTube cookie without
      // SAPISIDHASH is a different request, often 401.
      credentials: 'omit',
    });
  } catch {
    throw new YtError('network', method);
  }
  if (landedOnBlockPage(res)) throw new YtError('http', method, PUSHBACK_STATUS);
  if (!res.ok) throw new YtError('http', method, res.status);
  try {
    return await res.json();
  } catch {
    throw new YtError('parse', method);
  }
}

/* ---- pure helpers --------------------------------------------------- */

export function isChannelId(value) {
  return typeof value === 'string' && CHANNEL_ID_RE.test(value);
}

export function isAvatarUrl(value) {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && AVATAR_HOSTS.has(url.hostname);
}

/**
 * A bare token with no @ is a handle — typing "mkbhd" means @mkbhd, not
 * a name search. Dots are legal in handles (`mr.beast`), so a dot is not
 * a URL signal; a slash or a scheme is. Spaces are a name, not a handle.
 * Channel ids are the 24-character UC… form and win before that fallback.
 * A watch / shorts / youtu.be URL is kind `video`; resolveChannelId reads
 * the uploader off the player payload.
 */
export function normalizeChannelInput(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;

  if (CHANNEL_ID_RE.test(raw)) return { kind: 'id', id: raw };

  if (!/[/:]/.test(raw) && !/\s/.test(raw)) {
    const handle = raw.startsWith('@') ? raw.slice(1) : raw;
    if (!handle) return null;
    if (YT_HOSTS.has(handle.toLowerCase()) || YT_HOSTS.has(raw.toLowerCase())) return null;
    return { kind: 'url', url: `${YT_ORIGIN}/@${handle}` };
  }

  let url;
  try {
    const withProto = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    url = new URL(withProto);
  } catch {
    return null;
  }

  if (!YT_HOSTS.has(url.hostname.toLowerCase())) return null;

  const videoId = videoIdFromParsedUrl(url);
  if (videoId) return { kind: 'video', id: videoId };

  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;

  const head = parts[0];
  const headLower = head.toLowerCase();

  if (headLower === 'channel' && parts[1] && CHANNEL_ID_RE.test(parts[1])) {
    return { kind: 'id', id: parts[1] };
  }
  if (head.startsWith('@') && head.length > 1) {
    return { kind: 'url', url: `${YT_ORIGIN}/${head}` };
  }
  if ((headLower === 'c' || headLower === 'user') && parts[1]) {
    return { kind: 'url', url: `${YT_ORIGIN}/${headLower}/${parts[1]}` };
  }
  return null;
}

/**
 * A bare 11-character token is a video id here; the same token on Add
 * / Watchlist is a handle. Channel URLs and @handles are not videos.
 */
export function normalizeVideoInput(input) {
  if (input == null) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  if (VIDEO_ID_RE.test(raw)) return { kind: 'video', id: raw };
  const ch = normalizeChannelInput(raw);
  return ch && ch.kind === 'video' ? ch : null;
}

function videoIdFromParsedUrl(url) {
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be' || host === 'www.youtu.be') {
    const id = url.pathname.split('/').filter(Boolean)[0] || '';
    return VIDEO_ID_RE.test(id) ? id : '';
  }
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return '';
  const head = parts[0].toLowerCase();
  if (head === 'watch') {
    const id = url.searchParams.get('v') || '';
    return VIDEO_ID_RE.test(id) ? id : '';
  }
  if ((head === 'shorts' || head === 'embed' || head === 'live' || head === 'v') && parts[1]) {
    return VIDEO_ID_RE.test(parts[1]) ? parts[1] : '';
  }
  return '';
}

export function thumbUrl(videoId, size = 'mq') {
  const s = THUMB_SIZES.has(size) ? size : 'mq';
  const file = s === 'default' ? 'default.jpg' : `${s}default.jpg`;
  return `https://i.ytimg.com/vi/${videoId}/${file}`;
}

export function parseDuration(text) {
  if (text == null) return 0;
  const s = String(text).trim();
  if (!/^\d+:\d{1,2}(:\d{1,2})?$/.test(s)) return 0;
  const parts = s.split(':').map(Number);
  let sec = 0;
  for (const n of parts) sec = sec * 60 + n;
  return sec;
}

/**
 * Compact counts are approximate: "79M" is 79000000, not the exact view
 * count. YouTube rounded it before we saw it.
 */
export function parseCompactCount(text) {
  if (text == null) return 0;
  const s = String(text).trim();
  const m = s.match(/([\d,.]+)\s*([KMB])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n)) return 0;
  const suffix = (m[2] || '').toUpperCase();
  const mult = suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : suffix === 'B' ? 1e9 : 1;
  return Math.round(n * mult);
}

/* ---- parsers -------------------------------------------------------- */

export function parseFeedXml(xml) {
  if (typeof xml !== 'string' || !/<feed\b/i.test(xml)) {
    throw new YtError('parse', 'feed');
  }

  const entryStart = xml.search(/<entry\b/i);
  const prefix = entryStart >= 0 ? xml.slice(0, entryStart) : xml;

  // The feed-level <yt:channelId> omits the UC prefix; the self-link and
  // each entry carry the real id. Prefer a UC… form when we can see one.
  let channelId =
    asChannelId((prefix.match(/channel_id=(UC[\w-]{22})/) || [])[1]) ||
    asChannelId((prefix.match(/\/channel\/(UC[\w-]{22})/) || [])[1]) ||
    asChannelId(tagText(prefix, 'yt:channelId'));

  const channelTitle = tagText(prefix, 'title');
  const entries = [];

  const blocks = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const v = tagText(block, 'yt:videoId');
    if (!v) continue;
    if (!channelId) channelId = asChannelId(tagText(block, 'yt:channelId'));
    const published = tagText(block, 'published');
    const at = Date.parse(published);
    const views = Number(attr(tagAttrs(block, 'media:statistics'), 'views')) || 0;
    entries.push({
      v,
      title: tagText(block, 'title'),
      // Missing or invalid <published> is 0. Only at > 0 is a real time;
      // treating 0 as one overwrites the player and that id is never classified again.
      at: at > 0 ? at : 0,
      views,
      description: tagText(block, 'media:description'),
    });
  }

  return { channelId, channelTitle, entries };
}

export function parseResolveUrl(json) {
  json = asJson(json, 'resolve_url');
  const id = json.endpoint?.browseEndpoint?.browseId;
  return CHANNEL_ID_RE.test(id) ? id : null;
}

export function parseChannelHeader(json) {
  json = asJson(json, 'browse');
  const meta = json.metadata?.channelMetadataRenderer || {};
  const header = json.header?.pageHeaderRenderer || {};
  const vm = header.content?.pageHeaderViewModel || {};

  const id = asChannelId(meta.externalId);
  if (!id) throw new YtError('parse', 'browse');

  const title = header.pageTitle || meta.title || '';

  let handle = '';
  const vanity = meta.vanityChannelUrl || (meta.ownerUrls && meta.ownerUrls[0]) || '';
  const vanityMatch = String(vanity).match(/@[\w.-]+/);
  if (vanityMatch) handle = vanityMatch[0];

  let subscribers = 0;
  walk(vm.metadata, (n) => {
    for (const part of n.metadataParts || []) {
      const t = ytText(part.text || part);
      if (t.startsWith('@')) handle = t.split(/\s/)[0];
      if (/subscriber/i.test(t)) subscribers = parseCompactCount(t);
    }
  });

  const headerThumbs =
    vm.image?.decoratedAvatarViewModel?.avatar?.avatarViewModel?.image?.sources || [];
  const avatar =
    pickThumbUrl(headerThumbs, 120) || pickThumbUrl(meta.avatar?.thumbnails || []);

  return { id, title, handle, avatar, subscribers };
}

/**
 * Newest-first video rows of a Videos-tab browse, capped at the feed's own
 * window: every row the caller has not seen costs a player request to date.
 * The id is `contentId` — `videoId` sits on nested endpoints several times
 * per row. There is no upload time, only "3 days ago", so rows have no `at`.
 */
export function parseChannelVideos(json, channelId) {
  json = asJson(json, 'browse');
  const id = asChannelId(json.metadata?.channelMetadataRenderer?.externalId);
  // A missing channel answers 200 with an alert and no metadata.
  if (!id || (channelId && id !== channelId)) throw new YtError('parse', 'browse');
  const entries = [];
  const seen = new Set();
  walk(json.contents, (node) => {
    const lockup = node.lockupViewModel;
    if (!lockup || lockup.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO') return;
    const v = String(lockup.contentId || '');
    if (!VIDEO_ID_RE.test(v) || seen.has(v)) return;
    seen.add(v);
    const meta = lockup.metadata?.lockupMetadataViewModel || {};
    let views = 0;
    walk(meta.metadata, (n) => {
      for (const part of n.metadataParts || []) {
        const text = ytText(part.text);
        if (/\bviews?\b/i.test(text)) views = parseCompactCount(text);
      }
    });
    entries.push({ v, title: ytText(meta.title), views });
  });
  return { channelId: id, entries: entries.slice(0, FEED_WINDOW) };
}

export function parsePlayer(json) {
  json = asJson(json, 'player');
  const details = json.videoDetails;
  if (!details || typeof details !== 'object') throw new YtError('parse', 'player');

  // isShortsEligible means the video could be shown as a short, not that
  // it is one. It is never read.
  const micro = json.microformat?.playerMicroformatRenderer || {};
  const live = micro.liveBroadcastDetails || {};
  const startRaw = live.startTimestamp;
  // A scheduled stream past its time, still waiting for the creator, has no
  // startTimestamp; the waiting screen still carries the time, in seconds.
  const slate = json.playabilityStatus?.liveStreamability?.liveStreamabilityRenderer
    ?.offlineSlate?.liveStreamOfflineSlateRenderer;
  const slateSeconds = Number(slate?.scheduledStartTime);
  const startsAt = startRaw
    ? Date.parse(startRaw)
    : (slateSeconds > 0 ? slateSeconds * 1000 : NaN);
  const publishedRaw = micro.publishDate;
  const publishedAt = publishedRaw ? Date.parse(publishedRaw) : NaN;

  return {
    v: details.videoId || '',
    title: details.title || ytText(micro.title) || '',
    channelId: details.channelId || micro.externalChannelId || '',
    channelTitle: details.author || micro.ownerChannelName || '',
    lengthSeconds: Number(details.lengthSeconds) || 0,
    isLive: !!details.isLive,
    isUpcoming: !!details.isUpcoming,
    startsAt: Number.isFinite(startsAt) ? startsAt : 0,
    publishedAt: Number.isFinite(publishedAt) ? publishedAt : 0,
    views: Number(details.viewCount ?? micro.viewCount) || 0,
  };
}

/* ---- network callers ------------------------------------------------ */

export async function resolveChannelId(input, { fetch = globalThis.fetch } = {}) {
  const norm = normalizeChannelInput(input);
  if (!norm) return null;
  if (norm.kind === 'id') return norm.id;
  if (norm.kind === 'video') {
    const json = await innertubePost('player', { videoId: norm.id }, fetch);
    const channelId = parsePlayer(json).channelId;
    return CHANNEL_ID_RE.test(channelId) ? channelId : null;
  }
  const json = await innertubePost('navigation/resolve_url', { url: norm.url }, fetch);
  return parseResolveUrl(json);
}

async function fetchFeed(query, fetchImpl) {
  const url = `${YT_ORIGIN}/feeds/videos.xml?${query}`;
  let res;
  try {
    // The feed's cache-control is max-age=900 with no ETag/304, so a poll
    // without cache:'no-cache' returns the same bytes for 15 minutes.
    res = await fetchImpl(url, { cache: 'no-cache', credentials: 'omit' });
  } catch {
    throw new YtError('network', 'feed');
  }
  if (landedOnBlockPage(res)) throw new YtError('http', 'feed', PUSHBACK_STATUS);
  if (!res.ok) throw new YtError('http', 'feed', res.status);
  let xml;
  try {
    xml = await res.text();
  } catch {
    throw new YtError('parse', 'feed');
  }
  return parseFeedXml(xml);
}

export async function fetchChannelFeed(channelId, { fetch = globalThis.fetch } = {}) {
  return fetchFeed(`channel_id=${encodeURIComponent(channelId)}`, fetch);
}

export async function fetchChannelVideos(channelId, { fetch = globalThis.fetch } = {}) {
  const json = await innertubePost('browse', { browseId: channelId, params: BROWSE_VIDEOS_TAB_PARAMS }, fetch);
  return parseChannelVideos(json, channelId);
}

/**
 * A channel's newest uploads: the channel feed, or its Videos tab when the
 * feed fails. On 2026-09-13 every feed address answered 404 for every channel
 * while Innertube kept working (docs/youtube.md). The tab is about nine times
 * the bytes, has no exact upload times, and leaves out shorts and live
 * streams, so it only stands in. A network error or a pushback skips it: the
 * tab would fail the same way, and a block must not be pushed on.
 */
export async function fetchLatestUploads(channelId, { fetch = globalThis.fetch } = {}) {
  try {
    const feed = await fetchChannelFeed(channelId, { fetch });
    return { via: 'feed', entries: feed.entries };
  } catch (err) {
    const standIn = err instanceof YtError
      && (err.kind === 'parse' || (err.kind === 'http' && !isPushback(err)));
    if (!standIn) throw err;
    try {
      const tab = await fetchChannelVideos(channelId, { fetch });
      return { via: 'videos', entries: tab.entries };
    } catch (second) {
      // The feed's error is the one that describes the channel: a channel
      // that is gone fails the tab too, as a parse error.
      throw isPushback(second) ? second : err;
    }
  }
}

export async function fetchChannelHeader(channelId, { fetch = globalThis.fetch } = {}) {
  const json = await innertubePost('browse', { browseId: channelId, params: BROWSE_VIDEOS_TAB_PARAMS }, fetch);
  return parseChannelHeader(json);
}

export async function isShort(videoId, { fetch = globalThis.fetch } = {}) {
  const url = `${YT_ORIGIN}/shorts/${videoId}`;
  let res;
  try {
    // redirect:'manual' yields an opaque response whose status cannot be
    // read. Leave the default (follow) and inspect redirected / url.
    res = await fetch(url, { method: 'HEAD', credentials: 'omit' });
  } catch {
    throw new YtError('network', 'shorts');
  }
  // Before the /watch test: a block-page redirect is also "redirected".
  if (landedOnBlockPage(res)) throw new YtError('http', 'shorts', PUSHBACK_STATUS);
  if (!res.ok) throw new YtError('http', 'shorts', res.status);
  if (res.redirected && /\/watch/.test(res.url || '')) return false;
  return true;
}

async function fetchPlayer(videoId, { fetch = globalThis.fetch } = {}) {
  const json = await innertubePost('player', { videoId }, fetch);
  return parsePlayer(json);
}

async function classifyPlayer(p, { fetch = globalThis.fetch } = {}) {
  if (p.isUpcoming) return { k: 'premiere', d: 0, st: p.startsAt };
  if (p.isLive) return { k: 'live', d: 0, st: p.startsAt };
  // Shorts max out at 3 minutes, so a longer video cannot be one.
  if (p.lengthSeconds > 180) return { k: 'video', d: p.lengthSeconds, st: 0 };
  const short = await isShort(p.v, { fetch });
  return { k: short ? 'short' : 'video', d: p.lengthSeconds, st: 0 };
}

/**
 * `pa` is the upload time from the player, to the second; it matched the
 * feed's `<published>` (docs/youtube.md). A row from the Videos tab has no
 * other source for it.
 */
export async function classifyVideo(videoId, { fetch = globalThis.fetch } = {}) {
  const p = await fetchPlayer(videoId, { fetch });
  return { ...(await classifyPlayer(p, { fetch })), pa: p.publishedAt };
}
