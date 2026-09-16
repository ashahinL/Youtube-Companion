/**
 * UI language that follows settings.ui.locale. chrome.i18n.getMessage is
 * bound to the browser language, so a user who picks Arabic inside English
 * Chrome would still get English from it.
 */

const cache = new Map();

function asSupported(locale) {
  return locale === 'ar' ? 'ar' : 'en';
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flatten(json) {
  const map = {};
  if (!json || typeof json !== 'object') return map;
  for (const [key, entry] of Object.entries(json)) {
    if (!entry || typeof entry.message !== 'string') continue;
    let msg = entry.message;
    const placeholders = entry.placeholders;
    if (placeholders && typeof placeholders === 'object') {
      for (const [name, spec] of Object.entries(placeholders)) {
        const content = spec && spec.content != null ? String(spec.content) : '';
        msg = msg.replace(new RegExp('\\$' + escapeRe(name) + '\\$', 'gi'), content);
      }
    }
    map[key] = msg;
  }
  return map;
}

function attr(el, name) {
  if (!el || typeof el.getAttribute !== 'function') return '';
  return el.getAttribute(name) || '';
}

function substitute(text, substitutions) {
  const subs = substitutions == null ? [] : [].concat(substitutions);
  return String(text)
    .replace(/\$(\d+)\$/g, (_, n) => {
      const idx = Number(n) - 1;
      return idx >= 0 && idx < subs.length ? String(subs[idx]) : '';
    })
    .replace(/\$(\d+)/g, (_, n) => {
      const idx = Number(n) - 1;
      return idx >= 0 && idx < subs.length ? String(subs[idx]) : '';
    });
}

export function resolveLocale(setting, navigatorLanguage) {
  if (setting === 'en' || setting === 'ar') return setting;
  const lang = String(navigatorLanguage || '').toLowerCase();
  return lang.startsWith('ar') ? 'ar' : 'en';
}

export async function loadMessages(locale) {
  const loc = asSupported(locale);
  if (cache.has(loc)) return cache.get(loc);
  const pending = (async () => {
    const url = chrome.runtime.getURL(`_locales/${loc}/messages.json`);
    const res = await fetch(url);
    const json = await res.json();
    return flatten(json);
  })();
  cache.set(loc, pending);
  try {
    const map = await pending;
    cache.set(loc, map);
    return map;
  } catch (err) {
    cache.delete(loc);
    throw err;
  }
}

export function translate(map, key, substitutions) {
  if (!map || !Object.prototype.hasOwnProperty.call(map, key)) return key;
  return substitute(map[key], substitutions);
}

/**
 * Chrome i18n has no plural rules, so count-1 copy lives on a `…One`
 * sibling of `key`. Missing One falls through to `key`.
 */
export function translateCount(map, key, count, substitutions) {
  const n = Number(count);
  const oneKey = `${key}One`;
  const use = n === 1 && map && Object.prototype.hasOwnProperty.call(map, oneKey)
    ? oneKey
    : key;
  const subs = substitutions == null ? [String(count)] : substitutions;
  return translate(map, use, subs);
}

export function applyTo(root, map) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  for (const el of root.querySelectorAll('[data-i18n]')) {
    const key = attr(el, 'data-i18n');
    if (key) el.textContent = translate(map, key);
  }
  for (const el of root.querySelectorAll('[data-i18n-title]')) {
    const key = attr(el, 'data-i18n-title');
    if (key) el.setAttribute('title', translate(map, key));
  }
  for (const el of root.querySelectorAll('[data-i18n-placeholder]')) {
    const key = attr(el, 'data-i18n-placeholder');
    if (key) el.setAttribute('placeholder', translate(map, key));
  }
  for (const el of root.querySelectorAll('[data-i18n-label]')) {
    const key = attr(el, 'data-i18n-label');
    if (key) el.setAttribute('aria-label', translate(map, key));
  }
}

export function direction(locale) {
  return asSupported(locale) === 'ar' ? 'rtl' : 'ltr';
}

export function applyDirection(doc, locale) {
  const root = doc && doc.documentElement;
  if (!root) return;
  const loc = asSupported(locale);
  const dir = direction(loc);
  root.lang = loc;
  root.dir = dir;
  if (typeof root.setAttribute === 'function') {
    root.setAttribute('lang', loc);
    root.setAttribute('dir', dir);
  }
}
