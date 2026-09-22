/**
 * Reads the subscriptions.csv that Google Takeout exports from YouTube, for
 * bringing a subscription list across while signed out of YouTube. Pure: no
 * chrome, no DOM, never throws on bad input.
 *
 * The file has three columns, channel id, channel URL and channel title, in
 * that order in every language. The header row is translated with the
 * account's language, so it is never matched by name: a row counts when its
 * first cell is a channel id, which no header is.
 */

import { isChannelId } from './yt.js';
import { MAX_BACKUP_BYTES, MAX_BACKUP_CHANNELS } from './backup.js';

// The same ceilings as a backup file, for the same reason: every channel is a
// request on each check, from the user's own address.
export const MAX_TAKEOUT_BYTES = MAX_BACKUP_BYTES;
export const MAX_TAKEOUT_CHANNELS = MAX_BACKUP_CHANNELS;

const MAX_TITLE_LENGTH = 200;

/** 'size' for a file of `size` bytes that is too large to read, else ''. */
export function takeoutSizeError(size) {
  return Number(size) > MAX_TAKEOUT_BYTES ? 'size' : '';
}

/**
 * RFC 4180 rows: quoted cells may hold commas, doubled quotes and line
 * breaks, and lines end in CRLF or LF.
 */
function csvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (text[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cleanTitle(value) {
  // Titles are shown as text, never markup; control characters are the only
  // thing that could still upset a row.
  return String(value || '')
    .replace(/[\x00-\x1f\x7f]/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/**
 * { ok: true, channels: [{ id, title }] } in file order, each id once, or
 * { ok: false, error } where error is 'size', 'empty' (no channel rows) or
 * 'count' (more than MAX_TAKEOUT_CHANNELS).
 */
export function parseTakeoutCsv(text) {
  if (typeof text !== 'string') return { ok: false, error: 'empty' };
  if (takeoutSizeError(text.length)) return { ok: false, error: 'size' };

  const channels = [];
  const seen = new Set();
  for (const cells of csvRows(text.replace(/^\uFEFF/, ''))) {
    const id = String(cells[0] || '').trim();
    if (!isChannelId(id) || seen.has(id)) continue;
    seen.add(id);
    channels.push({ id, title: cleanTitle(cells[2]) });
  }

  if (!channels.length) return { ok: false, error: 'empty' };
  if (channels.length > MAX_TAKEOUT_CHANNELS) return { ok: false, error: 'count' };
  return { ok: true, channels };
}
