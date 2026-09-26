/**
 * Isolated-world audio-mode engine, the scan of the All subscriptions
 * page, and group chips on the subscriptions feed. Pins the player to
 * 144p, covers the video, accounts listening time, and tears the session
 * down on one AbortSignal. Also tells the worker when the main video
 * ends, so a listen-later queue can advance.
 * Classic script: content scripts cannot use import.
 */

(function (root) {
  'use strict';

  const Core = root.AudioModeCore;
  if (!Core) return;

  const PAGE_ORIGIN = 'https://www.youtube.com';
  const OVERLAY_ID = 'ytc-audio-overlay';
  const AUDIO_STATS_KEY = 'audioStats';
  const AUDIO_STATS_RETENTION_DAYS = 90;
  const SAMPLE_MS = 5000;
  const FLUSH_MS = 30000;
  const CALL_TIMEOUT_MS = 1500;
  const BRIDGE_READY_MS = 1500;
  const BRIDGE_RETRY_MS = 50;
  // 32 random bytes, hex. A page can still watch postMessage; there is no
  // fixed name to search for. That is not secrecy.
  const TOKEN_RE = /^[0-9a-f]{64}$/;
  const PIN_SETTLE_MS = 250;
  const MENU_WAIT_MS = 150;
  const DEFAULT_RESTORE = 'hd720';
  const DEFAULT_PRESET = 'midnight';
  const CHANNEL_ID_RE = /^UC[\w-]{22}$/;
  // Shape only: YouTube handles take letters from many scripts.
  const HANDLE_RE = /^@[^\s\/?#@]{1,100}$/;
  const MAX_COLLABORATORS = 10;
  // A collab list that came back empty is asked for again after this long;
  // one that arrived is kept for as long as the same video shows the same line.
  const COLLAB_RETRY_MS = 5000;
  const SLEEP_MINUTES = [15, 30, 60];

  const PRESETS = {
    midnight: { from: '#0f0f14', to: '#1e1e28' },
    slate: { from: '#17171f', to: '#3a3a48' },
    ember: { from: '#14080a', to: '#8c1220' },
    amber: { from: '#141007', to: '#8a6210' },
    forest: { from: '#081410', to: '#14763a' },
    sunset: { from: '#96630d', to: '#7a1020' },
  };

  const QUALITY_SET = {
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

  function fallbackQuality(fallback) {
    if (typeof fallback === 'string' && QUALITY_SET[fallback]) return fallback;
    return DEFAULT_RESTORE;
  }

  function restoreFallbackFromSettings(settings) {
    const audio = settings && typeof settings === 'object' ? settings.audio : null;
    const q = audio && typeof audio === 'object' ? audio.restoreQuality : null;
    return fallbackQuality(q);
  }

  // tiny and small are what audio mode itself asks for, so restoring to
  // one cannot be told apart from not restoring at all. Adaptive
  // streaming also reports them in the first seconds of a page load,
  // before the player has climbed. Someone who genuinely chose 144p
  // therefore gets the configured fallback (hd720 by default) instead.
  function restorableQuality(captured, fallback) {
    if (
      typeof captured === 'string'
      && QUALITY_SET[captured]
      && captured !== 'tiny'
      && captured !== 'small'
    ) {
      return captured;
    }
    return fallbackQuality(fallback);
  }

  let session = null;
  let gate = Promise.resolve();
  let bridgePromise = null;
  let bridgeToken = '';
  let bootOnce = null;
  const overlayByLocale = Object.create(null);
  let collabCache = null;
  // The sleep timer lives in the tab, so it keeps counting after the popup
  // closes. A hidden tab's timers can run up to a minute late.
  let sleepTimer = null;
  let sleepAt = 0;
  let nextCallId = 1;
  const pending = new Map();

  function normalizeLevels(levels) {
    if (Array.isArray(levels)) {
      const out = [];
      for (let i = 0; i < levels.length; i++) out.push(String(levels[i]));
      return out;
    }
    if (typeof levels === 'string' && levels) {
      return levels.split(/[,\s]+/).filter(Boolean);
    }
    return [];
  }

  function pickAudioQuality(levels) {
    const list = normalizeLevels(levels);
    if (list.indexOf('tiny') !== -1) return 'tiny';
    if (list.indexOf('small') !== -1) return 'small';
    return 'tiny';
  }

  function lookupPreset(name) {
    if (typeof name !== 'string') {
      return { name: DEFAULT_PRESET, from: PRESETS[DEFAULT_PRESET].from, to: PRESETS[DEFAULT_PRESET].to };
    }
    const key = name.trim().toLowerCase();
    if (PRESETS[key]) return { name: key, from: PRESETS[key].from, to: PRESETS[key].to };
    return { name: DEFAULT_PRESET, from: PRESETS[DEFAULT_PRESET].from, to: PRESETS[DEFAULT_PRESET].to };
  }

  function sanitizeHex(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (/^#[0-9a-fA-F]{6}$/.test(v)) return '#' + v.slice(1).toLowerCase();
    if (/^#[0-9a-fA-F]{3}$/.test(v)) {
      const r = v.charAt(1);
      const g = v.charAt(2);
      const b = v.charAt(3);
      return ('#' + r + r + g + g + b + b).toLowerCase();
    }
    return null;
  }

  // Only a data URL is painted. An https cover would make youtube.com
  // fetch a third-party host whenever audio mode is on.
  function coverDataUrl(value) {
    if (typeof value !== 'string') return null;
    const v = value.trim();
    if (!v) return null;
    if (/["\\\r\n]/.test(v)) return null;
    if (!/^data:image\//i.test(v)) return null;
    return v;
  }

  function overlayLookFromSettings(settings, cover) {
    const audio = settings && typeof settings === 'object' ? settings.audio : null;
    const group = audio && typeof audio === 'object' ? audio : {};
    const type = typeof group.backgroundType === 'string'
      ? group.backgroundType.trim().toLowerCase()
      : 'color';

    if (type === 'image') {
      const url = coverDataUrl(cover);
      if (url) return { kind: 'image', url: url, preset: DEFAULT_PRESET };
    }

    if (group.preset === 'custom' || type === 'custom') {
      const color = sanitizeHex(group.customColor || group.color);
      if (color) return { kind: 'color', color: color, preset: DEFAULT_PRESET };
    }

    const preset = lookupPreset(group.preset);
    return { kind: 'preset', preset: preset.name, from: preset.from, to: preset.to };
  }

  // Same rule as lib/i18n.js resolveLocale. Copied because content scripts
  // cannot import, and chrome.i18n.getMessage follows the browser language.
  function resolveLocale(setting, navigatorLanguage) {
    if (setting === 'en' || setting === 'ar') return setting;
    const lang = String(navigatorLanguage || '').toLowerCase();
    return lang.startsWith('ar') ? 'ar' : 'en';
  }

  function localeFromSettings(settings, navigatorLanguage) {
    const ui = settings && typeof settings === 'object' ? settings.ui : null;
    const setting = ui && typeof ui === 'object' ? ui.locale : null;
    return resolveLocale(setting, navigatorLanguage);
  }

  function navigatorLanguage() {
    try {
      const nav = root.navigator;
      return (nav && nav.language) || '';
    } catch (err) {
      return '';
    }
  }

  function messageOf(pack, key, substitutions) {
    if (!pack || typeof pack !== 'object') return '';
    const text = pack[key];
    if (typeof text !== 'string' || !text) return '';
    const subs = substitutions == null ? [] : [].concat(substitutions);
    return text
      .replace(/\$(\d+)\$/g, function (_, n) {
        const idx = Number(n) - 1;
        return idx >= 0 && idx < subs.length ? String(subs[idx]) : '';
      })
      .replace(/\$(\d+)/g, function (_, n) {
        const idx = Number(n) - 1;
        return idx >= 0 && idx < subs.length ? String(subs[idx]) : '';
      });
  }

  function boundShortcut(value) {
    return typeof value === 'string' ? value.trim() : '';
  }

  function exitLabel(pack, shortcut) {
    const bound = boundShortcut(shortcut);
    if (bound) return messageOf(pack, 'overlayExitShortcut', [bound]);
    return messageOf(pack, 'overlayExit');
  }

  function overlayCopy(settings, pack, shortcut, navigatorLanguageValue) {
    const locale = localeFromSettings(settings, navigatorLanguageValue);
    return {
      locale: locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      title: messageOf(pack, 'overlayTitle'),
      exit: exitLabel(pack, shortcut),
    };
  }

  function rememberOverlayReply(reply) {
    if (!reply || typeof reply !== 'object') return;
    const overlays = reply.overlays;
    if (overlays && typeof overlays === 'object') {
      if (overlays.en && typeof overlays.en === 'object') overlayByLocale.en = overlays.en;
      if (overlays.ar && typeof overlays.ar === 'object') overlayByLocale.ar = overlays.ar;
    }
    if (reply.overlay && typeof reply.overlay === 'object') {
      const loc = reply.locale === 'ar' ? 'ar' : 'en';
      overlayByLocale[loc] = reply.overlay;
    }
  }

  async function overlayPackFor(locale) {
    const loc = locale === 'ar' ? 'ar' : 'en';
    if (overlayByLocale[loc]) return overlayByLocale[loc];
    await requestAudioModeBoot();
    if (overlayByLocale[loc]) return overlayByLocale[loc];
    try {
      const ch = root.chrome;
      if (!ch || !ch.runtime || typeof ch.runtime.sendMessage !== 'function') {
        return overlayByLocale[loc] || null;
      }
      const reply = await ch.runtime.sendMessage({ type: 'audioMode.boot' });
      rememberOverlayReply(reply);
      return overlayByLocale[loc] || null;
    } catch (err) {
      return overlayByLocale[loc] || null;
    }
  }

  let shortcutOnce = null;

  // Once per page: the binding does not change while this script lives, and
  // suggested_key is not a substitute for what Chrome actually registered.
  function requestAudioModeShortcut() {
    if (shortcutOnce) return shortcutOnce;
    shortcutOnce = (async function () {
      try {
        const ch = root.chrome;
        if (!ch || !ch.runtime || typeof ch.runtime.sendMessage !== 'function') return '';
        const res = await ch.runtime.sendMessage({ type: 'audioMode.shortcut' });
        if (!res || res.ok === false) return '';
        return boundShortcut(res.shortcut);
      } catch (err) {
        return '';
      }
    })();
    return shortcutOnce;
  }

  const OVERLAY_ICON_SVG =
    '<svg class="ytc-audio-icon" viewBox="0 0 48 48" aria-hidden="true" focusable="false">' +
    '<path fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" d="M8 24a16 16 0 0 1 32 0"/>' +
    '<path fill="currentColor" d="M8 24v8.5A4.5 4.5 0 0 0 12.5 37h2A3.5 3.5 0 0 0 18 33.5V27a3 3 0 0 0-3-3H8z"/>' +
    '<path fill="currentColor" d="M40 24v8.5A4.5 4.5 0 0 1 35.5 37h-2A3.5 3.5 0 0 1 30 33.5V27a3 3 0 0 1 3-3h7z"/>' +
    '</svg>';

  function stopFaceEvent(ev) {
    try {
      if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
    } catch (err) {
      // swallow
    }
  }

  function onFaceExit(ev) {
    stopFaceEvent(ev);
    try {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    } catch (err) {
      // swallow
    }
    toggle();
  }

  function ensureFace(el) {
    if (!el || typeof el.querySelector !== 'function') return;
    if (el.querySelector('.ytc-audio-face')) return;
    const face = document.createElement('div');
    face.className = 'ytc-audio-face';
    face.innerHTML = OVERLAY_ICON_SVG +
      '<p class="ytc-audio-title"></p>' +
      '<button type="button" class="ytc-audio-exit"></button>';
    const btn = face.querySelector('.ytc-audio-exit');
    if (btn) {
      btn.addEventListener('click', onFaceExit);
      btn.addEventListener('mousedown', stopFaceEvent);
      btn.addEventListener('dblclick', stopFaceEvent);
    }
    el.appendChild(face);
  }

  async function paintFace(el, settings) {
    if (!el) return;
    const nav = navigatorLanguage();
    const locale = localeFromSettings(settings, nav);
    try {
      el.setAttribute('dir', locale === 'ar' ? 'rtl' : 'ltr');
      el.setAttribute('lang', locale);
    } catch (err) {
      // swallow
    }
    const pack = await overlayPackFor(locale);
    const shortcut = await requestAudioModeShortcut();
    let node = null;
    try { node = document.getElementById(OVERLAY_ID); } catch (err) { node = null; }
    if (!node || node !== el) return;
    const copy = overlayCopy(settings, pack, shortcut, nav);
    try {
      node.setAttribute('dir', copy.dir);
      node.setAttribute('lang', copy.locale);
      const title = node.querySelector('.ytc-audio-title');
      const btn = node.querySelector('.ytc-audio-exit');
      if (title) title.textContent = copy.title;
      if (btn) btn.textContent = copy.exit;
    } catch (err) {
      // swallow
    }
  }

  function scheduleOverlayPaint(el) {
    readStoredLook().then(function (stored) {
      const node = document.getElementById(OVERLAY_ID);
      if (!node) return;
      applyLook(node, overlayLookFromSettings(stored.settings, stored.cover));
      paintFace(node, stored.settings);
    });
  }

  function mergeAudioStats(stored, delta, now) {
    const listenedIn = stored && stored.listened && typeof stored.listened === 'object'
      ? stored.listened
      : {};
    const activeIn = stored && stored.active && typeof stored.active === 'object'
      ? stored.active
      : {};
    const listened = {};
    const active = {};
    for (const key of Object.keys(listenedIn)) listened[key] = listenedIn[key];
    for (const key of Object.keys(activeIn)) active[key] = activeIn[key];

    const when = now instanceof Date ? now : new Date(now || Date.now());
    const day = Core.dayKey(when);
    const addL = Math.max(0, Number(delta && delta.listened) || 0);
    const addA = Math.max(0, Number(delta && delta.active) || 0);
    if (addL) listened[day] = (Number(listened[day]) || 0) + addL;
    if (addA) active[day] = (Number(active[day]) || 0) + addA;

    const storedTotals = stored && stored.totals && typeof stored.totals === 'object'
      ? stored.totals
      : null;
    // Seed from the unpruned maps so a record written before totals
    // existed does not lose days that this merge is about to drop.
    const totals = storedTotals
      ? {
        listened: Math.max(0, Number(storedTotals.listened) || 0) + addL,
        active: Math.max(0, Number(storedTotals.active) || 0) + addA,
      }
      : {
        listened: Core.sumLogs(listened, 'all'),
        active: Core.sumLogs(active, 'all'),
      };

    const at = when.getTime();
    return {
      listened: Core.pruneOldEntries(listened, AUDIO_STATS_RETENTION_DAYS, at),
      active: Core.pruneOldEntries(active, AUDIO_STATS_RETENTION_DAYS, at),
      totals: totals,
    };
  }

  let writeChain = Promise.resolve();

  async function persistAudioStats(delta, now) {
    const addL = Math.max(0, Number(delta && delta.listened) || 0);
    const addA = Math.max(0, Number(delta && delta.active) || 0);
    if (!addL && !addA) return null;

    const run = async () => {
      const ch = root.chrome;
      if (!ch || !ch.storage || !ch.storage.local) return null;
      const got = await ch.storage.local.get(AUDIO_STATS_KEY);
      const next = mergeAudioStats(got && got[AUDIO_STATS_KEY], delta, now);
      await ch.storage.local.set({ [AUDIO_STATS_KEY]: next });
      return next;
    };

    const job = writeChain.then(run, run);
    writeChain = job.then(function () {}, function () {});
    return job;
  }

  function wait(ms, signal) {
    return new Promise(function (resolve) {
      if (signal && signal.aborted) {
        resolve();
        return;
      }
      const id = setTimeout(resolve, ms);
      if (signal) {
        signal.addEventListener('abort', function () {
          clearTimeout(id);
          resolve();
        }, { once: true });
      }
    });
  }

  function callPlayer(method, args) {
    const win = root.window || root;
    if (!win || typeof win.postMessage !== 'function') return Promise.resolve(undefined);
    const id = nextCallId++;
    return new Promise(function (resolve) {
      const timer = setTimeout(function () {
        pending.delete(id);
        resolve(undefined);
      }, CALL_TIMEOUT_MS);
      pending.set(id, { resolve: resolve, timer: timer });
      try {
        if (!bridgeToken) {
          pending.delete(id);
          clearTimeout(timer);
          resolve(undefined);
          return;
        }
        win.postMessage({
          type: bridgeToken,
          dir: 'request',
          id: id,
          method: method,
          args: Array.isArray(args) ? args : [],
        }, PAGE_ORIGIN);
      } catch (err) {
        pending.delete(id);
        clearTimeout(timer);
        resolve(undefined);
      }
    });
  }

  function onBridgeMessage(event) {
    try {
      const win = root.window || root;
      if (event.source !== win) return;
      if (event.origin !== PAGE_ORIGIN) return;
      const data = event.data;
      if (!data || typeof data !== 'object') return;
      if (!bridgeToken || data.type !== bridgeToken) return;
      if (data.dir === 'response') {
        const waitOn = pending.get(data.id);
        if (!waitOn) return;
        pending.delete(data.id);
        clearTimeout(waitOn.timer);
        waitOn.resolve(data.ok ? data.result : undefined);
        return;
      }
      if (data.dir === 'event' && data.event === 'onPlaybackQualityChange') {
        onQualityChange(data.quality);
      }
    } catch (err) {
      // swallow
    }
  }

  function onQualityChange(quality) {
    if (!session) return;
    const kind = Core.classifyQualityChange(quality, { settled: session.settled });
    if (kind === 'audio') {
      session.settled = true;
      return;
    }
    if (kind === 'user') {
      gate = gate.then(function () { return disable(); }).catch(function () {});
    }
  }

  function findVideo() {
    try {
      const player = document.getElementById('movie_player');
      if (!player) return null;
      return player.querySelector('video.html5-main-video') || player.querySelector('video') || null;
    } catch (err) {
      return null;
    }
  }

  function findMoviePlayer() {
    try {
      return document.getElementById('movie_player') || null;
    } catch (err) {
      return null;
    }
  }

  const PLAYER_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  function isPlayerRate(value) {
    if (typeof value !== 'number' || !isFinite(value)) return false;
    for (let i = 0; i < PLAYER_RATES.length; i++) {
      if (PLAYER_RATES[i] === value) return true;
    }
    return false;
  }

  function isSeekTime(value) {
    return typeof value === 'number' && isFinite(value) && value >= 0;
  }

  function isVolumeLevel(value) {
    return typeof value === 'number'
      && isFinite(value)
      && value >= 0
      && value <= 100
      && Math.floor(value) === value;
  }

  function finiteOr(value, fallback) {
    const n = Number(value);
    return isFinite(n) ? n : fallback;
  }

  // #movie_player and its <video> stay in the DOM after an in-page
  // navigation to /; currentSrc is empty and duration is NaN there.
  function videoHasMedia(video) {
    if (!video) return false;
    const src = video.currentSrc;
    if (typeof src !== 'string' || !src) return false;
    const duration = Number(video.duration);
    return isFinite(duration) && duration > 0;
  }

  // <video>.volume is YouTube's level times a per-video loudness
  // factor (100 → 0.4629 on the measured video). The slider's
  // aria-valuenow is the integer the user set.
  function readVolumeNow() {
    try {
      const player = findMoviePlayer();
      if (!player || typeof player.querySelector !== 'function') return null;
      const panel = player.querySelector('.ytp-volume-panel');
      if (!panel || typeof panel.getAttribute !== 'function') return null;
      const raw = panel.getAttribute('aria-valuenow');
      if (raw == null || raw === '') return null;
      const n = Number(raw);
      if (!isFinite(n) || n < 0 || n > 100 || Math.floor(n) !== n) return null;
      return n;
    } catch (err) {
      return null;
    }
  }

  function collapse(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  // LRM/RLM, embeddings, isolates. A name or the owner line can wrap an
  // RTL run in these; they are not part of the name and would make a
  // collapsed indexOf miss.
  function stripMarks(text) {
    return String(text || '').replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '');
  }

  /*
   * The owner line under the video. A normal video's is a link to the
   * channel; a collab video's is one link with no address, "A and B", beside
   * a stack of avatars. The avatar stack stays in the page after moving on to
   * a normal video, so the missing address is what marks a collab. On an
   * in-page move the address bar changes first and the line follows, on a
   * slow page seconds later, together with ytd-watch-flexy's video-id
   * (docs/youtube.md); until they match, the line belongs to the last video.
   */
  function readOwner(videoId) {
    try {
      const doc = root.document;
      if (!doc || typeof doc.querySelector !== 'function') return null;
      const flexy = doc.querySelector('ytd-watch-flexy');
      const shown = flexy && typeof flexy.getAttribute === 'function' ? flexy.getAttribute('video-id') : null;
      if (videoId && shown && shown !== videoId) return { stale: true, collab: false, text: '', href: '' };
      const owner = doc.querySelector('ytd-watch-metadata ytd-video-owner-renderer');
      if (!owner || typeof owner.querySelector !== 'function') return null;
      const links = typeof owner.querySelectorAll === 'function' ? owner.querySelectorAll('a') : [];
      let text = '';
      let href = '';
      for (let i = 0; i < links.length; i++) {
        const link = links[i];
        if (!text) text = collapse(link.textContent);
        const target = typeof link.getAttribute === 'function' ? link.getAttribute('href') : '';
        if (!href && target) href = String(target);
      }
      const collab = !href && !!owner.querySelector('yt-avatar-stack-view-model');
      return { collab: collab, text: text, href: href };
    } catch (err) {
      return null;
    }
  }

  function readChannelName(owner) {
    if (owner && owner.stale) return '';
    try {
      const doc = root.document;
      if (!doc || typeof doc.querySelector !== 'function') return '';
      const sels = [
        '#upload-info #channel-name a',
        'ytd-video-owner-renderer ytd-channel-name a',
        'ytd-channel-name a',
        'ytd-miniplayer #channel-name',
      ];
      for (let i = 0; i < sels.length; i++) {
        const el = doc.querySelector(sels[i]);
        const text = el && el.textContent ? String(el.textContent).trim() : '';
        if (text) return text;
      }
    } catch (err) {
      return '';
    }
    return owner ? owner.text : '';
  }

  /** A normal video's channel, from its owner link: `/@handle` or `/channel/UC…`. */
  function ownerChannel(owner) {
    if (!owner || owner.collab || !owner.href || !owner.text) return null;
    try {
      const parts = new URL(owner.href, PAGE_ORIGIN).pathname.split('/').filter(Boolean);
      if (parts[0] === 'channel' && CHANNEL_ID_RE.test(parts[1] || '')) {
        return { id: parts[1], handle: '', name: owner.text };
      }
      const head = decodeURIComponent(parts[0] || '');
      if (HANDLE_RE.test(head)) return { id: '', handle: head, name: owner.text };
    } catch (err) {
      return null;
    }
    return null;
  }

  /**
   * The bridge's answer is page data, so it is checked here: real channel ids,
   * short names, more than one row. Right after an in-page move the renderer
   * can still hold the previous video's list; the line on screen is what
   * rules that out. Only the first name has to appear in it. Two-channel
   * lines read "A and B"; three or more read "<first> and N more", and those
   * last words follow the UI language, so later names are often absent.
   * Direction marks on a name or on the line are ignored for that check;
   * the returned name is still only collapsed.
   */
  function cleanCollaborators(list, ownerText) {
    if (!Array.isArray(list)) return [];
    const line = collapse(ownerText);
    const lineKey = stripMarks(line);
    const seen = Object.create(null);
    const out = [];
    let checkedFirst = false;
    for (let i = 0; i < list.length && out.length < MAX_COLLABORATORS; i++) {
      const row = list[i];
      if (!row || typeof row !== 'object') continue;
      const id = typeof row.id === 'string' ? row.id : '';
      const name = typeof row.name === 'string' ? collapse(row.name) : '';
      if (!name) continue;
      if (!checkedFirst) {
        checkedFirst = true;
        if (line && lineKey.indexOf(stripMarks(name)) < 0) return [];
      }
      if (!CHANNEL_ID_RE.test(id) || name.length > 200 || seen[id]) continue;
      seen[id] = true;
      const handle = typeof row.handle === 'string' && HANDLE_RE.test(row.handle) ? row.handle : '';
      out.push({ id: id, handle: handle, name: name });
    }
    return out.length > 1 ? out : [];
  }

  async function readCollaborators(owner, videoId) {
    const key = videoId + '\n' + owner.text;
    const now = Date.now();
    if (collabCache && collabCache.key === key
      && (collabCache.list.length || now - collabCache.at < COLLAB_RETRY_MS)) {
      return collabCache.list;
    }
    await ensureBridge();
    const list = cleanCollaborators(await callPlayer('collaborators', []), owner.text);
    collabCache = { key: key, list: list, at: now };
    return list;
  }

  function readVideoId() {
    try {
      const href = root.location && root.location.href;
      const fromUrl = Core.videoIdFromUrl(href);
      if (fromUrl) return fromUrl;
      const doc = root.document;
      if (!doc || typeof doc.querySelector !== 'function') return '';
      const link = doc.querySelector('#movie_player a.ytp-title-link')
        || doc.querySelector('ytd-miniplayer a[href*="/watch?v="]');
      if (!link) return '';
      const href2 = link.href || (typeof link.getAttribute === 'function' ? link.getAttribute('href') : '');
      if (!href2) return '';
      const abs = Core.videoIdFromUrl(href2);
      if (abs) return abs;
      const u = new URL(href2, PAGE_ORIGIN);
      const id = u.searchParams.get('v');
      return id ? id : '';
    } catch (err) {
      return '';
    }
  }

  function readPlayer(owner) {
    const video = findVideo();
    if (!video || !videoHasMedia(video)) return { ok: false, on: !!session };
    const videoId = readVideoId() || '';
    if (owner === undefined) owner = readOwner(videoId);
    const single = ownerChannel(owner);
    let title = '';
    try {
      title = Core.tabTitleToVideoTitle(root.document && root.document.title);
    } catch (err) {
      title = '';
    }
    return {
      ok: true,
      on: !!session,
      paused: !!video.paused,
      currentTime: Math.max(0, finiteOr(video.currentTime, 0)),
      duration: Math.max(0, finiteOr(video.duration, 0)),
      playbackRate: finiteOr(video.playbackRate, 1),
      volume: readVolumeNow(),
      muted: !!video.muted,
      title: title,
      channel: readChannelName(owner),
      // The channels the page credits: a normal video's one channel, or,
      // after readPlayerWithChannels, every channel of a collab video.
      collab: !!(owner && owner.collab),
      channels: single ? [single] : [],
      videoId: videoId,
      sleepAt: sleepAt,
    };
  }

  function setSleep(minutes) {
    if (sleepTimer) clearTimeout(sleepTimer);
    sleepTimer = null;
    sleepAt = 0;
    if (!minutes) return;
    const ms = minutes * 60000;
    sleepAt = Date.now() + ms;
    sleepTimer = setTimeout(function () {
      sleepTimer = null;
      sleepAt = 0;
      controlPlayer({ action: 'pause' }).catch(function () {});
    }, ms);
  }

  async function readPlayerWithChannels() {
    const owner = readOwner(readVideoId() || '');
    const state = readPlayer(owner);
    if (state.ok && state.collab) state.channels = await readCollaborators(owner, state.videoId);
    return state;
  }

  function parseControl(msg) {
    if (!msg || typeof msg !== 'object') return null;
    const action = msg.action;
    if (action === 'play' || action === 'pause') return { action: action };
    if (action === 'seek') {
      if (!isSeekTime(msg.time)) return null;
      return { action: 'seek', time: msg.time };
    }
    if (action === 'speed') {
      if (!isPlayerRate(msg.rate)) return null;
      return { action: 'speed', rate: msg.rate };
    }
    if (action === 'volume') {
      if (!isVolumeLevel(msg.volume)) return null;
      return { action: 'volume', volume: msg.volume };
    }
    if (action === 'sleep') {
      if (msg.minutes !== 0 && SLEEP_MINUTES.indexOf(msg.minutes) < 0) return null;
      return { action: 'sleep', minutes: msg.minutes };
    }
    return null;
  }

  async function controlPlayer(msg) {
    const parsed = parseControl(msg);
    if (!parsed) return { ok: false };
    if (!findMoviePlayer()) return { ok: false };
    if (parsed.action === 'sleep') {
      setSleep(parsed.minutes);
      return { ok: true, sleepAt: sleepAt };
    }
    await ensureBridge();
    if (parsed.action === 'play') {
      await callPlayer('playVideo');
      return { ok: true };
    }
    if (parsed.action === 'pause') {
      await callPlayer('pauseVideo');
      return { ok: true };
    }
    if (parsed.action === 'seek') {
      await callPlayer('seekTo', [parsed.time]);
      return { ok: true };
    }
    if (parsed.action === 'speed') {
      await callPlayer('setPlaybackRate', [parsed.rate]);
      return { ok: true };
    }
    if (parsed.action === 'volume') {
      // setVolume does not unmute. Mute keeps the level, matching
      // YouTube's own mute button.
      if (parsed.volume === 0) {
        await callPlayer('mute');
        return { ok: true };
      }
      await callPlayer('setVolume', [parsed.volume]);
      await callPlayer('unMute');
      return { ok: true };
    }
    return { ok: false };
  }

  function videoState() {
    const video = findVideo();
    if (!video) return null;
    return {
      currentTime: video.currentTime,
      paused: video.paused,
      ended: video.ended,
    };
  }

  function sample(current) {
    if (!current || !current.accumulator) return;
    current.accumulator.sample(videoState(), Date.now());
  }

  function applyLook(el, look) {
    if (!el || !look) return;
    el.style.backgroundImage = '';
    el.style.removeProperty('--ytc-audio-custom-color');
    if (look.kind === 'image') {
      const url = coverDataUrl(look.url);
      if (url) {
        el.dataset.kind = 'image';
        el.dataset.preset = look.preset || DEFAULT_PRESET;
        el.style.backgroundImage = 'url("' + url + '")';
        return;
      }
    }
    if (look.kind === 'color') {
      el.dataset.kind = 'color';
      el.dataset.preset = look.preset || DEFAULT_PRESET;
      el.style.setProperty('--ytc-audio-custom-color', look.color);
      return;
    }
    el.dataset.kind = 'preset';
    el.dataset.preset = look.preset || DEFAULT_PRESET;
  }

  async function readStoredSettings() {
    try {
      const ch = root.chrome;
      if (!ch || !ch.storage || !ch.storage.local) return null;
      const got = await ch.storage.local.get('settings');
      return got && got.settings ? got.settings : null;
    } catch (err) {
      return null;
    }
  }

  async function readStoredLook() {
    try {
      const ch = root.chrome;
      if (!ch || !ch.storage || !ch.storage.local) return { settings: null, cover: '' };
      const got = await ch.storage.local.get(['settings', 'audioCover']);
      return {
        settings: got && got.settings ? got.settings : null,
        cover: got ? got.audioCover : '',
      };
    } catch (err) {
      return { settings: null, cover: '' };
    }
  }

  // .html5-video-container is 1879×0 on a live watch page: its <video>
  // child is position:absolute, so the box has no in-flow height. The
  // overlay is inset:0, so hanging it there paints nothing. #movie_player
  // is the positioning context that actually has size (1879×995).
  function findOverlayParent() {
    try {
      return document.getElementById('movie_player');
    } catch (err) {
      return null;
    }
  }

  function ensureOverlay() {
    const parent = findOverlayParent();
    if (!parent) return null;
    let el = document.getElementById(OVERLAY_ID);
    if (el && el.parentNode !== parent) parent.appendChild(el);
    if (!el) {
      el = document.createElement('div');
      el.id = OVERLAY_ID;
      el.className = 'ytc-audio-overlay';
      parent.appendChild(el);
    }
    try { el.removeAttribute('aria-hidden'); } catch (err) { /* swallow */ }
    ensureFace(el);
    scheduleOverlayPaint(el);
    return el;
  }

  function removeOverlay() {
    const el = document.getElementById(OVERLAY_ID);
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  // YouTube player chrome. These class names change without notice —
  // first thing to check if pinning stops landing.
  const YTP_SETTINGS_BUTTON = '.ytp-settings-button';
  const YTP_SETTINGS_MENU = '.ytp-settings-menu';
  const YTP_MENU_ITEM = '.ytp-menuitem';
  const YTP_MENU_ITEM_LABEL = '.ytp-menuitem-label';
  const YTP_MENU_ITEM_CONTENT = '.ytp-menuitem-content';

  function menuItems(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    return Array.prototype.slice.call(rootEl.querySelectorAll(YTP_MENU_ITEM));
  }

  function itemLabel(el) {
    const lab = el.querySelector(YTP_MENU_ITEM_LABEL);
    return ((lab && lab.textContent) || el.textContent || '').trim();
  }

  // The label is translated ("الجودة" in Arabic), so the row is also found
  // by its value, which names a resolution such as "Auto (720p)" in every
  // language. No other row of the gear menu shows one.
  function isQualityRow(el) {
    if (!el || typeof el.querySelector !== 'function') return false;
    if (/quality/i.test(itemLabel(el))) return true;
    const value = el.querySelector(YTP_MENU_ITEM_CONTENT);
    return /\d{3,4}p/.test((value && value.textContent) || '');
  }

  async function pinViaSettingsMenu(quality, signal) {
    try {
      const player = document.getElementById('movie_player');
      if (!player || (signal && signal.aborted)) return;
      const gear = player.querySelector(YTP_SETTINGS_BUTTON);
      if (!gear) return;
      gear.click();
      await wait(MENU_WAIT_MS, signal);
      if (signal && signal.aborted) return;

      const menu = player.querySelector(YTP_SETTINGS_MENU) || player;
      const rows = menuItems(menu);
      let qualityRow = null;
      for (let i = 0; i < rows.length; i++) {
        if (isQualityRow(rows[i])) {
          qualityRow = rows[i];
          break;
        }
      }
      if (qualityRow) {
        qualityRow.click();
        await wait(MENU_WAIT_MS, signal);
        if (signal && signal.aborted) return;
      }

      const wanted = quality === 'small' ? /240p/i : /144p/i;
      const levelMenu = player.querySelector(YTP_SETTINGS_MENU) || player;
      const levelRows = menuItems(levelMenu);
      let levelRow = null;
      for (let i = 0; i < levelRows.length; i++) {
        if (wanted.test(itemLabel(levelRows[i]))) {
          levelRow = levelRows[i];
          break;
        }
      }
      if (levelRow) levelRow.click();
      await wait(80, signal);
      if (gear.getAttribute('aria-expanded') === 'true') gear.click();
    } catch (err) {
      // fail quietly
    }
  }

  async function pinQuality(current) {
    const levels = await callPlayer('getAvailableQualityLevels');
    if (current.signal.aborted) return;
    const q = pickAudioQuality(levels);
    current.pinnedQuality = q;
    await callPlayer('setPlaybackQualityRange', [q, q]);
    if (current.signal.aborted) return;
    await callPlayer('setPlaybackQuality', [q]);
    if (current.signal.aborted) return;
    await wait(PIN_SETTLE_MS, current.signal);
    if (current.signal.aborted) return;
    const now = await callPlayer('getPlaybackQuality');
    if (now === 'tiny' || now === 'small') {
      current.settled = true;
      return;
    }
    await pinViaSettingsMenu(q, current.signal);
  }

  async function restoreQuality(q) {
    const settings = await readStoredSettings();
    const quality = restorableQuality(q, restoreFallbackFromSettings(settings));
    if (quality === 'auto') {
      await callPlayer('setPlaybackQualityRange', ['tiny', 'highres']);
      await callPlayer('setPlaybackQuality', ['auto']);
      return;
    }
    await callPlayer('setPlaybackQualityRange', [quality, quality]);
    await callPlayer('setPlaybackQuality', [quality]);
  }

  function bindVideo(current) {
    const video = findVideo();
    if (!video || video === current.boundVideo) return;
    current.boundVideo = video;
    current.accumulator.reset();
    const opts = { signal: current.signal };
    try {
      video.addEventListener('timeupdate', function () { sample(current); }, opts);
      video.addEventListener('emptied', function () { current.accumulator.reset(); }, opts);
    } catch (err) {
      // swallow
    }
  }

  function bindStorage(current) {
    const ch = root.chrome;
    if (!ch || !ch.storage || !ch.storage.onChanged) return;
    function onChange(changes, area) {
      if (area !== 'local' || !changes) return;
      if (!changes.settings && !changes.audioCover) return;
      const el = document.getElementById(OVERLAY_ID);
      if (!el) return;
      readStoredLook().then(function (stored) {
        const node = document.getElementById(OVERLAY_ID);
        if (!node) return;
        applyLook(node, overlayLookFromSettings(stored.settings, stored.cover));
        if (changes.settings) paintFace(node, stored.settings);
      });
    }
    try {
      ch.storage.onChanged.addListener(onChange);
      current.signal.addEventListener('abort', function () {
        try { ch.storage.onChanged.removeListener(onChange); } catch (err) { /* swallow */ }
      });
    } catch (err) {
      // swallow
    }
  }

  function observePlayer(current) {
    if (typeof MutationObserver !== 'function') return;
    const player = document.getElementById('movie_player');
    if (!player) return;
    const obs = new MutationObserver(function () {
      if (current.signal.aborted) return;
      ensureOverlay();
      bindVideo(current);
    });
    try {
      obs.observe(player, { childList: true, subtree: false });
      const container = player.querySelector('.html5-video-container');
      if (container) obs.observe(container, { childList: true, subtree: false });
      current.signal.addEventListener('abort', function () { obs.disconnect(); });
    } catch (err) {
      try { obs.disconnect(); } catch (err2) { /* swallow */ }
    }
  }

  function onNavigate(current) {
    if (!session || session !== current) return;
    const from = current.url;
    const to = location.href;
    current.url = to;
    let playerPresent = false;
    try { playerPresent = !!document.getElementById('movie_player'); } catch (err) { /* swallow */ }
    const kind = Core.classifyNavigation(from, to, playerPresent);
    if (kind === 'depart') {
      gate = gate.then(function () { return disable(); }).catch(function () {});
      return;
    }
    if (kind === 'arrive') {
      current.settled = false;
      current.accumulator.reset();
      current.boundVideo = null;
      ensureOverlay();
      bindVideo(current);
      pinQuality(current);
      return;
    }
    if (kind === 'carry') {
      ensureOverlay();
      bindVideo(current);
    }
  }

  function bindSession(current) {
    const signal = current.signal;
    const onNav = function () { onNavigate(current); };
    try {
      document.addEventListener('yt-navigate-finish', onNav, { signal: signal });
      document.addEventListener('yt-page-data-updated', onNav, { signal: signal });
      const win = root.window || root;
      if (win && win.addEventListener) win.addEventListener('popstate', onNav, { signal: signal });
    } catch (err) {
      // swallow
    }
    bindVideo(current);
    bindStorage(current);
    observePlayer(current);

    const sampleId = setInterval(function () { sample(current); }, SAMPLE_MS);
    const flushId = setInterval(function () {
      persistAudioStats(current.accumulator.drain()).catch(function () {});
    }, FLUSH_MS);
    // Closing the tab would lose up to FLUSH_MS of listening. A storage write
    // started from pagehide or a hidden page usually lands before it goes.
    const flushNow = function () {
      if (session !== current) return;
      sample(current);
      persistAudioStats(current.accumulator.drain()).catch(function () {});
    };
    try {
      const win = root.window || root;
      if (win && win.addEventListener) win.addEventListener('pagehide', flushNow, { signal: signal });
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'hidden') flushNow();
      }, { signal: signal });
    } catch (err) {
      // swallow
    }
    signal.addEventListener('abort', function () {
      clearInterval(sampleId);
      clearInterval(flushId);
    });
  }

  function randomToken() {
    const cryptoObj = root.crypto;
    if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') return '';
    const bytes = new Uint8Array(32);
    cryptoObj.getRandomValues(bytes);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      const h = bytes[i].toString(16);
      hex += h.length === 1 ? '0' + h : h;
    }
    return TOKEN_RE.test(hex) ? hex : '';
  }

  function postAdopt(token) {
    const win = root.window || root;
    try {
      win.postMessage({ type: token, dir: 'adopt' }, PAGE_ORIGIN);
    } catch (err) {
      // swallow
    }
  }

  function ensureBridge() {
    if (bridgePromise) return bridgePromise;
    bridgePromise = new Promise(function (resolve) {
      const token = randomToken();
      if (!token) {
        resolve();
        return;
      }
      bridgeToken = token;
      const win = root.window || root;
      if (!win || typeof win.postMessage !== 'function' || typeof win.addEventListener !== 'function') {
        resolve();
        return;
      }
      let settled = false;
      let retryId = null;
      let timeoutId = null;
      function done() {
        if (settled) return;
        settled = true;
        try { win.removeEventListener('message', onReady, false); } catch (err) { /* swallow */ }
        if (retryId) clearInterval(retryId);
        if (timeoutId) clearTimeout(timeoutId);
        resolve();
      }
      function onReady(event) {
        try {
          if (event.source !== win) return;
          if (event.origin !== PAGE_ORIGIN) return;
          const data = event.data;
          if (!data || typeof data !== 'object') return;
          if (data.type !== token || data.dir !== 'ready') return;
          done();
        } catch (err) {
          // swallow
        }
      }
      try { win.addEventListener('message', onReady, false); } catch (err) { /* swallow */ }
      retryId = setInterval(function () {
        if (settled) return;
        postAdopt(token);
      }, BRIDGE_RETRY_MS);
      timeoutId = setTimeout(done, BRIDGE_READY_MS);
      postAdopt(token);
    });
    return bridgePromise;
  }

  async function enable() {
    if (session) return;
    let player = null;
    try { player = document.getElementById('movie_player'); } catch (err) { player = null; }
    if (!player) return;
    await ensureBridge();
    if (session) return;

    const controller = new AbortController();
    const current = {
      controller: controller,
      signal: controller.signal,
      accumulator: Core.createStatsAccumulator(),
      settled: false,
      previousQuality: DEFAULT_RESTORE,
      url: typeof location !== 'undefined' ? location.href : '',
      boundVideo: null,
      pinnedQuality: 'tiny',
    };
    session = current;

    const prev = await callPlayer('getPlaybackQuality');
    if (current.signal.aborted || session !== current) return;
    const settings = await readStoredSettings();
    if (current.signal.aborted || session !== current) return;
    current.previousQuality = restorableQuality(prev, restoreFallbackFromSettings(settings));

    ensureOverlay();
    bindSession(current);
    await pinQuality(current);
    if (session !== current) return;
    sample(current);
  }

  async function disable() {
    const current = session;
    if (!current) return;
    session = null;
    sample(current);
    const delta = current.accumulator.drain();
    current.controller.abort();
    removeOverlay();
    await Promise.all([
      persistAudioStats(delta).catch(function () {}),
      restoreQuality(current.previousQuality).catch(function () {}),
    ]);
  }

  function toggle() {
    gate = gate.then(function () {
      return session ? disable() : enable();
    }).catch(function () {});
    return gate;
  }

  // Polling, not a subtree MutationObserver: YouTube mutates the page
  // constantly, and the wait ends as soon as #movie_player exists.
  const PLAYER_POLL_MS = 250;
  const PLAYER_POLL_MAX_MS = 20000;

  function enableWhenPlayerReady() {
    let player = null;
    try { player = document.getElementById('movie_player'); } catch (err) { player = null; }
    if (player) {
      gate = gate.then(enable).catch(function () {});
      return;
    }
    let elapsed = 0;
    function poll() {
      elapsed += PLAYER_POLL_MS;
      let el = null;
      try { el = document.getElementById('movie_player'); } catch (err) { el = null; }
      if (el) {
        gate = gate.then(enable).catch(function () {});
        return;
      }
      if (elapsed >= PLAYER_POLL_MAX_MS) return;
      setTimeout(poll, PLAYER_POLL_MS);
    }
    setTimeout(poll, PLAYER_POLL_MS);
  }

  function onVideoEnded(event) {
    try {
      // Ads and preview players fire ended too; only the main watch
      // video is what the worker handed this tab.
      if (event.target !== findVideo()) return;
      const id = readVideoId();
      if (!id) return;
      const ch = root.chrome;
      if (!ch || !ch.runtime || typeof ch.runtime.sendMessage !== 'function') return;
      Promise.resolve(ch.runtime.sendMessage({ type: 'queue.ended', v: id })).then(
        function () {},
        function () {},
      );
    } catch (err) {
      // ignore
    }
  }

  function requestAudioModeBoot() {
    if (bootOnce) return bootOnce;
    bootOnce = (async function () {
      try {
        const ch = root.chrome;
        if (!ch || !ch.runtime || typeof ch.runtime.sendMessage !== 'function') return null;
        const reply = await ch.runtime.sendMessage({ type: 'audioMode.boot' });
        rememberOverlayReply(reply);
        return reply;
      } catch (err) {
        return null;
      }
    })();
    bootOnce.then(function (reply) {
      if (reply && reply.openInAudioMode === true) enableWhenPlayerReady();
    }, function () {});
    return bootOnce;
  }

  function shouldBoot() {
    try {
      if (typeof document === 'undefined' || !document || !document.documentElement) return false;
      const ch = root.chrome;
      return !!(ch && ch.runtime && ch.runtime.id && typeof ch.runtime.getURL === 'function');
    } catch (err) {
      return false;
    }
  }

  // Same reader as src/lib/subscriptions-page.js. This file cannot import.
  const SCAN_AVATAR_HOSTS = {
    'yt3.ggpht.com': true,
    'yt3.googleusercontent.com': true,
  };
  const SCAN_EMPTY_PAGE = {
    sessionIndex: null,
    subscribed: 0,
    continuation: false,
    avatar: '',
  };

  function scanSessionIndexIn(html) {
    const match = /["']SESSION_INDEX["']\s*:\s*"?(\d+)"?/.exec(html);
    if (!match) return null;
    const n = Number(match[1]);
    return isFinite(n) ? n : null;
  }

  function scanAssignmentAt(html) {
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

  function scanJsonEnd(text, start) {
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

  function scanEscapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  // Some responses carry the JSON in its own <script type="application/json">
  // and assign it with JSON.parse(<var>.textContent) (docs/youtube.md).
  function scanJsonScriptAt(html) {
    const use = /window\[\s*["']ytInitialData["']\s*\]\s*=\s*JSON\.parse\(\s*([A-Za-z_$][\w$]*)\.textContent/.exec(html);
    if (!use) return -1;
    const decl = new RegExp(
      '\\b' + scanEscapeRegExp(use[1]) + '\\s*=\\s*document\\.getElementById\\(\\s*["\']([^"\']+)["\']',
    ).exec(html);
    if (!decl) return -1;
    const tag = new RegExp('<script\\b[^>]*\\bid=["\']' + scanEscapeRegExp(decl[1]) + '["\'][^>]*>').exec(html);
    if (!tag) return -1;
    const start = html.indexOf('{', tag.index + tag[0].length);
    if (start < 0 || html.slice(tag.index + tag[0].length, start).trim()) return -1;
    return start;
  }

  function scanInitialData(html) {
    let start = scanAssignmentAt(html);
    if (start < 0 || html[start] !== '{') start = scanJsonScriptAt(html);
    if (start < 0) return null;
    const end = scanJsonEnd(html, start);
    if (end < 0) return null;
    try {
      return JSON.parse(html.slice(start, end));
    } catch (err) {
      return null;
    }
  }

  function scanAvatarUrl(value) {
    if (typeof value !== 'string') return '';
    let raw = value.trim();
    if (!raw) return '';
    if (raw.startsWith('//')) raw = 'https:' + raw;
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:' || !SCAN_AVATAR_HOSTS[url.hostname]) return '';
      return url.href;
    } catch (err) {
      return '';
    }
  }

  function scanBestThumbnail(thumbs) {
    if (!Array.isArray(thumbs)) return '';
    let best = '';
    let bestWidth = -1;
    for (let i = 0; i < thumbs.length; i++) {
      const thumb = thumbs[i];
      const url = scanAvatarUrl(thumb && thumb.url);
      if (!url) continue;
      const width = Number(thumb && thumb.width);
      const rank = isFinite(width) ? width : 0;
      if (!best || rank >= bestWidth) {
        best = url;
        bestWidth = rank;
      }
    }
    return best;
  }

  function scanAccountAvatar(data) {
    const buttons = data
      && data.topbar
      && data.topbar.desktopTopbarRenderer
      && data.topbar.desktopTopbarRenderer.topbarButtons;
    if (!Array.isArray(buttons)) return '';
    for (let i = 0; i < buttons.length; i++) {
      const menu = buttons[i] && buttons[i].topbarMenuButtonRenderer;
      if (!menu || !menu.avatar) continue;
      return scanBestThumbnail(menu.avatar.thumbnails);
    }
    return '';
  }

  function scanCountRows(node, acc) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) scanCountRows(node[i], acc);
      return;
    }
    const row = node.channelRenderer;
    if (row && typeof row === 'object') {
      const button = row.subscriptionButton;
      if (button && button.subscribed === true) acc.subscribed += 1;
    }
    if (node.continuationItemRenderer) acc.continuation = true;
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) scanCountRows(node[keys[i]], acc);
  }

  function parseSubscriptionsHtml(html) {
    if (typeof html !== 'string' || !html) {
      return {
        sessionIndex: SCAN_EMPTY_PAGE.sessionIndex,
        subscribed: 0,
        continuation: false,
        avatar: '',
      };
    }
    try {
      const data = scanInitialData(html);
      const acc = { subscribed: 0, continuation: false };
      if (data) scanCountRows(data, acc);
      return {
        sessionIndex: scanSessionIndexIn(html),
        // Unreadable is not empty: the scan reads the live rows either way.
        subscribed: data ? acc.subscribed : null,
        continuation: acc.continuation,
        avatar: data ? scanAccountAvatar(data) : '',
      };
    } catch (err) {
      return {
        sessionIndex: null,
        subscribed: 0,
        continuation: false,
        avatar: '',
      };
    }
  }

  // Past the last account the same HTML comes back with SESSION_INDEX 0
  // and status 200. The index that came back has to be the one we asked for.
  function takeAccountPage(accounts, html) {
    if (!Array.isArray(accounts) || accounts.length >= 10) return false;
    const parsed = parseSubscriptionsHtml(html);
    if (!parsed || parsed.sessionIndex !== accounts.length) return false;
    accounts.push({
      index: accounts.length,
      subscribed: parsed.subscribed,
      continuation: parsed.continuation === true,
      avatar: parsed.avatar || '',
    });
    return true;
  }

  // The account switcher's reply is the one place the names are. Same
  // function as parseAccountSwitcher in src/lib/subscriptions-page.js.
  const SCAN_NAME_MAX = 80;

  function scanSwitcherIndex(node) {
    if (typeof node === 'string') {
      const match = /[?&]authuser=(\d)(?!\d)/.exec(node);
      return match ? Number(match[1]) : null;
    }
    if (!node || typeof node !== 'object') return null;
    const values = Array.isArray(node) ? node : Object.values(node);
    for (let i = 0; i < values.length; i++) {
      const found = scanSwitcherIndex(values[i]);
      if (found != null) return found;
    }
    return null;
  }

  function scanSwitcherName(value) {
    if (!value || typeof value !== 'object') return '';
    let text = '';
    if (typeof value.simpleText === 'string') text = value.simpleText;
    else if (Array.isArray(value.runs)) {
      text = value.runs.map(function (run) {
        return run && typeof run.text === 'string' ? run.text : '';
      }).join('');
    }
    return text.trim().slice(0, SCAN_NAME_MAX);
  }

  function scanSwitcherItems(node, out) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) scanSwitcherItems(node[i], out);
      return;
    }
    if (node.accountItem && typeof node.accountItem === 'object') {
      out.push(node.accountItem);
      return;
    }
    const keys = Object.keys(node);
    for (let i = 0; i < keys.length; i++) scanSwitcherItems(node[keys[i]], out);
  }

  // The selected account comes first, not account 0: the index is the
  // authuser number in each row's sign-in link.
  function parseAccountSwitcher(text) {
    if (typeof text !== 'string' || !text) return [];
    let data;
    try {
      data = JSON.parse(text.replace(/^\)\]\}'\s*/, ''));
    } catch (err) {
      return [];
    }
    const items = [];
    scanSwitcherItems(data, items);
    const seen = {};
    const out = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const index = scanSwitcherIndex(item.serviceEndpoint);
      if (index == null || seen[index]) continue;
      const name = scanSwitcherName(item.accountName);
      const avatar = scanBestThumbnail(item.accountPhoto && item.accountPhoto.thumbnails);
      if (!name && !avatar) continue;
      seen[index] = true;
      out.push({ index: index, name: name, avatar: avatar });
    }
    return out;
  }

  // One read per page load. The names stay in this tab: they are painted
  // and never sent to the worker or stored.
  let switcherLoad = null;

  function loadAccountNames() {
    if (!switcherLoad) {
      switcherLoad = (async function () {
        const byIndex = {};
        try {
          const fetchFn = root.fetch || fetch;
          const res = await fetchFn('https://www.youtube.com/getAccountSwitcherEndpoint', {
            credentials: 'include',
            cache: 'no-store',
          });
          if (!res || res.ok !== true) return byIndex;
          const rows = parseAccountSwitcher(await res.text());
          for (let i = 0; i < rows.length; i++) byIndex[rows[i].index] = rows[i];
        } catch (err) {
          // Names are a nicety: without them the rows read "Account N".
        }
        return byIndex;
      })();
    }
    return switcherLoad;
  }

  function accountTitle(pack, account) {
    if (account && typeof account.name === 'string' && account.name) return account.name;
    return messageOf(pack, 'scanAccount', [String(account.index + 1)]);
  }

  const SCAN_OVERLAY_ID = 'ytc-scan-overlay';
  const SCAN_ROW_WAIT_MS = 15000;
  const SCAN_ROW_POLL_MS = 250;
  const SCAN_GROW_MS = 4000;
  const SCAN_GROW_POLL_MS = 200;
  const SCAN_SCROLL_ROUNDS = 40;
  // Chrome kills the worker when one event runs longer than 5 minutes.
  // The keepalive ping does not reset that clock, so the picker gives up
  // with a minute to spare. Same value as ACCOUNT_PICK_MS in the service worker.
  const ACCOUNT_PICK_MS = 4 * 60 * 1000;
  let scanTask = null;
  let accountPickTimer = null;
  let accountPickPack = null;
  let accountPickTeardown = false;
  let heldChoice = null;
  let pickerSend = null;
  let chooseSend = null;
  let lastExportName = '';
  let pickerWanted = false;

  function pagePath() {
    try {
      if (root.location && typeof root.location.pathname === 'string') return root.location.pathname;
    } catch (err) {
      // fall through
    }
    try {
      return String(location.pathname || '');
    } catch (err) {
      return '';
    }
  }

  function channelRowCount() {
    try {
      if (!document || typeof document.querySelectorAll !== 'function') return 0;
      const found = document.querySelectorAll('ytd-channel-renderer');
      return found && typeof found.length === 'number' ? found.length : 0;
    } catch (err) {
      return 0;
    }
  }

  function scrollToY(y) {
    try {
      const win = root.window || (typeof window !== 'undefined' ? window : null);
      if (win && typeof win.scrollTo === 'function') win.scrollTo(0, y);
    } catch (err) {
      // swallow
    }
  }

  function scrollToBottom() {
    let height = 0;
    try {
      const scroller = document.scrollingElement || document.documentElement;
      if (scroller && typeof scroller.scrollHeight === 'number') height = scroller.scrollHeight;
    } catch (err) {
      height = 0;
    }
    scrollToY(height);
  }

  function waitForChannelRow() {
    return new Promise(function (resolve) {
      const start = Date.now();
      function poll() {
        if (channelRowCount() > 0) {
          resolve(true);
          return;
        }
        if (Date.now() - start >= SCAN_ROW_WAIT_MS) {
          resolve(false);
          return;
        }
        setTimeout(poll, SCAN_ROW_POLL_MS);
      }
      poll();
    });
  }

  function countMessage(pack, key, n) {
    const count = Number(n) || 0;
    const one = key + 'One';
    const use = count === 1 && pack && typeof pack[one] === 'string' && pack[one] ? one : key;
    return messageOf(pack, use, [String(count)]);
  }

  async function scanCopy() {
    const settings = await readStoredSettings();
    const locale = localeFromSettings(settings, navigatorLanguage());
    let pack = null;
    try {
      pack = await overlayPackFor(locale);
    } catch (err) {
      pack = null;
    }
    return { locale: locale, pack: pack || {} };
  }

  function usableBackground(color) {
    if (typeof color !== 'string') return '';
    const value = color.trim().toLowerCase();
    if (!value || value === 'transparent' || value === 'rgba(0, 0, 0, 0)') return '';
    return color;
  }

  function channelLuminance(color) {
    const match = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(String(color));
    if (!match) return null;
    return (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255;
  }

  function readPageBackground() {
    try {
      const view = root.getComputedStyle || (typeof getComputedStyle === 'function' ? getComputedStyle : null);
      if (typeof view !== 'function') return '';
      const nodes = [];
      if (document.body) nodes.push(document.body);
      try {
        const app = document.querySelector('ytd-app');
        if (app) nodes.push(app);
      } catch (err) {
        // swallow
      }
      if (document.documentElement) nodes.push(document.documentElement);
      for (let i = 0; i < nodes.length; i++) {
        const color = usableBackground(view(nodes[i]).backgroundColor);
        if (color) return color;
      }
    } catch (err) {
      return '';
    }
    return '';
  }

  function paintScanSurface(el) {
    const color = readPageBackground();
    const lum = color ? channelLuminance(color) : null;
    if (!color || lum == null) return;
    const dark = lum < 0.5;
    try {
      if (el.style) {
        el.style.backgroundColor = color;
        el.style.color = dark ? '#f1f1f1' : '#0f0f0f';
        el.style.colorScheme = dark ? 'dark' : 'light';
      }
      if (dark) el.setAttribute('data-dark', '');
      else el.removeAttribute('data-dark');
    } catch (err) {
      // swallow
    }
  }

  function applyScanLocale(el, locale) {
    const loc = locale === 'ar' ? 'ar' : 'en';
    try {
      el.setAttribute('dir', loc === 'ar' ? 'rtl' : 'ltr');
      el.setAttribute('lang', loc);
    } catch (err) {
      // swallow
    }
  }

  function setScanHidden(node, hidden) {
    if (!node) return;
    try {
      if (hidden) node.setAttribute('hidden', '');
      else node.removeAttribute('hidden');
    } catch (err) {
      // swallow
    }
  }

  function clearAccountPickTimer() {
    if (accountPickTimer == null) return;
    try { clearTimeout(accountPickTimer); } catch (err) { /* swallow */ }
    accountPickTimer = null;
  }

  function hideScanChoices(el) {
    const walk = function (node) {
      if (!node) return;
      const cls = typeof node.className === 'string' ? node.className : '';
      const names = cls.split(/\s+/);
      if (
        names.indexOf('ytc-scan-scan') !== -1
        || names.indexOf('ytc-scan-another') !== -1
        || names.indexOf('ytc-scan-merge') !== -1
        || names.indexOf('ytc-scan-replace') !== -1
        || names.indexOf('ytc-scan-export') !== -1
        || names.indexOf('ytc-scan-delete') !== -1
        || names.indexOf('ytc-scan-cancel') !== -1
      ) {
        setScanHidden(node, true);
      }
      const kids = node.children || [];
      for (let i = 0; i < kids.length; i++) walk(kids[i]);
    };
    walk(el);
  }

  function onAccountPickExpired() {
    accountPickTimer = null;
    // The worker has stopped waiting. A late click must not answer it.
    chooseSend = null;
    let el = null;
    try { el = document.getElementById(SCAN_OVERLAY_ID); } catch (err) { el = null; }
    if (!el) return;
    hideScanChoices(el);
    const line = el.querySelector && el.querySelector('.ytc-scan-expired');
    if (!line) return;
    line.textContent = messageOf(accountPickPack, 'scanExpired');
    setScanHidden(line, false);
  }

  function startAccountPickTimer(pack) {
    clearAccountPickTimer();
    accountPickPack = pack || null;
    if (!accountPickTeardown) {
      accountPickTeardown = true;
      try {
        const win = root.window || root;
        if (win && win.addEventListener) win.addEventListener('pagehide', clearAccountPickTimer);
      } catch (err) { /* swallow */ }
    }
    try {
      accountPickTimer = setTimeout(onAccountPickExpired, ACCOUNT_PICK_MS);
    } catch (err) {
      accountPickTimer = null;
    }
  }

  function finishAccountChoice(payload) {
    const held = heldChoice;
    const picking = pickerSend;
    const choosing = chooseSend;
    heldChoice = null;
    pickerSend = null;
    chooseSend = null;
    try { if (held && held.send) held.send(payload); } catch (err) { /* swallow */ }
    try { if (picking) picking(payload); } catch (err) { /* swallow */ }
    try { if (choosing) choosing(payload); } catch (err) { /* swallow */ }
  }

  // A youtube.com page can dispatch clicks at this overlay. Only a real
  // click may change the watchlist or ask for the backup.
  function isTrustedClick(ev) {
    return !!(ev && ev.isTrusted === true);
  }

  function replyChoose(payload) {
    const send = chooseSend;
    chooseSend = null;
    clearAccountPickTimer();
    try { if (send) send(payload); } catch (err) { /* swallow */ }
  }

  function showImportWarning(open) {
    let el = null;
    try { el = document.getElementById(SCAN_OVERLAY_ID); } catch (err) { el = null; }
    if (!el || typeof el.querySelector !== 'function') return;
    setScanHidden(el.querySelector('.ytc-scan-decide'), open);
    setScanHidden(el.querySelector('.ytc-scan-warn'), !open);
  }

  function onScanMerge(ev) {
    stopFaceEvent(ev);
    if (!isTrustedClick(ev)) return;
    replyChoose({ ok: true, mode: 'merge' });
  }

  function onScanReplace(ev) {
    stopFaceEvent(ev);
    if (!isTrustedClick(ev)) return;
    showImportWarning(true);
  }

  function onScanExport(ev) {
    stopFaceEvent(ev);
    if (!isTrustedClick(ev)) return;
    replyChoose({ ok: true, mode: 'export' });
  }

  function onScanDelete(ev) {
    stopFaceEvent(ev);
    if (!isTrustedClick(ev)) return;
    replyChoose({ ok: true, mode: 'replace' });
  }

  function onScanCancel(ev) {
    stopFaceEvent(ev);
    if (!isTrustedClick(ev)) return;
    showImportWarning(false);
  }

  function saveScanDownload(msg) {
    const name = msg && typeof msg.name === 'string' ? msg.name : '';
    const text = msg && typeof msg.text === 'string' ? msg.text : '';
    if (!name || !text) return false;
    let url = '';
    try {
      const blob = new Blob([text], { type: 'application/json' });
      url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      // Never put the link in YouTube's DOM: page scripts watch mutations
      // and could fetch the blob, which is the whole watchlist. Chrome
      // downloads from a detached anchor.
      a.click();
      // Revoking in the same turn can cancel the download in some browsers.
      setTimeout(function () {
        try { URL.revokeObjectURL(url); } catch (err) { /* swallow */ }
      }, 1000);
    } catch (err) {
      if (url) {
        try { URL.revokeObjectURL(url); } catch (ignore) { /* swallow */ }
      }
      return false;
    }
    lastExportName = name;
    return true;
  }

  function onScanDone(ev) {
    clearAccountPickTimer();
    stopFaceEvent(ev);
    try {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    } catch (err) {
      // swallow
    }
    finishAccountChoice({ ok: false, error: 'done' });
    try {
      const ch = root.chrome;
      if (!ch || !ch.runtime || typeof ch.runtime.sendMessage !== 'function') return;
      Promise.resolve(ch.runtime.sendMessage({ type: 'subscriptions.close' })).then(
        function () {},
        function () {},
      );
    } catch (err) {
      // swallow
    }
  }

  function onScanAnother(ev) {
    stopFaceEvent(ev);
    try {
      if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
    } catch (err) {
      // swallow
    }
    // Which account gets read is the person's choice, like Add new and Replace.
    if (!isTrustedClick(ev)) return;
    clearAccountPickTimer();
    pickerWanted = true;
    if (!heldChoice) return;
    const send = heldChoice.send;
    const info = heldChoice.info;
    heldChoice = null;
    openAccountPicker(info, send);
  }

  function scanNode(className) {
    const node = document.createElement('p');
    node.className = className;
    return node;
  }

  function scanButton(className, onClick) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    button.addEventListener('click', onClick);
    return button;
  }

  function appendChooseControls(el) {
    const decide = document.createElement('div');
    decide.className = 'ytc-scan-decide';
    decide.appendChild(scanButton('ytc-scan-merge', onScanMerge));
    decide.appendChild(scanButton('ytc-scan-replace', onScanReplace));
    setScanHidden(decide, true);
    const warn = document.createElement('div');
    warn.className = 'ytc-scan-warn';
    const warnText = scanNode('ytc-scan-warn-text');
    const saved = scanNode('ytc-scan-saved');
    const failed = scanNode('ytc-scan-export-failed');
    setScanHidden(saved, true);
    setScanHidden(failed, true);
    const row = document.createElement('div');
    row.className = 'ytc-scan-warn-actions';
    row.appendChild(scanButton('ytc-scan-export', onScanExport));
    row.appendChild(scanButton('ytc-scan-delete', onScanDelete));
    row.appendChild(scanButton('ytc-scan-cancel', onScanCancel));
    warn.appendChild(warnText);
    warn.appendChild(saved);
    warn.appendChild(failed);
    warn.appendChild(row);
    setScanHidden(warn, true);
    el.appendChild(decide);
    el.appendChild(warn);
  }

  function ensureScanOverlay(got) {
    let el = null;
    try { el = document.getElementById(SCAN_OVERLAY_ID); } catch (err) { el = null; }
    if (!el) {
      el = document.createElement('div');
      el.id = SCAN_OVERLAY_ID;
      const spinner = document.createElement('div');
      spinner.className = 'ytc-scan-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      const title = document.createElement('h1');
      title.className = 'ytc-scan-title';
      title.setAttribute('role', 'status');
      const sub = scanNode('ytc-scan-sub');
      const names = scanNode('ytc-scan-names');
      setScanHidden(names, true);
      const count = scanNode('ytc-scan-count');
      const label = document.createElement('span');
      label.className = 'ytc-scan-count-label';
      const num = document.createElement('span');
      num.className = 'ytc-scan-num';
      count.appendChild(label);
      count.appendChild(num);
      const loaded = scanNode('ytc-scan-loaded');
      const who = document.createElement('div');
      who.className = 'ytc-scan-who';
      const whoImg = document.createElement('img');
      whoImg.className = 'ytc-scan-avatar';
      whoImg.alt = '';
      try { whoImg.referrerPolicy = 'no-referrer'; } catch (err) { /* swallow */ }
      const whoLabel = document.createElement('span');
      whoLabel.className = 'ytc-scan-who-label';
      who.appendChild(whoImg);
      who.appendChild(whoLabel);
      const picker = document.createElement('div');
      picker.className = 'ytc-scan-picker';
      const actions = document.createElement('div');
      actions.className = 'ytc-scan-actions';
      const another = document.createElement('button');
      another.type = 'button';
      another.className = 'ytc-scan-another';
      another.addEventListener('click', onScanAnother);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ytc-scan-done';
      btn.addEventListener('click', onScanDone);
      const expired = scanNode('ytc-scan-expired');
      setScanHidden(expired, true);
      actions.appendChild(another);
      actions.appendChild(btn);
      el.appendChild(spinner);
      el.appendChild(who);
      el.appendChild(title);
      el.appendChild(sub);
      el.appendChild(names);
      el.appendChild(count);
      el.appendChild(loaded);
      el.appendChild(picker);
      appendChooseControls(el);
      el.appendChild(expired);
      el.appendChild(actions);
      const parent = document.documentElement || document.body;
      if (parent && typeof parent.appendChild === 'function') parent.appendChild(el);
    }
    applyScanLocale(el, got && got.locale);
    paintScanSurface(el);
    return el;
  }

  function paintScanProgress(got, n, paging) {
    let el = null;
    try { el = document.getElementById(SCAN_OVERLAY_ID); } catch (err) { el = null; }
    if (!el || typeof el.querySelector !== 'function') return;
    const count = Math.max(0, Number(n) || 0);
    const num = el.querySelector('.ytc-scan-num');
    const label = el.querySelector('.ytc-scan-count-label');
    const loaded = el.querySelector('.ytc-scan-loaded');
    const pack = got && got.pack;
    if (num) num.textContent = String(count);
    if (label) label.textContent = messageOf(pack, 'scanFound');
    if (loaded) loaded.textContent = messageOf(pack, 'scanLoaded', [String(count)]);
    setScanHidden(loaded, !paging);
  }

  function knownAccount(info) {
    const n = info && info.account;
    return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 9 && Math.floor(n) === n;
  }

  function paintWho(el, pack, info) {
    const who = el.querySelector('.ytc-scan-who');
    if (!who) return;
    const show = knownAccount(info);
    setScanHidden(who, !show);
    if (!show) return;
    const label = who.querySelector('.ytc-scan-who-label');
    const img = who.querySelector('.ytc-scan-avatar');
    const fallback = messageOf(pack, 'scanAccount', [String(info.account + 1)]);
    if (label) label.textContent = fallback;
    paintWhoPicture(img, scanAvatarUrl(info && info.avatar));
    const account = info.account;
    const pictured = !!scanAvatarUrl(info && info.avatar);
    loadAccountNames().then(function (names) {
      const found = names[account];
      if (!found) return;
      // A later paint may have moved on to another account or state.
      if (label && found.name && label.textContent === fallback) label.textContent = found.name;
      if (img && !pictured && found.avatar && label && label.textContent === found.name) {
        paintWhoPicture(img, found.avatar);
      }
    }, function () {});
  }

  function paintWhoPicture(img, avatar) {
    if (!img) return;
    if (avatar) {
      try { img.setAttribute('src', avatar); } catch (err) { img.src = avatar; }
      setScanHidden(img, false);
    } else {
      try { img.removeAttribute('src'); } catch (err) { /* swallow */ }
      setScanHidden(img, true);
    }
  }

  function scanCount(value) {
    const n = Number(value);
    if (!isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  function paintChooseCopy(el, pack, info) {
    const fresh = scanCount(info && info.fresh);
    const extra = scanCount(info && info.extra);
    const title = el.querySelector('.ytc-scan-title');
    const sub = el.querySelector('.ytc-scan-sub');
    if (title) title.textContent = messageOf(pack, 'scanDifferTitle');
    if (sub) sub.textContent = messageOf(pack, 'scanDifferLine', [String(fresh), String(extra)]);
    setScanHidden(sub, false);
    const merge = el.querySelector('.ytc-scan-merge');
    const replace = el.querySelector('.ytc-scan-replace');
    const warnText = el.querySelector('.ytc-scan-warn-text');
    const exportBtn = el.querySelector('.ytc-scan-export');
    const deleteBtn = el.querySelector('.ytc-scan-delete');
    const cancelBtn = el.querySelector('.ytc-scan-cancel');
    if (merge) merge.textContent = messageOf(pack, 'scanAddNew');
    if (replace) replace.textContent = messageOf(pack, 'scanReplaceList');
    if (warnText) warnText.textContent = countMessage(pack, 'scanReplaceWarn', extra);
    if (exportBtn) exportBtn.textContent = messageOf(pack, 'scanReplaceExport');
    if (deleteBtn) deleteBtn.textContent = messageOf(pack, 'scanReplaceDelete');
    if (cancelBtn) cancelBtn.textContent = messageOf(pack, 'scanReplaceCancel');
    // The account wait hides these. A later choice has to show them again.
    setScanHidden(merge, false);
    setScanHidden(replace, false);
    setScanHidden(exportBtn, false);
    setScanHidden(deleteBtn, false);
    setScanHidden(cancelBtn, false);
    const saved = el.querySelector('.ytc-scan-saved');
    const failed = el.querySelector('.ytc-scan-export-failed');
    const showSaved = !!(info && info.exported === true && lastExportName);
    if (saved) {
      saved.textContent = showSaved ? messageOf(pack, 'scanExportSaved', [lastExportName]) : '';
      setScanHidden(saved, !showSaved);
    }
    if (failed) {
      const showFailed = !!(info && info.exportError === true);
      failed.textContent = showFailed ? messageOf(pack, 'scanExportFailed') : '';
      setScanHidden(failed, !showFailed);
    }
  }

  // Which channels a replace dropped: the first few names, and "and others"
  // when there were more.
  function paintRemovedNames(el, got, mode, info) {
    const line = el.querySelector('.ytc-scan-names');
    if (!line) return;
    const names = (info && info.removedNames) || [];
    const removed = Number(info && info.removed) || 0;
    const show = (mode === 'added' || mode === 'removed') && removed > 0 && names.length > 0;
    setScanHidden(line, !show);
    if (!show) {
      line.textContent = '';
      return;
    }
    const joined = names.join(got && got.locale === 'ar' ? '\u060c ' : ', ');
    const key = removed > names.length ? 'scanRemovedNamesMore' : 'scanRemovedNames';
    line.textContent = messageOf(got && got.pack, key, [joined]);
  }

  function paintScanMode(got, mode, info) {
    clearAccountPickTimer();
    const el = ensureScanOverlay(got);
    if (!el || typeof el.querySelector !== 'function') return;
    setScanHidden(el.querySelector('.ytc-scan-expired'), true);
    const pack = got && got.pack;
    const title = el.querySelector('.ytc-scan-title');
    const sub = el.querySelector('.ytc-scan-sub');
    paintRemovedNames(el, got, mode, info);
    const count = el.querySelector('.ytc-scan-count');
    const loaded = el.querySelector('.ytc-scan-loaded');
    const spinner = el.querySelector('.ytc-scan-spinner');
    const btn = el.querySelector('.ytc-scan-done');
    const another = el.querySelector('.ytc-scan-another');
    const picker = el.querySelector('.ytc-scan-picker');
    const decide = el.querySelector('.ytc-scan-decide');
    const warn = el.querySelector('.ytc-scan-warn');
    const result = mode === 'added' || mode === 'nothing' || mode === 'removed';
    const spinning = mode === 'scanning' || mode === 'accounts';
    const choice = mode === 'choose';
    const warning = choice && !!(info && (info.exported === true || info.exportError === true));
    setScanHidden(spinner, !spinning);
    setScanHidden(count, mode !== 'scanning');
    setScanHidden(loaded, true);
    setScanHidden(picker, mode !== 'picker');
    setScanHidden(decide, !choice || warning);
    setScanHidden(warn, !warning);
    setScanHidden(btn, mode === 'scanning');
    if (btn) btn.textContent = messageOf(pack, 'scanDone');
    if (another) another.textContent = messageOf(pack, 'scanAnother');
    const showAnother = result && knownAccount(info);
    setScanHidden(another, !showAnother);
    if (result || choice || mode === 'empty') paintWho(el, pack, info);
    else {
      const who = el.querySelector('.ytc-scan-who');
      setScanHidden(who, true);
    }
    if (choice) {
      paintChooseCopy(el, pack, info);
      return;
    }
    if (mode === 'scanning') {
      if (title) title.textContent = messageOf(pack, 'scanTitle');
      if (sub) sub.textContent = messageOf(pack, 'scanStay');
      setScanHidden(sub, false);
      paintScanProgress(got, channelRowCount(), false);
      return;
    }
    if (mode === 'accounts') {
      if (title) title.textContent = messageOf(pack, 'scanAccounts');
      if (sub) sub.textContent = messageOf(pack, 'scanStay');
      setScanHidden(sub, false);
      return;
    }
    if (mode === 'picker') {
      if (title) title.textContent = messageOf(pack, 'scanChoose');
      if (sub) sub.textContent = messageOf(pack, 'scanStay');
      setScanHidden(sub, false);
      return;
    }
    if (mode === 'added') {
      const added = Number(info && info.added) || 0;
      const skipped = Number(info && info.skipped) || 0;
      const removed = Number(info && info.removed) || 0;
      if (title) title.textContent = countMessage(pack, 'scanAdded', added);
      if (removed > 0) {
        if (sub) sub.textContent = countMessage(pack, 'scanRemoved', removed);
        setScanHidden(sub, false);
      } else if (skipped) {
        if (sub) sub.textContent = countMessage(pack, 'scanSkipped', skipped);
        setScanHidden(sub, false);
      } else {
        if (sub) sub.textContent = '';
        setScanHidden(sub, true);
      }
      return;
    }
    if (mode === 'removed') {
      const removed = Number(info && info.removed) || 0;
      if (title) title.textContent = countMessage(pack, 'scanRemoved', removed);
      if (sub) sub.textContent = '';
      setScanHidden(sub, true);
      return;
    }
    if (mode === 'empty') {
      if (title) title.textContent = messageOf(pack, 'scanReplaceEmpty');
      if (sub) sub.textContent = '';
      setScanHidden(sub, true);
      return;
    }
    if (mode === 'nothing') {
      if (title) title.textContent = messageOf(pack, 'scanNothing');
      if (sub) sub.textContent = '';
      setScanHidden(sub, true);
      return;
    }
    if (mode === 'signedOut') {
      if (title) title.textContent = messageOf(pack, 'scanSignedOut');
      if (sub) sub.textContent = messageOf(pack, 'scanSignedOutFile');
      setScanHidden(sub, false);
      return;
    }
    if (title) title.textContent = messageOf(pack, 'scanFailed');
    if (sub) sub.textContent = '';
    setScanHidden(sub, true);
  }

  function safePaint(fn) {
    try { fn(); } catch (err) { /* A DOM change must not drop the list. */ }
  }

  function continuationPresent() {
    try {
      if (!document || typeof document.querySelector !== 'function') return false;
      return !!document.querySelector('ytd-continuation-item-renderer');
    } catch (err) {
      return false;
    }
  }

  // The sentinel leaving is the end of the list. A round that does not
  // grow is not: the next page can arrive after the first second
  // (docs/youtube.md).
  function waitForMoreRows(got, before) {
    return new Promise(function (resolve) {
      const start = Date.now();
      function poll() {
        const after = channelRowCount();
        if (after > before) {
          safePaint(function () { paintScanProgress(got, after, true); });
          resolve(true);
          return;
        }
        if (!continuationPresent() || Date.now() - start >= SCAN_GROW_MS) {
          resolve(false);
          return;
        }
        setTimeout(poll, SCAN_GROW_POLL_MS);
      }
      poll();
    });
  }

  async function loadRemainingRows(got) {
    try {
      if (!continuationPresent()) return;
      for (let round = 0; round < SCAN_SCROLL_ROUNDS; round++) {
        const before = channelRowCount();
        safePaint(function () { paintScanProgress(got, before, true); });
        scrollToBottom();
        await waitForMoreRows(got, before);
        safePaint(function () { paintScanProgress(got, channelRowCount(), true); });
        if (!continuationPresent()) break;
      }
    } finally {
      scrollToTop();
      safePaint(function () { paintScanProgress(got, channelRowCount(), false); });
    }
  }

  function scrollToTop() {
    scrollToY(0);
  }

  function wantedAccount(msg) {
    const n = msg && msg.index;
    return typeof n === 'number' && isFinite(n) && n >= 0 && n <= 9 && Math.floor(n) === n ? n : null;
  }

  async function runSubscriptionScan(msg) {
    if (pagePath() !== '/feed/channels') return { ok: false, error: 'wrongPage' };
    // Right after a switch the previous account's page can still be here,
    // with its rows loaded. Answering would import that account's list.
    // An unreadable session is not a mismatch: the bridge read below fails
    // on its own if the page is broken.
    const want = wantedAccount(msg);
    if (want != null) {
      const current = await readCurrentSession();
      if (current != null && current !== want) return { ok: false, error: 'wrongAccount' };
    }
    const got = await scanCopy();
    safePaint(function () { paintScanMode(got, 'scanning', {}); });
    const ready = await waitForChannelRow();
    if (!ready) {
      safePaint(function () { paintScanMode(got, 'signedOut', {}); });
      return { ok: false, error: 'signedOut' };
    }
    await loadRemainingRows(got);
    await ensureBridge();
    const channels = await callPlayer('subscribedChannels', []);
    if (!Array.isArray(channels)) {
      safePaint(function () { paintScanMode(got, 'failed', {}); });
      return { ok: false, error: 'failed' };
    }
    safePaint(function () { paintScanProgress(got, channels.length, false); });
    return { ok: true, channels: channels };
  }

  function scanSubscriptions(msg) {
    if (scanTask) return scanTask;
    scanTask = runSubscriptionScan(msg).then(
      function (res) {
        scanTask = null;
        return res || { ok: false, error: 'failed' };
      },
      function () {
        scanTask = null;
        return { ok: false, error: 'failed' };
      },
    );
    return scanTask;
  }

  function resultInfo(msg) {
    const added = Number(msg && msg.added) || 0;
    const skipped = Number(msg && msg.skipped) || 0;
    const removed = Number(msg && msg.removed) || 0;
    const account = msg && msg.account;
    const names = msg && Array.isArray(msg.removedNames) ? msg.removedNames : [];
    return {
      added: added,
      skipped: skipped,
      removed: removed > 0 ? removed : 0,
      removedNames: names.filter(function (name) { return typeof name === 'string' && name; }).slice(0, 3),
      account: typeof account === 'number' ? account : null,
      avatar: msg && typeof msg.avatar === 'string' ? msg.avatar : '',
    };
  }

  async function showScanResult(msg) {
    try {
      const got = await scanCopy();
      const error = msg && typeof msg.error === 'string' ? msg.error : '';
      const info = resultInfo(msg);
      if (error === 'signedOut') paintScanMode(got, 'signedOut', info);
      else if (error === 'empty') paintScanMode(got, 'empty', info);
      else if (error) paintScanMode(got, 'failed', info);
      else if (info.added > 0) paintScanMode(got, 'added', info);
      else if (info.removed > 0) paintScanMode(got, 'removed', info);
      else paintScanMode(got, 'nothing', info);
      if (!error) startAccountPickTimer(got.pack);
    } catch (err) {
      // Done can still close the tab if a later paint works.
    }
  }

  function showImportChoice(msg, sendResponse) {
    chooseSend = sendResponse;
    const info = {
      account: msg && msg.account,
      avatar: msg && typeof msg.avatar === 'string' ? msg.avatar : '',
      fresh: msg && msg.fresh,
      extra: msg && msg.extra,
      exported: !!(msg && msg.exported === true),
      exportError: !!(msg && msg.exportError === true),
    };
    scanCopy().then(function (got) {
      safePaint(function () { paintScanMode(got, 'choose', info); });
      startAccountPickTimer(got && got.pack);
    }, function () {});
  }

  function accountCountText(pack, account) {
    if (account && account.subscribed === null) return messageOf(pack, 'scanAccountUncounted');
    if (!account || !account.subscribed) return messageOf(pack, 'scanAccountNone');
    if (account.continuation) return messageOf(pack, 'scanAccountMore', [String(account.subscribed)]);
    return countMessage(pack, 'scanAccountChannels', account.subscribed);
  }

  function clearNode(node) {
    if (!node) return;
    while (node.firstChild) {
      try { node.removeChild(node.firstChild); } catch (err) { break; }
    }
  }

  function sendAccountChoice(send, info, account) {
    clearAccountPickTimer();
    pickerSend = null;
    try {
      send({
        ok: true,
        index: account.index,
        current: info && typeof info.current === 'number' ? info.current : null,
        avatar: account.avatar || '',
      });
    } catch (err) {
      // swallow
    }
  }

  function openAccountPicker(info, send) {
    pickerWanted = false;
    pickerSend = send;
    scanCopy().then(function (got) {
      safePaint(function () { paintScanMode(got, 'picker', {}); });
      let list = null;
      try { list = document.getElementById(SCAN_OVERLAY_ID); } catch (err) { list = null; }
      const picker = list && list.querySelector ? list.querySelector('.ytc-scan-picker') : null;
      clearNode(picker);
      if (!picker) return;
      const accounts = info && info.accounts;
      const pack = got && got.pack;
      for (let i = 0; accounts && i < accounts.length; i++) {
        const account = accounts[i];
        const row = document.createElement('div');
        const scannable = account.subscribed !== 0;
        row.className = scannable
          ? 'ytc-scan-row'
          : 'ytc-scan-row ytc-scan-row--empty';
        const avatar = scanAvatarUrl(account.avatar);
        if (avatar) {
          const img = document.createElement('img');
          img.className = 'ytc-scan-avatar';
          img.alt = '';
          try { img.referrerPolicy = 'no-referrer'; } catch (err) { /* swallow */ }
          try { img.setAttribute('src', avatar); } catch (err) { img.src = avatar; }
          row.appendChild(img);
        }
        const text = document.createElement('div');
        text.className = 'ytc-scan-row-text';
        const name = document.createElement('span');
        name.className = 'ytc-scan-row-name';
        name.textContent = accountTitle(pack, account);
        if (info && info.current === account.index) {
          name.textContent += ' · ' + messageOf(pack, 'scanAccountHere');
        }
        const detail = document.createElement('span');
        detail.className = 'ytc-scan-row-detail';
        detail.textContent = accountCountText(pack, account);
        text.appendChild(name);
        text.appendChild(detail);
        row.appendChild(text);
        if (scannable) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'ytc-scan-scan';
          button.textContent = messageOf(pack, 'scanAccountScan');
          button.addEventListener('click', function (ev) {
            stopFaceEvent(ev);
            if (!isTrustedClick(ev)) return;
            if (pickerSend !== send) return;
            sendAccountChoice(send, info, account);
          });
          row.appendChild(button);
        }
        picker.appendChild(row);
      }
      startAccountPickTimer(pack);
    }, function () {});
  }

  async function readCurrentSession() {
    try {
      await ensureBridge();
      const value = await callPlayer('sessionIndex', []);
      if (typeof value === 'number' && isFinite(value) && value >= 0 && Math.floor(value) === value) {
        return value;
      }
    } catch (err) {
      return null;
    }
    return null;
  }

  async function fetchAccountHtml(index) {
    const fetchFn = root.fetch || fetch;
    const res = await fetchFn('https://www.youtube.com/feed/channels?authuser=' + index, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!res || res.ok !== true) return null;
    return await res.text();
  }

  async function collectAccounts(again) {
    if (pagePath() !== '/feed/channels') return { error: 'wrongPage' };
    // A follow-up ask arrives while the result is on screen. Fetching
    // quietly leaves that result up until Import another account.
    if (!again || pickerWanted) {
      const got = await scanCopy();
      safePaint(function () { paintScanMode(got, 'accounts', {}); });
    }
    const names = loadAccountNames();
    const accounts = [];
    for (let n = 0; n < 10; n++) {
      let html = null;
      try {
        html = await fetchAccountHtml(n);
      } catch (err) {
        break;
      }
      if (typeof html !== 'string') break;
      if (!takeAccountPage(accounts, html)) break;
    }
    if (!accounts.length) return null;
    const byIndex = await names;
    for (let i = 0; i < accounts.length; i++) {
      const found = byIndex[accounts[i].index];
      if (!found) continue;
      if (found.name) accounts[i].name = found.name;
      if (!accounts[i].avatar && found.avatar) accounts[i].avatar = found.avatar;
    }
    const current = await readCurrentSession();
    return { accounts: accounts, current: current };
  }

  function chooseAccounts(info, send, again) {
    const accounts = info.accounts;
    const rich = [];
    for (let i = 0; i < accounts.length; i++) {
      if (accounts[i].subscribed !== 0) rich.push(accounts[i]);
    }
    // again is the worker asking after a result. A navigation loads a new
    // script, so this flag, not memory, is what keeps the result on screen.
    if (!again && !pickerWanted && rich.length === 1) {
      sendAccountChoice(send, info, rich[0]);
      return;
    }
    if (again && !pickerWanted) {
      heldChoice = { send: send, info: info };
      return;
    }
    openAccountPicker(info, send);
  }

  function listAccountsForImport(again) {
    return collectAccounts(again).then(function (info) {
      if (!info) return { ok: false, error: 'signedOut' };
      if (info.error) return { ok: false, error: info.error };
      return info;
    }, function () {
      return { ok: false, error: 'failed' };
    });
  }

  function answerAccounts(msg, sendResponse) {
    const again = !!(msg && msg.again);
    listAccountsForImport(again).then(function (info) {
      if (!info || info.ok === false) {
        const error = info && info.error ? info.error : 'failed';
        if (error === 'signedOut') {
          scanCopy().then(function (got) {
            safePaint(function () { paintScanMode(got, 'signedOut', {}); });
          }, function () {});
        }
        sendResponse({ ok: false, error: error });
        return;
      }
      chooseAccounts(info, sendResponse, again);
    }, function () {
      sendResponse({ ok: false, error: 'failed' });
    });
  }

  // Group names, membership and handle folding. Same functions as
  // src/lib/view.js. This file is a classic script, so it cannot import them.
  const GROUP_NAME_MAX = 24;
  const GROUP_MAX_PER_CHANNEL = 8;

  function fold(value) {
    return String(value || '').normalize('NFKC').toLowerCase();
  }

  function normalizeGroupName(raw) {
    const collapsed = String(raw ?? '').trim().replace(/\s+/g, ' ');
    if (!collapsed) return '';
    const chars = [...collapsed];
    return chars.length > GROUP_NAME_MAX ? chars.slice(0, GROUP_NAME_MAX).join('') : collapsed;
  }

  function groupKey(name) {
    const normalised = normalizeGroupName(name);
    return normalised ? fold(normalised) : '';
  }

  function sanitizeChannelGroups(raw) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    const seen = new Set();
    for (const item of raw) {
      if (typeof item !== 'string') continue;
      const name = normalizeGroupName(item);
      if (!name) continue;
      const key = fold(name);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(name);
      if (out.length >= GROUP_MAX_PER_CHANNEL) break;
    }
    return out;
  }

  function groupNamesInList(channels, locale) {
    const names = [];
    const seen = new Set();
    for (const ch of channels || []) {
      for (const name of sanitizeChannelGroups(ch?.groups)) {
        const key = fold(name);
        if (seen.has(key)) continue;
        seen.add(key);
        names.push(name);
      }
    }
    const loc = locale === 'ar' ? 'ar' : locale === 'en' ? 'en' : undefined;
    names.sort((a, b) => a.localeCompare(b, loc, { sensitivity: 'base' }));
    return names;
  }

  function channelInGroup(ch, groupName) {
    const key = groupKey(groupName);
    if (!key) return false;
    return sanitizeChannelGroups(ch?.groups).some((name) => fold(name) === key);
  }

  function resolvedFeedGroup(channels, raw) {
    const key = fold(String(raw || '').trim());
    if (!key) return '';
    return groupNamesInList(channels).find((name) => fold(name) === key) || '';
  }

  function handleKey(handle) {
    return fold(String(handle || '').replace(/^@/, ''));
  }

  // Not settings.feed.group. That key is the popup's Feeds chip, and
  // picking a chip here must not move it.
  const SUBS_PAGE_GROUP_KEY = 'subsPageGroup';
  const SUBS_PATH = '/feed/subscriptions';
  const SUBS_ROW_ID = 'ytc-subs-groups';
  const SUBS_HIDDEN_CLASS = 'ytc-subs-hidden';
  const SUBS_SPACER_CLASS = 'ytc-subs-spacer';
  // Each continuation round is another fetch. Twelve matching cards, or
  // ten shelves, is enough: the spacer then holds the sentinel below the
  // fold so the rest loads only when the person scrolls. A narrow group
  // would otherwise keep fetching until YouTube answers with a block page.
  const SUBS_MIN_VISIBLE = 12;
  const SUBS_MAX_ROUNDS = 10;

  const subs = {
    active: false,
    channels: [],
    locale: 'en',
    selected: '',
    rounds: 0,
    brake: false,
    painting: false,
    storageBound: false,
    resizeBound: false,
    observer: null,
    observerTarget: null,
    waitObserver: null,
  };
  let subsGen = 0;
  let subsWrite = 0;
  let subsStarted = false;

  function groupsOnYouTubeEnabled(settings) {
    const feed = settings && typeof settings === 'object' ? settings.feed : null;
    if (!feed || typeof feed !== 'object' || Array.isArray(feed)) return true;
    if (!Object.prototype.hasOwnProperty.call(feed, 'groupsOnYouTube')) return true;
    return !!feed.groupsOnYouTube;
  }

  function subsPathname() {
    let path = pagePath();
    if (path.length > 1 && path.charAt(path.length - 1) === '/') path = path.slice(0, -1);
    return path;
  }

  function pageDocument() {
    try {
      if (root.document) return root.document;
    } catch (err) {
      // fall through
    }
    try {
      return document;
    } catch (err) {
      return null;
    }
  }

  function subsMatchNote(pack, count) {
    const n = Math.max(0, Math.floor(Number(count) || 0));
    return countMessage(pack, 'subsGroupsMatch', n);
  }

  function subsBrakeDue(visible, rounds) {
    return visible >= SUBS_MIN_VISIBLE || rounds >= SUBS_MAX_ROUNDS;
  }

  function subsSpacerPx(docHeight, viewport) {
    const view = Number(viewport);
    const docH = Number(docHeight);
    if (!Number.isFinite(view) || view <= 0) return 0;
    if (!Number.isFinite(docH) || docH <= 0) return Math.round(view * 2);
    return Math.max(0, Math.round(view * 2 - docH));
  }

  function parsePx(value) {
    const n = parseFloat(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function tagNameOf(el) {
    if (!el) return '';
    return String(el.tagName || el.localName || '').toLowerCase();
  }

  function hasClass(el, name) {
    if (!el || !el.classList || typeof el.classList.contains !== 'function') return false;
    try { return el.classList.contains(name); } catch (err) { return false; }
  }

  function addClass(el, name) {
    if (!el || hasClass(el, name) || !el.classList || typeof el.classList.add !== 'function') return;
    try { el.classList.add(name); } catch (err) { /* swallow */ }
  }

  function removeClass(el, name) {
    if (!hasClass(el, name) || typeof el.classList.remove !== 'function') return;
    try { el.classList.remove(name); } catch (err) { /* swallow */ }
  }

  function nameKey(value) {
    return fold(String(value || '').trim());
  }

  function handleFromHref(href) {
    const raw = String(href || '').trim();
    if (!raw) return '';
    try {
      const url = new URL(raw, PAGE_ORIGIN);
      let head = url.pathname.split('/').filter(Boolean)[0] || '';
      try { head = decodeURIComponent(head); } catch (err) { /* keep the raw segment */ }
      if (head.charAt(0) !== '@') return '';
      return handleKey(head);
    } catch (err) {
      return '';
    }
  }

  function linkHref(link) {
    if (!link) return '';
    try {
      if (typeof link.getAttribute === 'function') {
        const attr = link.getAttribute('href');
        if (attr) return attr;
      }
    } catch (err) {
      // fall through
    }
    return typeof link.href === 'string' ? link.href : '';
  }

  function cardChannelLink(card) {
    if (!card || typeof card.querySelector !== 'function') return null;
    try {
      return card.querySelector('a[href^="/@"]');
    } catch (err) {
      return null;
    }
  }

  // The avatar link is often the first a[href^="/@"] and has no text.
  // The name a person reads sits on the metadata line.
  function cardVisibleName(card) {
    if (!card || typeof card.querySelector !== 'function') return '';
    let meta = null;
    try {
      meta = card.querySelector('yt-content-metadata-view-model a[href^="/@"]');
    } catch (err) {
      meta = null;
    }
    const metaText = meta ? String(meta.textContent || '').trim() : '';
    if (metaText) return metaText;
    const link = cardChannelLink(card);
    return link ? String(link.textContent || '').trim() : '';
  }

  // A stored handle can stay empty until a later check fills it in. The
  // card still shows the channel's name, so that is the fallback: only for
  // members with no handle, so a handle that does not match stays a miss.
  // Built once per paint; walking every channel for every card stalled
  // the page with a few hundred cards and a long list.
  function groupMatcher(channels, groupName) {
    const handles = new Set();
    const names = new Set();
    const list = Array.isArray(channels) ? channels : [];
    for (let i = 0; i < list.length; i++) {
      const ch = list[i];
      if (!channelInGroup(ch, groupName)) continue;
      const stored = handleKey(ch && ch.handle);
      if (stored) handles.add(stored);
      else {
        const name = nameKey(ch && ch.title);
        if (name) names.add(name);
      }
    }
    return { handles: handles, names: names };
  }

  // A card with no channel link has nothing safe to match, so it stays hidden.
  function cardInGroup(card, matcher) {
    const link = cardChannelLink(card);
    if (!link) return false;
    const handle = handleFromHref(linkHref(link));
    if (handle && matcher.handles.has(handle)) return true;
    const visible = nameKey(cardVisibleName(card));
    return !!visible && matcher.names.has(visible);
  }

  function childElements(parent) {
    if (!parent || !parent.children) return [];
    const out = [];
    const kids = parent.children;
    for (let i = 0; i < kids.length; i++) out.push(kids[i]);
    return out;
  }

  function applySubsFilter(contents, channels, groupName) {
    const kids = childElements(contents);
    const group = resolvedFeedGroup(channels, groupName);
    let loaded = 0;
    let visible = 0;
    if (!group) {
      for (let i = 0; i < kids.length; i++) removeClass(kids[i], SUBS_HIDDEN_CLASS);
      for (let i = 0; i < kids.length; i++) {
        if (tagNameOf(kids[i]) === 'ytd-rich-item-renderer') {
          loaded += 1;
          visible += 1;
        }
      }
      return { visible: visible, loaded: loaded, filtered: false, group: '' };
    }
    const matcher = groupMatcher(channels, group);
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (tagNameOf(el) !== 'ytd-rich-item-renderer') continue;
      loaded += 1;
      const show = cardInGroup(el, matcher);
      if (show) {
        removeClass(el, SUBS_HIDDEN_CLASS);
        visible += 1;
      } else {
        addClass(el, SUBS_HIDDEN_CLASS);
      }
    }
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      if (tagNameOf(el) !== 'ytd-rich-section-renderer') continue;
      let followed = false;
      for (let j = i + 1; j < kids.length; j++) {
        if (tagNameOf(kids[j]) === 'ytd-rich-section-renderer') break;
        if (tagNameOf(kids[j]) === 'ytd-rich-item-renderer' && !hasClass(kids[j], SUBS_HIDDEN_CLASS)) {
          followed = true;
          break;
        }
      }
      if (followed) removeClass(el, SUBS_HIDDEN_CLASS);
      else addClass(el, SUBS_HIDDEN_CLASS);
    }
    return { visible: visible, loaded: loaded, filtered: true, group: group };
  }

  function findChild(contents, pred) {
    const kids = childElements(contents);
    for (let i = 0; i < kids.length; i++) {
      if (pred(kids[i])) return kids[i];
    }
    return null;
  }

  function removeNode(node) {
    if (!node || !node.parentNode || typeof node.parentNode.removeChild !== 'function') return;
    try { node.parentNode.removeChild(node); } catch (err) { /* swallow */ }
  }

  function removeSubsSpacer(contents) {
    if (!contents) return;
    const spacer = findChild(contents, function (el) { return hasClass(el, SUBS_SPACER_CLASS); });
    removeNode(spacer);
  }

  function readViewport() {
    try {
      const win = root.window || root;
      const h = win && win.innerHeight;
      if (typeof h === 'number' && h > 0) return h;
    } catch (err) {
      // swallow
    }
    return 0;
  }

  function applySpacerHeight(spacer) {
    if (!spacer) return;
    const doc = pageDocument();
    const scroller = doc && (doc.scrollingElement || doc.documentElement);
    const total = scroller && typeof scroller.scrollHeight === 'number' ? scroller.scrollHeight : 0;
    const current = spacer.offsetHeight || parsePx(spacer.style && spacer.style.height) || 0;
    const without = Math.max(0, total - current);
    const px = subsSpacerPx(without, readViewport());
    const next = px ? (px + 'px') : '0px';
    if (!spacer.style) spacer.style = {};
    if (spacer.style.height !== next) spacer.style.height = next;
  }

  // The sentinel loads the next shelf when it scrolls into view. Height
  // placed after it would not move it, so the spacer sits in front of it.
  function placeSubsSpacer(contents) {
    if (!contents || typeof contents.insertBefore !== 'function') return null;
    const doc = pageDocument();
    if (!doc || typeof doc.createElement !== 'function') return null;
    let spacer = findChild(contents, function (el) { return hasClass(el, SUBS_SPACER_CLASS); });
    if (!spacer) {
      spacer = doc.createElement('div');
      spacer.className = SUBS_SPACER_CLASS;
      if (typeof spacer.setAttribute === 'function') spacer.setAttribute('aria-hidden', 'true');
    }
    const sentinel = findChild(contents, function (el) {
      return tagNameOf(el) === 'ytd-continuation-item-renderer';
    });
    if (sentinel) {
      if (spacer.parentNode !== contents || spacer.nextSibling !== sentinel) {
        contents.insertBefore(spacer, sentinel);
      }
    } else if (spacer.parentNode !== contents || contents.lastChild !== spacer) {
      contents.appendChild(spacer);
    }
    applySpacerHeight(spacer);
    return spacer;
  }

  function renderSubsContents(contents, channels, groupName, rounds, pack) {
    const applied = applySubsFilter(contents, channels, groupName);
    let brake = false;
    let note = '';
    if (!applied.group) {
      removeSubsSpacer(contents);
    } else {
      brake = subsBrakeDue(applied.visible, rounds);
      if (brake) placeSubsSpacer(contents);
      else removeSubsSpacer(contents);
      if (brake && applied.visible < SUBS_MIN_VISIBLE) note = subsMatchNote(pack, applied.visible);
    }
    return {
      visible: applied.visible,
      loaded: applied.loaded,
      filtered: applied.filtered,
      group: applied.group,
      brake: brake,
      note: note,
    };
  }

  function findGrid() {
    const doc = pageDocument();
    if (!doc || typeof doc.querySelector !== 'function') return null;
    // Home stays mounted, hidden, and its grid is the first one in the document.
    try {
      return doc.querySelector('ytd-browse[page-subtype="subscriptions"] ytd-rich-grid-renderer');
    } catch (err) {
      return null;
    }
  }

  function findContents() {
    const grid = findGrid();
    if (!grid) return null;
    const kids = childElements(grid);
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] && kids[i].id === 'contents') return kids[i];
    }
    return null;
  }

  function findChipRow() {
    const grid = findGrid();
    if (!grid) return null;
    const kids = childElements(grid);
    for (let i = 0; i < kids.length; i++) {
      if (kids[i] && kids[i].id === SUBS_ROW_ID) return kids[i];
    }
    return null;
  }

  function chipLabel(name, pack) {
    if (name) return name;
    return messageOf(pack, 'subsGroupsAll');
  }

  function buildChipRow(names, selected, locale, pack) {
    const doc = pageDocument();
    if (!doc || typeof doc.createElement !== 'function') return null;
    const row = doc.createElement('div');
    row.id = SUBS_ROW_ID;
    row.className = 'ytc-subs-groups';
    const dir = locale === 'ar' ? 'rtl' : 'ltr';
    const lang = locale === 'ar' ? 'ar' : 'en';
    if (typeof row.setAttribute === 'function') {
      row.setAttribute('dir', dir);
      row.setAttribute('lang', lang);
    }
    const bar = doc.createElement('div');
    bar.className = 'ytc-subs-groups__bar';
    if (typeof bar.setAttribute === 'function') {
      bar.setAttribute('role', 'group');
      bar.setAttribute('aria-label', messageOf(pack, 'subsGroupsLabel'));
    }
    const chips = [{ name: '', label: chipLabel('', pack) }];
    for (let i = 0; i < names.length; i++) chips.push({ name: names[i], label: names[i] });
    for (let i = 0; i < chips.length; i++) {
      const chip = chips[i];
      const btn = doc.createElement('button');
      btn.type = 'button';
      btn.className = 'ytc-subs-groups__chip';
      btn.textContent = chip.label;
      if (typeof btn.setAttribute === 'function') {
        btn.setAttribute('data-group', chip.name);
        btn.setAttribute('aria-pressed', chip.name === selected ? 'true' : 'false');
      }
      if (typeof btn.addEventListener === 'function') {
        btn.addEventListener('click', function (ev) {
          try {
            if (ev && ev.preventDefault) ev.preventDefault();
            if (ev && ev.stopPropagation) ev.stopPropagation();
          } catch (err) {
            // swallow
          }
          chooseSubsGroup(chip.name);
        });
      }
      bar.appendChild(btn);
    }
    const note = doc.createElement('p');
    note.className = 'ytc-subs-groups__note';
    if (typeof note.setAttribute === 'function') note.setAttribute('hidden', '');
    row.appendChild(bar);
    row.appendChild(note);
    return row;
  }

  function paintPressed(row, selected) {
    if (!row || !row.firstChild) return;
    const buttons = childElements(row.firstChild);
    const current = selected || '';
    for (let i = 0; i < buttons.length; i++) {
      const btn = buttons[i];
      if (!btn || typeof btn.getAttribute !== 'function' || typeof btn.setAttribute !== 'function') continue;
      const name = btn.getAttribute('data-group') || '';
      btn.setAttribute('aria-pressed', name === current ? 'true' : 'false');
    }
  }

  function paintSubsNote(row, text) {
    if (!row) return;
    const kids = childElements(row);
    let note = null;
    for (let i = 0; i < kids.length; i++) {
      if (hasClass(kids[i], 'ytc-subs-groups__note')) note = kids[i];
    }
    if (!note) return;
    if (!text) {
      note.textContent = '';
      if (typeof note.setAttribute === 'function') note.setAttribute('hidden', '');
      return;
    }
    if (typeof note.removeAttribute === 'function') note.removeAttribute('hidden');
    note.textContent = text;
  }

  function ensureChipRow(contents, pack) {
    if (!contents || !contents.parentNode || typeof contents.parentNode.insertBefore !== 'function') return null;
    const names = groupNamesInList(subs.channels, subs.locale);
    const sig = subs.locale + '\n' + (messageOf(pack, 'subsGroupsAll') || '') + '\n' + names.join('\n');
    let row = findChipRow();
    if (!row || row._ytcSig !== sig) {
      const fresh = buildChipRow(names, subs.selected, subs.locale, pack);
      if (!fresh) return null;
      fresh._ytcSig = sig;
      if (row) removeNode(row);
      contents.parentNode.insertBefore(fresh, contents);
      row = fresh;
    } else if (row.parentNode !== contents.parentNode || row.nextSibling !== contents) {
      contents.parentNode.insertBefore(row, contents);
    }
    paintPressed(row, subs.selected);
    return row;
  }

  function paintSubsNow(pack) {
    if (subs.painting) return;
    subs.painting = true;
    try {
      const contents = findContents();
      if (!contents) return;
      const rendered = renderSubsContents(
        contents,
        subs.channels,
        subs.selected,
        subs.rounds,
        pack,
      );
      subs.brake = rendered.brake;
      subs.selected = rendered.group;
      const row = ensureChipRow(contents, pack);
      if (row) paintSubsNote(row, rendered.note);
    } catch (err) {
      // swallow
    } finally {
      subs.painting = false;
    }
  }

  // The pack is fetched once per language. A cached pack paints in this
  // turn, so a burst of new cards is not dropped while a message is in flight.
  function paintSubs() {
    const locale = subs.locale;
    const loc = locale === 'ar' ? 'ar' : 'en';
    if (overlayByLocale[loc]) {
      paintSubsNow(overlayByLocale[loc]);
      return Promise.resolve();
    }
    return overlayPackFor(locale).then(function (pack) {
      if (!subs.active || (subs.locale === 'ar' ? 'ar' : 'en') !== loc) return;
      paintSubsNow(pack);
    }, function () {});
  }

  function isForeignSubsNode(node) {
    if (!node || node.nodeType !== 1) return false;
    if (node.id === SUBS_ROW_ID) return false;
    if (hasClass(node, SUBS_SPACER_CLASS)) return false;
    return true;
  }

  function watchContents(contents) {
    if (!contents) return;
    const Ctor = root.MutationObserver;
    if (typeof Ctor !== 'function') return;
    if (subs.observer && subs.observerTarget === contents) return;
    if (subs.observer) {
      try { subs.observer.disconnect(); } catch (err) { /* swallow */ }
      subs.observer = null;
      subs.observerTarget = null;
    }
    let obs = null;
    try {
      obs = new Ctor(function (records) {
        if (!subs.active || subs.painting) return;
        let foreign = false;
        const list = records || [];
        for (let i = 0; i < list.length; i++) {
          const nodes = list[i] && list[i].addedNodes;
          if (!nodes) continue;
          for (let j = 0; j < nodes.length; j++) {
            if (isForeignSubsNode(nodes[j])) foreign = true;
          }
        }
        if (foreign && subs.selected && !subs.brake) subs.rounds += 1;
        paintSubs();
      });
      obs.observe(contents, { childList: true });
      subs.observer = obs;
      subs.observerTarget = contents;
    } catch (err) {
      subs.observer = null;
      subs.observerTarget = null;
    }
  }

  function watchForGrid() {
    if (subs.waitObserver) return;
    const Ctor = root.MutationObserver;
    if (typeof Ctor !== 'function') return;
    const doc = pageDocument();
    const body = doc && doc.body;
    if (!body) return;
    let obs = null;
    try {
      obs = new Ctor(function () {
        if (subsPathname() !== SUBS_PATH || !subs.active) {
          try { obs.disconnect(); } catch (err) { /* swallow */ }
          if (subs.waitObserver === obs) subs.waitObserver = null;
          return;
        }
        const contents = findContents();
        if (!contents) return;
        try { obs.disconnect(); } catch (err) { /* swallow */ }
        if (subs.waitObserver === obs) subs.waitObserver = null;
        paintSubs();
        watchContents(contents);
      });
      obs.observe(body, { childList: true, subtree: true });
      subs.waitObserver = obs;
    } catch (err) {
      subs.waitObserver = null;
    }
  }

  function onSubsResize() {
    if (!subs.active || !subs.brake || !subs.selected) return;
    const contents = findContents();
    if (!contents) return;
    const spacer = findChild(contents, function (el) { return hasClass(el, SUBS_SPACER_CLASS); });
    if (spacer) applySpacerHeight(spacer);
  }

  function bindSubsResize() {
    if (subs.resizeBound) return;
    const win = root.window || root;
    if (!win || typeof win.addEventListener !== 'function') return;
    try {
      win.addEventListener('resize', onSubsResize);
      subs.resizeBound = true;
    } catch (err) {
      // swallow
    }
  }

  function unbindSubsResize() {
    if (!subs.resizeBound) return;
    const win = root.window || root;
    if (win && typeof win.removeEventListener === 'function') {
      try { win.removeEventListener('resize', onSubsResize); } catch (err) { /* swallow */ }
    }
    subs.resizeBound = false;
  }

  function teardownSubsDom() {
    subs.active = false;
    subs.brake = false;
    subs.rounds = 0;
    subs.painting = false;
    subs.selected = '';
    if (subs.observer) {
      try { subs.observer.disconnect(); } catch (err) { /* swallow */ }
    }
    subs.observer = null;
    subs.observerTarget = null;
    if (subs.waitObserver) {
      try { subs.waitObserver.disconnect(); } catch (err) { /* swallow */ }
    }
    subs.waitObserver = null;
    unbindSubsResize();
    try {
      const contents = findContents();
      if (contents) {
        applySubsFilter(contents, subs.channels, '');
        removeSubsSpacer(contents);
      }
      removeNode(findChipRow());
    } catch (err) {
      // swallow
    }
  }

  async function readSubsStored() {
    const empty = { channels: [], settings: null, selected: '' };
    const ch = root.chrome;
    if (!ch || !ch.storage || !ch.storage.local || typeof ch.storage.local.get !== 'function') return empty;
    try {
      const got = await ch.storage.local.get(['channels', 'settings', SUBS_PAGE_GROUP_KEY]);
      return {
        channels: got && Array.isArray(got.channels) ? got.channels : [],
        settings: got ? got.settings : null,
        selected: got && typeof got[SUBS_PAGE_GROUP_KEY] === 'string' ? got[SUBS_PAGE_GROUP_KEY] : '',
      };
    } catch (err) {
      return empty;
    }
  }

  function writeSubsGroup(name) {
    const ch = root.chrome;
    if (!ch || !ch.storage || !ch.storage.local || typeof ch.storage.local.set !== 'function') return;
    const payload = {};
    payload[SUBS_PAGE_GROUP_KEY] = name;
    try {
      const pending = ch.storage.local.set(payload);
      if (pending && typeof pending.then === 'function') pending.then(function () {}, function () {});
    } catch (err) {
      // swallow
    }
  }

  function chooseSubsGroup(name) {
    const resolved = name ? resolvedFeedGroup(subs.channels, name) : '';
    if (subs.active && resolved === subs.selected) return;
    subsWrite += 1;
    subs.selected = resolved;
    subs.rounds = 0;
    subs.brake = false;
    const contents = findContents();
    if (contents) removeSubsSpacer(contents);
    if (subs.active) paintSubs();
    writeSubsGroup(resolved);
  }

  async function refreshSubsGroups() {
    const gen = ++subsGen;
    const writeAt = subsWrite;
    if (subsPathname() !== SUBS_PATH) {
      teardownSubsDom();
      return;
    }
    const stored = await readSubsStored();
    if (gen !== subsGen) return;
    if (subsPathname() !== SUBS_PATH) {
      teardownSubsDom();
      return;
    }
    const channels = stored.channels;
    const settings = stored.settings;
    subs.locale = localeFromSettings(settings, navigatorLanguage());
    const names = groupNamesInList(channels, subs.locale);
    // Off, or a list with no groups: the page stays as YouTube drew it.
    if (!groupsOnYouTubeEnabled(settings) || names.length === 0) {
      teardownSubsDom();
      return;
    }
    subs.channels = channels;
    if (writeAt === subsWrite) {
      const resolved = resolvedFeedGroup(channels, stored.selected);
      if (!subs.active || resolved !== subs.selected) {
        if (resolved !== subs.selected) {
          subs.rounds = 0;
          subs.brake = false;
        }
        subs.selected = resolved;
      }
    }
    subs.active = true;
    await paintSubs();
    const contents = findContents();
    if (contents) {
      if (subs.waitObserver) {
        try { subs.waitObserver.disconnect(); } catch (err) { /* swallow */ }
        subs.waitObserver = null;
      }
      watchContents(contents);
    } else {
      watchForGrid();
    }
    bindSubsResize();
  }

  function syncSubsPage() {
    if (subsPathname() !== SUBS_PATH) {
      teardownSubsDom();
      return;
    }
    refreshSubsGroups();
  }

  function onSubsStorage(changes, area) {
    try {
      if (area !== 'local' || !changes) return;
      if (subsPathname() !== SUBS_PATH) return;
      const groupChange = changes[SUBS_PAGE_GROUP_KEY];
      const channelsChange = changes.channels;
      const settingsChange = changes.settings;
      if (!groupChange && !channelsChange && !settingsChange) return;
      if (groupChange && !channelsChange && !settingsChange) {
        const next = typeof groupChange.newValue === 'string'
          ? resolvedFeedGroup(subs.channels, groupChange.newValue)
          : '';
        if (next === subs.selected) return;
      }
      refreshSubsGroups();
    } catch (err) {
      // swallow
    }
  }

  function bindSubsStorage() {
    if (subs.storageBound) return;
    const ch = root.chrome;
    if (!ch || !ch.storage || !ch.storage.onChanged || typeof ch.storage.onChanged.addListener !== 'function') return;
    try {
      ch.storage.onChanged.addListener(onSubsStorage);
      subs.storageBound = true;
    } catch (err) {
      // swallow
    }
  }

  function startSubsGroups() {
    if (subsStarted) return;
    subsStarted = true;
    const doc = pageDocument();
    if (doc && typeof doc.addEventListener === 'function') {
      try { doc.addEventListener('yt-navigate-finish', syncSubsPage); } catch (err) { /* swallow */ }
    }
    const win = root.window || root;
    if (win && typeof win.addEventListener === 'function') {
      try { win.addEventListener('popstate', syncSubsPage); } catch (err) { /* swallow */ }
    }
    bindSubsStorage();
    syncSubsPage();
  }

  function boot() {
    try {
      const win = root.window || root;
      if (win && win.addEventListener) win.addEventListener('message', onBridgeMessage, false);
    } catch (err) {
      // swallow
    }
    const ch = root.chrome;
    if (ch && ch.runtime && ch.runtime.onMessage && ch.runtime.onMessage.addListener) {
      ch.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
        if (!msg) return;
        if (msg.type === 'audioMode.state') {
          sendResponse({ ok: true, on: !!session });
          return;
        }
        if (msg.type === 'audioMode.player') {
          readPlayerWithChannels().then(
            function (res) { sendResponse(res); },
            function () { sendResponse(readPlayer()); },
          );
          return true;
        }
        if (msg.type === 'audioMode.control') {
          controlPlayer(msg).then(
            function (res) { sendResponse(res || { ok: false }); },
            function () { sendResponse({ ok: false }); },
          );
          return true;
        }
        if (msg.type === 'subscriptions.accounts') {
          answerAccounts(msg, sendResponse);
          return true;
        }
        if (msg.type === 'subscriptions.scan') {
          scanSubscriptions(msg).then(
            function (res) { sendResponse(res || { ok: false, error: 'failed' }); },
            function () { sendResponse({ ok: false, error: 'failed' }); },
          );
          return true;
        }
        if (msg.type === 'subscriptions.result') {
          showScanResult(msg).then(
            function () { sendResponse({ ok: true }); },
            function () { sendResponse({ ok: true }); },
          );
          return true;
        }
        if (msg.type === 'subscriptions.choose') {
          showImportChoice(msg, sendResponse);
          return true;
        }
        if (msg.type === 'subscriptions.download') {
          let ok = false;
          try { ok = saveScanDownload(msg) === true; } catch (err) { ok = false; }
          try { sendResponse({ ok: ok }); } catch (err) { /* swallow */ }
          return;
        }
        if (msg.type !== 'audioMode.toggle') return;
        toggle().then(
          function () { sendResponse({ ok: true, on: !!session }); },
          function () { sendResponse({ ok: false, on: !!session }); },
        );
        return true;
      });
    }
    try {
      const doc = root.document;
      // ended does not bubble, but a capture listener on document still
      // sees it, and keeps working across YouTube's in-page navigations
      // without tracking which <video> is current.
      if (doc && typeof doc.addEventListener === 'function') {
        doc.addEventListener('ended', onVideoEnded, true);
      }
    } catch (err) {
      // swallow
    }
    // The worker says whether this tab was opened in audio mode.
    requestAudioModeBoot();
    try { startSubsGroups(); } catch (err) { /* swallow */ }
  }

  const api = {
    TOKEN_RE,
    AUDIO_STATS_KEY,
    AUDIO_STATS_RETENTION_DAYS,
    PRESETS,
    DEFAULT_PRESET,
    pickAudioQuality,
    isQualityRow,
    lookupPreset,
    sanitizeHex,
    overlayLookFromSettings,
    mergeAudioStats,
    persistAudioStats,
    applyLook,
    findOverlayParent,
    resolveLocale,
    localeFromSettings,
    messageOf,
    boundShortcut,
    exitLabel,
    overlayCopy,
    overlayPackFor,
    ensureBridge,
    restorableQuality,
    restoreFallbackFromSettings,
    readPlayer,
    readPlayerWithChannels,
    cleanCollaborators,
    parseControl,
    controlPlayer,
    enable,
    disable,
    scanSubscriptions,
    showScanResult,
    parseSubscriptionsHtml,
    takeAccountPage,
    parseAccountSwitcher,
    openAccountPicker,
    chooseAccounts,
    fold,
    normalizeGroupName,
    groupNamesInList,
    channelInGroup,
    resolvedFeedGroup,
    handleKey,
    groupsOnYouTubeEnabled,
    subsMatchNote,
    subsBrakeDue,
    subsSpacerPx,
    applySubsFilter,
    renderSubsContents,
    refreshSubsGroups,
    chooseSubsGroup,
    syncSubsPage,
    SUBS_PAGE_GROUP_KEY,
    SUBS_HIDDEN_CLASS,
    SUBS_MIN_VISIBLE,
    SUBS_MAX_ROUNDS,
  };

  // Named API is for the Node suite only. A youtube.com script that can
  // read AudioModeContent would know this extension is installed.
  if (root.__ytcHarness) {
    try {
      Object.defineProperty(root, 'AudioModeContent', {
        value: api,
        enumerable: false,
        configurable: true,
      });
    } catch (err) {
      root.AudioModeContent = api;
    }
  }

  if (shouldBoot()) boot();
})(typeof globalThis !== 'undefined' ? globalThis : this);
