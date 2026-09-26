/**
 * In-memory chrome.storage.local for Node suites. Deep-clones on the way
 * in and out so a test holding a reference cannot mutate the store behind
 * the code's back. Also records alarms, notifications, badge, tabs,
 * and runtime calls so the worker suite can assert on them.
 */

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function changeOf(oldValue, newValue) {
  return { oldValue: clone(oldValue), newValue: clone(newValue) };
}

function applyI18n(entry, substitutions) {
  if (!entry || typeof entry.message !== 'string') return '';
  let msg = entry.message;
  const subs = substitutions == null ? [] : [].concat(substitutions);
  if (entry.placeholders && typeof entry.placeholders === 'object') {
    for (const [name, spec] of Object.entries(entry.placeholders)) {
      const content = spec && spec.content != null ? String(spec.content) : '';
      const m = content.match(/\$(\d+)/);
      const idx = m ? Number(m[1]) - 1 : -1;
      const value = idx >= 0 && idx < subs.length ? String(subs[idx]) : '';
      msg = msg.replace(new RegExp('\\$' + name + '\\$', 'ig'), value);
    }
  }
  msg = msg.replace(/\$(\d+)\$/g, (_, n) => {
    const idx = Number(n) - 1;
    return idx >= 0 && idx < subs.length ? String(subs[idx]) : '';
  });
  return msg;
}

function makeStorageArea(store, fire, hold) {
  return {
    async get(keys) {
      if (keys === null || keys === undefined) return clone(store);
      if (typeof keys === 'string') {
        return keys in store ? { [keys]: clone(store[keys]) } : {};
      }
      if (Array.isArray(keys)) {
        const out = {};
        for (const key of keys) {
          if (key in store) out[key] = clone(store[key]);
        }
        return out;
      }
      if (keys && typeof keys === 'object') {
        const out = {};
        for (const [key, fallback] of Object.entries(keys)) {
          out[key] = key in store ? clone(store[key]) : clone(fallback);
        }
        return out;
      }
      return clone(store);
    },

    async set(items) {
      if (hold) {
        const waiting = hold();
        if (waiting) await waiting;
      }
      if (!items || typeof items !== 'object') return;
      const changes = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = changeOf(store[key], value);
        store[key] = clone(value);
      }
      fire(changes);
    },

    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      const changes = {};
      for (const key of list) {
        if (!(key in store)) continue;
        changes[key] = changeOf(store[key], undefined);
        delete store[key];
      }
      if (Object.keys(changes).length) fire(changes);
    },

    async clear() {
      const changes = {};
      for (const key of Object.keys(store)) {
        changes[key] = changeOf(store[key], undefined);
        delete store[key];
      }
      if (Object.keys(changes).length) fire(changes);
    },
  };
}

export function installChromeMock(initial = {}) {
  const previous = globalThis.chrome;
  const storage = clone(initial) ?? {};
  const session = {};
  const listeners = [];
  const alarms = {};
  const i18nMessages = {
    nNewVideos: {
      message: '$COUNT$ new videos',
      placeholders: { count: { content: '$1' } },
    },
    nNewVideosOne: {
      message: '$COUNT$ new video',
      placeholders: { count: { content: '$1' } },
    },
  };

  const handle = {
    storage,
    session,
    sessionSetHold: null,
    alarms,
    i18nMessages,
    storageChangedListeners: listeners,
    alarmsCreated: [],
    alarmsCleared: [],
    notifications: [],
    notificationsCleared: [],
    badgeText: '',
    badgeTexts: [],
    badgeColor: null,
    actionTitle: '',
    tabsCreated: [],
    tabsUpdated: [],
    tabsRemoved: [],
    tabsReloaded: [],
    windowsUpdated: [],
    urlTabs: null,
    onTabMessage: null,
    tabRemovedListeners: [],
    tabCreatedListeners: [],
    tabUpdatedListeners: [],
    messagesSent: [],
    commandListeners: [],
    commandList: [{ name: 'toggle-audio-mode', shortcut: '' }],
    activeTab: null,
    dnrRules: [],
    dnrUpdates: [],
    uninstallUrl: '',
    platformInfoCalls: 0,
    runtimeListeners: {
      onInstalled: [],
      onStartup: [],
      onMessage: [],
    },
    alarmListeners: [],
    notificationClickListeners: [],
    notificationButtonListeners: [],
  };

  function fire(changes, area = 'local') {
    for (const fn of [...listeners]) fn(changes, area);
  }

  globalThis.chrome = {
    storage: {
      local: makeStorageArea(storage, (changes) => fire(changes, 'local')),
      session: makeStorageArea(
        session,
        (changes) => fire(changes, 'session'),
        () => handle.sessionSetHold,
      ),

      onChanged: {
        addListener(fn) {
          if (typeof fn === 'function') listeners.push(fn);
        },
        removeListener(fn) {
          const i = listeners.indexOf(fn);
          if (i >= 0) listeners.splice(i, 1);
        },
      },
    },

    alarms: {
      async create(name, info) {
        const opts = info && typeof info === 'object' ? info : {};
        const rec = { name };
        if (opts.periodInMinutes != null) rec.periodInMinutes = opts.periodInMinutes;
        if (opts.when != null) {
          rec.when = opts.when;
          rec.scheduledTime = opts.when;
        } else if (opts.delayInMinutes != null) {
          rec.scheduledTime = Date.now() + opts.delayInMinutes * 60_000;
        } else if (opts.periodInMinutes != null) {
          rec.scheduledTime = Date.now() + opts.periodInMinutes * 60_000;
        } else {
          rec.scheduledTime = Date.now();
        }
        handle.alarmsCreated.push({ name, ...opts, scheduledTime: rec.scheduledTime });
        alarms[name] = rec;
      },
      async clear(name) {
        handle.alarmsCleared.push(name);
        const had = Object.prototype.hasOwnProperty.call(alarms, name);
        delete alarms[name];
        return had;
      },
      async get(name) {
        const rec = alarms[name];
        if (!rec) return undefined;
        const out = { name: rec.name, scheduledTime: rec.scheduledTime };
        if (rec.periodInMinutes != null) out.periodInMinutes = rec.periodInMinutes;
        return out;
      },
      async getAll() {
        return Object.keys(alarms).map((n) => {
          const rec = alarms[n];
          const out = { name: rec.name, scheduledTime: rec.scheduledTime };
          if (rec.periodInMinutes != null) out.periodInMinutes = rec.periodInMinutes;
          return out;
        });
      },
      onAlarm: {
        addListener(fn) {
          if (typeof fn === 'function') handle.alarmListeners.push(fn);
        },
        removeListener(fn) {
          const i = handle.alarmListeners.indexOf(fn);
          if (i >= 0) handle.alarmListeners.splice(i, 1);
        },
      },
    },

    notifications: {
      create(id, options, callback) {
        const opts = options && typeof options === 'object' ? options : {};
        // Chrome rejects a notification whose icon it cannot load.
        if (typeof handle.notificationFail === 'function' && handle.notificationFail(opts)) {
          return Promise.reject(new Error('Unable to download all specified images.'));
        }
        handle.notifications.push({
          id,
          type: opts.type,
          title: opts.title,
          message: opts.message,
          iconUrl: opts.iconUrl,
          buttons: opts.buttons,
        });
        if (typeof callback === 'function') callback(id);
        return Promise.resolve(id);
      },
      clear(id, callback) {
        handle.notificationsCleared.push(id);
        if (typeof callback === 'function') callback(true);
        return Promise.resolve(true);
      },
      onButtonClicked: {
        addListener(fn) {
          if (typeof fn === 'function') handle.notificationButtonListeners.push(fn);
        },
      },
      onClicked: {
        addListener(fn) {
          if (typeof fn === 'function') handle.notificationClickListeners.push(fn);
        },
        removeListener(fn) {
          const i = handle.notificationClickListeners.indexOf(fn);
          if (i >= 0) handle.notificationClickListeners.splice(i, 1);
        },
      },
    },

    action: {
      async setBadgeText({ text } = {}) {
        const value = text == null ? '' : String(text);
        handle.badgeText = value;
        handle.badgeTexts.push(value);
      },
      async setBadgeBackgroundColor({ color } = {}) {
        handle.badgeColor = color;
      },
      async setTitle({ title } = {}) {
        handle.actionTitle = title == null ? '' : String(title);
      },
    },

    tabs: {
      async create(opts) {
        const tab = { id: handle.tabsCreated.length + 1, ...(opts || {}) };
        handle.tabsCreated.push({ ...tab });
        return tab;
      },
      async update(tabId, opts) {
        const tab = { id: tabId, ...(opts || {}) };
        handle.tabsUpdated.push({ tabId, ...(opts || {}) });
        return tab;
      },
      async query(info) {
        if (info?.active && info?.currentWindow) {
          return handle.activeTab ? [handle.activeTab] : [];
        }
        if (info?.url && Array.isArray(handle.urlTabs)) return clone(handle.urlTabs);
        return [];
      },
      async sendMessage(tabId, message) {
        handle.messagesSent.push({ tabId, message });
        if (typeof handle.onTabMessage === 'function') return handle.onTabMessage(tabId, message);
        return { ok: true };
      },
      async remove(tabId) {
        handle.tabsRemoved.push(tabId);
      },
      async reload(tabId) {
        handle.tabsReloaded.push(tabId);
      },
      onRemoved: {
        addListener(fn) {
          if (typeof fn === 'function') handle.tabRemovedListeners.push(fn);
        },
        removeListener(fn) {
          const i = handle.tabRemovedListeners.indexOf(fn);
          if (i >= 0) handle.tabRemovedListeners.splice(i, 1);
        },
      },
      onCreated: {
        addListener(fn) {
          if (typeof fn === 'function') handle.tabCreatedListeners.push(fn);
        },
        removeListener(fn) {
          const i = handle.tabCreatedListeners.indexOf(fn);
          if (i >= 0) handle.tabCreatedListeners.splice(i, 1);
        },
      },
      onUpdated: {
        addListener(fn) {
          if (typeof fn === 'function') handle.tabUpdatedListeners.push(fn);
        },
        removeListener(fn) {
          const i = handle.tabUpdatedListeners.indexOf(fn);
          if (i >= 0) handle.tabUpdatedListeners.splice(i, 1);
        },
      },
    },

    windows: {
      async update(windowId, opts) {
        handle.windowsUpdated.push({ windowId, ...(opts || {}) });
        return { id: windowId, ...(opts || {}) };
      },
    },

    commands: {
      async getAll() {
        return (handle.commandList || []).map((c) => ({ ...c }));
      },
      onCommand: {
        addListener(fn) {
          if (typeof fn === 'function') handle.commandListeners.push(fn);
        },
        removeListener(fn) {
          const i = handle.commandListeners.indexOf(fn);
          if (i >= 0) handle.commandListeners.splice(i, 1);
        },
      },
    },

    declarativeNetRequest: {
      async updateDynamicRules({ addRules = [], removeRuleIds = [] } = {}) {
        const remove = new Set(removeRuleIds);
        handle.dnrRules = handle.dnrRules.filter((rule) => !remove.has(rule.id));
        for (const rule of addRules) handle.dnrRules.push(clone(rule));
        handle.dnrUpdates.push({
          addRules: clone(addRules),
          removeRuleIds: [...removeRuleIds],
        });
      },
    },

    runtime: {
      id: 'youtube-companion-test',
      lastError: undefined,
      getURL(path) {
        return 'chrome-extension://youtube-companion/' + String(path || '').replace(/^\//, '');
      },
      getManifest() {
        return { version: '9.9.9' };
      },
      async setUninstallURL(url) {
        handle.uninstallUrl = String(url);
      },
      async getPlatformInfo() {
        handle.platformInfoCalls++;
        return { os: 'test' };
      },
      onInstalled: {
        addListener(fn) {
          if (typeof fn === 'function') handle.runtimeListeners.onInstalled.push(fn);
        },
      },
      onStartup: {
        addListener(fn) {
          if (typeof fn === 'function') handle.runtimeListeners.onStartup.push(fn);
        },
      },
      onMessage: {
        addListener(fn) {
          if (typeof fn === 'function') handle.runtimeListeners.onMessage.push(fn);
        },
      },
    },

    i18n: {
      getMessage(key, substitutions) {
        return applyI18n(i18nMessages[key], substitutions);
      },
    },
  };

  handle.restore = () => {
    if (previous === undefined) delete globalThis.chrome;
    else globalThis.chrome = previous;
  };

  handle.resetCalls = () => {
    handle.alarmsCreated.length = 0;
    handle.alarmsCleared.length = 0;
    handle.notifications.length = 0;
    handle.notificationsCleared.length = 0;
    handle.badgeTexts.length = 0;
    handle.tabsCreated.length = 0;
    handle.tabsUpdated.length = 0;
    handle.tabsRemoved.length = 0;
    handle.tabsReloaded.length = 0;
    handle.windowsUpdated.length = 0;
    handle.messagesSent.length = 0;
    handle.urlTabs = null;
    handle.onTabMessage = null;
    handle.activeTab = null;
    handle.sessionSetHold = null;
    handle.notificationFail = null;
    for (const key of Object.keys(alarms)) delete alarms[key];
    for (const key of Object.keys(session)) delete session[key];
    handle.badgeText = '';
  };

  handle.fireNotificationClick = (id) => {
    for (const fn of handle.notificationClickListeners) fn(id);
  };

  handle.fireAlarm = (name) => {
    const alarm = alarms[name] || { name };
    return Promise.all(handle.alarmListeners.map((fn) => fn(alarm)));
  };

  handle.fireTabRemoved = (tabId) => {
    for (const fn of handle.tabRemovedListeners) fn(tabId);
  };

  return handle;
}
