/**
 * MAIN-world bridge. Isolated content scripts can see the element but
 * not its methods or the page's own data, which is the only reason this
 * file exists. It receives a request, calls the player, reads a collab
 * video's channel list, reads the All subscriptions rows, or reads and
 * edits the watch-page queue, and posts the result back. Never throws
 * into the page. Loaded as a MAIN-world content script, so it is not a
 * web-accessible file.
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
    // Not player methods: page data, answered without the player.
    collaborators: 0,
    subscribedChannels: 0,
    sessionIndex: 0,
    queueSnapshot: 0,
    queueOps: 1,
    queueWatch: 1,
  };

  const MAX_COLLABORATORS = 10;
  // src/lib/backup.js MAX_BACKUP_CHANNELS. This file cannot import.
  const MAX_SUBSCRIBED_CHANNELS = 2000;
  // Same cap as src/lib/takeout.js.
  const MAX_CHANNEL_TITLE = 200;
  // The worker stores only the exact 24-character form. Anything shorter
  // is dropped here only when it cannot be a channel id at all.
  const CHANNEL_ID_RE = /^UC[\w-]{20,}$/;
  // Same shape as a watch id. Queue ops reject anything else.
  const VIDEO_ID_RE = /^[A-Za-z0-9_-]{11}$/;
  // The panel can be longer; the snapshot the popup stores is capped.
  const MAX_QUEUE_IDS = 100;
  const MAX_QUEUE_OPS = 100;
  // A quiet edit still has to finish the batch. Five seconds is the give-up,
  // not a failure the popup has to show.
  const QUEUE_WAIT_MS = 5000;
  // The page fires several signals for one redraw.
  const QUEUE_DEBOUNCE_MS = 150;

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

  function isVideoId(value) {
    return typeof value === 'string' && VIDEO_ID_RE.test(value);
  }

  function hasExactKeys(obj, names) {
    const keys = Object.keys(obj);
    if (keys.length !== names.length) return false;
    for (let i = 0; i < names.length; i++) {
      if (!Object.prototype.hasOwnProperty.call(obj, names[i])) return false;
    }
    return true;
  }

  // after is omitted, an id, or null (the top of the queue). Any other
  // shape is a different operation and is refused whole.
  function isAfterValue(value) {
    return value === null || isVideoId(value);
  }

  function isQueueOp(op) {
    if (!op || typeof op !== 'object' || Array.isArray(op)) return false;
    if (op.op === 'clear') return hasExactKeys(op, ['op']);
    if (op.op === 'remove') return hasExactKeys(op, ['op', 'v']) && isVideoId(op.v);
    if (op.op === 'move') {
      return hasExactKeys(op, ['op', 'v', 'after']) && isVideoId(op.v) && isAfterValue(op.after);
    }
    if (op.op === 'add') {
      if (!isVideoId(op.v)) return false;
      if (hasExactKeys(op, ['op', 'v'])) return true;
      return hasExactKeys(op, ['op', 'v', 'after']) && isAfterValue(op.after);
    }
    return false;
  }

  function isQueueOps(value) {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_QUEUE_OPS) return false;
    for (let i = 0; i < value.length; i++) {
      if (!isQueueOp(value[i])) return false;
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
    if (method === 'queueWatch') return typeof args[0] === 'boolean';
    if (method === 'queueOps') return isQueueOps(args[0]);
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

  // #movie_player.getPlaylist() stays on the old order until a refresh, and
  // after Clear it still lists videos the panel has dropped. The panel is
  // the list (docs/youtube.md). playlistSetVideoId never leaves this bridge:
  // it is how this page's edit endpoint names a row, and a refresh replaces it.
  function readQueueState() {
    const empty = { panel: null, listId: '', queued: [], playing: '' };
    const doc = root.document;
    if (!doc || typeof doc.querySelectorAll !== 'function') return empty;
    const panels = doc.querySelectorAll('ytd-playlist-panel-renderer');
    if (!panels || typeof panels.length !== 'number') return empty;
    let panel = null;
    for (let i = 0; i < panels.length; i++) {
      const data = panels[i] && panels[i].data;
      const id = data && data.playlistId;
      if (typeof id === 'string' && id.indexOf('TLPQ') === 0) {
        panel = panels[i];
        break;
      }
    }
    if (!panel) return empty;
    const queued = [];
    let playing = '';
    if (typeof panel.querySelectorAll === 'function') {
      const rows = panel.querySelectorAll('ytd-playlist-panel-video-renderer');
      if (rows && typeof rows.length === 'number') {
        for (let i = 0; i < rows.length; i++) {
          const data = rows[i] && rows[i].data;
          if (!data || typeof data !== 'object') continue;
          const v = data.videoId;
          if (!isVideoId(v)) continue;
          const set = data.playlistSetVideoId;
          if (typeof set === 'string' && set) queued.push({ v: v, set: set });
          else if (!playing) playing = v;
        }
      }
    }
    return { panel: panel, listId: panel.data.playlistId, queued: queued, playing: playing };
  }

  function readQueueSnapshot() {
    try {
      const state = readQueueState();
      if (!state.listId) return { listId: '', ids: [], playing: '' };
      const ids = [];
      for (let i = 0; i < state.queued.length && ids.length < MAX_QUEUE_IDS; i++) {
        ids.push(state.queued[i].v);
      }
      return { listId: state.listId, ids: ids, playing: state.playing };
    } catch (err) {
      return { listId: '', ids: [], playing: '' };
    }
  }

  function queueApp() {
    const doc = root.document;
    if (!doc || typeof doc.querySelector !== 'function') return null;
    return doc.querySelector('ytd-app');
  }

  function dispatchYtAction(target, detail) {
    if (!target || typeof target.dispatchEvent !== 'function') return;
    const Ctor = root.CustomEvent;
    if (typeof Ctor !== 'function') return;
    let ev;
    try {
      ev = new Ctor('yt-action', { bubbles: true, composed: true, detail: detail });
    } catch (err) {
      return;
    }
    try {
      target.dispatchEvent(ev);
    } catch (err) {
      // The page's own handler owns a failure of the action.
    }
  }

  function dispatchAdd(v) {
    const app = queueApp();
    if (!app) return;
    dispatchYtAction(app, {
      actionName: 'yt-add-to-playlist-command',
      args: [{
        addToPlaylistCommand: {
          openMiniplayer: false,
          videoId: v,
          listType: 'PLAYLIST_EDIT_LIST_TYPE_QUEUE',
          onCreateListCommand: {
            commandMetadata: {
              webCommandMetadata: {
                sendPost: true,
                apiUrl: '/youtubei/v1/playlist/create',
              },
            },
            createPlaylistServiceEndpoint: {
              videoIds: [v],
              params: 'CAQ%3D',
            },
          },
          videoIds: [v],
        },
      }, app],
      optionalAction: false,
      returnValue: [],
    });
  }

  function dispatchEdit(panel, playlistId, actions, params) {
    const endpoint = { playlistId: playlistId, actions: actions };
    if (params) endpoint.params = params;
    dispatchYtAction(panel, {
      actionName: 'yt-service-request',
      args: [panel, {
        commandMetadata: {
          webCommandMetadata: {
            sendPost: true,
            apiUrl: '/youtubei/v1/browse/edit_playlist',
          },
        },
        playlistEditEndpoint: endpoint,
      }],
      optionalAction: false,
      returnValue: [],
    });
  }

  function dispatchRefresh(playlistId) {
    const app = queueApp();
    if (!app) return;
    dispatchYtAction(app, {
      actionName: 'yt-refresh-playlist-command',
      args: [{ refreshPlaylistCommand: { listId: playlistId } }, app],
      optionalAction: false,
      returnValue: [],
    });
  }

  function dispatchClear(playlistId) {
    const app = queueApp();
    if (!app) return;
    dispatchYtAction(app, {
      actionName: 'yt-end-playlist-command',
      args: [{
        endPlaylistCommand: {
          closeListPanel: true,
          listId: playlistId,
          listType: 'PLAYLIST_EDIT_LIST_TYPE_QUEUE',
        },
      }, app],
      optionalAction: false,
      returnValue: [],
    });
  }

  const queueWaiters = [];
  let queueListening = false;
  let queueWatching = false;
  let queueDebounce = null;
  let queueLastPosted = null;
  // Two queueOps messages can be in flight before either batch has read the
  // panel. One chain keeps the second from editing a list the first is
  // still waiting on.
  let queueChain = null;

  function queueSignalName(event) {
    if (!event || typeof event.type !== 'string') return '';
    if (event.type === 'yt-playlist-data-updated' || event.type === 'yt-navigate-finish') {
      return event.type;
    }
    if (event.type !== 'yt-action') return '';
    const detail = event.detail;
    const name = detail && detail.actionName;
    if (name === 'yt-update-playlist-action' || name === 'yt-end-playlist-command') return name;
    return '';
  }

  function snapshotsEqual(a, b) {
    if (!a || !b) return false;
    if (a.listId !== b.listId || a.playing !== b.playing) return false;
    if (!Array.isArray(a.ids) || !Array.isArray(b.ids) || a.ids.length !== b.ids.length) return false;
    for (let i = 0; i < a.ids.length; i++) {
      if (a.ids[i] !== b.ids[i]) return false;
    }
    return true;
  }

  function postQueueChanged() {
    if (!queueWatching) return;
    let snap;
    try {
      snap = readQueueSnapshot();
    } catch (err) {
      return;
    }
    if (queueLastPosted && snapshotsEqual(queueLastPosted, snap)) return;
    queueLastPosted = snap;
    adopted.forEach(function (token) {
      postToPage({
        type: token,
        dir: 'event',
        event: 'queueChanged',
        snapshot: snap,
      });
    });
  }

  function scheduleQueuePost() {
    if (!queueWatching) return;
    if (queueDebounce != null) clearTimeout(queueDebounce);
    queueDebounce = setTimeout(function () {
      queueDebounce = null;
      postQueueChanged();
    }, QUEUE_DEBOUNCE_MS);
  }

  function onQueueSignal(event) {
    let name = '';
    try {
      name = queueSignalName(event);
    } catch (err) {
      return;
    }
    if (!name) return;
    const pending = queueWaiters.slice();
    for (let i = 0; i < pending.length; i++) {
      try {
        pending[i].match(name);
      } catch (err) {
        // One waiter failing must not drop the signal for the rest.
      }
    }
    if (queueWatching) scheduleQueuePost();
  }

  function ensureQueueListeners() {
    if (queueListening) return;
    const doc = root.document;
    if (!doc || typeof doc.addEventListener !== 'function') return;
    doc.addEventListener('yt-playlist-data-updated', onQueueSignal, false);
    doc.addEventListener('yt-navigate-finish', onQueueSignal, false);
    // Capture: that is where yt-update-playlist-action was seen on document.
    doc.addEventListener('yt-action', onQueueSignal, true);
    queueListening = true;
  }

  // Resolves on the next signal for which `pred` is true, or when the wait
  // is up. A timeout is the page staying quiet, and the batch carries on.
  function expectQueue(pred) {
    ensureQueueListeners();
    return new Promise(function (resolve) {
      let settled = false;
      const entry = {
        match: function (name) {
          let ok = false;
          try {
            ok = !!pred(name);
          } catch (err) {
            ok = false;
          }
          if (ok) finish();
        },
      };
      function finish() {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const at = queueWaiters.indexOf(entry);
        if (at !== -1) queueWaiters.splice(at, 1);
        resolve();
      }
      queueWaiters.push(entry);
      const timer = setTimeout(finish, QUEUE_WAIT_MS);
    });
  }

  function expectSignal(name) {
    return expectQueue(function (got) { return got === name; });
  }

  function expectQueued(v) {
    return expectQueue(function () {
      const snap = readQueueSnapshot();
      return snap.ids.indexOf(v) !== -1;
    });
  }

  async function runRemove(v) {
    const state = readQueueState();
    if (!state.listId) return false;
    let set = '';
    for (let i = 0; i < state.queued.length; i++) {
      if (state.queued[i].v === v) {
        set = state.queued[i].set;
        break;
      }
    }
    if (!set) return false;
    const pending = expectSignal('yt-update-playlist-action');
    dispatchEdit(state.panel, state.listId, [{
      action: 'ACTION_REMOVE_VIDEO',
      setVideoId: set,
    }], 'CAE%3D');
    await pending;
    return true;
  }

  async function runMove(v, after) {
    const state = readQueueState();
    if (!state.listId) return false;
    const rows = state.queued;
    let from = -1;
    let afterAt = -1;
    for (let i = 0; i < rows.length; i++) {
      if (from === -1 && rows[i].v === v) from = i;
      if (after != null && afterAt === -1 && rows[i].v === after) afterAt = i;
    }
    if (from === -1) return false;
    if (after == null) {
      if (from === 0) return false;
    } else if (afterAt === -1 || from === afterAt + 1) {
      return false;
    }
    const mine = rows[from].set;
    if (!mine) return false;
    let actions;
    if (after == null) {
      const successor = rows[0].set;
      if (!successor) return false;
      actions = [{
        action: 'ACTION_MOVE_VIDEO_BEFORE',
        setVideoId: mine,
        movedSetVideoIdSuccessor: successor,
      }];
    } else {
      const predecessor = rows[afterAt].set;
      if (!predecessor) return false;
      actions = [{
        action: 'ACTION_MOVE_VIDEO_AFTER',
        setVideoId: mine,
        movedSetVideoIdPredecessor: predecessor,
      }];
    }
    const pending = expectSignal('yt-update-playlist-action');
    dispatchEdit(state.panel, state.listId, actions);
    await pending;
    return true;
  }

  async function runAdd(op) {
    const snap = readQueueSnapshot();
    if (snap.ids.indexOf(op.v) !== -1) return false;
    const pending = expectQueued(op.v);
    dispatchAdd(op.v);
    await pending;
    if (!Object.prototype.hasOwnProperty.call(op, 'after')) return false;
    const now = readQueueSnapshot();
    const at = now.ids.indexOf(op.v);
    const before = at <= 0 ? null : now.ids[at - 1];
    if (before === op.after) return false;
    return runMove(op.v, op.after);
  }

  async function runClear() {
    const snap = readQueueSnapshot();
    if (!snap.listId) return false;
    const pending = expectSignal('yt-playlist-data-updated');
    dispatchClear(snap.listId);
    await pending;
    return true;
  }

  // The panel does not redraw after a remove or a move until something
  // asks it to. One refresh at the end of the batch is enough; Clear has
  // already dropped the list, so there is nothing left to redraw.
  async function refreshQueue() {
    const snap = readQueueSnapshot();
    if (!snap.listId) return;
    const pending = expectSignal('yt-playlist-data-updated');
    dispatchRefresh(snap.listId);
    await pending;
  }

  async function performQueueOps(ops) {
    let edited = false;
    for (let i = 0; i < ops.length; i++) {
      const op = ops[i];
      if (op.op === 'add') {
        if (await runAdd(op)) edited = true;
      } else if (op.op === 'remove') {
        if (await runRemove(op.v)) edited = true;
      } else if (op.op === 'move') {
        if (await runMove(op.v, op.after)) edited = true;
      } else if (op.op === 'clear') {
        await runClear();
      }
    }
    if (edited) await refreshQueue();
    return readQueueSnapshot();
  }

  function runQueueOps(ops) {
    const prev = queueChain || Promise.resolve();
    const job = prev.then(function () {
      return performQueueOps(ops);
    });
    queueChain = job.then(function () { return null; }, function () { return null; });
    return job;
  }

  function queueWatch(on) {
    if (on) {
      queueWatching = true;
      ensureQueueListeners();
    } else {
      queueWatching = false;
      if (queueDebounce != null) {
        clearTimeout(queueDebounce);
        queueDebounce = null;
      }
    }
    return readQueueSnapshot();
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
      if (req.method === 'queueSnapshot') {
        reply(req.token, req.id, { ok: true, result: readQueueSnapshot() });
        return;
      }
      if (req.method === 'queueOps') {
        runQueueOps(req.args[0]).then(function (snap) {
          reply(req.token, req.id, { ok: true, result: snap });
        }, function () {
          reply(req.token, req.id, { ok: false, error: 'failed' });
        });
        return;
      }
      if (req.method === 'queueWatch') {
        reply(req.token, req.id, { ok: true, result: queueWatch(req.args[0]) });
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
    readQueueSnapshot,
    runQueueOps,
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
