/**
 * The shipped support methods and the filter that keeps only usable rows.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORT_METHODS, supportRows } from '../src/lib/support.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const json = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function threwOn(input) {
  try {
    const got = supportRows(input);
    return { threw: false, got };
  } catch (err) {
    return { threw: true, got: err };
  }
}

export default async function run(t) {
  t.section('shipped methods');

  const paypal = SUPPORT_METHODS.find((m) => m.id === 'paypal');
  t.check(
    'PayPal url is exactly paypal.me/ashahin22',
    paypal?.url === 'https://paypal.me/ashahin22',
    paypal?.url,
  );
  const instapay = SUPPORT_METHODS.find((m) => m.id === 'instapay');
  t.check(
    'InstaPay address is exactly ashahin22@instapay',
    instapay?.address === 'ashahin22@instapay',
    instapay?.address,
  );

  const en = json('_locales/en/messages.json');
  const ar = json('_locales/ar/messages.json');

  for (const method of SUPPORT_METHODS) {
    if (method.url != null) {
      t.check(
        `${method.id} url is https`,
        typeof method.url === 'string' && method.url.startsWith('https://'),
        method.url,
      );
    }
    if (method.qr != null) {
      const file = path.join(ROOT, 'src/popup', method.qr);
      t.check(`${method.id} qr exists under src/popup/`, fs.existsSync(file), method.qr);
      if (fs.existsSync(file)) {
        const buf = fs.readFileSync(file);
        t.check(
          `${method.id} qr is a PNG`,
          buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIG),
        );
      }
    }
    if (typeof method.hintKey === 'string') {
      t.check(`${method.id} hintKey in en`, method.hintKey in en, method.hintKey);
      t.check(`${method.id} hintKey in ar`, method.hintKey in ar, method.hintKey);
    }
  }

  t.section('supportRows');

  t.check(
    'drops a row with no id',
    supportRows([{ name: 'PayPal', url: 'https://example.com' }]).length === 0,
  );
  t.check(
    'drops a row with no name',
    supportRows([{ id: 'paypal', url: 'https://example.com' }]).length === 0,
  );
  t.check(
    'drops a non-string id',
    supportRows([{ id: 1, name: 'PayPal', url: 'https://example.com' }]).length === 0,
  );
  t.check(
    'drops a row with neither url nor address',
    supportRows([{ id: 'x', name: 'X', qr: 'img/x.png' }]).length === 0,
  );
  t.check(
    'drops a non-https url with no address',
    supportRows([{ id: 'x', name: 'X', url: 'http://example.com' }]).length === 0,
  );

  const kept = supportRows([{
    id: 'x',
    name: 'X',
    url: 'http://example.com',
    address: 'ashahin22@instapay',
  }]);
  t.check(
    'keeps an address-only row whose url was bad',
    kept.length === 1 && kept[0].address === 'ashahin22@instapay' && kept[0].url == null,
    JSON.stringify(kept[0]),
  );

  const parentQr = supportRows([{
    id: 'x',
    name: 'X',
    address: 'a@b',
    qr: '../secret.png',
  }]);
  t.check('drops a ../ qr', parentQr.length === 1 && parentQr[0].qr == null, JSON.stringify(parentQr[0]));

  const schemeQr = supportRows([{
    id: 'x',
    name: 'X',
    address: 'a@b',
    qr: 'https://example.com/qr.png',
  }]);
  t.check('drops an https: qr', schemeQr.length === 1 && schemeQr[0].qr == null, JSON.stringify(schemeQr[0]));

  for (const input of [null, undefined, 'paypal']) {
    const result = threwOn(input);
    t.check(
      `does not throw on ${String(input)}`,
      !result.threw && Array.isArray(result.got) && result.got.length === 0,
      result.threw ? String(result.got) : JSON.stringify(result.got),
    );
  }

  const junk = threwOn([null, 1, '', { id: 1 }, { name: 'X' }, [], { foo: true }]);
  t.check(
    'does not throw on an array of junk',
    !junk.threw && Array.isArray(junk.got) && junk.got.length === 0,
    junk.threw ? String(junk.got) : JSON.stringify(junk.got),
  );
}
