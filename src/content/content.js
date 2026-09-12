/**
 * Isolated-world audio-mode engine. Pins the player to 144p, covers the
 * video, accounts listening time, and tears the session down on one
 * AbortSignal. Classic script: content scripts cannot use import.
 */

(function (root) {
  'use strict';

  const Core = root.AudioModeCore;
  if (!Core) return;

  const BRIDGE_TYPE = 'ytc-audio-bridge';
  const PAGE_ORIGIN = 'https://www.youtube.com';
  const OVERLAY_ID = 'ytc-audio-overlay';
  const AUDIO_STATS_KEY = 'audioStats';
  const AUDIO_STATS_RETENTION_DAYS = 90;
  const SAMPLE_MS = 5000;
  const FLUSH_MS = 30000;
  const CALL_TIMEOUT_MS = 1500;
  const PIN_SETTLE_MS = 250;
  const MENU_WAIT_MS = 150;
  const DEFAULT_RESTORE = 'hd720';
  const DEFAULT_PRESET = 'midnight';

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

  function overlayLookFromSettings(settings) {
    const audio = settings && typeof settings === 'object' ? settings.audio : null;
    const group = audio && typeof audio === 'object' ? audio : {};
    const type = typeof group.backgroundType === 'string'
      ? group.backgroundType.trim().toLowerCase()
      : 'color';

    if (type === 'image') {
      const url = Core.sanitizeImageUrl(group.imageUrl);
      if (url) return { kind: 'image', url: url, preset: DEFAULT_PRESET };
    }

    if (group.preset === 'custom' || type === 'custom') {
      const color = sanitizeHex(group.customColor || group.color);
      if (color) return { kind: 'color', color: color, preset: DEFAULT_PRESET };
    }

    const preset = lookupPreset(group.preset);
    return { kind: 'preset', preset: preset.name, from: preset.from, to: preset.to };
  }

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

  function messageOf(json, key, substitutions) {
    if (!json || typeof json !== 'object') return '';
    const entry = json[key];
    if (!entry || typeof entry.message !== 'string') return '';
    let msg = entry.message;
    const placeholders = entry.placeholders;
    if (placeholders && typeof placeholders === 'object') {
      for (const name of Object.keys(placeholders)) {
        const spec = placeholders[name];
        const content = spec && spec.content != null ? String(spec.content) : '';
        msg = msg.replace(new RegExp('\\$' + escapeRe(name) + '\\$', 'gi'), content);
      }
    }
    const subs = substitutions == null ? [] : [].concat(substitutions);
    return msg
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

  function exitLabel(messages, shortcut) {
    const bound = boundShortcut(shortcut);
    if (bound) return messageOf(messages, 'overlayExitShortcut', [bound]);
    return messageOf(messages, 'overlayExit');
  }

  function overlayCopy(settings, messages, shortcut, navigatorLanguageValue) {
    const locale = localeFromSettings(settings, navigatorLanguageValue);
    return {
      locale: locale,
      dir: locale === 'ar' ? 'rtl' : 'ltr',
      title: messageOf(messages, 'overlayTitle'),
      exit: exitLabel(messages, shortcut),
    };
  }

  const overlayMessages = new Map();
  let shortcutOnce = null;

  async function loadOverlayMessages(locale) {
    const loc = locale === 'ar' ? 'ar' : 'en';
    if (overlayMessages.has(loc)) return overlayMessages.get(loc);
    const pending = (async function () {
      const ch = root.chrome;
      if (!ch || !ch.runtime || typeof ch.runtime.getURL !== 'function') return null;
      const url = ch.runtime.getURL('_locales/' + loc + '/messages.json');
      const res = await fetch(url);
      return await res.json();
    })();
    overlayMessages.set(loc, pending);
    try {
      const json = await pending;
      if (!json || typeof json !== 'object') {
        overlayMessages.delete(loc);
        return null;
      }
      overlayMessages.set(loc, json);
      return json;
    } catch (err) {
      overlayMessages.delete(loc);
      return null;
    }
  }

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
    const messages = await loadOverlayMessages(locale);
    const shortcut = await requestAudioModeShortcut();
    let node = null;
    try { node = document.getElementById(OVERLAY_ID); } catch (err) { node = null; }
    if (!node || node !== el) return;
    const copy = overlayCopy(settings, messages, shortcut, nav);
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
    readStoredSettings().then(function (settings) {
      const node = document.getElementById(OVERLAY_ID);
      if (!node) return;
      applyLook(node, overlayLookFromSettings(settings));
      paintFace(node, settings);
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

    const at = when.getTime();
    return {
      listened: Core.pruneOldEntries(listened, AUDIO_STATS_RETENTION_DAYS, at),
      active: Core.pruneOldEntries(active, AUDIO_STATS_RETENTION_DAYS, at),
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
        win.postMessage({
          type: BRIDGE_TYPE,
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
      if (data.type !== BRIDGE_TYPE) return;
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
      el.dataset.kind = 'image';
      el.dataset.preset = look.preset || DEFAULT_PRESET;
      el.style.backgroundImage = 'url("' + look.url + '")';
      return;
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

  function menuItems(rootEl) {
    if (!rootEl || typeof rootEl.querySelectorAll !== 'function') return [];
    return Array.prototype.slice.call(rootEl.querySelectorAll(YTP_MENU_ITEM));
  }

  function itemLabel(el) {
    const lab = el.querySelector(YTP_MENU_ITEM_LABEL);
    return ((lab && lab.textContent) || el.textContent || '').trim();
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
        if (/quality/i.test(itemLabel(rows[i]))) {
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
      if (area !== 'local' || !changes || !changes.settings) return;
      const el = document.getElementById(OVERLAY_ID);
      if (!el) return;
      applyLook(el, overlayLookFromSettings(changes.settings.newValue));
      paintFace(el, changes.settings.newValue);
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
    signal.addEventListener('abort', function () {
      clearInterval(sampleId);
      clearInterval(flushId);
    });
  }

  function ensureBridge() {
    if (bridgePromise) return bridgePromise;
    bridgePromise = new Promise(function (resolve) {
      try {
        const ch = root.chrome;
        if (!ch || !ch.runtime || typeof ch.runtime.getURL !== 'function' || typeof document === 'undefined') {
          resolve();
          return;
        }
        const s = document.createElement('script');
        s.src = ch.runtime.getURL('src/content/inject.js');
        s.onload = function () {
          if (s.parentNode) s.parentNode.removeChild(s);
          resolve();
        };
        s.onerror = function () {
          if (s.parentNode) s.parentNode.removeChild(s);
          resolve();
        };
        (document.head || document.documentElement).appendChild(s);
      } catch (err) {
        resolve();
      }
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

  function shouldBoot() {
    try {
      if (typeof document === 'undefined' || !document || !document.documentElement) return false;
      const ch = root.chrome;
      return !!(ch && ch.runtime && ch.runtime.id && typeof ch.runtime.getURL === 'function');
    } catch (err) {
      return false;
    }
  }

  function boot() {
    // Isolated-world console is not the page console. This attribute is
    // how you prove which content-script revision is live after a reload.
    try {
      document.documentElement.dataset.amBeacon = 'loaded';
    } catch (err) {
      // swallow
    }
    try {
      const win = root.window || root;
      if (win && win.addEventListener) win.addEventListener('message', onBridgeMessage, false);
    } catch (err) {
      // swallow
    }
    const ch = root.chrome;
    if (ch && ch.runtime && ch.runtime.onMessage && ch.runtime.onMessage.addListener) {
      ch.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
        if (!msg || msg.type !== 'audioMode.toggle') return;
        toggle().then(
          function () { sendResponse({ ok: true, on: !!session }); },
          function () { sendResponse({ ok: false, on: !!session }); },
        );
        return true;
      });
    }
  }

  const api = {
    BRIDGE_TYPE,
    AUDIO_STATS_KEY,
    AUDIO_STATS_RETENTION_DAYS,
    PRESETS,
    DEFAULT_PRESET,
    pickAudioQuality,
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
    restorableQuality,
    restoreFallbackFromSettings,
    enable,
    disable,
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
