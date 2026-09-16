/**
 * MAIN-world bridge to #movie_player. Isolated content scripts can see
 * the element but not its methods or the page's own data, which is the
 * only reason this file exists. It receives a request, calls the player
 * or reads a collab video's channel list, and posts the result back.
 * Never throws into the page. Loaded as a MAIN-world content script, so
 * it is not a web-accessible file.
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
    // Not a player method: read-only page data, answered without the player.
    collaborators: 0,
  };

  const MAX_COLLABORATORS = 10;

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

  let adopted = '';

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
    if (!adopted || data.type !== adopted) return null;
    if (data.dir !== 'request') return null;
    if (typeof data.id !== 'number' || !isFinite(data.id)) return null;
    const args = Array.isArray(data.args) ? data.args : null;
    if (!isAllowedCall(data.method, args)) return null;
    return { id: data.id, method: data.method, args: args };
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

  function reply(id, payload) {
    const msg = {
      type: adopted,
      dir: 'response',
      id: id,
      ok: !!payload.ok,
    };
    if (payload.ok) msg.result = payload.result;
    else msg.error = payload.error || 'failed';
    postToPage(msg);
  }

  function takeAdopt(event, token) {
    if (adopted) {
      if (adopted !== token) return;
      if (event && typeof event.stopImmediatePropagation === 'function') {
        event.stopImmediatePropagation();
      }
      replyReady(adopted);
      return;
    }
    adopted = token;
    if (event && typeof event.stopImmediatePropagation === 'function') {
      event.stopImmediatePropagation();
    }
    replyReady(adopted);
  }

  let boundPlayer = null;

  function bindQualityEvents(player) {
    if (!player || boundPlayer === player) return;
    if (typeof player.addEventListener !== 'function') return;
    boundPlayer = player;
    try {
      player.addEventListener('onPlaybackQualityChange', function (ev) {
        try {
          if (!adopted) return;
          let quality = ev;
          if (ev && typeof ev === 'object' && ev.data != null) quality = ev.data;
          if (typeof quality !== 'string') return;
          postToPage({
            type: adopted,
            dir: 'event',
            event: 'onPlaybackQualityChange',
            quality: quality,
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
        reply(req.id, { ok: true, result: readCollaborators() });
        return;
      }
      const player = getPlayer();
      if (!player || typeof player[req.method] !== 'function') {
        reply(req.id, { ok: false, error: 'no player' });
        return;
      }
      bindQualityEvents(player);
      const result = player[req.method].apply(player, req.args);
      reply(req.id, { ok: true, result: result });
    } catch (err) {
      try {
        const id = event && event.data && event.data.id;
        if (typeof id === 'number' && isFinite(id) && adopted) {
          reply(id, { ok: false, error: 'failed' });
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
    onMessage,
    getToken: function () { return adopted; },
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
