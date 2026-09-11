/**
 * In-memory chrome.storage.local for Node suites. Deep-clones on the way
 * in and out so a test holding a reference cannot mutate the store behind
 * the code's back.
 */

function clone(value) {
  if (value === undefined) return undefined;
  return structuredClone(value);
}

function changeOf(oldValue, newValue) {
  return { oldValue: clone(oldValue), newValue: clone(newValue) };
}

export function installChromeMock(initial = {}) {
  const previous = globalThis.chrome;
  const storage = clone(initial) ?? {};
  const listeners = [];

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
  };

  return {
    storage,
    restore() {
      if (previous === undefined) delete globalThis.chrome;
      else globalThis.chrome = previous;
    },
  };
}
