/**
 * Wire-layer suite. Parsers run against committed fixtures; network callers
 * get an injected fetch. Nothing here talks to youtube.com.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  YtError,
  normalizeChannelInput,
  normalizeVideoInput,
  thumbUrl,
  parseDuration,
  parseCompactCount,
  parseFeedXml,
  parseResolveUrl,
  parseChannelHeader,
  parsePlayer,
  resolveChannelId,
  fetchChannelFeed,
  fetchChannelHeader,
  isShort,
  classifyVideo,
  isChannelId,
  isAvatarUrl,
  isPushback,
} from '../src/lib/yt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.join(ROOT, 'test/fixtures');
const read = (name) => fs.readFileSync(path.join(FIX, name), 'utf8');
const readJson = (name) => JSON.parse(read(name));

function jsonRes(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    redirected: false,
    url: '',
  };
}

function textRes(text, { status = 200, cache } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => text,
    json: async () => JSON.parse(text),
    redirected: false,
    url: '',
    cache,
  };
}

function headRes({ status = 200, redirected = false, url = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected,
    url,
    json: async () => ({}),
    text: async () => '',
  };
}

function recordFetch(handler) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts });
    return handler(String(url), opts, calls);
  };
  fetch.calls = calls;
  return fetch;
}

export default async function run(t) {
  const rssMkbhd = read('rss.mkbhd.xml');
  const rssBeast = read('rss.mrbeast-with-shorts.xml');
  const resolveJson = readJson('resolve_url.mkbhd.json');
  const browseJson = readJson('browse.videos-tab.mrbeast.json');
  const playerNormal = readJson('player.normal-video.json');
  const playerLive = readJson('player.live.json');
  const playerPremiere = readJson('player.premiere.synthetic.json');

  /* ---- normalizeChannelInput ---------------------------------------- */
  t.section('normalizeChannelInput');

  const mkbhdId = 'UCBJycsmduvYEL83R_U4JriQ';
  const asId = (input) => normalizeChannelInput(input);
  t.check('bare channel id', asId(mkbhdId)?.kind === 'id' && asId(mkbhdId)?.id === mkbhdId);
  t.check('trims whitespace around a channel id', asId(`  ${mkbhdId}  `)?.id === mkbhdId);

  t.check(
    '@handle',
    JSON.stringify(asId('@mkbhd')) === JSON.stringify({ kind: 'url', url: 'https://www.youtube.com/@mkbhd' }),
  );
  t.check(
    'bare word is a handle',
    JSON.stringify(asId('mkbhd')) === JSON.stringify({ kind: 'url', url: 'https://www.youtube.com/@mkbhd' }),
  );
  t.check(
    'a dotted handle is still a handle',
    JSON.stringify(asId('mr.beast')) === JSON.stringify({ kind: 'url', url: 'https://www.youtube.com/@mr.beast' }),
  );
  t.check('a name with spaces is not a handle', asId('marques brownlee') === null);
  t.check('a bare youtube host is not a handle', asId('youtube.com') === null);
  t.check(
    'youtube.com/@handle',
    asId('youtube.com/@mkbhd')?.url === 'https://www.youtube.com/@mkbhd',
  );
  t.check(
    'www.youtube.com/@handle',
    asId('www.youtube.com/@mkbhd')?.url === 'https://www.youtube.com/@mkbhd',
  );
  t.check(
    'm.youtube.com/@handle',
    asId('m.youtube.com/@mkbhd')?.url === 'https://www.youtube.com/@mkbhd',
  );
  t.check(
    'https handle with ?si= and no slash',
    asId('https://www.youtube.com/@mkbhd?si=xyz')?.url === 'https://www.youtube.com/@mkbhd',
  );
  t.check(
    'https handle with trailing slash',
    asId('https://www.youtube.com/@mkbhd/')?.url === 'https://www.youtube.com/@mkbhd',
  );

  const channelUrl = `https://www.youtube.com/channel/${mkbhdId}`;
  t.check(
    '/channel/UC… is kind id, no network needed',
    asId(channelUrl)?.kind === 'id' && asId(channelUrl)?.id === mkbhdId,
  );
  t.check(
    '/c/SomeName is kind url',
    JSON.stringify(asId('https://www.youtube.com/c/SomeName')) ===
      JSON.stringify({ kind: 'url', url: 'https://www.youtube.com/c/SomeName' }),
  );
  t.check(
    '/user/SomeName is kind url',
    JSON.stringify(asId('https://www.youtube.com/user/SomeName')) ===
      JSON.stringify({ kind: 'url', url: 'https://www.youtube.com/user/SomeName' }),
  );

  t.check(
    'watch URL is a video',
    JSON.stringify(asId('https://www.youtube.com/watch?v=Od6M0AXpcxQ')) ===
      JSON.stringify({ kind: 'video', id: 'Od6M0AXpcxQ' }),
  );
  t.check(
    'shorts URL is a video',
    asId('https://www.youtube.com/shorts/5mU6SRS2Bxo')?.id === '5mU6SRS2Bxo'
      && asId('https://www.youtube.com/shorts/5mU6SRS2Bxo')?.kind === 'video',
  );
  t.check(
    'youtu.be URL is a video',
    JSON.stringify(asId('https://youtu.be/Od6M0AXpcxQ')) ===
      JSON.stringify({ kind: 'video', id: 'Od6M0AXpcxQ' }),
  );
  t.check(
    'watch URL keeps v= among other params',
    asId('https://www.youtube.com/watch?t=30&v=Od6M0AXpcxQ')?.id === 'Od6M0AXpcxQ',
  );
  t.check(
    'playlist URL is rejected',
    asId('https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxx') === null,
  );
  t.check('non-YouTube URL is rejected', asId('https://example.com/@mkbhd') === null);
  t.check('empty string is rejected', asId('') === null);
  t.check('whitespace-only is rejected', asId('   ') === null);

  /* ---- normalizeVideoInput ------------------------------------------ */
  t.section('normalizeVideoInput');

  const asVid = (input) => normalizeVideoInput(input);
  t.check(
    'bare 11-character id is a video',
    JSON.stringify(asVid('Od6M0AXpcxQ')) === JSON.stringify({ kind: 'video', id: 'Od6M0AXpcxQ' }),
  );
  t.check(
    'watch URL is a video',
    JSON.stringify(asVid('https://www.youtube.com/watch?v=Od6M0AXpcxQ')) ===
      JSON.stringify({ kind: 'video', id: 'Od6M0AXpcxQ' }),
  );
  t.check(
    'shorts URL is a video',
    asVid('https://www.youtube.com/shorts/5mU6SRS2Bxo')?.id === '5mU6SRS2Bxo',
  );
  t.check(
    'youtu.be URL is a video',
    asVid('https://youtu.be/Od6M0AXpcxQ')?.id === 'Od6M0AXpcxQ',
  );
  t.check('a handle is not a video', asVid('@mkbhd') === null);
  t.check('a bare word is not a video on Feeds', asVid('mkbhd') === null);
  t.check('a channel id is not a video', asVid(mkbhdId) === null);
  t.check('a name with spaces is not a video', asVid('never gonna give you up') === null);
  t.check('empty string is not a video', asVid('') === null);

  /* ---- thumbUrl / parseDuration / parseCompactCount ----------------- */
  t.section('thumbUrl / duration / compact count');

  t.check('thumbUrl default size is mq', thumbUrl('Od6M0AXpcxQ') === 'https://i.ytimg.com/vi/Od6M0AXpcxQ/mqdefault.jpg');
  t.check('thumbUrl default.jpg', thumbUrl('Od6M0AXpcxQ', 'default') === 'https://i.ytimg.com/vi/Od6M0AXpcxQ/default.jpg');
  t.check('thumbUrl hq', thumbUrl('Od6M0AXpcxQ', 'hq') === 'https://i.ytimg.com/vi/Od6M0AXpcxQ/hqdefault.jpg');
  t.check('thumbUrl sd', thumbUrl('Od6M0AXpcxQ', 'sd') === 'https://i.ytimg.com/vi/Od6M0AXpcxQ/sddefault.jpg');
  t.check('thumbUrl maxres', thumbUrl('Od6M0AXpcxQ', 'maxres') === 'https://i.ytimg.com/vi/Od6M0AXpcxQ/maxresdefault.jpg');

  const durationCases = [
    ['23:28', 1408],
    ['1:02:03', 3723],
    ['0:05', 5],
    ['3:14', 194],
    ['57:51', 3471],
    ['', 0],
    ['live', 0],
    ['abc', 0],
    [null, 0],
    ['1:2:3:4', 0],
  ];
  for (const [input, expected] of durationCases) {
    const got = parseDuration(input);
    t.check(`parseDuration(${JSON.stringify(input)}) = ${expected}`, got === expected, String(got));
  }

  const countCases = [
    ['79M views', 79000000],
    ['516M subscribers', 516000000],
    ['1.4K', 1400],
    ['1.4k', 1400],
    ['1,234 views', 1234],
    ['21.2M subscribers', 21200000],
    ['1.27M subscribers', 1270000],
    ['86.4K subscribers', 86400],
    ['105 subscribers', 105],
    ['1 subscriber', 1],
    ['', 0],
    ['nope', 0],
    [null, 0],
  ];
  for (const [input, expected] of countCases) {
    const got = parseCompactCount(input);
    t.check(`parseCompactCount(${JSON.stringify(input)}) = ${expected}`, got === expected, String(got));
  }

  /* ---- parseFeedXml ------------------------------------------------- */
  t.section('parseFeedXml');

  const mkbhdFeed = parseFeedXml(rssMkbhd);
  t.check('MKBHD feed has 15 entries', mkbhdFeed.entries.length === 15, String(mkbhdFeed.entries.length));
  t.check('MKBHD channel title', mkbhdFeed.channelTitle === 'Marques Brownlee', mkbhdFeed.channelTitle);
  t.check(
    'MKBHD channel id is the UC… form (feed-level yt:channelId omits UC)',
    mkbhdFeed.channelId === mkbhdId,
    mkbhdFeed.channelId,
  );

  const first = mkbhdFeed.entries[0];
  t.check('first entry id', first.v === 'Od6M0AXpcxQ', first.v);
  t.check(
    'first entry title',
    first.title === 'iPhone 18 Pro/Duo Impressions: Mogged',
    first.title,
  );
  t.check(
    'first entry published epoch ms',
    first.at === Date.parse('2026-09-10T07:29:55+00:00') && first.at === 1789025395000,
    String(first.at),
  );
  t.check('first entry views', first.views === 15803019, String(first.views));
  t.check(
    'first entry description starts with the fixture text',
    first.description.startsWith('The first folding iPhone Duo and iPhone 18 Pro are here'),
    first.description.slice(0, 80),
  );

  const swapped = parseFeedXml(
    `<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/">
      <title>Swap</title>
      <link rel="self" href="http://www.youtube.com/feeds/videos.xml?channel_id=${mkbhdId}"/>
      <entry>
        <title>  One  </title>
        <yt:videoId> abcdefghijk </yt:videoId>
        <published>2026-09-10T07:29:55+00:00</published>
        <media:statistics average="5.00" views="42" count="1"/>
        <media:description>hi</media:description>
      </entry>
    </feed>`,
  );
  t.check('feed parser is robust to attribute order', swapped.entries[0].views === 42, String(swapped.entries[0]?.views));
  t.check('feed parser trims video id whitespace', swapped.entries[0].v === 'abcdefghijk', swapped.entries[0]?.v);

  let feedThrew = false;
  try {
    parseFeedXml('not xml at all');
  } catch (err) {
    feedThrew = err instanceof YtError && err.kind === 'parse';
  }
  t.check('garbage XML throws YtError parse', feedThrew);

  const beastFeed = parseFeedXml(rssBeast);
  const beastIds = beastFeed.entries.map((e) => e.v);
  t.check('MrBeast feed has 15 entries', beastIds.length === 15, String(beastIds.length));
  t.check(
    'MrBeast ids come out in document order',
    JSON.stringify(beastIds) === JSON.stringify([
      'gTKS8SAwUzE', '5mU6SRS2Bxo', 'Qtl8lJwbd4g', 'LiH-P4rSkLI', 'Af6i6ChAVTw',
      'NMR32p4kwAQ', 'f7y2XikE7sY', 'lVylRtlPOIE', 'Df5Y-2ndQyU', 'egvLKQe6I4I',
      'LgbyEFILLJI', 'iYlODtkyw_I', 'YA_kX8hu1gg', 'XCGVurja73c', 'r9aWeGqp43s',
    ]),
    JSON.stringify(beastIds),
  );
  t.check('includes short 5mU6SRS2Bxo at index 1', beastIds[1] === '5mU6SRS2Bxo');
  t.check('includes short LiH-P4rSkLI at index 3', beastIds[3] === 'LiH-P4rSkLI');
  t.check('MrBeast channel title', beastFeed.channelTitle === 'MrBeast', beastFeed.channelTitle);
  t.check(
    'MrBeast channel id',
    beastFeed.channelId === 'UCX6OQ3DkcsbYNE6H8uQQuVA',
    beastFeed.channelId,
  );

  /* ---- parseResolveUrl ---------------------------------------------- */
  t.section('parseResolveUrl');

  t.check(
    'resolve_url browseId is MKBHD',
    parseResolveUrl(resolveJson) === mkbhdId,
    String(parseResolveUrl(resolveJson)),
  );
  t.check('resolve_url accepts a JSON string', parseResolveUrl(JSON.stringify(resolveJson)) === mkbhdId);
  t.check('resolve_url without a browseId returns null', parseResolveUrl({}) === null);

  /* ---- parseChannelHeader ------------------------------------------- */
  t.section('parseChannelHeader');

  const header = parseChannelHeader(browseJson);
  t.check('header id', header.id === 'UCX6OQ3DkcsbYNE6H8uQQuVA', header.id);
  t.check('header title', header.title === 'MrBeast', header.title);
  t.check('header handle', header.handle === '@MrBeast', header.handle);
  t.check('header subscribers is 516M', header.subscribers === 516000000, String(header.subscribers));
  t.check(
    'header avatar is the s120 yt3.googleusercontent URL',
    header.avatar ===
      'https://yt3.googleusercontent.com/nxYrc_1_2f77DoBadyxMTmv7ZpRZapHR5jbuYe7PlPd5cIRJxtNNEYyOC0ZsxaDyJJzXrnJiuDE=s120-c-k-c0x00ffffff-no-rj',
    header.avatar,
  );
  // Backups keep an avatar only when isAvatarUrl accepts it, so the host
  // list must cover what YouTube actually serves.
  t.check('the served header avatar passes isAvatarUrl', isAvatarUrl(header.avatar), header.avatar);
  t.check('a UC id passes isChannelId', isChannelId(header.id));
  t.check('a handle is not a channel id', !isChannelId('@MrBeast'));
  t.check('an id with a trailing space is not a channel id', !isChannelId(`${header.id} `));

  /* ---- parsePlayer -------------------------------------------------- */
  t.section('parsePlayer');

  const normal = parsePlayer(playerNormal);
  t.check('normal video id', normal.v === 'Od6M0AXpcxQ', normal.v);
  t.check(
    'normal video title',
    normal.title === 'iPhone 18 Pro/Duo Impressions: Mogged',
    normal.title,
  );
  t.check('normal video channel id', normal.channelId === mkbhdId, normal.channelId);
  t.check('normal video channel title', normal.channelTitle === 'Marques Brownlee', normal.channelTitle);
  t.check('normal video lengthSeconds is 1034', normal.lengthSeconds === 1034, String(normal.lengthSeconds));
  t.check('normal video is not live', normal.isLive === false);
  t.check('normal video is not upcoming', normal.isUpcoming === false);
  t.check('normal video startsAt is 0', normal.startsAt === 0, String(normal.startsAt));
  t.check('normal video views', normal.views === 15914913, String(normal.views));
  t.check(
    'normal video publishedAt matches publishDate',
    normal.publishedAt === Date.parse('2026-09-10T00:29:55-07:00') && normal.publishedAt === 1789025395000,
    String(normal.publishedAt),
  );
  t.check('normal parse result has no isShortsEligible key', !('isShortsEligible' in normal));

  const live = parsePlayer(playerLive);
  t.check('live isLive true', live.isLive === true);
  t.check('live isUpcoming false', live.isUpcoming === false);
  t.check('live lengthSeconds is 0', live.lengthSeconds === 0, String(live.lengthSeconds));
  t.check('live video id', live.v === '7brdg4U0EbU', live.v);
  t.check('live channel title', live.channelTitle === 'eXtra news Live Stream', live.channelTitle);
  t.check(
    'live startsAt matches 2026-09-11T10:38:47+00:00',
    live.startsAt === Date.parse('2026-09-11T10:38:47+00:00') && live.startsAt === 1789123127000,
    String(live.startsAt),
  );

  const premiere = parsePlayer(playerPremiere);
  t.check('premiere isUpcoming true', premiere.isUpcoming === true);
  t.check('premiere isLive false', premiere.isLive === false);
  t.check(
    'premiere startsAt is 2026-12-01T18:00:00+00:00 (future)',
    premiere.startsAt === Date.parse('2026-12-01T18:00:00+00:00') && premiere.startsAt === 1796148000000,
    String(premiere.startsAt),
  );
  t.check('premiere startsAt is after the live start', premiere.startsAt > live.startsAt);

  let playerThrew = false;
  try {
    parsePlayer({});
  } catch (err) {
    playerThrew = err instanceof YtError && err.kind === 'parse';
  }
  t.check('player without videoDetails throws YtError parse', playerThrew);

  /* ---- classifyVideo (mocked fetch) --------------------------------- */
  t.section('classifyVideo');

  {
    const fetch = recordFetch((url) => {
      if (url.includes('/youtubei/v1/player')) return jsonRes(playerPremiere);
      throw new Error(`unexpected fetch ${url}`);
    });
    const got = await classifyVideo('7brdg4U0EbU', { fetch });
    t.check('upcoming -> premiere', got.k === 'premiere' && got.d === 0 && got.st === 1796148000000, JSON.stringify(got));
    t.check('premiere makes only the player call', fetch.calls.length === 1, String(fetch.calls.length));
  }

  {
    const fetch = recordFetch((url) => {
      if (url.includes('/youtubei/v1/player')) return jsonRes(playerLive);
      throw new Error(`unexpected fetch ${url}`);
    });
    const got = await classifyVideo('7brdg4U0EbU', { fetch });
    t.check('isLive -> live', got.k === 'live' && got.d === 0 && got.st === 1789123127000, JSON.stringify(got));
    t.check('live makes only the player call', fetch.calls.length === 1, String(fetch.calls.length));
  }

  {
    const fetch = recordFetch((url) => {
      if (url.includes('/youtubei/v1/player')) return jsonRes(playerNormal);
      throw new Error(`shorts request must not fire for a 1034s video: ${url}`);
    });
    const got = await classifyVideo('Od6M0AXpcxQ', { fetch });
    t.check('1034s -> video', got.k === 'video' && got.d === 1034 && got.st === 0, JSON.stringify(got));
    t.check('1034s video triggers no shorts request', fetch.calls.length === 1, String(fetch.calls.length));
    t.check('the one call was player', fetch.calls[0].url.includes('/youtubei/v1/player'));
  }

  {
    const eligible = structuredClone(playerNormal);
    eligible.microformat.playerMicroformatRenderer.isShortsEligible = true;
    eligible.videoDetails.isShortsEligible = true;
    const fetch = recordFetch((url) => {
      if (url.includes('/youtubei/v1/player')) return jsonRes(eligible);
      throw new Error(`isShortsEligible must not trigger a shorts request: ${url}`);
    });
    const got = await classifyVideo('Od6M0AXpcxQ', { fetch });
    t.check('isShortsEligible is ignored for a long video', got.k === 'video' && fetch.calls.length === 1, got.k);
  }

  const shortPlayer = {
    videoDetails: {
      videoId: 'shortishxxx',
      title: 'Shortish',
      lengthSeconds: '40',
      channelId: mkbhdId,
      author: 'Marques Brownlee',
      viewCount: '9',
    },
    microformat: {
      playerMicroformatRenderer: {
        publishDate: '2026-01-01T00:00:00+00:00',
        ownerChannelName: 'Marques Brownlee',
      },
    },
  };

  {
    const fetch = recordFetch((url) => {
      if (url.includes('/youtubei/v1/player')) return jsonRes(shortPlayer);
      if (url.includes('/shorts/shortishxxx')) {
        return headRes({ status: 200, redirected: false, url: 'https://www.youtube.com/shorts/shortishxxx' });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const got = await classifyVideo('shortishxxx', { fetch });
    t.check('40s + 200 shorts -> short', got.k === 'short' && got.d === 40, JSON.stringify(got));
    t.check('40s video does trigger the shorts request', fetch.calls.length === 2, String(fetch.calls.length));
    t.check('second call is HEAD shorts', fetch.calls[1].url === 'https://www.youtube.com/shorts/shortishxxx' && fetch.calls[1].opts.method === 'HEAD');
    t.check('shorts HEAD does not pass redirect:manual', fetch.calls[1].opts.redirect !== 'manual');
  }

  {
    const fetch = recordFetch((url) => {
      if (url.includes('/youtubei/v1/player')) return jsonRes(shortPlayer);
      if (url.includes('/shorts/shortishxxx')) {
        return headRes({
          status: 200,
          redirected: true,
          url: 'https://www.youtube.com/watch?v=shortishxxx',
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const got = await classifyVideo('shortishxxx', { fetch });
    t.check('40s + redirect to /watch -> video', got.k === 'video' && got.d === 40, JSON.stringify(got));
    t.check('watch-redirect still made two calls', fetch.calls.length === 2, String(fetch.calls.length));
  }

  /* ---- network callers, mocked -------------------------------------- */
  t.section('network callers');

  {
    const fetch = recordFetch((url, opts) => {
      t.check('feed URL', url === `https://www.youtube.com/feeds/videos.xml?channel_id=${mkbhdId}`, url);
      t.check("feed passes cache: 'no-cache'", opts.cache === 'no-cache', String(opts.cache));
      t.check("feed omits credentials", opts.credentials === 'omit', String(opts.credentials));
      return textRes(rssMkbhd);
    });
    const got = await fetchChannelFeed(mkbhdId, { fetch });
    t.check('fetchChannelFeed parses the XML', got.entries[0].v === 'Od6M0AXpcxQ');
  }

  {
    let called = 0;
    const fetch = async () => {
      called++;
      return jsonRes({});
    };
    const a = await resolveChannelId(mkbhdId, { fetch });
    const b = await resolveChannelId(`https://www.youtube.com/channel/${mkbhdId}`, { fetch });
    t.check('bare UC… resolves without a request', a === mkbhdId && called === 0, String(called));
    t.check('/channel/ URL resolves without a request', b === mkbhdId && called === 0, String(called));
  }

  {
    const fetch = recordFetch((url, opts) => {
      t.check('resolve_url endpoint', url === 'https://www.youtube.com/youtubei/v1/navigation/resolve_url?prettyPrint=false', url);
      t.check('resolve_url has no key= query', !url.includes('key='));
      const body = JSON.parse(opts.body);
      t.check('resolve_url body url', body.url === 'https://www.youtube.com/@mkbhd', body.url);
      t.check('innertube clientName WEB', body.context.client.clientName === 'WEB');
      t.check('Content-Type is json', opts.headers['Content-Type'] === 'application/json');
      t.check("resolve_url omits credentials", opts.credentials === 'omit', String(opts.credentials));
      return jsonRes(resolveJson);
    });
    const id = await resolveChannelId('@mkbhd', { fetch });
    t.check('resolveChannelId(@mkbhd) returns the id', id === mkbhdId, String(id));
  }

  {
    const fetch = recordFetch((url, opts) => {
      t.check('watch URL hits player, not resolve_url', /\/player/.test(url) && !/resolve_url/.test(url), url);
      const body = JSON.parse(opts.body);
      t.check('player videoId is the watch id', body.videoId === 'Od6M0AXpcxQ', body.videoId);
      t.check("player omits credentials", opts.credentials === 'omit', String(opts.credentials));
      return jsonRes(playerNormal);
    });
    const id = await resolveChannelId('https://www.youtube.com/watch?v=Od6M0AXpcxQ', { fetch });
    t.check('watch URL resolves to the uploader', id === mkbhdId, String(id));
  }

  {
    const fetch = recordFetch(() => {
      throw new Error('offline');
    });
    let err = null;
    try {
      await resolveChannelId('https://www.youtube.com/watch?v=Od6M0AXpcxQ', { fetch });
    } catch (e) {
      err = e;
    }
    t.check(
      'watch URL network failure throws YtError, not null',
      err instanceof YtError && err.kind === 'network',
      String(err && err.kind),
    );
  }

  {
    const fetch = recordFetch(() => ({
      ok: false,
      status: 500,
      json: async () => ({}),
      text: async () => '',
    }));
    let err = null;
    try {
      await resolveChannelId('https://www.youtube.com/watch?v=Od6M0AXpcxQ', { fetch });
    } catch (e) {
      err = e;
    }
    t.check(
      'watch URL HTTP error throws YtError kind http',
      err instanceof YtError && err.kind === 'http' && err.status === 500,
      String(err && err.kind),
    );
  }

  {
    const fetch = recordFetch(() => jsonRes({
      videoDetails: {
        videoId: 'Od6M0AXpcxQ',
        title: 'No channel',
        lengthSeconds: '10',
      },
    }));
    const id = await resolveChannelId('https://www.youtube.com/watch?v=Od6M0AXpcxQ', { fetch });
    t.check('watch URL with no channel id returns null', id === null, String(id));
  }

  {
    const fetch = recordFetch((url, opts) => {
      t.check('browse endpoint', url === 'https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', url);
      t.check('browse has no key=', !url.includes('key='));
      const body = JSON.parse(opts.body);
      t.check('browseId', body.browseId === 'UCX6OQ3DkcsbYNE6H8uQQuVA', body.browseId);
      t.check('Videos-tab params', body.params === 'EgZ2aWRlb3PyBgQKAjoA', body.params);
      return jsonRes(browseJson);
    });
    const h = await fetchChannelHeader('UCX6OQ3DkcsbYNE6H8uQQuVA', { fetch });
    t.check('fetchChannelHeader title', h.title === 'MrBeast');
  }

  {
    const fetch = recordFetch(() => {
      throw new Error('offline');
    });
    let err = null;
    try {
      await fetchChannelFeed(mkbhdId, { fetch });
    } catch (e) {
      err = e;
    }
    t.check('network failure throws YtError kind network', err instanceof YtError && err.kind === 'network', String(err?.kind));
  }

  {
    const fetch = recordFetch((url) => {
      if (url.includes('/shorts/')) {
        return headRes({ status: 200, redirected: false, url });
      }
      throw new Error(`unexpected ${url}`);
    });
    t.check('isShort 200 not redirected is true', (await isShort('5mU6SRS2Bxo', { fetch })) === true);
    t.check('isShort used HEAD', fetch.calls[0].opts.method === 'HEAD');
    t.check("isShort omits credentials", fetch.calls[0].opts.credentials === 'omit', String(fetch.calls[0].opts.credentials));
  }

  {
    const fetch = recordFetch((url) =>
      headRes({ status: 200, redirected: true, url: 'https://www.youtube.com/watch?v=gTKS8SAwUzE' }),
    );
    t.check('isShort redirected to /watch is false', (await isShort('gTKS8SAwUzE', { fetch })) === false);
  }

  /* ---- pushback ------------------------------------------------------ */
  t.section('pushback');

  async function thrown(fn) {
    try {
      await fn();
      return null;
    } catch (err) {
      return err;
    }
  }
  const SORRY = 'https://www.google.com/sorry/index?continue=https://www.youtube.com/';
  const blocked = recordFetch(() => headRes({ status: 429, url: '' }));
  const sorry = recordFetch(() => headRes({ status: 200, redirected: true, url: SORRY }));

  const feed429 = await thrown(() => fetchChannelFeed(mkbhdId, { fetch: blocked }));
  t.check('a 429 feed is pushback', isPushback(feed429), String(feed429?.message));
  t.check('a 429 feed keeps its status', feed429?.status === 429);
  t.check('a sorry-page feed is pushback', isPushback(await thrown(() => fetchChannelFeed(mkbhdId, { fetch: sorry }))));
  t.check('a 429 player is pushback', isPushback(await thrown(() => classifyVideo('Od6M0AXpcxQ', { fetch: blocked }))));
  t.check('a sorry-page resolve is pushback', isPushback(await thrown(() => resolveChannelId('@mkbhd', { fetch: sorry }))));
  const shortSorry = await thrown(() => isShort('gTKS8SAwUzE', { fetch: sorry }));
  t.check('a sorry redirect on /shorts/ is pushback, not "normal video"', isPushback(shortSorry), String(shortSorry));

  const five00 = await thrown(() => fetchChannelFeed(mkbhdId, { fetch: recordFetch(() => headRes({ status: 500 })) }));
  t.check('a 500 is not pushback', five00 instanceof YtError && !isPushback(five00));
  const lookalike = recordFetch(() => headRes({ status: 200, redirected: true, url: 'https://notgoogle.com/sorry/' }));
  const lookalikeErr = await thrown(() => isShort('gTKS8SAwUzE', { fetch: lookalike }));
  t.check('a /sorry path on another host is not pushback', !isPushback(lookalikeErr), String(lookalikeErr));
  t.check('a plain Error is not pushback', !isPushback(new Error('429')));
}
