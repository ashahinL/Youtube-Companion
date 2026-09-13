/**
 * MAIN-world bridge to #movie_player. Isolated content scripts can see
 * the element but not its methods, which is the only reason this file
 * exists. It receives a request, calls the player, and posts the result
 * back. Never throws into the page.
 */

(function (root) {
  'use strict';

  // A second copy of this file would double-reply to every request.
  // AudioModeBridge is suite-only, so this flag is the browser-side guard.
  if (root.__ytcAudioBridgeInstalled) return;
  root.__ytcAudioBridgeInstalled = true;

  const BRIDGE_TYPE = 'ytc-audio-bridge';
  const PAGE_ORIGIN = 'https://www.youtube.com';
  const win = root.window || root;

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
  };

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

  // Content-script postMessage carries the page origin, not
  // chrome-extension://. Other windows and page scripts share this
  // channel, so origin, source, and shape are all checked before any call.
  function readRequest(event, expectedWindow) {
    if (!event || event.source !== expectedWindow) return null;
    if (event.origin !== PAGE_ORIGIN) return null;
    const data = event.data;
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    if (data.type !== BRIDGE_TYPE) return null;
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

  function reply(id, payload) {
    try {
      const msg = {
        type: BRIDGE_TYPE,
        dir: 'response',
        id: id,
        ok: !!payload.ok,
      };
      if (payload.ok) msg.result = payload.result;
      else msg.error = payload.error || 'failed';
      win.postMessage(msg, PAGE_ORIGIN);
    } catch (err) {
      // postMessage itself must not escape.
    }
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
          win.postMessage({
            type: BRIDGE_TYPE,
            dir: 'event',
            event: 'onPlaybackQualityChange',
            quality: quality,
          }, PAGE_ORIGIN);
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
      const req = readRequest(event, win);
      if (!req) return;
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
        if (typeof id === 'number' && isFinite(id)) {
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
    BRIDGE_TYPE,
    PAGE_ORIGIN,
    ARITY,
    PLAYBACK_RATES,
    isQuality,
    isSeekTime,
    isPlaybackRate,
    isVolumeLevel,
    isAllowedCall,
    readRequest,
    onMessage,
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
