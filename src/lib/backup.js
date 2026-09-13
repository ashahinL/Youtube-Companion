/**
 * Export and import of settings plus the channel list. Pure: no chrome,
 * no DOM, never throws on bad input.
 *
 * The feed and the classification cache are not in the file — both
 * rebuild from the channel list on the next sweep, and restoring a
 * stale feed over a fresh one would walk it backwards.
 */

import { DEFAULT_SETTINGS, clampSettings } from './settings.js';

// The file format's id predates the extension's current name. Changing it
// would make every backup already on someone's disk unreadable.
const APP = 'youtube-companion';
const VERSION = 1;

const ERR = {
  json: 'That file is not valid JSON.',
  app: 'That file is not a Companion for YouTube backup.',
  version: 'This backup version is not supported.',
  channels: 'That backup has no channel list.',
  id: 'A channel in that file has no id.',
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(error) {
  return { ok: false, error };
}

function usableId(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cloneData(value) {
  try {
    return structuredClone(value);
  } catch {
    return {};
  }
}

/**
 * Overlay `patch` onto `base`. Unknown keys are ignored so a removed
 * setting cannot haunt the object after it leaves the defaults.
 */
function overlay(base, patch) {
  if (!isPlainObject(patch)) return structuredClone(base);
  const out = structuredClone(base);
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in out)) continue;
    if (value === undefined) continue;
    const current = out[key];
    if (isPlainObject(current) && isPlainObject(value)) {
      out[key] = overlay(current, value);
    } else if (!isPlainObject(current)) {
      out[key] = value;
    }
  }
  return out;
}

/**
 * lastFetchAt, lastError, and seeded describe a moment on the machine
 * that wrote the file. Carrying them across would skip the silent seed
 * or keep a stale error, so they are left out and reset on import.
 */
function exportChannel(raw) {
  const id = usableId(raw?.id);
  if (!id) return null;
  const addedAt = Number(raw.addedAt);
  const lastVideoAt = Number(raw.lastVideoAt);
  return {
    id,
    handle: typeof raw.handle === 'string' ? raw.handle : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    avatar: typeof raw.avatar === 'string' ? raw.avatar : '',
    favorite: !!raw.favorite,
    addedAt: Number.isFinite(addedAt) ? addedAt : 0,
    lastVideoAt: Number.isFinite(lastVideoAt) ? lastVideoAt : 0,
  };
}

function normalizeChannel(raw, now) {
  const id = usableId(raw?.id);
  if (!id) return null;
  const addedAt = Number(raw.addedAt);
  const lastVideoAt = Number(raw.lastVideoAt);
  return {
    id,
    handle: typeof raw.handle === 'string' ? raw.handle : '',
    title: typeof raw.title === 'string' ? raw.title : '',
    avatar: typeof raw.avatar === 'string' ? raw.avatar : '',
    favorite: !!raw.favorite,
    addedAt: Number.isFinite(addedAt) ? addedAt : now,
    lastVideoAt: Number.isFinite(lastVideoAt) ? lastVideoAt : 0,
    lastFetchAt: 0,
    lastError: null,
    seeded: false,
  };
}

export function buildBackup({ settings, channels } = {}) {
  const list = Array.isArray(channels) ? channels : [];
  const exported = [];
  for (const ch of list) {
    const row = exportChannel(ch);
    if (row) exported.push(row);
  }
  return {
    app: APP,
    version: VERSION,
    exportedAt: new Date().toISOString(),
    settings: isPlainObject(settings) ? cloneData(settings) : {},
    channels: exported,
  };
}

export function parseBackup(text) {
  if (typeof text !== 'string') return fail(ERR.json);

  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail(ERR.json);
  }

  if (!isPlainObject(raw)) return fail(ERR.app);
  if (raw.app !== APP) return fail(ERR.app);
  if (Number(raw.version) !== VERSION) return fail(ERR.version);
  if (!Array.isArray(raw.channels)) return fail(ERR.channels);

  for (const entry of raw.channels) {
    if (!usableId(entry?.id)) return fail(ERR.id);
  }

  return { ok: true, data: raw };
}

export function mergeBackup(current, incoming, mode) {
  const src = isPlainObject(current) ? current : {};
  const file = isPlainObject(incoming) ? incoming : {};
  const replace = mode === 'replace';
  const now = Date.now();

  const incomingList = Array.isArray(file.channels) ? file.channels : [];
  const currentList = Array.isArray(src.channels) ? src.channels : [];

  let settings;
  if (replace) {
    settings = clampSettings(overlay(DEFAULT_SETTINGS, file.settings));
  } else {
    const live = overlay(DEFAULT_SETTINGS, src.settings);
    settings = clampSettings(overlay(live, file.settings));
  }

  const next = [];
  const seen = new Set();
  let added = 0;
  let skipped = 0;

  if (!replace) {
    // The live record is newer than a file, so an id already present
    // keeps its favourite flag and stamps instead of taking the file's.
    for (const ch of currentList) {
      const id = usableId(ch?.id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      next.push({ ...ch });
    }
  }

  for (const raw of incomingList) {
    const row = normalizeChannel(raw, now);
    if (!row) continue;
    if (seen.has(row.id)) {
      skipped++;
      continue;
    }
    seen.add(row.id);
    next.push(row);
    added++;
  }

  return { settings, channels: next, added, skipped };
}
