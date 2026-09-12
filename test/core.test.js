/**
 * Audio-mode core: rates, savings, stats accumulator, URL/tab classification.
 * Loads src/content/core.js as a classic script in node:vm, the way Chrome will.
 */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = fs.readFileSync(path.join(ROOT, 'src/content/core.js'), 'utf8');
const sandbox = { URL, __ytcHarness: true };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'src/content/core.js' });
const core = sandbox.AudioModeCore;

function same(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function watchTab(over) {
  return Object.assign({
    id: 1,
    url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    title: 'Video - YouTube',
    audible: false,
    mutedInfo: { muted: false },
    lastAccessed: 100,
    windowId: 1,
    index: 0,
  }, over);
}

export default async function run(t) {
  t.section('classic-script load');

  t.check('core.js loads as a plain browser script and attaches its global', !!sandbox.AudioModeCore);

  const bare = { URL };
  vm.createContext(bare);
  vm.runInContext(src, bare, { filename: 'src/content/core.js' });
  t.check(
    'core.js attaches AudioModeCore without the harness (content.js reads it in the isolated world)',
    !!bare.AudioModeCore && typeof bare.AudioModeCore.dayKey === 'function',
  );
  t.check('dayKey is a function', typeof sandbox.AudioModeCore.dayKey === 'function');
  t.check('createStatsAccumulator is a function', typeof sandbox.AudioModeCore.createStatsAccumulator === 'function');
  t.check('pickTargetTab is a function', typeof sandbox.AudioModeCore.pickTargetTab === 'function');
  t.check('videoIdFromUrl is a function', typeof sandbox.AudioModeCore.videoIdFromUrl === 'function');
  t.check('tabTitleToVideoTitle is a function', typeof sandbox.AudioModeCore.tabTitleToVideoTitle === 'function');
  t.check('classifyQualityChange is a function', typeof sandbox.AudioModeCore.classifyQualityChange === 'function');
  t.check('isYoutubeOrigin is a function', typeof sandbox.AudioModeCore.isYoutubeOrigin === 'function');
  t.check('classifyNavigation is a function', typeof sandbox.AudioModeCore.classifyNavigation === 'function');
  t.check('isControllableTab is a function', typeof sandbox.AudioModeCore.isControllableTab === 'function');

  t.section('date keys');

  // 21 Aug 2026, 01:30 local. Under UTC+3 this is 22:30 UTC on the 20th,
  // so the old toISOString() key filed it against the wrong day.
  const localMorning = new Date(2026, 7, 21, 1, 30, 0);
  t.check('dayKey uses local time, not UTC', core.dayKey(localMorning) === '2026-08-21', core.dayKey(localMorning));
  t.check('dayKey pads single-digit months and days', core.dayKey(new Date(2026, 0, 5)) === '2026-01-05', core.dayKey(new Date(2026, 0, 5)));
  // 1 Sep local, still 31 Aug in UTC — the month filter must say September.
  t.check('monthKey uses local time', core.monthKey(new Date(2026, 8, 1, 2, 0, 0)) === '2026-09', core.monthKey(new Date(2026, 8, 1, 2, 0, 0)));

  const keys = [
    core.dayKey(new Date(2026, 8, 9)),
    core.dayKey(new Date(2026, 8, 10)),
    core.dayKey(new Date(2025, 11, 31)),
  ];
  t.check(
    'day keys sort lexicographically in chronological order',
    same([...keys].sort(), [...keys].sort((a, b) => (a < b ? -1 : 1))),
    JSON.stringify(keys),
  );

  t.section('pruning');

  const pruneNow = new Date(2026, 7, 21).getTime();
  const pruneLogs = {
    '2026-08-20': 100, // yesterday — keep
    '2026-06-01': 50, // 81 days ago — keep
    '2026-01-01': 25, // way past 90 days — drop
  };
  const pruned = core.pruneOldEntries(pruneLogs, 90, pruneNow);
  t.check(
    'pruneOldEntries drops entries past the retention window',
    same(Object.keys(pruned).sort(), ['2026-06-01', '2026-08-20']),
    JSON.stringify(Object.keys(pruned).sort()),
  );

  const frozenLogs = { '2020-01-01': 5 };
  core.pruneOldEntries(frozenLogs, 90, new Date(2026, 7, 21).getTime());
  t.check('pruneOldEntries does not mutate its input', same(frozenLogs, { '2020-01-01': 5 }), JSON.stringify(frozenLogs));
  t.check('pruneOldEntries tolerates missing logs', same(core.pruneOldEntries(null, 90, Date.now()), {}));

  t.section('log sums');

  const sumNow = new Date(2026, 7, 21).getTime();
  t.check(
    'sumLogs scoped to month ignores other months',
    core.sumLogs({ '2026-08-01': 60, '2026-08-20': 40, '2026-07-31': 999 }, 'month', sumNow) === 100,
  );
  t.check(
    'sumLogs with all scope includes everything',
    core.sumLogs({ '2026-08-01': 60, '2026-07-31': 40 }, 'all', sumNow) === 100,
  );
  t.check(
    'sumLogs skips non-numeric values instead of producing NaN',
    core.sumLogs({ '2026-08-01': 'oops', '2026-08-02': 10 }, 'all', sumNow) === 10,
  );

  t.section('savings');

  // Regression guard for the 2x overstatement. 18.75 MB/min is 2.5 Mbps and
  // 33.75 is 4.5 Mbps — both YouTube upload guidance, not what a player pulls.
  t.check('data rates: hd720 is not the old upload-guidance 18.75', core.DATA_RATES.hd720 !== 18.75, String(core.DATA_RATES.hd720));
  t.check('data rates: hd1080 is not the old upload-guidance 33.75', core.DATA_RATES.hd1080 !== 33.75, String(core.DATA_RATES.hd1080));
  t.check('data rates: audioMode is a real number', core.DATA_RATES.audioMode > core.DATA_RATES.audioMode - 1, String(core.DATA_RATES.audioMode));
  t.check('data rates: hd720 > audioMode', core.DATA_RATES.hd720 > core.DATA_RATES.audioMode);
  t.check('data rates: hd1080 > hd720', core.DATA_RATES.hd1080 > core.DATA_RATES.hd720);

  const hour = core.computeSavings(3600, core.DATA_RATES.hd720);
  t.check('computeSavings usedMb for one hour', Math.round(hour.usedMb) === 72, String(hour.usedMb)); // 60 min * 1.2
  t.check('computeSavings baselineMb for one hour', Math.round(hour.baselineMb) === 600, String(hour.baselineMb)); // 60 min * 10
  t.check('computeSavings savedMb for one hour', Math.round(hour.savedMb) === 528, String(hour.savedMb));
  t.check('computeSavings never returns negative savings', core.computeSavings(3600, 0.1).savedMb === 0, String(core.computeSavings(3600, 0.1).savedMb));
  t.check('computeSavings treats negative input as zero', core.computeSavings(-500, core.DATA_RATES.hd720).usedMb === 0);

  t.section('stats accumulator');

  const first = core.createStatsAccumulator();
  first.sample({ currentTime: 10, paused: false, ended: false }, 1000);
  t.check('accumulator credits nothing on the first sample', same(first.peek(), { listened: 0, active: 0 }), JSON.stringify(first.peek()));

  const normal = core.createStatsAccumulator();
  normal.sample({ currentTime: 0, paused: false, ended: false }, 0);
  normal.sample({ currentTime: 5, paused: false, ended: false }, 5000);
  const normalPeek = normal.peek();
  t.check('accumulator credits media seconds during normal playback: listened', normalPeek.listened === 5, String(normalPeek.listened));
  t.check('accumulator credits media seconds during normal playback: active', normalPeek.active === 5, String(normalPeek.active));

  // The old tick counter added 5 per 5s tick regardless of rate, so 2x
  // listening recorded the same as 1x while pulling twice the data.
  const double = core.createStatsAccumulator();
  double.sample({ currentTime: 0, paused: false, ended: false }, 0);
  double.sample({ currentTime: 20, paused: false, ended: false }, 10000);
  const doublePeek = double.peek();
  t.check('accumulator counts double at 2x playback rate: listened', doublePeek.listened === 20, String(doublePeek.listened));
  t.check('accumulator counts double at 2x playback rate: active', doublePeek.active === 10, String(doublePeek.active));

  // Background tabs can have timers throttled. The old counter credited a
  // flat 5s per firing, so a 5s timer throttled to 60s under-counted 12x.
  const throttled = core.createStatsAccumulator();
  throttled.sample({ currentTime: 0, paused: false, ended: false }, 0);
  throttled.sample({ currentTime: 60, paused: false, ended: false }, 60000);
  t.check('accumulator stays accurate when the timer is throttled', throttled.peek().listened === 60, String(throttled.peek().listened));

  const paused = core.createStatsAccumulator();
  paused.sample({ currentTime: 30, paused: true, ended: false }, 0);
  paused.sample({ currentTime: 30, paused: true, ended: false }, 10000);
  const pausedPeek = paused.peek();
  t.check('accumulator counts active but not listened while paused: listened', pausedPeek.listened === 0, String(pausedPeek.listened));
  t.check('accumulator counts active but not listened while paused: active', pausedPeek.active === 10, String(pausedPeek.active));

  const seekFwd = core.createStatsAccumulator();
  seekFwd.sample({ currentTime: 10, paused: false, ended: false }, 0);
  seekFwd.sample({ currentTime: 600, paused: false, ended: false }, 5000);
  t.check('accumulator ignores a forward seek: listened', seekFwd.peek().listened === 0, String(seekFwd.peek().listened));
  t.check('accumulator ignores a forward seek: active', seekFwd.peek().active === 5, String(seekFwd.peek().active));

  const seekBack = core.createStatsAccumulator();
  seekBack.sample({ currentTime: 600, paused: false, ended: false }, 0);
  seekBack.sample({ currentTime: 10, paused: false, ended: false }, 5000);
  t.check('accumulator ignores a backward seek', seekBack.peek().listened === 0, String(seekBack.peek().listened));

  const slept = core.createStatsAccumulator();
  slept.sample({ currentTime: 0, paused: false, ended: false }, 0);
  slept.sample({ currentTime: 3600, paused: false, ended: false }, 3600000);
  t.check('accumulator ignores a sleep or suspend gap', same(slept.peek(), { listened: 0, active: 0 }), JSON.stringify(slept.peek()));

  const resume = core.createStatsAccumulator();
  resume.sample({ currentTime: 0, paused: false, ended: false }, 0);
  resume.sample({ currentTime: 3600, paused: false, ended: false }, 3600000);
  resume.sample({ currentTime: 3605, paused: false, ended: false }, 3605000);
  t.check('accumulator resumes cleanly after a sleep gap', resume.peek().listened === 5, String(resume.peek().listened));

  const ended = core.createStatsAccumulator();
  ended.sample({ currentTime: 100, paused: false, ended: true }, 0);
  ended.sample({ currentTime: 100, paused: false, ended: true }, 5000);
  t.check('accumulator does not count a finished video', ended.peek().listened === 0, String(ended.peek().listened));

  const jumped = core.createStatsAccumulator();
  jumped.sample({ currentTime: 500, paused: false, ended: false }, 0);
  jumped.reset();
  jumped.sample({ currentTime: 0, paused: false, ended: false }, 5000);
  jumped.sample({ currentTime: 5, paused: false, ended: false }, 10000);
  t.check('accumulator reset re-establishes the baseline without crediting a jump', jumped.peek().listened === 5, String(jumped.peek().listened));

  const drained = core.createStatsAccumulator();
  drained.sample({ currentTime: 0, paused: false, ended: false }, 0);
  drained.sample({ currentTime: 5, paused: false, ended: false }, 5000);
  t.check('drain returns totals and zeroes the counters: drain', same(drained.drain(), { listened: 5, active: 5 }));
  t.check('drain returns totals and zeroes the counters: peek', same(drained.peek(), { listened: 0, active: 0 }), JSON.stringify(drained.peek()));

  const keepBaseline = core.createStatsAccumulator();
  keepBaseline.sample({ currentTime: 0, paused: false, ended: false }, 0);
  keepBaseline.sample({ currentTime: 5, paused: false, ended: false }, 5000);
  keepBaseline.drain();
  keepBaseline.sample({ currentTime: 10, paused: false, ended: false }, 10000);
  t.check('drain does not lose the sampling baseline', keepBaseline.peek().listened === 5, String(keepBaseline.peek().listened));

  t.section('formatting');

  t.check('formatTime renders minutes and seconds: 0', core.formatTime(0) === '0:00', core.formatTime(0));
  t.check('formatTime renders minutes and seconds: 9', core.formatTime(9) === '0:09', core.formatTime(9));
  t.check('formatTime renders minutes and seconds: 75', core.formatTime(75) === '1:15', core.formatTime(75));
  t.check('formatTime pads minutes only once hours appear: 3600', core.formatTime(3600) === '1:00:00', core.formatTime(3600));
  t.check('formatTime pads minutes only once hours appear: 3725', core.formatTime(3725) === '1:02:05', core.formatTime(3725));
  t.check('formatTime handles NaN', core.formatTime(NaN) === '0:00');
  t.check('formatTime handles undefined', core.formatTime(undefined) === '0:00');
  t.check('formatTime handles negatives', core.formatTime(-5) === '0:00', core.formatTime(-5));
  t.check('formatData switches to GB above 1024MB: 2048', core.formatData(2048) === '2.00GB', core.formatData(2048));
  t.check('formatData switches to GB above 1024MB: 512', core.formatData(512) === '512MB', core.formatData(512));
  t.check('formatData does not round real usage down to 0MB: 0.4', core.formatData(0.4) === '0.4MB', core.formatData(0.4));
  t.check('formatData does not round real usage down to 0MB: 0', core.formatData(0) === '0MB', core.formatData(0));
  t.check('formatData accepts localized units', core.formatData(2048, { gb: ' ج.ب', mb: ' م.ب' }) === '2.00 ج.ب', core.formatData(2048, { gb: ' ج.ب', mb: ' م.ب' }));

  t.section('URL validation');

  t.check('isWatchUrl accepts a real watch URL', core.isWatchUrl('https://www.youtube.com/watch?v=abc123') === true);

  // The old check was url.includes('youtube.com'), which these all pass.
  // Combined with activeTab from a keyboard command, that allowed the
  // content script to be injected into an attacker-controlled page.
  t.check('isWatchUrl rejects a look-alike host: hash', core.isWatchUrl('https://evil.com/#youtube.com') === false);
  t.check('isWatchUrl rejects a look-alike host: path', core.isWatchUrl('https://evil.com/youtube.com/watch') === false);
  t.check('isWatchUrl rejects a look-alike host: suffix', core.isWatchUrl('https://youtube.com.evil.com/watch') === false);
  t.check('isWatchUrl rejects a look-alike host: notyoutube', core.isWatchUrl('https://notyoutube.com/watch') === false);
  t.check('isWatchUrl rejects non-watch YouTube pages', core.isWatchUrl('https://www.youtube.com/feed/subscriptions') === false);
  t.check('isWatchUrl rejects plain http', core.isWatchUrl('http://www.youtube.com/watch?v=abc') === false);
  t.check('isWatchUrl rejects malformed input: not a url', core.isWatchUrl('not a url') === false);
  t.check('isWatchUrl rejects malformed input: undefined', core.isWatchUrl(undefined) === false);
  t.check('isWatchUrl rejects malformed input: null', core.isWatchUrl(null) === false);

  t.check('isYoutubeOrigin accepts https://www.youtube.com/', core.isYoutubeOrigin('https://www.youtube.com/') === true);
  t.check('isYoutubeOrigin accepts a watch URL', core.isYoutubeOrigin('https://www.youtube.com/watch?v=abc') === true);
  t.check('isYoutubeOrigin accepts a feed URL', core.isYoutubeOrigin('https://www.youtube.com/feed/subscriptions') === true);
  t.check('isYoutubeOrigin rejects http', core.isYoutubeOrigin('http://www.youtube.com/') === false);
  t.check('isYoutubeOrigin rejects m.youtube.com', core.isYoutubeOrigin('https://m.youtube.com/') === false);
  t.check('isYoutubeOrigin rejects youtube.com without www', core.isYoutubeOrigin('https://youtube.com/') === false);
  t.check('isYoutubeOrigin rejects evil hash', core.isYoutubeOrigin('https://evil.com/#youtube.com') === false);
  t.check('isYoutubeOrigin rejects youtube.com.evil.com', core.isYoutubeOrigin('https://youtube.com.evil.com/watch') === false);
  t.check('isYoutubeOrigin rejects www.youtube.com.evil.com', core.isYoutubeOrigin('https://www.youtube.com.evil.com/') === false);
  t.check('isYoutubeOrigin rejects not a url', core.isYoutubeOrigin('not a url') === false);
  t.check('isYoutubeOrigin rejects undefined', core.isYoutubeOrigin(undefined) === false);
  t.check('isYoutubeOrigin rejects null', core.isYoutubeOrigin(null) === false);

  t.check(
    'classifyNavigation carries watch -> home when the player is still there',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/', true) === 'carry',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/', true),
  );
  t.check(
    'classifyNavigation carries watch -> feed when the player is still there',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/feed/subscriptions', true) === 'carry',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/feed/subscriptions', true),
  );
  t.check(
    'classifyNavigation departs watch -> home when the player is gone',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/', false) === 'depart',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://www.youtube.com/', false),
  );
  t.check(
    'classifyNavigation arrives at a watch URL regardless of the player flag: from home',
    core.classifyNavigation('https://www.youtube.com/', 'https://www.youtube.com/watch?v=abc', false) === 'arrive',
    core.classifyNavigation('https://www.youtube.com/', 'https://www.youtube.com/watch?v=abc', false),
  );
  t.check(
    'classifyNavigation arrives at a watch URL regardless of the player flag: watch to watch',
    core.classifyNavigation('https://www.youtube.com/watch?v=aaa', 'https://www.youtube.com/watch?v=bbb', true) === 'arrive',
    core.classifyNavigation('https://www.youtube.com/watch?v=aaa', 'https://www.youtube.com/watch?v=bbb', true),
  );
  t.check(
    'classifyNavigation never carries onto a look-alike origin: evil hash',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://evil.com/#youtube.com', true) === 'depart',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://evil.com/#youtube.com', true),
  );
  t.check(
    'classifyNavigation never carries onto a look-alike origin: youtube.com.evil.com',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://youtube.com.evil.com/', true) === 'depart',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'https://youtube.com.evil.com/', true),
  );
  t.check(
    'classifyNavigation never carries onto a look-alike origin: http youtube',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'http://www.youtube.com/', true) === 'depart',
    core.classifyNavigation('https://www.youtube.com/watch?v=abc', 'http://www.youtube.com/', true),
  );
  t.check(
    'classifyNavigation is idle for non-watch movement without a player',
    core.classifyNavigation('https://www.youtube.com/', 'https://www.youtube.com/feed/subscriptions', false) === 'idle',
    core.classifyNavigation('https://www.youtube.com/', 'https://www.youtube.com/feed/subscriptions', false),
  );

  const watch = { id: 1, url: 'https://www.youtube.com/watch?v=abc' };
  const home = { id: 2, url: 'https://www.youtube.com/' };
  const evil = { id: 3, url: 'https://evil.com/#youtube.com' };
  t.check('isControllableTab allows watch URLs', core.isControllableTab(watch) === true);
  t.check('isControllableTab rejects an unlisted home tab', core.isControllableTab(home) === false);
  t.check('isControllableTab allows a listed miniplayer tab (array)', core.isControllableTab(home, [2]) === true);
  t.check('isControllableTab allows a listed miniplayer tab (map)', core.isControllableTab(home, { 2: true }) === true);
  t.check('isControllableTab rejects a look-alike origin even when listed', core.isControllableTab(evil, [3]) === false);
  t.check('isControllableTab rejects null', core.isControllableTab(null, [1]) === false);

  t.check(
    'sanitizeImageUrl accepts https',
    core.sanitizeImageUrl('https://example.com/bg.jpg') === 'https://example.com/bg.jpg',
    core.sanitizeImageUrl('https://example.com/bg.jpg'),
  );
  t.check(
    'sanitizeImageUrl accepts data image URLs',
    core.sanitizeImageUrl('data:image/png;base64,iVBORw0KGgo=') === 'data:image/png;base64,iVBORw0KGgo=',
    core.sanitizeImageUrl('data:image/png;base64,iVBORw0KGgo='),
  );
  t.check('sanitizeImageUrl rejects values that break out of url("..."): quote', core.sanitizeImageUrl('https://x.com/a.jpg") ; background: red; ("') === null);
  t.check('sanitizeImageUrl rejects values that break out of url("..."): backslash', core.sanitizeImageUrl('https://x.com/a.jpg\\') === null);
  t.check('sanitizeImageUrl rejects values that break out of url("..."): newline', core.sanitizeImageUrl('https://x.com/a\n.jpg') === null);
  t.check('sanitizeImageUrl rejects javascript:', core.sanitizeImageUrl('javascript:alert(1)') === null);
  t.check('sanitizeImageUrl rejects http', core.sanitizeImageUrl('http://example.com/bg.jpg') === null);
  t.check('sanitizeImageUrl rejects data:text/html', core.sanitizeImageUrl('data:text/html,<script>x</script>') === null);
  t.check('sanitizeImageUrl rejects empty', core.sanitizeImageUrl('   ') === null);
  t.check('sanitizeImageUrl rejects null', core.sanitizeImageUrl(null) === null);
  t.check('sanitizeImageUrl rejects non-string', core.sanitizeImageUrl(42) === null);

  t.section('videoIdFromUrl');

  t.check(
    'videoIdFromUrl reads the v param of a watch URL',
    core.videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9wgxcQ') === 'dQw4w9wgxcQ',
    core.videoIdFromUrl('https://www.youtube.com/watch?v=dQw4w9wgxcQ'),
  );
  t.check(
    'videoIdFromUrl reads v when other params are present',
    core.videoIdFromUrl('https://www.youtube.com/watch?v=abc&list=PLxyz') === 'abc',
    core.videoIdFromUrl('https://www.youtube.com/watch?v=abc&list=PLxyz'),
  );
  t.check('videoIdFromUrl returns null when v is missing', core.videoIdFromUrl('https://www.youtube.com/watch') === null);
  t.check('videoIdFromUrl returns null when v is empty', core.videoIdFromUrl('https://www.youtube.com/watch?v=') === null);
  t.check('videoIdFromUrl rejects youtu.be', core.videoIdFromUrl('https://youtu.be/dQw4w9wgxcQ') === null);
  t.check('videoIdFromUrl rejects a feed URL', core.videoIdFromUrl('https://www.youtube.com/feed/subscriptions') === null);
  t.check('videoIdFromUrl rejects m.youtube.com', core.videoIdFromUrl('https://m.youtube.com/watch?v=abc') === null);
  t.check('videoIdFromUrl rejects not a url', core.videoIdFromUrl('not a url') === null);
  t.check('videoIdFromUrl rejects undefined', core.videoIdFromUrl(undefined) === null);
  t.check('videoIdFromUrl rejects null', core.videoIdFromUrl(null) === null);
  t.check('videoIdFromUrl rejects a number', core.videoIdFromUrl(42) === null);
  t.check('videoIdFromUrl rejects a brace', core.videoIdFromUrl('{') === null);

  t.section('tabTitleToVideoTitle');

  t.check('tabTitleToVideoTitle strips the YouTube suffix and unread count', core.tabTitleToVideoTitle('(3) A lecture - YouTube') === 'A lecture', core.tabTitleToVideoTitle('(3) A lecture - YouTube'));
  t.check('tabTitleToVideoTitle strips the YouTube suffix alone', core.tabTitleToVideoTitle('A lecture - YouTube') === 'A lecture', core.tabTitleToVideoTitle('A lecture - YouTube'));
  t.check('tabTitleToVideoTitle strips an unread count without a suffix', core.tabTitleToVideoTitle('(12) Solo piano') === 'Solo piano', core.tabTitleToVideoTitle('(12) Solo piano'));
  t.check('tabTitleToVideoTitle is safe on null', core.tabTitleToVideoTitle(null) === '');
  t.check('tabTitleToVideoTitle is safe on undefined', core.tabTitleToVideoTitle(undefined) === '');
  t.check('tabTitleToVideoTitle is safe on empty', core.tabTitleToVideoTitle('') === '');
  t.check('tabTitleToVideoTitle trims a suffix-only title', core.tabTitleToVideoTitle('   - YouTube  ') === '');
  t.check('tabTitleToVideoTitle trims', core.tabTitleToVideoTitle('  Untitled  ') === 'Untitled', core.tabTitleToVideoTitle('  Untitled  '));
  t.check('tabTitleToVideoTitle leaves a title that is just YouTube alone', core.tabTitleToVideoTitle('YouTube') === 'YouTube');

  t.section('pickTargetTab');

  t.check('pickTargetTab returns null for missing', core.pickTargetTab(null, {}) === null);
  t.check('pickTargetTab returns null for empty', core.pickTargetTab([], {}) === null);
  t.check(
    'pickTargetTab returns null for non-watch lists',
    core.pickTargetTab([watchTab({ url: 'https://www.youtube.com/feed/subscriptions' })], {}) === null,
  );

  const homeTab = watchTab({ id: 1, url: 'https://www.youtube.com/' });
  const watchOnly = watchTab({ id: 2, lastAccessed: 1 });
  t.check('pickTargetTab filters non-watch URLs out of a mixed list', core.pickTargetTab([homeTab, watchOnly], {}).id === 2);

  const active = watchTab({ id: 1, audible: false, lastAccessed: 1, index: 2 });
  const last = watchTab({ id: 2, audible: true, lastAccessed: 999, index: 0 });
  t.check(
    'pickTargetTab prefers the active watch tab over lastSelected and audible',
    core.pickTargetTab([last, active], { activeTabId: 1, lastSelectedId: 2 }).id === 1,
  );

  const lastQuiet = watchTab({ id: 2, audible: false, lastAccessed: 1, index: 3 });
  const audible = watchTab({ id: 3, audible: true, lastAccessed: 500, index: 0 });
  t.check(
    'pickTargetTab prefers lastSelectedId when the active tab is not a watch URL',
    core.pickTargetTab([audible, lastQuiet], { activeTabId: 99, lastSelectedId: 2 }).id === 2,
  );

  t.check(
    'pickTargetTab ignores a lastSelectedId that is no longer in the list',
    core.pickTargetTab([watchTab({ id: 3, lastAccessed: 1 })], { lastSelectedId: 2 }).id === 3,
  );

  const homeSelected = watchTab({ id: 2, url: 'https://www.youtube.com/' });
  const otherWatch = watchTab({ id: 3, lastAccessed: 1 });
  t.check(
    'pickTargetTab ignores lastSelectedId when that tab is not a watch URL',
    core.pickTargetTab([homeSelected, otherWatch], { lastSelectedId: 2 }).id === 3,
  );

  const quietRecent = watchTab({ id: 1, audible: false, lastAccessed: 9000, index: 0 });
  const playing = watchTab({ id: 2, audible: true, lastAccessed: 1, index: 1 });
  t.check('pickTargetTab prefers audible unmuted over lastAccessed: quiet first', core.pickTargetTab([quietRecent, playing], {}).id === 2);
  t.check('pickTargetTab prefers audible unmuted over lastAccessed: playing first', core.pickTargetTab([playing, quietRecent], {}).id === 2);

  const muted = watchTab({
    id: 1,
    audible: true,
    mutedInfo: { muted: true },
    lastAccessed: 1,
    index: 0,
  });
  const playingUnmuted = watchTab({
    id: 2,
    audible: true,
    mutedInfo: { muted: false },
    lastAccessed: 1,
    index: 1,
  });
  t.check('pickTargetTab does not treat an audible-but-muted tab as playing: muted first', core.pickTargetTab([muted, playingUnmuted], {}).id === 2);
  t.check('pickTargetTab does not treat an audible-but-muted tab as playing: playing first', core.pickTargetTab([playingUnmuted, muted], {}).id === 2);

  const mutedRecent = watchTab({
    id: 1,
    audible: true,
    mutedInfo: { muted: true },
    lastAccessed: 5000,
    windowId: 1,
    index: 0,
  });
  const silentOlder = watchTab({
    id: 2,
    audible: false,
    lastAccessed: 10,
    windowId: 1,
    index: 1,
  });
  t.check('pickTargetTab falls through an audible-muted tab to lastAccessed', core.pickTargetTab([silentOlder, mutedRecent], {}).id === 1);

  const noAccess = watchTab({
    id: 1,
    lastAccessed: undefined,
    windowId: 1,
    index: 0,
  });
  delete noAccess.lastAccessed;
  const nanAccess = watchTab({
    id: 2,
    lastAccessed: NaN,
    windowId: 1,
    index: 1,
  });
  const hasAccess = watchTab({
    id: 3,
    lastAccessed: 50,
    windowId: 2,
    index: 0,
  });
  t.check(
    'pickTargetTab treats missing lastAccessed as 0, never NaN',
    core.pickTargetTab([noAccess, nanAccess, hasAccess], {}).id === 3,
  );

  const aMissing = watchTab({ id: 10, lastAccessed: undefined, windowId: 2, index: 0 });
  delete aMissing.lastAccessed;
  const bMissing = watchTab({ id: 11, lastAccessed: undefined, windowId: 1, index: 5 });
  delete bMissing.lastAccessed;
  t.check('pickTargetTab all-missing lastAccessed falls through to windowId: a then b', core.pickTargetTab([aMissing, bMissing], {}).id === 11);
  t.check('pickTargetTab all-missing lastAccessed falls through to windowId: b then a', core.pickTargetTab([bMissing, aMissing], {}).id === 11);

  const tieA = watchTab({
    id: 20,
    audible: false,
    lastAccessed: 0,
    windowId: 1,
    index: 0,
  });
  const tieB = watchTab({
    id: 10,
    audible: false,
    lastAccessed: 0,
    windowId: 1,
    index: 0,
  });
  t.check('pickTargetTab all-equal tie is stable regardless of input order: a then b', core.pickTargetTab([tieA, tieB], {}).id === 10);
  t.check('pickTargetTab all-equal tie is stable regardless of input order: b then a', core.pickTargetTab([tieB, tieA], {}).id === 10);

  const right = watchTab({ id: 1, lastAccessed: 0, windowId: 5, index: 0 });
  const leftOlderWindow = watchTab({ id: 2, lastAccessed: 0, windowId: 1, index: 8 });
  const sameWindowEarlier = watchTab({ id: 3, lastAccessed: 0, windowId: 1, index: 2 });
  const rankedTabs = [right, leftOlderWindow, sameWindowEarlier];
  t.check('pickTargetTab stable fallback is ascending windowId then index', core.pickTargetTab(rankedTabs, {}).id === 3);
  t.check('pickTargetTab stable fallback is independent of input order', core.pickTargetTab(rankedTabs.slice().reverse(), {}).id === 3);

  const unmutated = [
    watchTab({ id: 2, lastAccessed: 1, index: 1 }),
    watchTab({ id: 1, lastAccessed: 50, index: 0 }),
  ];
  const before = unmutated.map((tab) => tab.id);
  core.pickTargetTab(unmutated, {});
  t.check('pickTargetTab does not mutate its input', same(unmutated.map((tab) => tab.id), before), JSON.stringify(unmutated.map((tab) => tab.id)));

  const mini = watchTab({ id: 7, url: 'https://www.youtube.com/', audible: true });
  t.check('pickTargetTab excludes an unlisted miniplayer tab', core.pickTargetTab([mini], {}) === null);
  t.check('pickTargetTab includes a miniplayer tab listed in playerTabIds', core.pickTargetTab([mini], { playerTabIds: [7] }).id === 7);

  const audibleMini = watchTab({
    id: 1,
    url: 'https://www.youtube.com/',
    audible: true,
    lastAccessed: 1,
  });
  const quietWatch = watchTab({ id: 2, audible: false, lastAccessed: 9000 });
  t.check(
    'pickTargetTab prefers an audible miniplayer tab over a quiet watch tab',
    core.pickTargetTab([audibleMini, quietWatch], { playerTabIds: [1] }).id === 1,
  );

  const evilTab = watchTab({ id: 1, url: 'https://evil.com/#youtube.com', audible: true });
  const realWatch = watchTab({ id: 2, lastAccessed: 1 });
  t.check(
    'pickTargetTab still rejects a look-alike origin even when listed in playerTabIds',
    core.pickTargetTab([evilTab, realWatch], { playerTabIds: [1] }).id === 2,
  );

  const activeMini = watchTab({ id: 5, url: 'https://www.youtube.com/', audible: false });
  const otherPlaying = watchTab({ id: 6, audible: true, lastAccessed: 999 });
  t.check(
    'pickTargetTab can bind the active tab when that tab is a miniplayer',
    core.pickTargetTab([activeMini, otherPlaying], { activeTabId: 5, playerTabIds: [5] }).id === 5,
  );

  t.section('classifyQualityChange');

  t.check("144p is audio mode's own quality, however it is reported: tiny", core.classifyQualityChange('tiny', { settled: true }) === 'audio');
  t.check("144p is audio mode's own quality, however it is reported: small", core.classifyQualityChange('small', { settled: true }) === 'audio');

  for (const q of ['medium', 'large', 'hd720', 'hd1080', 'hd1440', 'highres', 'auto']) {
    t.check(`anything above 144p after settling is the user: ${q}`, core.classifyQualityChange(q, { settled: true }) === 'user', core.classifyQualityChange(q, { settled: true }));
  }

  // YouTube's adaptive engine picks a quality before the extension forces
  // 144p. Reading that as a manual change would switch audio mode straight
  // back off on every page load.
  t.check('startup quality is not blamed on the user: hd720 unsettled', core.classifyQualityChange('hd720', { settled: false }) === 'settling');
  t.check('startup quality is not blamed on the user: auto with empty state', core.classifyQualityChange('auto', {}) === 'settling');

  t.check('classifyQualityChange survives junk input: undefined settled', core.classifyQualityChange(undefined, { settled: true }) === 'user');
  t.check('classifyQualityChange survives junk input: null empty state', core.classifyQualityChange(null, {}) === 'settling');
  t.check('classifyQualityChange survives junk input: tiny with no state', core.classifyQualityChange('tiny') === 'audio');
}
