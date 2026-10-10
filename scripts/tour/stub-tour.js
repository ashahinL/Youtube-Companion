/**
 * Tour-only fakes for the popup in site/tour/. Loaded after
 * scripts/shots/stub.js and before the popup's own scripts, only by the
 * tour's popup.html. It reshapes the demo for one step from the address,
 * answers the messages the tour's scenes drive (add, follow, import, Up
 * next, the player, export), and tells the tour page what changed so its
 * mock YouTube page can follow.
 *
 * Address parameters, all optional:
 *   page=watch|subs|none  the focused YouTube tab (watch needs v=<id>)
 *   t=<seconds>           where the video is; paused=1 holds it there
 *   audio=1               audio mode is on in that tab
 *   drop=@a,@b            channels (and their videos) not on the list yet
 *   queue=<id>,<id>|none  Up next, from the demo's video ids
 *   seen=<hours>          the last popup open, for the New tags
 *   live=1                a live stream and a premiere at the top of Feeds
 */

(function (root) {
  'use strict';

  var demo = root.SHOTS_DEMO;
  var chrome = root.chrome;
  if (!demo || !chrome) return;

  var params = new URLSearchParams(root.location.search);
  var H = 3600 * 1000;
  var now = Date.now();
  var BEAST = 'UCX6OQ3DkcsbYNE6H8uQQuVA';
  var NASA = 'UCLA_DiR1FfKNvjuUpBHmylQ';

  function clone(value) {
    return value === undefined ? undefined : structuredClone(value);
  }

  function list(name) {
    var raw = params.get(name);
    return raw ? raw.split(',').map(function (s) { return s.trim(); }).filter(Boolean) : [];
  }

  // The theme mirror lives in this origin's localStorage, which every
  // reload of the tour's popup shares. A dark step must not leak into the
  // next light one before settings arrive.
  try {
    var theme = params.get('theme');
    if (theme === 'light' || theme === 'dark') root.localStorage.setItem('companion.theme', theme);
    else root.localStorage.removeItem('companion.theme');
  } catch (err) {
    // the popup then follows settings once they load
  }

  // Older MrBeast uploads for See more, from the committed Videos-tab
  // fixture, so every thumbnail is a real one.
  var MORE = [
    ['__fmDj0ZJ1Q', '50 YouTube Legends Fight For $1,000,000', '2 months ago', 84000000],
    ['GpQSUjNsNm0', '7 Days Stranded in The Arctic', '3 months ago', 126000000],
    ['AaMdXZMvT3w', 'Survive 30 Days On An Island With Your Ex, Win $250,000', '3 months ago', 107000000],
    ['6Zy5VLcEbZc', 'I Stranded 100 People In The Wilderness For $250,000', '4 months ago', 168000000],
    ['zRtGL0-5rg4', 'Last To Leave Grocery Store, Wins $250,000', '4 months ago', 192000000],
  ];

  // The demo feed leaves live out on purpose (see demo.js), so these two
  // are made up for the tour, with drawn thumbnails in site/tour/img/.
  var LIVE_ROWS = [
    { v: 'tourLiveISS', c: NASA, t: 'Live: Earth from the International Space Station', at: now - 20 * 60 * 1000, d: 0, vw: 0, k: 'live', st: now - 20 * 60 * 1000 },
    { v: 'tourPremier', c: NASA, t: 'Launch Coverage: Crew Mission to the Space Station', at: now - 10 * 60 * 1000, d: 0, vw: 0, k: 'premiere', st: now + 3 * H },
  ];
  var DRAWN = { tourLiveISS: 'live-iss.svg', tourPremier: 'premiere.svg' };

  var allChannels = clone(demo.channels);
  var allFeed = clone(demo.feed).concat(clone(LIVE_ROWS));

  function channelById(id) {
    return allChannels.find(function (ch) { return ch.id === id; }) || null;
  }

  function videoById(v) {
    var row = allFeed.find(function (item) { return item.v === v; });
    if (row) return { v: row.v, c: row.c, t: row.t, d: row.d || 0 };
    var more = MORE.find(function (m) { return m[0] === v; });
    return more ? { v: more[0], c: BEAST, t: more[1], d: 1200 } : null;
  }

  function queued(v) {
    var video = videoById(v);
    if (!video) return null;
    var ch = channelById(video.c);
    return { v: video.v, c: video.c, ct: ch ? ch.title : '', t: video.t, at: 0, d: video.d, qa: now };
  }

  /* ---- the demo for this step ---------------------------------------- */

  var dropped = list('drop').map(function (h) { return h.toLowerCase(); });
  function isDropped(ch) {
    return dropped.indexOf(String(ch.handle || '').toLowerCase()) >= 0;
  }
  var droppedIds = allChannels.filter(isDropped).map(function (ch) { return ch.id; });
  demo.channels = allChannels.filter(function (ch) { return !isDropped(ch); });
  demo.feed = (params.get('live') === '1' ? allFeed : clone(demo.feed))
    .filter(function (item) { return droppedIds.indexOf(item.c) < 0; });
  if (params.get('live') !== '1') allFeed = allFeed.filter(function (item) { return item.k !== 'live' && item.k !== 'premiere'; });

  var queueIds = list('queue');
  if (params.get('queue') === 'none') demo.queue = [];
  else if (queueIds.length) demo.queue = queueIds.map(queued).filter(Boolean);
  demo.queueOpen = true;

  if (params.has('seen')) demo.pollState.lastSeenAt = now - Number(params.get('seen')) * H;

  var page = params.get('page') || 'none';
  var pageVideo = videoById(params.get('v') || '');
  var tab = { id: 101, active: true, audible: false, status: 'complete', windowId: 1, index: 0, lastAccessed: now };
  if (page === 'watch' && pageVideo) {
    tab.url = 'https://www.youtube.com/watch?v=' + pageVideo.v;
    tab.title = pageVideo.t + ' - YouTube';
  } else if (page === 'subs') {
    tab.url = 'https://www.youtube.com/feed/subscriptions';
    tab.title = 'Subscriptions - YouTube';
  } else {
    tab = null;
  }
  demo.tabs = tab ? [tab] : [];

  /* ---- the player in that tab ---------------------------------------- */

  var player = null;
  var since = Date.now();
  if (tab && pageVideo) {
    var owner = channelById(pageVideo.c);
    player = {
      ok: true,
      on: params.get('audio') === '1',
      paused: params.get('paused') === '1',
      currentTime: Number(params.get('t')) || 0,
      duration: pageVideo.d,
      playbackRate: 1,
      volume: 100,
      muted: false,
      title: pageVideo.t,
      channel: owner ? owner.title : '',
      videoId: pageVideo.v,
      sleepAt: 0,
    };
    tab.audible = !player.paused;
  }

  // Wall-clock time inside the popup: it polls the player every second
  // and must see it move while it plays.
  function position() {
    if (!player) return 0;
    if (player.paused) return player.currentTime;
    var t = player.currentTime + ((Date.now() - since) / 1000) * player.playbackRate;
    return Math.min(player.duration || t, t);
  }

  function hold() {
    if (!player) return;
    player.currentTime = position();
    since = Date.now();
  }

  function playerNow() {
    if (!player) return { ok: false, on: false };
    var out = clone(player);
    out.currentTime = position();
    return out;
  }

  /* ---- telling the tour page ----------------------------------------- */

  function tell(type, detail) {
    try {
      var host = root.parent;
      if (!host || host === root) return;
      var data = Object.assign({ type: type, frame: root.name }, clone(detail || {}));
      host.dispatchEvent(new host.CustomEvent('tour:popup', { detail: data }));
    } catch (err) {
      // the popup works without a tour page around it
    }
  }

  function tellQueue() {
    tell('queue', { queue: demo.queue });
  }

  function tellPlayer() {
    tell('player', { player: playerNow() });
  }

  /* ---- worker messages ----------------------------------------------- */

  function snapshotState() {
    return chrome.runtime.sendMessage({ type: 'getState' });
  }

  function findChannel(input) {
    var text = String(input || '').trim();
    var watch = text.match(/[?&]v=([\w-]{11})/);
    if (watch) {
      var video = videoById(watch[1]);
      return video ? channelById(video.c) : null;
    }
    var handle = text.replace(/^https?:\/\/(www\.)?youtube\.com\//, '').replace(/^@?/, '@').toLowerCase();
    return allChannels.find(function (ch) { return String(ch.handle).toLowerCase() === handle; }) || null;
  }

  function addChannel(input) {
    var ch = findChannel(input);
    if (!ch) return Promise.resolve({ ok: false, error: 'not found' });
    if (demo.channels.some(function (c) { return c.id === ch.id; })) {
      return Promise.resolve({ ok: false, error: 'already added' });
    }
    var added = Object.assign(clone(ch), { addedAt: Date.now(), groups: [] });
    demo.channels.push(added);
    demo.feed = demo.feed.concat(allFeed.filter(function (item) { return item.c === ch.id; }))
      .sort(function (a, b) { return b.at - a.at; });
    tell('channels', { channel: added });
    return snapshotState().then(function (state) {
      return { ok: true, channel: clone(added), state: state };
    });
  }

  function queueReply() {
    return Promise.resolve({ ok: true, queue: clone(demo.queue) });
  }

  function onQueue(message) {
    var q = demo.queue;
    var at = q.findIndex(function (row) { return row.v === message.v; });
    if (message.type === 'queue.add') {
      var item = message.item || {};
      if (item.v && !q.some(function (row) { return row.v === item.v; })) q.push(clone(item));
    } else if (message.type === 'queue.remove') {
      if (at >= 0) q.splice(at, 1);
    } else if (message.type === 'queue.move') {
      if (at >= 0) {
        var row = q.splice(at, 1)[0];
        q.splice(Math.max(0, Math.min(Number(message.to) || 0, q.length)), 0, row);
      }
    } else if (message.type === 'queue.clear') {
      q.length = 0;
    }
    tellQueue();
    return queueReply();
  }

  var runtimeSend = chrome.runtime.sendMessage;
  chrome.runtime.sendMessage = function (message) {
    var type = message && message.type;
    if (type === 'addChannel') return addChannel(message.input);
    if (type === 'queue.add' || type === 'queue.remove' || type === 'queue.move' || type === 'queue.clear') {
      return onQueue(message);
    }
    if (type === 'queue.player' || type === 'queue.setOpen') return Promise.resolve({ ok: true });
    if (type === 'channel.more') {
      var rows = message.id === BEAST
        ? MORE.map(function (m) { return { v: m[0], title: m[1], ago: m[2], views: m[3] }; })
        : [];
      return Promise.resolve({ ok: true, rows: rows, token: '' });
    }
    if (type === 'importFromYouTube') {
      tell('import');
      return Promise.resolve({ ok: true });
    }
    if (type === 'updateSettings') {
      return runtimeSend.call(chrome.runtime, message).then(function (snap) {
        tell('settings', { settings: snap && snap.settings });
        return snap;
      });
    }
    return runtimeSend.call(chrome.runtime, message);
  };

  /* ---- the YouTube tab ----------------------------------------------- */

  function control(message) {
    if (!player) return { ok: false };
    hold();
    var action = message.action;
    if (action === 'play') player.paused = false;
    else if (action === 'pause') player.paused = true;
    else if (action === 'seek') player.currentTime = Math.max(0, Math.min(player.duration, Number(message.time) || 0));
    else if (action === 'speed') player.playbackRate = Number(message.rate) || 1;
    else if (action === 'volume') player.volume = Number(message.volume) || 0;
    else if (action === 'sleep') {
      var minutes = Number(message.minutes) || 0;
      player.sleepAt = minutes ? Date.now() + minutes * 60 * 1000 : 0;
    }
    tellPlayer();
    return { ok: true };
  }

  chrome.tabs.sendMessage = function (tabId, message) {
    var type = message && message.type;
    if (!tab || tabId !== tab.id) return Promise.resolve(null);
    if (type === 'audioMode.player') return Promise.resolve(playerNow());
    if (type === 'audioMode.toggle') {
      if (!player) return Promise.resolve({ ok: false, on: false });
      player.on = !player.on;
      tellPlayer();
      return Promise.resolve({ ok: true, on: player.on });
    }
    if (type === 'audioMode.state') return Promise.resolve({ ok: true, on: !!(player && player.on) });
    if (type === 'audioMode.control') return Promise.resolve(control(message));
    return Promise.resolve({ ok: true });
  };

  // The rating card asks for a review once audio mode has saved 1 GB; the
  // demo stats are past that, and the tour is about the stats themselves.
  var localGet = chrome.storage.local.get;
  chrome.storage.local.get = function (keys) {
    return localGet.call(chrome.storage.local, keys).then(function (got) {
      var wants = keys == null
        || keys === 'rateNoteDone'
        || (Array.isArray(keys) && keys.indexOf('rateNoteDone') >= 0)
        || (typeof keys === 'object' && !Array.isArray(keys) && 'rateNoteDone' in keys);
      if (wants) got.rateNoteDone = true;
      return got;
    });
  };

  /* ---- what would leave the popup ------------------------------------ */

  // Inside the tour the popup is an iframe, so close() would do nothing;
  // the tour page closes it instead.
  root.close = function () {
    tell('close');
  };

  // Export builds a blob link and clicks it. A real download from a page
  // someone is only watching would be a surprise.
  var anchorClick = root.HTMLAnchorElement.prototype.click;
  root.HTMLAnchorElement.prototype.click = function () {
    var name = this.download || this.getAttribute('download');
    if (!name) {
      anchorClick.call(this);
      return;
    }
    // The popup revokes the blob address a moment later, not in this turn.
    root.fetch(this.href)
      .then(function (res) { return res.blob(); })
      .then(function (blob) { tell('download', { name: name, size: blob.size }); })
      .catch(function () { tell('download', { name: name }); });
  };

  // The made-up live rows have no YouTube thumbnail.
  function swapDrawn(img) {
    var m = String(img.getAttribute('src') || '').match(/\/vi\/([\w-]{11})\//);
    if (m && DRAWN[m[1]]) img.src = new URL('../../../img/' + DRAWN[m[1]], root.document.baseURI).href;
  }
  new root.MutationObserver(function (records) {
    records.forEach(function (rec) {
      if (rec.type === 'attributes' && rec.target.tagName === 'IMG') swapDrawn(rec.target);
      (rec.addedNodes || []).forEach(function (node) {
        if (node.nodeType !== 1) return;
        if (node.tagName === 'IMG') swapDrawn(node);
        node.querySelectorAll('img').forEach(swapDrawn);
      });
    });
  }).observe(root.document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src'] });

  /* ---- what the tour's scenes call ----------------------------------- */

  root.__tourStub = {
    // The video ends: the next Up next entry starts in the same tab and
    // leaves the list, the way the queue plays through.
    advance: function () {
      if (!player || !demo.queue.length) return false;
      var next = demo.queue.shift();
      var owner = channelById(next.c);
      player = Object.assign(player, {
        paused: false,
        currentTime: 0,
        duration: next.d || 900,
        title: next.t,
        channel: owner ? owner.title : next.ct,
        videoId: next.v,
      });
      since = Date.now();
      tab.url = 'https://www.youtube.com/watch?v=' + next.v;
      tab.title = next.t + ' - YouTube';
      tellPlayer();
      tellQueue();
      return true;
    },
    player: playerNow,
    queue: function () { return clone(demo.queue); },
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
