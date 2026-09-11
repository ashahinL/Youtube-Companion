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
  thumbUrl,
  parseDuration,
  parseCompactCount,
  parseFeedXml,
  parseResolveUrl,
  parseChannelSearch,
  parseChannelHeader,
  parseChannelVideos,
  parsePlayer,
  resolveChannelId,
  searchChannels,
  fetchChannelFeed,
  fetchChannelHeader,
  fetchChannelVideos,
  isShort,
  classifyVideo,
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
  const searchJson = readJson('search.channels.json');
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

  t.check('watch URL is rejected', asId('https://www.youtube.com/watch?v=Od6M0AXpcxQ') === null);
  t.check(
    'playlist URL is rejected',
    asId('https://www.youtube.com/playlist?list=PLxxxxxxxxxxxxxxxxxxxxxx') === null,
  );
  t.check('non-YouTube URL is rejected', asId('https://example.com/@mkbhd') === null);
  t.check('empty string is rejected', asId('') === null);
  t.check('whitespace-only is rejected', asId('   ') === null);

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

  /* ---- parseChannelSearch ------------------------------------------- */
  t.section('parseChannelSearch');

  const searchHits = parseChannelSearch(searchJson);
  const searchIds = searchHits.map((c) => c.id);
  t.check('search returns 20 channels', searchHits.length === 20, String(searchHits.length));
  t.check(
    'search ids are unique (payload repeats each browseId ~3x)',
    new Set(searchIds).size === searchIds.length,
    String(searchIds.length - new Set(searchIds).size),
  );

  const mkbhdHits = searchHits.filter((c) => c.id === mkbhdId);
  t.check('MKBHD appears exactly once', mkbhdHits.length === 1, String(mkbhdHits.length));
  const mkbhdHit = mkbhdHits[0];
  t.check('MKBHD handle is @mkbhd', mkbhdHit.handle === '@mkbhd', mkbhdHit.handle);
  t.check('MKBHD title', mkbhdHit.title === 'Marques Brownlee', mkbhdHit.title);
  t.check('MKBHD subscribers is 21.2M', mkbhdHit.subscribers === 21200000, String(mkbhdHit.subscribers));
  t.check(
    'MKBHD avatar is the s176 yt3 thumbnail',
    mkbhdHit.avatar ===
      'https://yt3.ggpht.com/qu4TmIaYUlS41-dJ9gZ7DUR3nilvmB5_11i6OKSdvNnBNiyOusZP1bMN6ICnuxtjFBb6ioKgRQ=s176-c-k-c0x00ffffff-no-rj-mo',
    mkbhdHit.avatar,
  );

  t.check('first result is MKBHD (document order)', searchHits[0].id === mkbhdId);
  t.check(
    'second result is Auto Focus',
    searchHits[1].id === 'UC2J-0g_nxlwcD9JBK1eTleQ' && searchHits[1].handle === '@AutoFocus',
    JSON.stringify({ id: searchHits[1]?.id, handle: searchHits[1]?.handle }),
  );
  t.check('results with no id are dropped', searchHits.every((c) => CHANNEL_OK(c.id)));

  function CHANNEL_OK(id) {
    return typeof id === 'string' && /^UC[\w-]{22}$/.test(id);
  }

  /* ---- parseChannelHeader / parseChannelVideos ---------------------- */
  t.section('parseChannelHeader / parseChannelVideos');

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

  const videos = parseChannelVideos(browseJson);
  t.check('videos tab has 30 items', videos.items.length === 30, String(videos.items.length));

  const v0 = videos.items[0];
  t.check('first video contentId', v0.v === 'gTKS8SAwUzE', v0.v);
  t.check(
    'first video title',
    v0.title === 'I Survived The Most Extreme Places On Earth',
    v0.title,
  );
  t.check('first video duration 23:28 is 1408s', v0.d === 1408, String(v0.d));
  t.check('first video viewsText', v0.viewsText === '79M views', v0.viewsText);
  t.check('first video views', v0.views === 79000000, String(v0.views));
  t.check('first video ageText is the raw relative string', v0.ageText === '6 days ago', v0.ageText);
  t.check('first video is not live', v0.live === false);

  const shortish = videos.items.find((it) => it.v === 'F0OkwXKcPSE');
  t.check('3:14 badge parses to 194s', shortish?.d === 194, String(shortish?.d));

  const expectedToken =
    browseJson.contents.twoColumnBrowseResultsRenderer.tabs[1].tabRenderer.content
      .richGridRenderer.contents[30].continuationItemRenderer.continuationEndpoint
      .continuationCommand.token;
  t.check(
    'continuation is the grid load-more token, not a chip/description token',
    videos.continuation === expectedToken,
    String(videos.continuation).slice(0, 40),
  );

  const lockupIds = videos.items.map((it) => it.v);
  t.check(
    'second video is Qtl8lJwbd4g',
    lockupIds[1] === 'Qtl8lJwbd4g',
    lockupIds[1],
  );
  t.check(
    'no lockup used a missing contentId',
    lockupIds.every((id) => typeof id === 'string' && id.length > 0),
  );

  const continuationShape = {
    onResponseReceivedActions: [
      {
        appendContinuationItemsAction: {
          continuationItems: [
            {
              richItemRenderer: {
                content: {
                  lockupViewModel: {
                    contentId: 'AAAAAAAAAAA',
                    contentType: 'LOCKUP_CONTENT_TYPE_VIDEO',
                    metadata: {
                      lockupMetadataViewModel: {
                        title: { content: 'More' },
                        metadata: {
                          contentMetadataViewModel: {
                            metadataRows: [
                              {
                                metadataParts: [
                                  { text: { content: '1K views' } },
                                  { text: { content: '1 day ago' } },
                                ],
                              },
                            ],
                          },
                        },
                      },
                    },
                    contentImage: {
                      thumbnailViewModel: {
                        overlays: [
                          {
                            thumbnailBottomOverlayViewModel: {
                              badges: [{ thumbnailBadgeViewModel: { text: '1:00' } }],
                            },
                          },
                        ],
                      },
                    },
                  },
                },
              },
            },
            {
              continuationItemRenderer: {
                trigger: 'CONTINUATION_TRIGGER_ON_ITEM_SHOWN',
                continuationEndpoint: { continuationCommand: { token: 'NEXT_TOKEN' } },
              },
            },
          ],
        },
      },
    ],
  };
  const more = parseChannelVideos(continuationShape);
  t.check('continuation response yields the extra item', more.items[0]?.v === 'AAAAAAAAAAA' && more.items[0]?.d === 60);
  t.check('continuation response carries the next token', more.continuation === 'NEXT_TOKEN', String(more.continuation));

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
      t.check('search endpoint', url === 'https://www.youtube.com/youtubei/v1/search?prettyPrint=false', url);
      t.check('search has no key=', !url.includes('key='));
      const body = JSON.parse(opts.body);
      t.check('search channels-only params', body.params === 'EgIQAg%3D%3D', body.params);
      t.check('search query', body.query === 'marques brownlee', body.query);
      return jsonRes(searchJson);
    });
    const hits = await searchChannels('marques brownlee', { fetch });
    t.check('searchChannels returns parsed rows', hits[0].handle === '@mkbhd');
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
    const v = await fetchChannelVideos('UCX6OQ3DkcsbYNE6H8uQQuVA', { fetch });
    t.check('fetchChannelVideos first id', v.items[0].v === 'gTKS8SAwUzE');
  }

  {
    const fetch = recordFetch((_url, opts) => {
      const body = JSON.parse(opts.body);
      t.check('continuation body has the token', body.continuation === 'NEXT_TOKEN', JSON.stringify(body));
      t.check('continuation body has no browseId', body.browseId === undefined);
      t.check('continuation body has no params', body.params === undefined);
      return jsonRes({ onResponseReceivedActions: [] });
    });
    const got = await fetchChannelVideos('UCX6OQ3DkcsbYNE6H8uQQuVA', { fetch, continuation: 'NEXT_TOKEN' });
    t.check('empty continuation parse yields no items', got.items.length === 0 && got.continuation === null);
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
      await searchChannels('x', { fetch });
    } catch (e) {
      err = e;
    }
    t.check('500 throws YtError', err instanceof YtError, String(err));
    t.check("500 kind is 'http'", err?.kind === 'http', String(err?.kind));
    t.check('500 status is 500', err?.status === 500, String(err?.status));
    t.check('500 message names the endpoint', /search/.test(err?.message) && /500/.test(err?.message), err?.message);
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
}
