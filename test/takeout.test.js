/**
 * Google Takeout subscriptions.csv: rows, quoting, translated headers and
 * the limits. Pure — no chrome, no network.
 */

import {
  parseTakeoutCsv,
  takeoutSizeError,
  MAX_TAKEOUT_BYTES,
  MAX_TAKEOUT_CHANNELS,
} from '../src/lib/takeout.js';

const MKBHD = 'UCBJycsmduvYEL83R_U4JriQ';
const BEAST = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
const LINUS = 'UCXuqSBlHAE6Xw-yeJA0Tunw';

const row = (id, title) => `${id},http://www.youtube.com/channel/${id},${title}`;

export default async function run(t) {
  t.section('a Takeout file');

  const english = [
    'Channel Id,Channel Url,Channel Title',
    row(MKBHD, 'Marques Brownlee'),
    row(BEAST, 'MrBeast'),
    '',
  ].join('\n');
  const parsed = parseTakeoutCsv(english);
  t.check('reads every channel row', parsed.ok && parsed.channels.length === 2, JSON.stringify(parsed));
  t.check(
    'keeps ids and titles in file order',
    JSON.stringify(parsed.channels) === JSON.stringify([
      { id: MKBHD, title: 'Marques Brownlee' },
      { id: BEAST, title: 'MrBeast' },
    ]),
    JSON.stringify(parsed.channels),
  );

  const arabic = ['معرّف القناة,عنوان URL للقناة,عنوان القناة', row(MKBHD, 'Marques Brownlee')].join('\r\n');
  const arParsed = parseTakeoutCsv(arabic);
  t.check('a translated header is skipped, not read as a channel', arParsed.ok && arParsed.channels.length === 1, JSON.stringify(arParsed));

  const withBom = `\uFEFF${row(MKBHD, 'Marques Brownlee')}`;
  t.check('a byte-order mark before the first id is ignored', parseTakeoutCsv(withBom).channels?.[0]?.id === MKBHD);

  t.check(
    'CRLF line ends work',
    parseTakeoutCsv(`Channel Id,Channel Url,Channel Title\r\n${row(MKBHD, 'A')}\r\n${row(BEAST, 'B')}\r\n`).channels?.length === 2,
  );

  t.section('quoted titles');

  const quoted = [
    'Channel Id,Channel Url,Channel Title',
    `${MKBHD},http://www.youtube.com/channel/${MKBHD},"Tips, Tricks and ""Hacks"""`,
    `${BEAST},http://www.youtube.com/channel/${BEAST},"Two\nlines"`,
    row(LINUS, 'Linus Tech Tips'),
  ].join('\n');
  const q = parseTakeoutCsv(quoted);
  t.check('a comma inside quotes stays in the title', q.channels?.[0]?.title === 'Tips, Tricks and "Hacks"', JSON.stringify(q.channels?.[0]));
  t.check('a line break inside quotes does not start a row', q.channels?.length === 3 && q.channels[2].id === LINUS, JSON.stringify(q.channels));
  t.check('and becomes a space in the title', q.channels?.[1]?.title === 'Two lines', JSON.stringify(q.channels?.[1]));
  t.check(
    'a very long title is cut to 200 characters',
    parseTakeoutCsv(row(MKBHD, 'x'.repeat(500))).channels?.[0]?.title.length === 200,
  );
  t.check('a missing title is empty, not undefined', parseTakeoutCsv(`${MKBHD}\n`).channels?.[0]?.title === '');

  t.section('rows that are not channels');

  const messy = [
    'Channel Id,Channel Url,Channel Title',
    '',
    row(MKBHD, 'Marques Brownlee'),
    row(MKBHD, 'Marques Brownlee again'),
    'UCshort,http://www.youtube.com/channel/UCshort,Too short',
    `  ${BEAST}  ,http://www.youtube.com/channel/${BEAST},MrBeast`,
    '<html>not a csv</html>',
  ].join('\n');
  const m = parseTakeoutCsv(messy);
  t.check(
    'blank lines, bad ids and junk are skipped; a repeat counts once',
    m.ok && JSON.stringify(m.channels.map((ch) => ch.id)) === JSON.stringify([MKBHD, BEAST]),
    JSON.stringify(m),
  );
  t.check('the title comes from the first row of a repeated id', m.channels?.[0]?.title === 'Marques Brownlee');

  t.section('files that are refused');

  t.check('a file with no channel rows is empty', parseTakeoutCsv('Channel Id,Channel Url,Channel Title\n').error === 'empty');
  t.check('a backup JSON file is not a Takeout file', parseTakeoutCsv('{"app":"youtube-companion","channels":[]}').error === 'empty');
  t.check('not text is empty', parseTakeoutCsv(null).error === 'empty');
  t.check('an empty string is empty', parseTakeoutCsv('').error === 'empty');

  const letters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
  const manyIds = [];
  for (let i = 0; manyIds.length <= MAX_TAKEOUT_CHANNELS; i++) {
    const tail = `${letters[i % 64]}${letters[Math.floor(i / 64) % 64]}`.padEnd(22, 'x');
    manyIds.push(`UC${tail}`);
  }
  const tooMany = manyIds.map((id) => row(id, 'c')).join('\n');
  t.check(`more than ${MAX_TAKEOUT_CHANNELS} channels is refused`, parseTakeoutCsv(tooMany).error === 'count', String(manyIds.length));
  t.check(
    `exactly ${MAX_TAKEOUT_CHANNELS} is fine`,
    parseTakeoutCsv(manyIds.slice(0, MAX_TAKEOUT_CHANNELS).map((id) => row(id, 'c')).join('\n')).ok === true,
  );

  t.check('an oversized text is refused before parsing', parseTakeoutCsv(' '.repeat(MAX_TAKEOUT_BYTES + 1)).error === 'size');
  t.check('takeoutSizeError flags a file over the limit', takeoutSizeError(MAX_TAKEOUT_BYTES + 1) === 'size');
  t.check('takeoutSizeError passes a file at the limit', takeoutSizeError(MAX_TAKEOUT_BYTES) === '');
}
