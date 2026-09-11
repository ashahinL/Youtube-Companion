/**
 * Formatting helpers. Table-driven against pinned Intl output.
 */

import {
  relativeTime,
  duration,
  compactCount,
  absoluteTime,
} from '../src/lib/fmt.js';

const NOW = Date.parse('2026-09-12T12:00:00Z');
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

export default async function run(t) {
  t.section('relativeTime');

  const relativeCases = [
    { name: 'under a minute is just now', then: NOW - 30_000, expected: 'just now' },
    { name: 'future under a minute is just now', then: NOW + 30_000, expected: 'just now' },
    { name: '90 seconds rounds to 2m ago', then: NOW - 90_000, expected: '2m ago' },
    { name: '2 hours ago is narrow', then: NOW - 2 * HOUR, expected: '2h ago' },
    { name: '3 hours ahead formats forwards', then: NOW + 3 * HOUR, expected: 'in 3h' },
    { name: '3 days ago is long', then: NOW - 3 * DAY, expected: '3 days ago' },
    { name: '7 days is 1 week ago', then: NOW - 7 * DAY, expected: '1 week ago' },
    { name: 'on the dot is just now', then: NOW, expected: 'just now' },
  ];
  for (const c of relativeCases) {
    const got = relativeTime(c.then, NOW, 'en');
    t.check(c.name, got === c.expected, got);
  }

  t.check('undefined then is empty', relativeTime(undefined, NOW) === '');
  t.check('NaN then is empty', relativeTime(NaN, NOW) === '');
  t.check('NaN now is empty', relativeTime(NOW, NaN) === '');
  t.check(
    'epoch 0 does not throw and is non-empty',
    relativeTime(0, NOW, 'en').length > 0,
    relativeTime(0, NOW, 'en'),
  );
  t.check(
    'negative timestamp does not throw',
    typeof relativeTime(-1, NOW, 'en') === 'string',
  );

  const enAgo = relativeTime(NOW - 2 * HOUR, NOW, 'en');
  const arAgo = relativeTime(NOW - 2 * HOUR, NOW, 'ar');
  t.check(
    'ar relativeTime differs from en',
    arAgo !== enAgo && arAgo.length > 0,
    arAgo,
  );
  t.check('ar under a minute is not English', relativeTime(NOW - 10_000, NOW, 'ar') !== 'just now');

  t.check('59 minutes stays minutes', relativeTime(NOW - 59 * MIN, NOW, 'en') === '59m ago', relativeTime(NOW - 59 * MIN, NOW, 'en'));
  t.check('60 minutes becomes 1h ago', relativeTime(NOW - 60 * MIN, NOW, 'en') === '1h ago', relativeTime(NOW - 60 * MIN, NOW, 'en'));

  t.section('duration');

  const durationCases = [
    { name: '17:14', input: 1034, expected: '17:14' },
    { name: '1:02:03 past an hour', input: 3723, expected: '1:02:03' },
    { name: 'one hour even', input: 3600, expected: '1:00:00' },
    { name: 'five seconds', input: 5, expected: '0:05' },
    { name: 'one minute five', input: 65, expected: '1:05' },
    { name: 'zero is empty', input: 0, expected: '' },
    { name: 'undefined is empty', input: undefined, expected: '' },
    { name: 'NaN is empty', input: NaN, expected: '' },
    { name: 'negative is empty', input: -10, expected: '' },
    { name: 'sub-second floors to empty', input: 0.9, expected: '' },
  ];
  for (const c of durationCases) {
    const got = duration(c.input);
    t.check(c.name, got === c.expected, got);
  }

  t.section('compactCount');

  const countCases = [
    { name: '1.4M', input: 1_400_000, expected: '1.4M' },
    { name: '12K', input: 12_000, expected: '12K' },
    { name: '947 stays plain', input: 947, expected: '947' },
    { name: 'zero is 0', input: 0, expected: '0' },
    { name: 'undefined is empty', input: undefined, expected: '' },
    { name: 'NaN is empty', input: NaN, expected: '' },
    { name: 'negative compact', input: -1200, expected: '-1.2K' },
  ];
  for (const c of countCases) {
    const got = compactCount(c.input, 'en');
    t.check(c.name, got === c.expected, got);
  }

  const enCount = compactCount(1_400_000, 'en');
  const arCount = compactCount(1_400_000, 'ar');
  t.check('ar compactCount differs from en', arCount !== enCount && arCount.length > 0, arCount);

  t.section('absoluteTime');

  const stamp = Date.parse('2026-09-11T15:30:00Z');
  const expectedEn = new Intl.DateTimeFormat('en', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(new Date(stamp));
  t.check('en matches Intl short date-time', absoluteTime(stamp, 'en') === expectedEn, absoluteTime(stamp, 'en'));
  t.check(
    'ar absoluteTime differs from en',
    absoluteTime(stamp, 'ar') !== absoluteTime(stamp, 'en') && absoluteTime(stamp, 'ar').length > 0,
    absoluteTime(stamp, 'ar'),
  );
  t.check('undefined is empty', absoluteTime(undefined, 'en') === '');
  t.check('NaN is empty', absoluteTime(NaN, 'en') === '');
  t.check(
    'epoch 0 does not throw and is non-empty',
    absoluteTime(0, 'en').length > 0,
    absoluteTime(0, 'en'),
  );
  t.check(
    'negative does not throw',
    typeof absoluteTime(-1, 'en') === 'string' && absoluteTime(-1, 'en').length > 0,
  );
}
