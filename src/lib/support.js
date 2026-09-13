/**
 * Ways to support the project. Brand names live here so they are not
 * translated. Adding a method is one entry plus its hint in both locale
 * files.
 */

export const SUPPORT_METHODS = [
  { id: 'paypal', name: 'PayPal', hintKey: 'supportPaypalHint', url: 'https://paypal.me/ashahin22' },
  { id: 'instapay', name: 'InstaPay', hintKey: 'supportInstapayHint', address: 'ashahin22@instapay', qr: 'img/instapay-qr.png' },
];

function asText(value) {
  return typeof value === 'string' && value ? value : '';
}

function httpsUrl(value) {
  const url = asText(value);
  return url.startsWith('https://') ? url : '';
}

function relativeQr(value) {
  const qr = asText(value);
  // A scheme, parent segment, or absolute path would load something other
  // than a file next to the popup, so the image is omitted and the row kept.
  if (!qr) return '';
  if (qr.includes('..') || qr.includes(':') || qr.includes('\\') || qr.startsWith('/')) return '';
  return qr;
}

/**
 * A normalised copy of `methods`. Drops a row that cannot be used; never
 * throws, so a bad extra entry cannot take the sheet down with it.
 */
export function supportRows(methods) {
  if (!Array.isArray(methods)) return [];
  const rows = [];
  for (const raw of methods) {
    if (!raw || typeof raw !== 'object') continue;
    const id = asText(raw.id);
    const name = asText(raw.name);
    if (!id || !name) continue;
    const url = httpsUrl(raw.url);
    const address = asText(raw.address);
    if (!url && !address) continue;
    const row = { id, name };
    const hintKey = asText(raw.hintKey);
    if (hintKey) row.hintKey = hintKey;
    if (url) row.url = url;
    if (address) row.address = address;
    const qr = relativeQr(raw.qr);
    if (qr) row.qr = qr;
    rows.push(row);
  }
  return rows;
}
