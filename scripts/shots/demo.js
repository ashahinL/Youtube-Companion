/**
 * Demo snapshot for `npm run shots`. Channel ids, titles, handles and video
 * ids come from test/fixtures, so every thumbnail is a real one; timestamps are relative to now so
 * relative times stay readable whenever the shots are taken.
 */

(function (root) {
  'use strict';

  var H = 3600 * 1000;
  var D = 24 * H;
  var now = Date.now();

  function ago(ms) {
    return now - ms;
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  function dayKey(date) {
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
  }

  var today = new Date();
  var earlier = new Date(today.getTime());
  if (earlier.getDate() > 3) earlier.setDate(earlier.getDate() - 3);
  else earlier.setDate(1);
  var todayKey = dayKey(today);
  var earlierKey = dayKey(earlier);

  var MKBHD = 'UCBJycsmduvYEL83R_U4JriQ';
  var BEAST = 'UCX6OQ3DkcsbYNE6H8uQQuVA';

  // Copied from src/lib/settings.js — this file cannot import.
  var defaultSettings = {
    poll: {
      enabled: true,
      intervalMinutes: 30,
      favoriteIntervalMinutes: 10,
    },
    alerts: {
      enabled: true,
      notifyNormal: true,
      useAvatarIcon: true,
    },
    feed: {
      maxItems: 500,
      showShorts: false,
      favoritesOnly: false,
      group: '',
    },
    ui: {
      locale: 'auto',
    },
    audio: {
      openFeedInAudioMode: false,
      restoreQuality: 'hd720',
      preset: 'midnight',
      backgroundType: 'color',
      customColor: '#0f0f14',
    },
  };

  var channels = [
    {
      id: MKBHD,
      handle: '@mkbhd',
      title: 'Marques Brownlee',
      // No fixture carries this avatar; it is the one youtube.com/@mkbhd serves.
      avatar:
        'https://yt3.googleusercontent.com/qu4TmIaYUlS41-dJ9gZ7DUR3nilvmB5_11i6OKSdvNnBNiyOusZP1bMN6ICnuxtjFBb6ioKgRQ=s88-c-k-c0x00ffffff-no-rj',
      favorite: true,
      groups: ['Tech'],
      addedAt: ago(30 * D),
      lastFetchAt: ago(12 * 60 * 1000),
      lastVideoAt: ago(2 * H),
      lastError: null,
      seeded: true,
    },
    {
      id: BEAST,
      handle: '@MrBeast',
      title: 'MrBeast',
      avatar:
        'https://yt3.googleusercontent.com/nxYrc_1_2f77DoBadyxMTmv7ZpRZapHR5jbuYe7PlPd5cIRJxtNNEYyOC0ZsxaDyJJzXrnJiuDE=s120-c-k-c0x00ffffff-no-rj',
      favorite: false,
      groups: ['Fun'],
      addedAt: ago(20 * D),
      lastFetchAt: ago(12 * 60 * 1000),
      lastVideoAt: ago(1 * D),
      lastError: null,
      seeded: true,
    },
  ];

  // Two channels leave the Watchlist shot mostly empty. These have no
  // videos in the demo feed; their ids are the canonical ones and their
  // avatars are what each youtube.com/@handle page serves.
  [
    ['UCLA_DiR1FfKNvjuUpBHmylQ', '@NASA', 'NASA', 'eIf5fNPcIcj9ig-wZBeq4stFy1lgjWTW1nLT5dYlFkHZprZ03QBiMcbpwNMB6XSBjrSFGtAGQg', 5 * H, ['Science']],
    ['UCHnyfMqiRRG1u-2MsSQLbXA', '@veritasium', 'Veritasium', '7vCbvtCqtjQ3YLgsJt7Y952MQV1sBvhllSCSxHP8_sVZdcPCBrITfhkN2RdyCuwPnsByq-1GoA', 4 * D, ['Science']],
    ['UCsXVk37bltHxD1rDPwtNM8Q', '@kurzgesagt', 'Kurzgesagt – In a Nutshell', 'ytc/AIdro_n1Ribd7LwdP_qKtqWL3ZDfIgv9M1d6g78VwpHGXVR2Ir4', 9 * D, ['Science', 'Fun']],
    ['UCXuqSBlHAE6Xw-yeJA0Tunw', '@LinusTechTips', 'Linus Tech Tips', 'gnvYLhXy8FAlPXZ2RTrkrgj-5kyt0vdE2FUGVOiKGdEZIa-wN5A-7nwZBlWJLzUMmoh1NWAU', 14 * H, ['Tech']],
  ].forEach(function (c, i) {
    channels.push({
      id: c[0],
      handle: c[1],
      title: c[2],
      avatar: 'https://yt3.googleusercontent.com/' + c[3] + '=s88-c-k-c0x00ffffff-no-rj',
      favorite: i === 0,
      groups: c[5],
      addedAt: ago((10 - i) * D),
      lastFetchAt: ago(12 * 60 * 1000),
      lastVideoAt: ago(c[4]),
      lastError: null,
      seeded: true,
    });
  });

  function item(v, c, t, at, d, vw, k, extra) {
    var row = { v: v, c: c, t: t, at: at, d: d, vw: vw, k: k || 'video', st: 0 };
    if (extra) {
      var key;
      for (key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) row[key] = extra[key];
      }
    }
    return row;
  }

  // The only live fixture is a news channel's stream. Store images are
  // public-facing, so the demo feed leaves it out rather than show a
  // political thumbnail on the listing.
  var feed = [
    item('Od6M0AXpcxQ', MKBHD, 'iPhone 18 Pro/Duo Impressions: Mogged', ago(2 * H), 1034, 15803019),
    item('R6yNUnRXZ64', MKBHD, 'iPhone Duo is here', ago(3 * H), 22, 3208685, 'short'),
    item('uJdjKOBikTE', MKBHD, 'This iPhone Duo Animation \uD83D\uDC40', ago(6 * H), 18, 4590531, 'short'),
    item('ANmTVYkEtLw', MKBHD, 'Google Pixel 11/Pro Review: Poker Face', ago(9 * H), 842, 4369681),
    item('gTKS8SAwUzE', BEAST, 'I Survived The Most Extreme Places On Earth', ago(1 * D), 1520, 79286884),
    item('fo-uubnajWM', MKBHD, 'I Made a Bet with Tesla', ago(2 * D), 1240, 4818300),
    item('5mU6SRS2Bxo', BEAST, 'World’s Largest Tennis Match', ago(2 * D + 4 * H), 28, 11874962, 'short'),
    item('Qtl8lJwbd4g', BEAST, 'Escape 100 Cops, Win $500,000', ago(3 * D), 1840, 100043276),
    item('v-_d2e7x4KA', MKBHD, 'The Wildest Camera Robot', ago(3 * D + 6 * H), 45, 5027434, 'short'),
    item('LiH-P4rSkLI', BEAST, 'Can You Pass This Classroom Quiz?', ago(4 * D), 31, 48554980, 'short'),
    item('ngPkbaZliaU', MKBHD, 'The Truth About the Bezelless Concept Phone', ago(5 * D), 618, 5356398),
    item('Af6i6ChAVTw', BEAST, 'Last To Leave Mansion, Keeps It', ago(6 * D), 2104, 111435764),
    item('mfmdXPT7nAM', MKBHD, 'I Said Yes to Every Email for a Month! (Again)', ago(7 * D), 1855, 4833264),
    item('NMR32p4kwAQ', BEAST, 'Mr Rizz IRL', ago(8 * D), 16, 69400707, 'short'),
    item('o4SSoURPODY', MKBHD, 'Google Pixel 11/Pro/Fold Impressions: It Is What It Is', ago(10 * D), 1102, 3635548),
    item('f7y2XikE7sY', BEAST, 'Paying For Food With My Car', ago(11 * D), 19, 72815224, 'short'),
    item('Z6z_feacXW8', MKBHD, 'Galaxy Z Fold 8 Review: Honeymoon\'s Over', ago(12 * D), 1344, 5178379),
    item('lVylRtlPOIE', BEAST, 'I Granted 100 Kids Their Biggest Wish!', ago(13 * D), 1633, 61891829),
    item('_xjxwl1zLMc', MKBHD, 'Framework 13 Pro: The Modular Laptop is Real!', ago(14 * D), 956, 3670083),
    item('Df5Y-2ndQyU', BEAST, 'Read My Book, You Could Win $1,000,000', ago(15 * D), 24, 25295205, 'short'),
    item('8Hx2yvWSgs0', MKBHD, 'Samsung Z Fold 8 (Wide) Impressions: Better Than I Thought!', ago(16 * D), 721, 4809957),
    item('egvLKQe6I4I', BEAST, 'Don\'t Pop the Balloon', ago(17 * D), 21, 159907521, 'short'),
    item('kUnR9dO4EnA', MKBHD, 'This ZOOM is Insane!', ago(18 * D), 27, 4584828, 'short'),
    item('_oRgdlJUD18', MKBHD, 'iOS 27 Hands-On: Top 5 New Features!', ago(20 * D), 548, 6731211),
    item('LgbyEFILLJI', BEAST, '$1 vs $10,000 Cake', ago(21 * D), 33, 148505151, 'short'),
    item('eWKY0OnPByg', MKBHD, 'Apple Lost the AI Race', ago(22 * D), 892, 2251142),
    item('iYlODtkyw_I', BEAST, 'Survive 30 Days Chained To A Stranger, Win $250,000', ago(24 * D), 1922, 94503875),
    item('YA_kX8hu1gg', BEAST, 'This Plane Takes Off in 12 Seconds', ago(25 * D), 18, 42111703, 'short'),
    item('XCGVurja73c', BEAST, 'I Raced The Fastest Man On Earth', ago(26 * D), 22, 147164352, 'short'),
    item('r9aWeGqp43s', BEAST, 'We Made Make-A-Wish Kids’ Dreams Come True', ago(28 * D), 29, 20188042, 'short'),
  ];

  var listened = {};
  var active = {};
  listened[todayKey] = 18000;
  listened[earlierKey] = (listened[earlierKey] || 0) + 21378;
  active[todayKey] = 21000;
  active[earlierKey] = (active[earlierKey] || 0) + 25926;

  root.SHOTS_DEMO = {
    defaultSettings: defaultSettings,
    channels: channels,
    feed: feed,
    pollState: {
      running: false,
      lastPollAt: ago(12 * 60 * 1000),
      lastFavPollAt: ago(5 * 60 * 1000),
      // Hours ago, not now: isNewSince is a strict `at > lastSeenAt`, and the
      // popup holds that value for the whole open.
      lastSeenAt: ago(12 * H),
      notified: [],
    },
    audioStats: {
      listened: listened,
      active: active,
      totals: { listened: 72000, active: 86400 },
    },
    player: {
      ok: true,
      on: true,
      paused: false,
      currentTime: 345,
      duration: 1034,
      playbackRate: 1.25,
      volume: 75,
      muted: false,
      title: 'iPhone 18 Pro/Duo Impressions: Mogged',
      channel: 'Marques Brownlee',
      videoId: 'Od6M0AXpcxQ',
    },
    tabs: [
      {
        id: 101,
        url: 'https://www.youtube.com/watch?v=Od6M0AXpcxQ',
        title: 'iPhone 18 Pro/Duo Impressions: Mogged - YouTube',
        active: true,
        audible: true,
        status: 'complete',
        windowId: 1,
        index: 0,
        lastAccessed: now,
      },
      {
        id: 102,
        url: 'https://www.youtube.com/watch?v=gTKS8SAwUzE',
        title: 'I Survived The Most Extreme Places On Earth - YouTube',
        active: false,
        audible: false,
        status: 'complete',
        windowId: 1,
        index: 1,
        lastAccessed: now - 60 * 1000,
      },
    ],
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
