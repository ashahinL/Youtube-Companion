/**
 * What's new page, opened from the popup's note or from the bottom of
 * Settings. The welcome page belongs to a fresh install; this one is for
 * people who already had the extension and were updated under them. It
 * fetches nothing and stores nothing but the language; the stored theme is
 * applied on load.
 */

import {
  resolveLocale,
  loadMessages,
  translate,
  applyTo,
  applyDirection,
} from '../lib/i18n.js';
import { WHATS_NEW_VERSION } from '../lib/view.js';
import { applyTheme } from '../lib/theme.js';

// Each picture is a real popup frame, so an Arabic reader gets the Arabic
// one rather than a page of English screenshots.
const SHOTS = [
  { id: 'shot-player', file: 'player', alt: 'whatsNewQueueShot' },
  { id: 'shot-feeds', file: 'feeds', alt: 'whatsNewGroupsShot' },
  { id: 'shot-watchlist', file: 'watchlist', alt: 'whatsNewImportShot' },
];

let messages = {};

const el = (id) => document.getElementById(id);

function t(key, substitutions) {
  return translate(messages, key, substitutions);
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

async function applyLanguage(setting) {
  const locale = resolveLocale(setting, navigator.language);
  messages = await loadMessages(locale);
  applyDirection(document, locale);
  applyTo(document, messages);
  el('whatsnew-locale').value = setting;

  document.title = t('whatsNewTitle', [WHATS_NEW_VERSION]);
  el('whatsnew-title').textContent = t('whatsNewTitle', [WHATS_NEW_VERSION]);

  const suffix = locale === 'ar' ? '-ar' : '';
  for (const shot of SHOTS) {
    const img = el(shot.id);
    if (!img) continue;
    img.src = `img/${shot.file}${suffix}.png`;
    img.alt = t(shot.alt);
  }
}

function bind() {
  el('whatsnew-locale').addEventListener('change', async (event) => {
    const setting = event.target.value;
    await send({ type: 'updateSettings', patch: { ui: { locale: setting } } }).catch(() => {});
    await applyLanguage(setting);
  });
}

bind();

void (async () => {
  let setting = 'auto';
  let theme = 'system';
  try {
    const state = await send({ type: 'getState' });
    setting = state?.settings?.ui?.locale || 'auto';
    theme = state?.settings?.ui?.theme || 'system';
    // Reaching the page is acknowledgement, whichever way it was opened.
    await send({ type: 'whatsNew.seen' });
  } catch {
    // The page still reads in the browser's language without the worker.
  }
  await applyLanguage(setting);
  applyTheme(theme);
})();
