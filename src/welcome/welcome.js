/**
 * Welcome page, opened once on a fresh install: bring channels across from
 * the signed-in YouTube tab, or from a Takeout file when signed out, try
 * audio mode, pin the icon. Like the popup it never fetches; the worker
 * reads the list and checks the channels.
 */

import {
  resolveLocale,
  loadMessages,
  translate,
  translateCount,
  applyTo,
  applyDirection,
} from '../lib/i18n.js';
import { takeoutSizeError, MAX_TAKEOUT_CHANNELS } from '../lib/takeout.js';
import { errorText } from '../lib/view.js';
import { applyTheme } from '../lib/theme.js';

// The toolbar menu tells a page nothing when the icon is pinned, so the page
// asks again until it is.
const PIN_CHECK_MS = 1500;

const IMPORT_ERRORS = {
  empty: 'welcomeImportEmpty',
  size: 'welcomeImportTooBig',
  count: 'welcomeImportTooMany',
};

let messages = {};
let busy = false;
let sweepWatch = 0;
// Kept as a key, not text, so a language change redraws it.
let status = { key: '', subs: [], kind: '' };
let shortcuts = { shortcut: '', popup: '' };

const el = (id) => document.getElementById(id);

function t(key, substitutions) {
  return translate(messages, key, substitutions);
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

// "Alt+Shift+A" inside an Arabic sentence reorders to "A+Shift+Alt" unless it
// is isolated as its own left-to-right run.
function isolate(text) {
  return `${String.fromCodePoint(0x2068)}${text}${String.fromCodePoint(0x2069)}`;
}

function render() {
  const statusEl = el('welcome-import-status');
  statusEl.textContent = status.key
    ? translateCount(messages, status.key, Number(status.subs[0]), status.subs)
    : '';
  statusEl.className = status.kind ? `status status--${status.kind}` : 'status';

  el('welcome-import').disabled = busy;
  el('welcome-import-youtube').disabled = busy;
  el('welcome-import-spinner').hidden = !busy;

  for (const [id, key, keys] of [
    ['welcome-audio-key', 'welcomeAudioKey', shortcuts.shortcut],
    ['welcome-popup-key', 'welcomePopupKey', shortcuts.popup],
  ]) {
    // Chrome binds nothing when the suggested keys were taken. Same words
    // as the popup; this page has no link to change them.
    el(id).hidden = false;
    el(id).textContent = keys ? t(key, [isolate(keys)]) : t('audioShortcutNone');
  }
}

async function applyLanguage(setting) {
  const locale = resolveLocale(setting, navigator.language);
  messages = await loadMessages(locale);
  applyDirection(document, locale);
  applyTo(document, messages);
  el('welcome-locale').value = setting;
  render();
}

function setStatus(key, subs = [], kind = '') {
  status = { key, subs, kind };
  render();
}

async function importFromYouTubeTab() {
  if (busy) return;
  busy = true;
  // The result is drawn on the YouTube tab. This line only says that it opened.
  setStatus('welcomeImportOpened');
  try {
    const res = await send({ type: 'importFromYouTube' });
    if (!res || res.ok === false) {
      const error = res && res.error;
      if (error === 'no tab' || error === 'no script') {
        setStatus('errorNoYouTubeTab', [], 'error');
        return;
      }
    }
    setStatus('welcomeImportOpened', [], 'ok');
  } catch {
    setStatus('errorGeneric', [], 'error');
  } finally {
    busy = false;
    render();
  }
}

// The reason inside "Could not import that file: …", in the reader's language.
function importFailure(code) {
  const text = errorText(String(code || ''));
  return [translate(messages, text.key, text.subs)];
}

async function importFile(file) {
  // Checked before reading, so a wrong pick of a large download is refused
  // without holding the page.
  if (takeoutSizeError(file.size)) {
    setStatus('welcomeImportTooBig', [], 'error');
    return;
  }
  busy = true;
  setStatus('welcomeImportBusy');
  try {
    const res = await send({ type: 'importTakeout', data: await file.text() });
    if (!res || res.ok === false) {
      const key = IMPORT_ERRORS[res?.error];
      if (key) {
        const subs = res.error === 'count' ? [String(MAX_TAKEOUT_CHANNELS)] : [];
        setStatus(key, subs, 'error');
      } else setStatus('welcomeImportFailed', importFailure(res?.error), 'error');
      return;
    }
    const added = Number(res.added) || 0;
    const skipped = Number(res.skipped) || 0;
    if (!added) {
      setStatus('welcomeImportNothingNew', [String(skipped)], 'ok');
      return;
    }
    setStatus(skipped ? 'welcomeImportAddedSkipped' : 'welcomeImportAdded', [String(added), String(skipped)], 'ok');
    const watch = ++sweepWatch;
    // Not awaited: a first check of hundreds of channels takes minutes, and
    // the worker carries on if this page is closed.
    send({ type: 'sweep', scope: 'all' }).then((res) => {
      if (watch !== sweepWatch) return;
      if (!res || res.ok !== false) return;
      if (res.error === 'already running') return;
      if (res.error === 'slow down') {
        setStatus(
          skipped ? 'welcomeImportSlowDownSkipped' : 'welcomeImportSlowDown',
          [String(added), String(skipped)],
          'ok',
        );
      }
    }).catch(() => {});
  } catch (err) {
    setStatus('welcomeImportFailed', importFailure(err?.message), 'error');
  } finally {
    busy = false;
    render();
  }
}

async function checkPinned() {
  try {
    const settings = await chrome.action.getUserSettings();
    const pinned = !!settings?.isOnToolbar;
    el('welcome-pinned').hidden = !pinned;
    return pinned;
  } catch {
    return false;
  }
}

function watchPinned() {
  const timer = setInterval(async () => {
    if (document.hidden) return;
    if (await checkPinned()) clearInterval(timer);
  }, PIN_CHECK_MS);
}

function bind() {
  const fileInput = el('welcome-import-file');
  el('welcome-import-youtube').addEventListener('click', () => {
    void importFromYouTubeTab();
  });
  el('welcome-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (file) void importFile(file);
  });

  el('welcome-locale').addEventListener('change', async (event) => {
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
    const keys = await send({ type: 'audioMode.shortcut' });
    if (keys?.ok) shortcuts = { shortcut: keys.shortcut || '', popup: keys.popup || '' };
  } catch {
    // The page still reads in the browser's language without the worker.
  }
  await applyLanguage(setting);
  applyTheme(theme);
  if (location.hash === '#import') el('welcome-import-youtube').focus();
  if (typeof chrome.action?.getUserSettings === 'function' && !(await checkPinned())) watchPinned();
})();
