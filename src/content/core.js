/**
 * Pure audio-mode helpers shared by the content script and the Node suite.
 * Classic script, not an ES module: Chrome content scripts cannot use import.
 */

(function (root) {
  'use strict';

  // MB per minute of media consumed. Typical delivered DASH bitrates
  // (VP9 video + Opus audio), not YouTube's upload recommendations.
  // The previous constants (0.75 / 18.75 / 33.75) were upload guidance —
  // 2.5 and 4.5 Mbps — which overstated savings by roughly 2x.
  //
  //   audioMode: ~0.09 Mbps video (144p VP9) + ~0.13 Mbps audio (Opus)
  //   hd720:     ~1.2 Mbps video + audio
  //   hd1080:    ~2.2 Mbps video + audio
  //
  // Real bitrates vary widely with content; treat these as estimates.
  const DATA_RATES = {
    audioMode: 1.2,
    hd720: 10.0,
    hd1080: 17.6,
  };

  // Local time, not UTC. toISOString() rolls the day over at UTC midnight,
  // which lands mid-evening or pre-dawn depending on the offset and
  // misfiles late-night listening against the previous day.

  function pad2(n) {
    return (n < 10 ? '0' : '') + n;
  }

  function dayKey(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function monthKey(date) {
    const d = date || new Date();
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1);
  }

  function pruneOldEntries(logs, retentionDays, now) {
    if (!logs) return {};
    const cutoff = new Date(now || Date.now());
    cutoff.setDate(cutoff.getDate() - retentionDays);
    const cutoffKey = dayKey(cutoff);
    const out = {};
    for (const key of Object.keys(logs)) {
      if (key >= cutoffKey) out[key] = logs[key];
    }
    return out;
  }

  function sumLogs(logs, scope, now) {
    if (!logs) return 0;
    const prefix = monthKey(now ? new Date(now) : new Date());
    let total = 0;
    for (const key of Object.keys(logs)) {
      if (scope === 'month' && key.indexOf(prefix) !== 0) continue;
      const v = Number(logs[key]);
      if (isFinite(v)) total += v;
    }
    return total;
  }

  function computeSavings(listenedSeconds, baselineRate) {
    const minutes = Math.max(0, listenedSeconds || 0) / 60;
    const used = minutes * DATA_RATES.audioMode;
    const baseline = minutes * (baselineRate || DATA_RATES.hd720);
    return {
      usedMb: used,
      baselineMb: baseline,
      savedMb: Math.max(0, baseline - used),
    };
  }

  // Sampling video.currentTime, not a wall-clock tick. A 5s timer that
  // added 5 on every fire under-counted when background tabs throttled
  // it, and ignored playback rate (2x pulls twice the data per wall
  // second). The media-time delta is the data consumed at any rate,
  // independent of how regularly the sampler happens to run.

  const MAX_SAMPLE_GAP_S = 120; // longer implies sleep/suspend, not listening
  const MAX_RATE = 4; // beyond this a jump is a seek, not playback

  function createStatsAccumulator() {
    let lastWallMs = null;
    let lastMediaS = null;
    let listened = 0;
    let active = 0;

    function reset() {
      lastWallMs = null;
      lastMediaS = null;
    }

    return {
      // state: { currentTime, paused, ended }
      sample(state, nowMs) {
        const prevWall = lastWallMs;
        const prevMedia = lastMediaS;

        if (!state) {
          reset();
          return;
        }

        lastWallMs = nowMs;
        lastMediaS = state.currentTime;

        if (prevWall === null) return; // first sample sets the baseline

        const wallDelta = (nowMs - prevWall) / 1000;
        if (wallDelta <= 0) return;
        if (wallDelta > MAX_SAMPLE_GAP_S) return; // machine slept; don't credit it

        active += wallDelta;

        if (state.paused || state.ended) return;

        const mediaDelta = state.currentTime - prevMedia;
        if (mediaDelta <= 0) return; // paused mid-window or seeked back
        if (mediaDelta > wallDelta * MAX_RATE + 1) return; // seeked forward

        listened += mediaDelta;
      },

      // Called when playback is interrupted in a way that breaks the
      // continuity of currentTime (navigation, video element swap).
      reset,

      peek() {
        return { listened, active };
      },

      drain() {
        const out = { listened, active };
        listened = 0;
        active = 0;
        return out;
      },
    };
  }

  function formatTime(seconds) {
    if (seconds === null || seconds === undefined || isNaN(seconds)) return '0:00';
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const mStr = h > 0 ? (m < 10 ? '0' + m : '' + m) : '' + m;
    const sStr = s < 10 ? '0' + s : '' + s;
    return h > 0 ? h + ':' + mStr + ':' + sStr : mStr + ':' + sStr;
  }

  function formatData(mb, units) {
    const u = units || { gb: 'GB', mb: 'MB' };
    const v = Math.max(0, Number(mb) || 0);
    if (v >= 1024) return (v / 1024).toFixed(2) + u.gb;
    if (v > 0 && v < 1) return v.toFixed(1) + u.mb; // don't round real usage to "0MB"
    return Math.round(v) + u.mb;
  }

  function isYoutubeOrigin(url) {
    if (typeof url !== 'string') return false;
    try {
      return new URL(url).origin === 'https://www.youtube.com';
    } catch (e) {
      return false;
    }
  }

  function isWatchUrl(url) {
    if (typeof url !== 'string') return false;
    try {
      const u = new URL(url);
      return u.origin === 'https://www.youtube.com' && u.pathname === '/watch';
    } catch (e) {
      return false;
    }
  }

  // YouTube's in-page miniplayer changes the URL from /watch to / (or
  // another site path) while the player keeps running. Classify the SPA
  // navigation so the content script can carry audio mode instead of
  // treating every non-watch URL as "the player went away".
  //
  // playerPresent is a boolean the caller computes from the DOM; this
  // function never looks at the document. Look-alike origins never carry.
  //
  //   'arrive' — now on /watch
  //   'carry'  — player is still there on a www.youtube.com page (miniplayer)
  //   'depart' — left /watch and the player is gone
  //   'idle'   — any other non-watch movement
  function classifyNavigation(fromUrl, toUrl, playerPresent) {
    if (isWatchUrl(toUrl)) return 'arrive';
    if (playerPresent && isYoutubeOrigin(toUrl)) return 'carry';
    if (isWatchUrl(fromUrl)) return 'depart';
    return 'idle';
  }

  function idListContains(ids, id) {
    if (!ids || id == null) return false;
    if (Object.prototype.toString.call(ids) === '[object Array]') {
      for (let i = 0; i < ids.length; i++) {
        if (ids[i] === id) return true;
      }
      return false;
    }
    return !!ids[id];
  }

  // A tab the popup may bind to: a /watch URL, or a www.youtube.com tab
  // the caller has already identified as holding a player (miniplayer).
  function isControllableTab(tab, playerTabIds) {
    if (!tab) return false;
    if (isWatchUrl(tab.url)) return true;
    if (!isYoutubeOrigin(tab.url)) return false;
    return idListContains(playerTabIds, tab.id);
  }

  // `v` of a www.youtube.com /watch URL. Anything else, including
  // malformed input, returns null — never throws.
  function videoIdFromUrl(url) {
    if (!isWatchUrl(url)) return null;
    try {
      const id = new URL(url).searchParams.get('v');
      return id ? id : null;
    } catch (e) {
      return null;
    }
  }

  // Tab titles look like "(3) Video name - YouTube". Strip the unread
  // count and the product suffix; safe on null/undefined/empty.
  function tabTitleToVideoTitle(title) {
    if (title == null) return '';
    const s = String(title)
      .replace(/\s*-\s*YouTube\s*$/, '')
      .replace(/^\(\d+\)\s+/, '');
    return s.trim();
  }

  function findTabById(tabs, id) {
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i].id === id) return tabs[i];
    }
    return null;
  }

  function numOrZero(v) {
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  function isAudibleUnmuted(tab) {
    if (!tab || !tab.audible) return false;
    if (tab.mutedInfo && tab.mutedInfo.muted) return false;
    return true;
  }

  function compareWatchTabs(a, b) {
    const aAud = isAudibleUnmuted(a);
    const bAud = isAudibleUnmuted(b);
    if (aAud !== bAud) return aAud ? -1 : 1;

    const aAcc = numOrZero(a.lastAccessed);
    const bAcc = numOrZero(b.lastAccessed);
    if (aAcc !== bAcc) return bAcc - aAcc;

    const aWin = numOrZero(a.windowId);
    const bWin = numOrZero(b.windowId);
    if (aWin !== bWin) return aWin - bWin;

    const aIdx = numOrZero(a.index);
    const bIdx = numOrZero(b.index);
    if (aIdx !== bIdx) return aIdx - bIdx;

    // Final key so equal tabs do not depend on input order.
    return numOrZero(a.id) - numOrZero(b.id);
  }

  // Deterministic pick of which player tab the popup should control.
  // Ranking: active tab, last explicit selection, audible-unmuted,
  // most recently accessed, then windowId/index. Watch URLs always
  // qualify. Non-watch YouTube-origin tabs qualify only when listed in
  // opts.playerTabIds (miniplayer tabs the popup confirmed). Look-alike
  // origins never qualify. Does not mutate `tabs`.
  function pickTargetTab(tabs, opts) {
    opts = opts || {};
    if (!tabs || !tabs.length) return null;

    const watch = [];
    for (let i = 0; i < tabs.length; i++) {
      if (tabs[i] && isControllableTab(tabs[i], opts.playerTabIds)) watch.push(tabs[i]);
    }
    if (!watch.length) return null;

    let found;
    if (opts.activeTabId != null) {
      found = findTabById(watch, opts.activeTabId);
      if (found) return found;
    }
    if (opts.lastSelectedId != null) {
      found = findTabById(watch, opts.lastSelectedId);
      if (found) return found;
    }

    const ranked = watch.slice();
    ranked.sort(compareWatchTabs);
    return ranked[0];
  }

  // Who changed the video quality?
  //
  // The extension used to answer this with a 7-second timestamp: any change
  // reported soon after one of ours was assumed to be ours. That could not
  // work. An MSE quality switch fires loadstart/loadedmetadata/canplay, and
  // those events re-trigger the extension's own quality forcing -- so the
  // user's change arms the "this was programmatic" window about 50ms before
  // the user's change is reported, and the extension classified it as its
  // own. The result was audio mode staying on with the overlay up while the
  // video streamed at 1080p underneath.
  //
  // Identify by value instead of by time. While audio mode is on the only
  // quality it ever asks for is 144p (YouTube reports 'tiny', and 'small'
  // when 144p is unavailable), so anything else is somebody else's doing.
  //
  // 'settled' guards startup: YouTube's adaptive engine picks a high quality
  // before the extension forces it down, and that first report must not be
  // read as a user action. It becomes true the first time audio-mode quality
  // is actually observed, so policing only begins once 144p has been reached.
  function classifyQualityChange(quality, state) {
    state = state || {};
    if (quality === 'tiny' || quality === 'small') return 'audio';
    if (!state.settled) return 'settling';
    return 'user';
  }

  // Guards the custom-background feature. The value is interpolated into
  // `background: url("...")`, so quotes and backslashes must not survive,
  // and only https/data image sources are allowed.
  function sanitizeImageUrl(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (!v) return null;
    if (/["\\\r\n]/.test(v)) return null;
    let u;
    try {
      u = new URL(v);
    } catch (e) {
      return null;
    }
    if (u.protocol === 'https:') return v;
    if (u.protocol === 'data:' && /^data:image\//i.test(v)) return v;
    return null;
  }

  root.AudioModeCore = {
    DATA_RATES,
    dayKey,
    monthKey,
    pruneOldEntries,
    sumLogs,
    computeSavings,
    createStatsAccumulator,
    formatTime,
    formatData,
    isYoutubeOrigin,
    isWatchUrl,
    classifyNavigation,
    isControllableTab,
    classifyQualityChange,
    videoIdFromUrl,
    tabTitleToVideoTitle,
    pickTargetTab,
    sanitizeImageUrl,
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
