/**
 * Fake `chrome` for the popup when rendered by `scripts/shots.js`.
 * Installed before core.js and popup.js so every API the popup calls
 * answers with SHOTS_DEMO data instead of talking to a worker.
 */

(function (root) {
  'use strict';

  if (!root.SHOTS_DEMO) {
    var demoXhr = new XMLHttpRequest();
    demoXhr.open('GET', '/scripts/shots/demo.js', false);
    demoXhr.send(null);
    if (demoXhr.status < 200 || demoXhr.status >= 300) {
      throw new Error('shots demo.js failed to load');
    }
    (0, eval)(demoXhr.responseText);
  }

  var params = new URLSearchParams(root.location.search);
  var scene = params.get('scene') || 'player';
  var locale = params.get('locale') === 'ar' ? 'ar' : 'en';

  function demo() {
    return root.SHOTS_DEMO || {};
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  function clone(value) {
    if (value === undefined) return undefined;
    return structuredClone(value);
  }

  function merge(defaults, stored) {
    if (!isPlainObject(stored)) return clone(defaults);
    var out = clone(defaults);
    Object.keys(stored).forEach(function (key) {
      if (!(key in out)) return;
      if (stored[key] === undefined) return;
      var base = out[key];
      if (isPlainObject(base) && isPlainObject(stored[key])) {
        out[key] = merge(base, stored[key]);
      } else if (!isPlainObject(base)) {
        out[key] = stored[key];
      }
    });
    return out;
  }

  var settings = merge(demo().defaultSettings || {}, { ui: { locale: locale } });
  var sessionStore = {};

  function snapshot() {
    var d = demo();
    return {
      settings: clone(settings),
      channels: clone(d.channels || []),
      feed: clone(d.feed || []),
      pollState: clone(d.pollState || {}),
      queue: clone(d.queue || []),
      queueOpen: d.queueOpen === true,
    };
  }

  function readManifest() {
    try {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', '/manifest.json', false);
      xhr.send(null);
      if (xhr.status >= 200 && xhr.status < 300) return JSON.parse(xhr.responseText);
    } catch (err) {
      // version line in Settings stays hidden if the file cannot be read
    }
    return { version: '' };
  }

  var manifest = readManifest();

  function handleRuntime(message) {
    var type = message && message.type;
    if (type === 'getState') return snapshot();
    if (type === 'popupOpened') {
      var opened = snapshot();
      // Same field the worker sends: lastSeenAt is not overwritten here, so
      // the previous value is the snapshot's own lastSeenAt.
      opened.previousLastSeenAt = Number((opened.pollState && opened.pollState.lastSeenAt) || 0);
      return opened;
    }
    if (type === 'updateSettings') {
      settings = merge(settings, message.patch || {});
      return snapshot();
    }
    if (type === 'audioMode.shortcut') return { ok: true, shortcut: 'Alt+Shift+A' };
    if (type === 'sweep') return { ok: true };
    return { ok: true };
  }

  function playerFor(tabId) {
    var d = demo();
    // A channel page with no video: content.js returns ok:false, on:false.
    if (scene === 'follow' || tabId === 103) {
      return { ok: false, on: false };
    }
    if (tabId === 102) {
      return {
        ok: true,
        on: false,
        paused: true,
        currentTime: 0,
        duration: 1520,
        playbackRate: 1,
        volume: 100,
        muted: false,
        title: 'I Survived The Most Extreme Places On Earth',
        channel: 'MrBeast',
        videoId: 'gTKS8SAwUzE',
      };
    }
    return clone(d.player);
  }

  function demoTabs() {
    var d = demo();
    if (scene === 'follow') {
      // Channel page whose handle is not on the demo list, so followView
      // shows the card the same way a real focused tab would.
      return [{
        id: 103,
        url: 'https://www.youtube.com/@vsauce',
        title: 'Vsauce - YouTube',
        active: true,
        audible: false,
        status: 'complete',
        windowId: 1,
        index: 0,
        lastAccessed: Date.now(),
      }];
    }
    return clone(d.tabs || []);
  }

  function matchUrl(tab, pattern) {
    if (!pattern || typeof tab.url !== 'string') return true;
    if (pattern.indexOf('https://www.youtube.com/') === 0) {
      return tab.url.indexOf('https://www.youtube.com/') === 0;
    }
    return tab.url === pattern;
  }

  function events() {
    return {
      addListener: function () {},
      removeListener: function () {},
      hasListener: function () { return false; },
    };
  }

  function storageGet(store, keys) {
    if (keys === null || keys === undefined) return clone(store);
    if (typeof keys === 'string') {
      var one = {};
      if (keys in store) one[keys] = clone(store[keys]);
      return one;
    }
    if (Array.isArray(keys)) {
      var listed = {};
      keys.forEach(function (key) {
        if (key in store) listed[key] = clone(store[key]);
      });
      return listed;
    }
    if (keys && typeof keys === 'object') {
      var withDefaults = {};
      Object.keys(keys).forEach(function (key) {
        withDefaults[key] = key in store ? clone(store[key]) : clone(keys[key]);
      });
      return withDefaults;
    }
    return clone(store);
  }

  function localStore() {
    var d = demo();
    return { audioStats: d.audioStats };
  }

  root.chrome = {
    runtime: {
      id: 'shots',
      lastError: undefined,
      getManifest: function () { return clone(manifest); },
      getURL: function (p) { return '/' + String(p || '').replace(/^\//, ''); },
      sendMessage: function (message) { return Promise.resolve(handleRuntime(message)); },
    },
    tabs: {
      query: function (info) {
        var tabs = demoTabs();
        info = info || {};
        if (info.active) tabs = tabs.filter(function (tab) { return !!tab.active; });
        if (info.url) tabs = tabs.filter(function (tab) { return matchUrl(tab, info.url); });
        return Promise.resolve(clone(tabs));
      },
      sendMessage: function (tabId, message) {
        var type = message && message.type;
        if (type === 'audioMode.player') return Promise.resolve(playerFor(tabId));
        if (type === 'audioMode.toggle') return Promise.resolve({ ok: true, on: true });
        if (type === 'audioMode.control') return Promise.resolve({ ok: true });
        if (type === 'audioMode.state') return Promise.resolve({ ok: true, on: true });
        return Promise.resolve({ ok: true });
      },
      create: function () { return Promise.resolve({ id: 999 }); },
      onRemoved: events(),
      onCreated: events(),
      onUpdated: events(),
    },
    storage: {
      local: {
        get: function (keys) { return Promise.resolve(storageGet(localStore(), keys)); },
        set: function () { return Promise.resolve(); },
      },
      session: {
        get: function (keys) { return Promise.resolve(storageGet(sessionStore, keys)); },
        set: function (items) {
          if (items && typeof items === 'object') {
            Object.keys(items).forEach(function (key) {
              sessionStore[key] = clone(items[key]);
            });
          }
          return Promise.resolve();
        },
      },
      onChanged: events(),
    },
    i18n: {
      getMessage: function (key) { return typeof key === 'string' ? key : ''; },
    },
  };

  function click(sel) {
    var el = document.querySelector(sel);
    if (el) el.click();
  }

  function applyScene(name) {
    if (name === 'player' || name === 'audio') {
      click('#tab-audio');
      return;
    }
    if (name === 'feeds') {
      click('#tab-feeds');
      return;
    }
    if (name === 'groups') {
      click('#tab-feeds');
      whenPresent('#feed-groups [data-group="Tech"]', function (chip) {
        if (!chip) return;
        if (chip.getAttribute('aria-pressed') === 'true') return;
        chip.click();
        whenPresent('#feed-groups [data-group="Tech"][aria-pressed="true"]', function () {});
      });
      return;
    }
    if (name === 'watchlist') {
      click('#tab-watchlist');
      return;
    }
    if (name === 'settings') {
      click('#tab-settings');
      return;
    }
    if (name === 'sheet') {
      click('#tab-watchlist');
      // The watchlist renders after the tab switch, not during the click, so
      // clicking straight away sometimes found no row and shot an empty list.
      whenPresent('#watchlist-list .channel-row__main', function (opener) {
        if (opener) opener.click();
      });
      return;
    }
    if (name === 'support') {
      click('#appbar-support');
      var qr = document.querySelector('#support-methods [aria-controls="support-qr-instapay"]')
        || document.querySelector('#support-methods .support-method__qr-toggle');
      if (qr) qr.click();
      return;
    }
    if (name === 'follow') {
      click('#tab-audio');
      whenPresent('#follow-card:not([hidden]) .follow-card__btn', function () {});
    }
  }

  function whenPresent(sel, done) {
    var start = Date.now();
    (function tick() {
      var el = document.querySelector(sel);
      if (el || Date.now() - start >= 3000) {
        done(el);
        return;
      }
      setTimeout(tick, 50);
    })();
  }

  // Tabs stay unselected while body.is-opening; a selected tab means the
  // opening choice is done and a click will land on a drawn panel.
  function whenPopupReady(done) {
    var start = Date.now();
    (function tick() {
      var opening = document.body.classList.contains('is-opening');
      var chosen = document.querySelector('[role="tab"][aria-selected="true"]');
      if ((!opening && chosen) || Date.now() - start >= 3000) {
        done();
        return;
      }
      setTimeout(tick, 50);
    })();
  }

  whenPopupReady(function () {
    applyScene(scene);
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
