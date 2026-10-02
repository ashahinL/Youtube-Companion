/**
 * MAIN-world bridge. Isolated content scripts can see the element but
 * not its methods or the page's own data, which is the only reason this
 * file exists. It receives a request, calls the player, reads a collab
 * video's channel list, or reads the All subscriptions rows, and posts
 * the result back. Never throws into the page. Loaded as a MAIN-world
 * content script, so it is not a web-accessible file.
 */

(function (root) {
  'use strict';

  const PAGE_ORIGIN = 'https://www.youtube.com';
  const win = root.window || root;
  // 32 random bytes, hex. A page can still watch postMessage traffic; the
  // goal is no fixed name to search for, not secrecy.
  const TOKEN_RE = /^[0-9a-f]{64}$/;

  const ARITY = {
    getPlaybackQuality: 0,
    getAvailableQualityLevels: 0,
    setPlaybackQuality: 1,
    setPlaybackQualityRange: 2,
    playVideo: 0,
    pauseVideo: 0,
    seekTo: 1,
    setPlaybackRate: 1,
    setVolume: 1,
    mute: 0,
    unMute: 0,
    // Not player methods: read-only page data, answered without the player.
    collaborators: 0,
    subscribedChannels: 0,
    sessionIndex: 0,
    watchQueue: 0,
    setWatchQueue: 1,
    clearWatchQueue: 0,
  };

  const MAX_COLLABORATORS = 10;
  // src/lib/backup.js MAX_BACKUP_CHANNELS. This file cannot import.
  const MAX_SUBSCRIBED_CHANNELS = 2000;
  // Same cap as src/lib/takeout.js.
  const MAX_CHANNEL_TITLE = 200;
  // The worker stores only the exact 24-character form. Anything shorter
  // is dropped here only when it cannot be a channel id at all.
  const CHANNEL_ID_RE = /^UC[\w-]{20,}$/;

  const QUALITIES = {
    tiny: true,
    small: true,
    medium: true,
    large: true,
    hd720: true,
    hd1080: true,
    hd1440: true,
    hd2160: true,
    highres: true,
    auto: true,
  };

  // Same rates the Audio tab speed select offers. Object keys would
  // stringify 0.25; keep the list numeric so 0.25 === 0.25 holds.
  const PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  // Every well-formed token is served, not only the first. A page script or
  // another extension could adopt before the content script does, and a
  // first-wins bridge would then ignore ours for good. Serving the page's
  // own token gives it nothing it lacks: it can call its own player and
  // read its own data. There is no cap, since a page could fill any cap.
  const adopted = new Set();

  function isQuality(value) {
    return typeof value === 'string' && QUALITIES[value] === true;
  }

  function isSeekTime(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0;
  }

  function isPlaybackRate(value) {
    if (typeof value !== 'number' || !isFinite(value)) return false;
    for (let i = 0; i < PLAYBACK_RATES.length; i++) {
      if (PLAYBACK_RATES[i] === value) return true;
    }
    return false;
  }

  function isVolumeLevel(value) {
    return typeof value === 'number'
      && isFinite(value)
      && value >= 0
      && value <= 100
      && Math.floor(value) === value;
  }

  const VIDEO_ID_RE = /^[\w-]{11}$/;

  function isVideoIdList(value) {
    if (!Array.isArray(value) || value.length < 2 || value.length > 100) return false;
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== 'string' || !VIDEO_ID_RE.test(value[i])) return false;
    }
    return true;
  }

  function isAllowedCall(method, args) {
    if (typeof method !== 'string' || !Object.prototype.hasOwnProperty.call(ARITY, method)) {
      return false;
    }
    if (!Array.isArray(args)) return false;
    const n = ARITY[method];
    if (args.length !== n) return false;
    if (method === 'setPlaybackQuality') return isQuality(args[0]);
    if (method === 'setPlaybackQualityRange') return isQuality(args[0]) && isQuality(args[1]);
    if (method === 'seekTo') return isSeekTime(args[0]);
    if (method === 'setPlaybackRate') return isPlaybackRate(args[0]);
    if (method === 'setVolume') return isVolumeLevel(args[0]);
    if (method === 'setWatchQueue') return isVideoIdList(args[0]);
    return true;
  }

  function isPageEvent(event, expectedWindow) {
    if (!event || event.source !== expectedWindow) return false;
    if (event.origin !== PAGE_ORIGIN) return false;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
    return true;
  }

  function readAdopt(event, expectedWindow) {
    if (!isPageEvent(event, expectedWindow)) return null;
    const data = event.data;
    if (data.dir !== 'adopt') return null;
    if (typeof data.type !== 'string' || !TOKEN_RE.test(data.type)) return null;
    return { token: data.type };
  }

  // Content-script postMessage carries the page origin, not
  // chrome-extension://. Other windows and page scripts share this
  // channel, so origin, source, and shape are all checked before any call.
  function readRequest(event, expectedWindow) {
    if (!isPageEvent(event, expectedWindow)) return null;
    const data = event.data;
    if (typeof data.type !== 'string' || !adopted.has(data.type)) return null;
    if (data.dir !== 'request') return null;
    if (typeof data.id !== 'number' || !isFinite(data.id)) return null;
    const args = Array.isArray(data.args) ? data.args : null;
    if (!isAllowedCall(data.method, args)) return null;
    return { token: data.type, id: data.id, method: data.method, args: args };
  }

  function getPlayer() {
    try {
      const doc = root.document;
      if (!doc || typeof doc.getElementById !== 'function') return null;
      return doc.getElementById('movie_player') || null;
    } catch (err) {
      return null;
    }
  }

  function pick(obj, keys) {
    let node = obj;
    for (let i = 0; i < keys.length; i++) {
      if (!node || typeof node !== 'object') return undefined;
      node = node[keys[i]];
    }
    return node;
  }

  /*
   * A collab video's owner line is one link with no address ("A and B"); the
   * channels behind it exist only in the renderer's data, as the list its
   * Collaborators dialog opens (docs/youtube.md). Plain strings go back; the
   * content script checks them.
   */
  function readCollaborators() {
    const doc = root.document;
    if (!doc || typeof doc.querySelector !== 'function') return [];
    const owner = doc.querySelector('ytd-watch-metadata ytd-video-owner-renderer');
    const items = pick(owner && owner.data, [
      'navigationEndpoint', 'showDialogCommand', 'panelLoadingStrategy', 'inlineContent',
      'dialogViewModel', 'customContent', 'listViewModel', 'listItems',
    ]);
    if (!Array.isArray(items)) return [];
    const out = [];
    for (let i = 0; i < items.length && out.length < MAX_COLLABORATORS; i++) {
      const row = pick(items[i], ['listItemViewModel']);
      const name = pick(row, ['title', 'content']);
      const runs = pick(row, ['title', 'commandRuns']);
      const id = pick(runs, [0, 'onTap', 'innertubeCommand', 'browseEndpoint', 'browseId']);
      const subtitle = pick(row, ['subtitle', 'content']);
      // The subtitle reads "@TheDiaryOfACEO • 19.6M subscribers", with each
      // part wrapped in direction marks.
      const handle = typeof subtitle === 'string'
        ? subtitle.match(/@[^\s\u200e\u200f\u2066-\u2069\u2022]+/)
        : null;
      out.push({
        id: typeof id === 'string' ? id : '',
        name: typeof name === 'string' ? name : '',
        handle: handle ? handle[0] : '',
      });
    }
    return out;
  }

  function cleanScanTitle(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    if (trimmed.length <= MAX_CHANNEL_TITLE) return trimmed;
    return trimmed.slice(0, MAX_CHANNEL_TITLE);
  }

  function visibleChannelTitle(row) {
    if (!row || typeof row.querySelector !== 'function') return '';
    const named = row.querySelector('#text') || row.querySelector('#channel-title');
    if (!named || typeof named.textContent !== 'string') return '';
    return named.textContent;
  }

  // The path only: "/@name/videos?si=1" is "@name". Absolute hrefs do not
  // match the selector the caller uses, so they never arrive here.
  function handleFromHref(href) {
    if (typeof href !== 'string' || !href) return '';
    let path = href;
    const hash = path.indexOf('#');
    if (hash !== -1) path = path.slice(0, hash);
    const query = path.indexOf('?');
    if (query !== -1) path = path.slice(0, query);
    const scheme = path.indexOf('://');
    if (scheme !== -1) {
      const slash = path.indexOf('/', scheme + 3);
      path = slash === -1 ? '' : path.slice(slash);
    }
    const match = /\/@([^/]+)/.exec(path);
    if (!match || !match[1]) return '';
    return '@' + match[1];
  }

  function channelHandle(row) {
    if (!row || typeof row.querySelector !== 'function') return '';
    const link = row.querySelector('a[href^="/@"]');
    if (!link || typeof link.getAttribute !== 'function') return '';
    return handleFromHref(link.getAttribute('href'));
  }

  function shapeChannelRow(row) {
    const data = row && row.data;
    if (!data || typeof data !== 'object') return null;
    const button = data.subscriptionButton;
    if (!button || button.subscribed !== true) return null;
    const id = data.channelId;
    if (typeof id !== 'string' || !CHANNEL_ID_RE.test(id)) return null;
    const titleNode = data.title;
    const simple = titleNode && titleNode.simpleText;
    const title = typeof simple === 'string'
      ? cleanScanTitle(simple)
      : cleanScanTitle(visibleChannelTitle(row));
    return { id: id, title: title, handle: channelHandle(row) };
  }

  /*
   * /feed/channels groups rows under shelves whose headings are translated
   * and carry no stable id (docs/youtube.md). subscribed === true is the
   * test that does not depend on the language, and a purchased channel
   * still has it. One broken row is skipped; a broken document is [].
   */
  function readSubscribedChannels() {
    try {
      const doc = root.document;
      if (!doc || typeof doc.querySelectorAll !== 'function') return [];
      const rows = doc.querySelectorAll('ytd-channel-renderer');
      if (!rows || typeof rows.length !== 'number') return [];
      const out = [];
      const seen = Object.create(null);
      for (let i = 0; i < rows.length && out.length < MAX_SUBSCRIBED_CHANNELS; i++) {
        try {
          const shaped = shapeChannelRow(rows[i]);
          if (!shaped || seen[shaped.id]) continue;
          seen[shaped.id] = true;
          out.push(shaped);
        } catch (err) {
          // One row whose data throws is not the whole list.
        }
      }
      return out;
    } catch (err) {
      return [];
    }
  }

  function coerceSessionIndex(value) {
    if (typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value) {
      return value;
    }
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return null;
  }

  // ytcfg is the page's own object. The isolated world cannot see it, and
  // plain youtube.com is not always account 0 (docs/youtube.md).
  function readSessionIndex() {
    try {
      const cfg = root.ytcfg;
      if (!cfg || typeof cfg !== 'object') return null;
      if (typeof cfg.get === 'function') {
        const fromGet = coerceSessionIndex(cfg.get('SESSION_INDEX'));
        if (fromGet != null) return fromGet;
      }
      const data = cfg.data_;
      if (data && typeof data === 'object') {
        const fromData = coerceSessionIndex(data.SESSION_INDEX);
        if (fromData != null) return fromData;
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  function clipText(value) {
    if (typeof value !== 'string') return '';
    const trimmed = value.trim();
    return trimmed.length > 200 ? trimmed.slice(0, 200) : trimmed;
  }

  function videoIdFromHref(href) {
    if (typeof href !== 'string') return '';
    const watch = href.match(/[?&]v=([\w-]{11})/);
    if (watch) return watch[1];
    const shorts = href.match(/\/shorts\/([\w-]{11})/);
    return shorts ? shorts[1] : '';
  }

  function readWatchQueue() {
    const player = getPlayer();
    let playlistId = '';
    let index = 0;
    const ids = [];
    let videoId = '';
    let title = '';
    let channel = '';
    try {
      if (player && typeof player.getPlaylistId === 'function') {
        const id = player.getPlaylistId();
        if (typeof id === 'string') playlistId = id;
      }
      if (player && typeof player.getPlaylistIndex === 'function') {
        const n = player.getPlaylistIndex();
        if (typeof n === 'number' && isFinite(n) && n >= 0) index = Math.floor(n);
      }
      if (player && typeof player.getPlaylist === 'function') {
        const list = player.getPlaylist();
        if (Array.isArray(list)) {
          for (let i = 0; i < list.length && ids.length < 100; i++) {
            if (typeof list[i] === 'string' && VIDEO_ID_RE.test(list[i])) ids.push(list[i]);
          }
        }
      }
      if (player && typeof player.getVideoData === 'function') {
        const data = player.getVideoData();
        if (data && typeof data === 'object') {
          if (typeof data.video_id === 'string' && VIDEO_ID_RE.test(data.video_id)) videoId = data.video_id;
          title = clipText(data.title);
          channel = clipText(data.author);
          if (!playlistId && typeof data.list === 'string') playlistId = data.list;
        }
      }
    } catch (err) {
      // The player throws when it is mid-navigation.
    }
    const titles = Object.create(null);
    const channels = Object.create(null);
    try {
      const doc = root.document;
      const rows = doc && typeof doc.querySelectorAll === 'function'
        ? doc.querySelectorAll('ytd-playlist-panel-video-renderer')
        : [];
      for (let i = 0; i < rows.length && i < 100; i++) {
        const row = rows[i];
        const link = row.querySelector && row.querySelector('a#wc-endpoint, a[href*="watch?v="]');
        const id = videoIdFromHref(link && link.getAttribute('href'));
        if (!id) continue;
        const titleEl = row.querySelector('#video-title');
        const byline = row.querySelector('#byline');
        if (titleEl && titleEl.textContent) titles[id] = clipText(titleEl.textContent);
        if (byline && byline.textContent) channels[id] = clipText(byline.textContent);
      }
    } catch (err) {
      // The panel is optional. Ids from the player are enough.
    }
    const items = [];
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i];
      items.push({
        v: id,
        t: titles[id] || (id === videoId ? title : ''),
        ct: channels[id] || (id === videoId ? channel : ''),
      });
    }
    return { playlistId: playlistId, index: index, videoId: videoId, title: title, channel: channel, items: items };
  }

  // loadPlaylist updates #movie_player and leaves the queue panel as it
  // was. The panel is the page's own temporary list (id prefix TLPQ),
  // created by the same addToPlaylistCommand the Add to queue button sends.
  // Measured 2026-10-02: player 8ab5c328, watch HTML params "CAQ%3D".
  const QUEUE_LIST_TYPE = 'PLAYLIST_EDIT_LIST_TYPE_QUEUE';
  const QUEUE_WALK_BUDGET = 20000;
  const QUEUE_WALK_DEPTH = 30;
  const QUEUE_ADD_HOLD_MS = 8000;
  let queueAddKey = '';
  let queueAddAt = 0;

  function watchRoot() {
    try {
      const doc = root.document;
      if (!doc || typeof doc.querySelector !== 'function') return null;
      return doc.querySelector('ytd-watch-flexy')
        || doc.querySelector('ytd-app')
        || doc.documentElement
        || null;
    } catch (err) {
      return null;
    }
  }

  function firePageAction(name, arg) {
    const target = watchRoot();
    if (!target || typeof target.dispatchEvent !== 'function') return false;
    if (typeof root.CustomEvent !== 'function') return false;
    const action = {
      actionName: name,
      optionalAction: false,
      args: [arg, target],
      returnValue: [],
    };
    try {
      target.dispatchEvent(new root.CustomEvent('yt-action', {
        detail: action,
        bubbles: true,
        composed: true,
      }));
    } catch (err) {
      return false;
    }
    return true;
  }

  function isQueueAddCommand(cmd) {
    if (!cmd || cmd.listType !== QUEUE_LIST_TYPE) return false;
    const create = cmd.onCreateListCommand;
    const endpoint = create && create.createPlaylistServiceEndpoint;
    return !!(endpoint && typeof endpoint.params === 'string' && endpoint.params);
  }

  function findQueueAddCommand() {
    const starts = [];
    try {
      const doc = root.document;
      const flexy = doc && doc.querySelector && doc.querySelector('ytd-watch-flexy');
      if (flexy && flexy.data) starts.push(flexy.data);
      const app = doc && doc.querySelector && doc.querySelector('ytd-app');
      if (app && app.data && app.data !== (flexy && flexy.data)) starts.push(app.data);
    } catch (err) {
      // The page can throw while it is swapping documents.
    }
    if (root.ytInitialData) starts.push(root.ytInitialData);
    for (let s = 0; s < starts.length; s++) {
      const found = walkForQueueCommand(starts[s]);
      if (found) return found;
    }
    return null;
  }

  function walkForQueueCommand(start) {
    const stack = [{ node: start, depth: 0 }];
    const seen = new Set();
    let budget = QUEUE_WALK_BUDGET;
    while (stack.length && budget > 0) {
      const cur = stack.pop();
      const obj = cur.node;
      if (!obj || typeof obj !== 'object') continue;
      if (seen.has(obj)) continue;
      seen.add(obj);
      budget--;
      if (isQueueAddCommand(obj.addToPlaylistCommand)) return obj.addToPlaylistCommand;
      if (cur.depth >= QUEUE_WALK_DEPTH) continue;
      if (Array.isArray(obj)) {
        for (let i = obj.length - 1; i >= 0; i--) {
          const child = obj[i];
          if (child && typeof child === 'object') stack.push({ node: child, depth: cur.depth + 1 });
        }
        continue;
      }
      const later = [];
      let keys;
      try { keys = Object.keys(obj); } catch (err) { keys = []; }
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        if (key === 'html5PlaybackOnesieConfig' || key === 'streamingData' || key === 'captionTracks') continue;
        const child = obj[key];
        if (!child || typeof child !== 'object') continue;
        if (key === 'addToPlaylistCommand' || key === 'contents' || key === 'items' || key === 'results' || key === 'actions') {
          later.push(child);
          continue;
        }
        stack.push({ node: child, depth: cur.depth + 1 });
      }
      for (let i = 0; i < later.length; i++) {
        stack.push({ node: later[i], depth: cur.depth + 1 });
      }
    }
    return null;
  }

  function queueAddCommand(template, videoIds) {
    const first = videoIds[0];
    const create = template.onCreateListCommand;
    const endpoint = create.createPlaylistServiceEndpoint;
    return {
      addToPlaylistCommand: {
        // true matches the watch-page button. false makes the page insert
        // the playing video on its own, and then again from videoIds.
        openMiniplayer: true,
        videoId: first,
        listType: QUEUE_LIST_TYPE,
        onCreateListCommand: {
          clickTrackingParams: create.clickTrackingParams,
          commandMetadata: create.commandMetadata,
          createPlaylistServiceEndpoint: {
            videoIds: videoIds.slice(),
            params: endpoint.params,
          },
        },
        videoIds: videoIds.slice(),
        videoCommand: {
          commandMetadata: {
            webCommandMetadata: {
              url: '/watch?v=' + first,
              webPageType: 'WEB_PAGE_TYPE_WATCH',
              rootVe: 3832,
            },
          },
          watchEndpoint: { videoId: first },
        },
      },
    };
  }

  function setWatchQueue(ids) {
    if (!isVideoIdList(ids)) return false;
    const snap = readWatchQueue();
    const have = Object.create(null);
    const items = snap && Array.isArray(snap.items) ? snap.items : [];
    for (let i = 0; i < items.length; i++) {
      if (items[i] && typeof items[i].v === 'string') have[items[i].v] = true;
    }
    const missing = [];
    for (let i = 0; i < ids.length; i++) {
      if (!have[ids[i]]) missing.push(ids[i]);
    }
    if (!missing.length) return true;
    const key = missing.join(',');
    const now = Date.now();
    // The create call is a network round trip. Sending the same ids again
    // before it lands puts the video on the queue twice.
    if (key === queueAddKey && now - queueAddAt < QUEUE_ADD_HOLD_MS) return true;
    const template = findQueueAddCommand();
    if (!template) return false;
    if (!firePageAction('yt-add-to-playlist-command', queueAddCommand(template, missing))) return false;
    queueAddKey = key;
    queueAddAt = now;
    return true;
  }

  function clearWatchQueue() {
    return firePageAction('yt-end-playlist-command', {
      endPlaylistCommand: { listType: QUEUE_LIST_TYPE },
    });
  }

  function postToPage(msg) {
    try {
      win.postMessage(msg, PAGE_ORIGIN);
    } catch (err) {
      // postMessage itself must not escape.
    }
  }

  function replyReady(token) {
    postToPage({ type: token, dir: 'ready' });
  }

  function reply(token, id, payload) {
    const msg = {
      type: token,
      dir: 'response',
      id: id,
      ok: !!payload.ok,
    };
    if (payload.ok) msg.result = payload.result;
    else msg.error = payload.error || 'failed';
    postToPage(msg);
  }

  function takeAdopt(event, token) {
    adopted.add(token);
    // A second copy of this file must not answer the same token again.
    if (event && typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
    replyReady(token);
  }

  let boundPlayer = null;

  function bindQualityEvents(player) {
    if (!player || boundPlayer === player) return;
    if (typeof player.addEventListener !== 'function') return;
    boundPlayer = player;
    try {
      player.addEventListener('onPlaybackQualityChange', function (ev) {
        try {
          let quality = ev;
          if (ev && typeof ev === 'object' && ev.data != null) quality = ev.data;
          if (typeof quality !== 'string') return;
          adopted.forEach(function (token) {
            postToPage({
              type: token,
              dir: 'event',
              event: 'onPlaybackQualityChange',
              quality: quality,
            });
          });
        } catch (err) {
          // swallow
        }
      });
    } catch (err) {
      boundPlayer = null;
    }
  }

  function onMessage(event) {
    try {
      const adoptReq = readAdopt(event, win);
      if (adoptReq) {
        takeAdopt(event, adoptReq.token);
        return;
      }
      const req = readRequest(event, win);
      if (!req) return;
      if (req.method === 'collaborators') {
        reply(req.token, req.id, { ok: true, result: readCollaborators() });
        return;
      }
      if (req.method === 'subscribedChannels') {
        reply(req.token, req.id, { ok: true, result: readSubscribedChannels() });
        return;
      }
      if (req.method === 'sessionIndex') {
        reply(req.token, req.id, { ok: true, result: readSessionIndex() });
        return;
      }
      if (req.method === 'watchQueue') {
        reply(req.token, req.id, { ok: true, result: readWatchQueue() });
        return;
      }
      if (req.method === 'setWatchQueue') {
        reply(req.token, req.id, { ok: true, result: setWatchQueue(req.args[0]) === true });
        return;
      }
      if (req.method === 'clearWatchQueue') {
        reply(req.token, req.id, { ok: true, result: clearWatchQueue() === true });
        return;
      }
      const player = getPlayer();
      if (!player || typeof player[req.method] !== 'function') {
        reply(req.token, req.id, { ok: false, error: 'no player' });
        return;
      }
      bindQualityEvents(player);
      const result = player[req.method].apply(player, req.args);
      reply(req.token, req.id, { ok: true, result: result });
    } catch (err) {
      try {
        const data = event && event.data;
        const id = data && data.id;
        if (typeof id === 'number' && isFinite(id) && adopted.has(data.type)) {
          reply(data.type, id, { ok: false, error: 'failed' });
        }
      } catch (err2) {
        // swallow
      }
    }
  }

  try {
    win.addEventListener('message', onMessage, false);
  } catch (err) {
    // swallow
  }

  const api = {
    TOKEN_RE,
    PAGE_ORIGIN,
    ARITY,
    PLAYBACK_RATES,
    isQuality,
    isSeekTime,
    isPlaybackRate,
    isVolumeLevel,
    isAllowedCall,
    readAdopt,
    readRequest,
    readCollaborators,
    readSubscribedChannels,
    readSessionIndex,
    onMessage,
    hasToken: function (token) { return adopted.has(token); },
  };

  // Named API is for the Node suite only. This file runs in MAIN world,
  // so a youtube.com script that can read AudioModeBridge would know
  // this extension is installed.
  if (root.__ytcHarness) {
    try {
      Object.defineProperty(root, 'AudioModeBridge', {
        value: api,
        enumerable: false,
        configurable: true,
      });
    } catch (err) {
      root.AudioModeBridge = api;
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
