/**
 * In-memory chrome.storage.local for Node suites. Deep-clones on the way
 * in and out so a test holding a reference cannot mutate the store behind
 * the code's back. Also records alarms, notifications, badge, tabs, and
 * runtime calls so the worker suite can assert on them.
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

export function installChromeMock(initial = {}) {
  const previous = globalThis.chrome;
  const storage = clone(initial) ?? {};
  const listeners = [];
  const alarms = {};
  const i18nMessages = {
    nNewVideos: {
      message: '$COUNT$ new videos',
      placeholders: { count: { content: '$1' } },
    },
  };

  const handle = {
    storage,
    alarms,
    i18nMessages,
    alarmsCreated: [],
    alarmsCleared: [],
    notifications: [],
    badgeText: '',
    badgeTexts: [],
    badgeColor: null,
    tabsCreated: [],
    runtimeListeners: {
      onInstalled: [],
      onStartup: [],
      onMessage: [],
    },
    alarmListeners: [],
    notificationClickListeners: [],
  };

  function fire(changes) {
    for (const fn of [...listeners]) fn(changes, 'local');
  }

  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (keys === null || keys === undefined) return clone(storage);
          if (typeof keys === 'string') {
            return keys in storage ? { [keys]: clone(storage[keys]) } : {};
          }
          if (Array.isArray(keys)) {
            const out = {};
            for (const key of keys) {
              if (key in storage) out[key] = clone(storage[key]);
            }
            return out;
          }
          if (keys && typeof keys === 'object') {
            const out = {};
            for (const [key, fallback] of Object.entries(keys)) {
              out[key] = key in storage ? clone(storage[key]) : clone(fallback);
            }
            return out;
          }
          return clone(storage);
        },

        async set(items) {
          if (!items || typeof items !== 'object') return;
          const changes = {};
          for (const [key, value] of Object.entries(items)) {
            changes[key] = changeOf(storage[key], value);
            storage[key] = clone(value);
          }
          fire(changes);
        },

        async remove(keys) {
          const list = Array.isArray(keys) ? keys : [keys];
          const changes = {};
          for (const key of list) {
            if (!(key in storage)) continue;
            changes[key] = changeOf(storage[key], undefined);
            delete storage[key];
          }
          if (Object.keys(changes).length) fire(changes);
        },

        async clear() {
          const changes = {};
          for (const key of Object.keys(storage)) {
            changes[key] = changeOf(storage[key], undefined);
            delete storage[key];
          }
          if (Object.keys(changes).length) fire(changes);
        },
      },

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
        const rec = { name, ...(info || {}) };
        handle.alarmsCreated.push({ ...rec });
        alarms[name] = rec;
      },
      async clear(name) {
        handle.alarmsCleared.push(name);
        const had = Object.prototype.hasOwnProperty.call(alarms, name);
        delete alarms[name];
        return had;
      },
      async get(name) {
        return alarms[name] ? { ...alarms[name] } : undefined;
      },
      async getAll() {
        return Object.values(alarms).map((a) => ({ ...a }));
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
        handle.notifications.push({
          id,
          type: opts.type,
          title: opts.title,
          message: opts.message,
          iconUrl: opts.iconUrl,
        });
        if (typeof callback === 'function') callback(id);
        return Promise.resolve(id);
      },
      clear(id, callback) {
        if (typeof callback === 'function') callback(true);
        return Promise.resolve(true);
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
    },

    tabs: {
      async create(opts) {
        const tab = { id: handle.tabsCreated.length + 1, ...(opts || {}) };
        handle.tabsCreated.push({ ...tab });
        return tab;
      },
    },

    runtime: {
      lastError: undefined,
      getURL(path) {
        return 'chrome-extension://youtube-companion/' + String(path || '').replace(/^\//, '');
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
    handle.badgeTexts.length = 0;
    handle.tabsCreated.length = 0;
    for (const key of Object.keys(alarms)) delete alarms[key];
    handle.badgeText = '';
  };

  handle.fireNotificationClick = (id) => {
    for (const fn of handle.notificationClickListeners) fn(id);
  };

  handle.fireAlarm = (name) => {
    const alarm = alarms[name] || { name };
    return Promise.all(handle.alarmListeners.map((fn) => fn(alarm)));
  };

  return handle;
}
