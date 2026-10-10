/**
 * The tour's script: seven chapters, their steps, the caption under the
 * stage for each step, and what each step does on the stage. The captions
 * are the final text agreed for the tour; change them only together with
 * the plan they came from.
 *
 * A step is { title, caption, ms, setup(stage), run(stage) }. setup puts the
 * stage in a known state without animating, so any step can be opened on
 * its own; run animates it. Every pause goes through stage.wait, the
 * cursor or a stage tween, which all run on the tour's one clock.
 */

const PHONE = 'Od6M0AXpcxQ'; // Marques Brownlee, the page most steps sit on
const EXTREME = 'gTKS8SAwUzE'; // MrBeast, followed from its own page
const COPS = 'Qtl8lJwbd4g'; // MrBeast, playing while the alert comes in
const TESLA = 'fo-uubnajWM'; // the row added to Up next from Feeds
const UP_NEXT = '_oRgdlJUD18,iYlODtkyw_I,eWKY0OnPByg';

// Chapter 1 starts before Veritasium and MrBeast are on the list.
const NOT_YET = '@veritasium,@MrBeast';

function phonePage(stage, extra = {}) {
  stage.page.watch({ v: PHONE, ...extra });
}

async function clickTab(stage, id) {
  await stage.cursor.click(await stage.popup.find(`#${id}`));
  await stage.popup.find(`#${id}[aria-selected="true"]`);
}

async function openFromToolbar(stage) {
  await stage.cursor.click(stage.toolbarIcon);
  stage.badge('');
  await stage.popup.open();
  await stage.camera.focus('popup');
}

// Chapter 5 keeps the popup and YouTube's queue panel in one frame.
function bothQueues(stage) {
  return stage.camera.focus([stage.page.$('.yt-queue'), 'popup']);
}

export const CHAPTERS = [
  {
    title: 'Follow channels, no account',
    blurb: 'Add channels by link or handle, follow the page you are on, or bring your YouTube subscriptions.',
    image: { src: '../images/home-watchlist.png', alt: 'The Watchlist tab, with channels added by link.' },
    steps: [
      {
        title: 'Your subscriptions, without an account',
        caption: 'Companion for YouTube keeps your own list of channels. No sign-in and no API key: it reads public YouTube pages only.',
        ms: 8500,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, paused: 1, drop: NOT_YET, seen: 12 }, { open: false });
          phonePage(stage);
          stage.badge('2');
          await stage.camera.focus('page');
          stage.cursor.place(640, 330);
        },
        async run(stage) {
          await stage.wait(700);
          await openFromToolbar(stage);
          await stage.wait(1200);
          await stage.cursor.moveTo(await stage.popup.find('#feed-list .feed-row'), { at: [0.35, 0.5] });
          await stage.wait(1200);
        },
      },
      {
        title: 'Add a channel',
        caption: 'Paste a channel link, an @handle or a video link, and the channel is on your list.',
        ms: 9000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, paused: 1, drop: NOT_YET, seen: 12, scene: 'feeds' });
          phonePage(stage);
          await stage.camera.focus('popup');
        },
        async run(stage) {
          await clickTab(stage, 'tab-watchlist');
          const box = await stage.popup.find('#watchlist-input');
          await stage.cursor.click(box, { at: [0.3, 0.5] });
          await stage.type(box, '@veritasium');
          await stage.wait(300);
          await stage.cursor.click(await stage.popup.find('#watchlist-add-btn'));
          const row = await stage.popup.find('#watchlist-list .channel-row', (el) => el.textContent.includes('Veritasium'));
          await stage.popup.reveal(row);
          await stage.spot(row);
          await stage.wait(1800);
          await stage.spotOff();
        },
      },
      {
        title: 'Follow from the page you’re on',
        caption: 'On a channel or video page, the Player tab offers to follow it.',
        ms: 7500,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: EXTREME, t: 312, drop: '@MrBeast', seen: 12 }, { open: false });
          stage.page.watch({ v: EXTREME, t: 312, paused: false });
          await stage.camera.focus('page');
        },
        async run(stage) {
          await stage.wait(500);
          await openFromToolbar(stage);
          await stage.wait(500);
          const card = await stage.popup.find('#follow-card:not([hidden])');
          await stage.spot(card);
          await stage.wait(900);
          await stage.cursor.click(card.querySelector('.follow-card__btn'));
          await stage.spotOff();
          await stage.popup.find('#audio-channel .follow-check');
          await stage.spot(await stage.popup.find('#audio-channel'));
          await stage.wait(1600);
          await stage.spotOff();
        },
      },
      {
        title: 'Bring your YouTube subscriptions',
        caption: 'Import from YouTube reads your subscription list in your own signed-in tab. Nothing leaves your device.',
        ms: 10500,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: EXTREME, t: 320, seen: 12, scene: 'settings' });
          stage.page.watch({ v: EXTREME, t: 320, paused: false });
          await stage.camera.focus('popup');
        },
        async run(stage) {
          const button = await stage.popup.find('#settings-import-youtube');
          await stage.popup.reveal(button);
          await stage.cursor.click(button);
          await stage.camera.focus('page', 700);
          stage.address('https://www.youtube.com/feed/channels', 'Channels - YouTube');
          stage.page.scan('pick', {
            accounts: [
              { name: 'Sam Rivera', count: 48, color: '#2f7d6d' },
              { name: 'Sam at work', count: 7, color: '#a3542b' },
            ],
          });
          await stage.wait(900);
          await stage.cursor.click(stage.page.$('[data-account="0"] .scan__btn'));
          stage.page.scan('scanning');
          await stage.tween(2000, (k) => stage.page.scanCount(Math.round(48 * k)));
          await stage.wait(300);
          stage.page.scan('done', { added: 42, skipped: 6 });
          await stage.cursor.moveTo(stage.page.$('.scan__done'), { at: [0.5, 0.9] });
          await stage.wait(1500);
        },
      },
    ],
  },
  {
    title: 'One feed',
    blurb: 'Every upload from every channel in one timeline, with groups, live tags and a sheet per channel.',
    image: { src: '../images/home-feeds.png', alt: 'The Feeds tab, with new videos from every channel in one list.' },
    steps: [
      {
        title: 'Every upload, newest first',
        caption: 'Feeds puts every channel in one timeline, newest first. A New tag marks what came out since you last looked.',
        ms: 9000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, paused: 1, seen: 30, scene: 'feeds' });
          phonePage(stage);
          await stage.camera.focus('popup');
        },
        async run(stage) {
          const tag = await stage.popup.find('#feed-list .feed-tag--new');
          await stage.cursor.moveTo(tag);
          await stage.spot(tag, { pad: 4 });
          await stage.wait(1500);
          await stage.spotOff();
          await stage.cursor.moveTo({ x: 1150, y: 460 });
          await stage.popup.scrollTo(1100, { ms: 2400 });
          await stage.wait(500);
          await stage.popup.scrollTo(0, { ms: 1100 });
        },
      },
      {
        title: 'Groups',
        caption: 'Put channels in groups and look at one group at a time.',
        ms: 7000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, paused: 1, seen: 30, scene: 'feeds' });
          phonePage(stage);
          await stage.camera.focus('popup');
        },
        async run(stage) {
          await stage.cursor.click(await stage.popup.find('#feed-groups [data-group="Tech"]'));
          await stage.popup.find('#feed-groups [data-group="Tech"][aria-pressed="true"]');
          await stage.wait(400);
          await stage.spot(await stage.popup.find('#feed-list'), { pad: 2 });
          await stage.wait(2200);
          await stage.spotOff();
        },
      },
      {
        title: 'Live and premieres',
        caption: 'Live streams and premieres are tagged. Shorts stay out.',
        ms: 7000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, paused: 1, seen: 30, live: 1, scene: 'feeds' });
          phonePage(stage);
          await stage.camera.focus('popup');
        },
        async run(stage) {
          const live = await stage.popup.find('#feed-list .feed-row', (el) => el.querySelector('.feed-tag--live'));
          await stage.cursor.moveTo(live.querySelector('.feed-tag--live'));
          await stage.spot(live, { pad: 3 });
          await stage.wait(1700);
          const premiere = await stage.popup.find('#feed-list .feed-row', (el) => el.querySelector('.feed-tag--premiere'));
          await stage.spotOff();
          await stage.cursor.moveTo(premiere.querySelector('.feed-tag--premiere'));
          await stage.spot(premiere, { pad: 3 });
          await stage.wait(1700);
          await stage.spotOff();
        },
      },
      {
        title: 'A channel at a glance',
        caption: 'Click a channel’s name to see its newest videos. See more loads older ones.',
        ms: 8500,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, paused: 1, seen: 30, scene: 'feeds' });
          phonePage(stage);
          await stage.camera.focus('popup');
        },
        async run(stage) {
          const name = await stage.popup.find('#feed-list .feed-row__channel', (el) => el.textContent === 'MrBeast');
          await stage.cursor.click(name);
          await stage.popup.find('#channel-sheet:not([hidden])');
          await stage.wait(1000);
          const more = await stage.popup.find('#channel-sheet-more:not([hidden])');
          await stage.popup.reveal(more);
          await stage.cursor.click(more);
          await stage.popup.find('#channel-sheet-videos', (el) => el.textContent.includes('7 Days Stranded'));
          await stage.wait(300);
          const older = await stage.popup.find('#channel-sheet-videos .feed-row', (el) => el.textContent.includes('7 Days Stranded'));
          await stage.popup.reveal(older);
          await stage.spot(older, { pad: 3 });
          await stage.wait(1500);
          await stage.spotOff();
        },
      },
    ],
  },
  {
    title: 'Alerts',
    blurb: 'One desktop alert per check, with buttons to listen or queue the newest video.',
    steps: [
      {
        title: 'One alert per check',
        caption: 'When channels upload, you get one desktop alert, not one per video.',
        ms: 9000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: COPS, t: 610, queue: UP_NEXT }, { open: false });
          stage.page.watch({ v: COPS, t: 610, paused: false });
          await stage.camera.focus('page');
          stage.cursor.place(520, 420);
        },
        async run(stage) {
          await stage.wait(1200);
          stage.badge('3');
          await stage.notify({ title: '3 new videos', body: 'Marques Brownlee · MrBeast', buttons: ['Listen', 'Add to Up next'] });
          await stage.wait(1200);
          await stage.spot(stage.toolbarIcon, { pad: 4 });
          await stage.wait(1500);
          await stage.spotOff();
          await stage.cursor.moveTo(stage.el.querySelector('.ntf__title'));
          await stage.wait(800);
        },
      },
      {
        title: 'Act from the alert',
        caption: 'Listen right away, or add the newest video to Up next.',
        ms: 8000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: COPS, t: 616, queue: `${UP_NEXT},${PHONE}` }, { open: false });
          stage.page.watch({ v: COPS, t: 616, paused: false });
          await stage.camera.focus('page');
          stage.badge('3');
          await stage.notify({ title: '3 new videos', body: 'Marques Brownlee · MrBeast', buttons: ['Listen', 'Add to Up next'] });
        },
        async run(stage) {
          await stage.cursor.moveTo(stage.notifyButton(0));
          await stage.wait(500);
          await stage.cursor.click(stage.notifyButton(1));
          await stage.unnotify();
          await stage.wait(500);
          await openFromToolbar(stage);
          const row = await stage.popup.find('#queue-list .queue-row', (el) => el.textContent.includes('iPhone 18'));
          await stage.popup.reveal(row);
          await stage.spot(row, { pad: 3 });
          await stage.wait(1400);
          await stage.spotOff();
        },
      },
    ],
  },
  {
    title: 'Audio mode',
    blurb: 'Keep the sound, drop the picture: 144p under a cover, with the controls in the popup.',
    image: { src: '../images/home-player.png', alt: 'The Player tab, with audio mode on.' },
    steps: [
      {
        title: 'Listen with less data',
        caption: 'Audio mode drops the video to 144p and covers it. Same sound, about 8× less data than 720p.',
        ms: 10000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, t: 345, queue: 'none', scene: 'player' });
          phonePage(stage, { t: 345, paused: false });
          await stage.camera.focus('popup');
        },
        async run(stage) {
          await stage.wait(400);
          const toggle = await stage.popup.find('#audio-toggle');
          await stage.cursor.click(toggle, { aim: toggle.parentElement.querySelector('.switch__track') || toggle });
          await stage.wait(300);
          await stage.camera.focus('page');
          await stage.cursor.moveTo(stage.page.$('.yt-player'), { at: [0.6, 0.45] });
          await stage.wait(600);
          await stage.spot(stage.page.$('.yt-quality'), { pad: 5 });
          await stage.wait(2200);
          await stage.spotOff();
        },
      },
      {
        title: 'Player controls',
        caption: 'Play, skip, change speed or set a sleep timer from the popup.',
        ms: 10500,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, t: 352, audio: 1, queue: 'none', scene: 'player' });
          phonePage(stage, { t: 352, paused: false, audio: true });
          await stage.camera.focus('page');
        },
        async run(stage) {
          await stage.camera.focus('popup');
          const play = await stage.popup.find('#audio-play');
          await stage.cursor.click(play);
          await stage.wait(700);
          await stage.cursor.click(play);
          await stage.wait(400);
          await stage.cursor.click(await stage.popup.find('#audio-forward'));
          await stage.wait(400);
          await stage.choose(await stage.popup.find('#audio-speed'), '1.5');
          await stage.wait(300);
          const sleep = await stage.popup.find('#audio-sleep');
          await stage.choose(sleep, '30');
          await stage.spot(sleep, { pad: 4 });
          await stage.wait(1400);
          await stage.spotOff();
        },
      },
      {
        title: 'See what you saved',
        caption: 'The Player tab counts the data audio mode has saved.',
        ms: 7000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, t: 380, audio: 1, queue: 'none', scene: 'player' });
          phonePage(stage, { t: 380, paused: false, audio: true });
          await stage.camera.focus('popup');
        },
        async run(stage) {
          const saved = await stage.popup.find('#audio-stat-saved');
          const stats = saved.closest('.audio-stat').parentElement;
          await stage.popup.reveal(stats);
          await stage.cursor.moveTo(saved);
          await stage.spot(stats, { pad: 4 });
          await stage.wait(2400);
          await stage.spotOff();
        },
      },
    ],
  },
  {
    title: 'Up next',
    blurb: 'A listen-later list that mirrors YouTube’s own queue and plays itself through.',
    steps: [
      {
        title: 'A listen-later list',
        caption: 'Add any video from Feeds to Up next.',
        ms: 8000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, t: 200, queue: '_oRgdlJUD18,iYlODtkyw_I', scene: 'feeds' });
          phonePage(stage, { t: 200, paused: false });
          await stage.camera.focus('popup');
        },
        async run(stage) {
          const row = await stage.popup.find('#feed-list .feed-row', (el) => el.textContent.includes('I Made a Bet with Tesla'));
          await stage.popup.reveal(row);
          await stage.cursor.click(row.querySelector('.feed-row__queue'));
          await stage.wait(500);
          await clickTab(stage, 'tab-audio');
          const added = await stage.popup.find('#queue-list .queue-row', (el) => el.textContent.includes('Tesla'));
          await stage.popup.reveal(added);
          await stage.spot(added, { pad: 3 });
          await stage.wait(1500);
          await stage.spotOff();
        },
      },
      {
        title: 'In step with YouTube’s queue',
        caption: 'Up next and YouTube’s own queue mirror each other. Reorder, remove or clear on either side.',
        ms: 11000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, t: 230, queue: UP_NEXT, scene: 'player' });
          phonePage(stage, { t: 230, paused: false, queuePanel: true });
          await bothQueues(stage);
          await stage.popup.reveal(await stage.popup.find('#queue-list'));
          stage.cursor.place(1000, 420);
        },
        async run(stage) {
          await stage.spot(stage.page.$('.yt-queue'), { pad: 4 });
          await stage.wait(1400);
          await stage.spotOff();
          const rows = stage.popup.$$('#queue-list .queue-row');
          const last = rows[rows.length - 1];
          const lastV = last.dataset.queueV;
          await stage.drag(last.querySelector('.queue-row__handle'), rows[0]);
          // A browser that will not hand a scripted pointer to the list
          // still shows the same move, made with the handle's arrow keys.
          if (stage.popup.$('#queue-list .queue-row')?.dataset.queueV !== lastV) {
            const handle = stage.popup.$(`#queue-list .queue-row[data-queue-v="${lastV}"] .queue-row__handle`);
            const view = handle.ownerDocument.defaultView;
            handle.dispatchEvent(new view.KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
          }
          await stage.wait(600);
          await stage.cursor.moveTo(stage.page.$('.yt-queue'), { at: [0.5, 0.35] });
          await stage.spot(stage.page.$('.yt-queue'), { pad: 4 });
          await stage.wait(1800);
          await stage.spotOff();
        },
      },
      {
        title: 'It plays through',
        caption: 'When a video ends, the next one plays. Audio mode stays on.',
        ms: 9500,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, t: 1029, audio: 1, queue: UP_NEXT, scene: 'player' });
          phonePage(stage, { t: 1029, paused: false, audio: true, queuePanel: true });
          await bothQueues(stage);
          await stage.popup.reveal(await stage.popup.find('#queue-list'));
          stage.cursor.place(620, 440);
        },
        async run(stage) {
          await stage.cursor.moveTo(stage.page.$('.yt-ctl__time'));
          await stage.wait(4600);
          stage.popup.stub()?.advance();
          await stage.wait(1300);
          await stage.spot(await stage.popup.find('#audio-player'), { pad: 3 });
          await stage.wait(1500);
          await stage.spotOff();
        },
      },
    ],
  },
  {
    title: 'On YouTube itself',
    blurb: 'Your groups as chips on YouTube’s own Subscriptions page.',
    steps: [
      {
        title: 'Your groups on the Subscriptions page',
        caption: 'Your groups also show as chips on YouTube’s Subscriptions page.',
        ms: 9000,
        async setup(stage) {
          await stage.popup.close();
          stage.page.subs();
          await stage.camera.focus('page');
          stage.cursor.place(700, 420);
        },
        async run(stage) {
          await stage.wait(500);
          await stage.spot(stage.page.$('.ytc-chips'), { pad: 6 });
          await stage.wait(1300);
          await stage.spotOff();
          await stage.cursor.click(stage.page.$('.ytc-chip[data-group="Tech"]'));
          await stage.wait(2400);
        },
      },
    ],
  },
  {
    title: 'Make it yours',
    blurb: 'English or Arabic, light or dark, and a backup file that is yours to keep.',
    steps: [
      {
        title: 'Arabic and a dark theme',
        caption: 'English or Arabic, light or dark.',
        ms: 9000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, paused: 1, scene: 'settings' });
          phonePage(stage);
          await stage.camera.focus('popup');
        },
        async run(stage) {
          const arabic = await stage.popup.find('input[data-setting="ui.locale"][value="ar"]');
          await stage.cursor.click(arabic, { aim: arabic.closest('label') });
          await stage.popup.find('html[dir="rtl"]');
          await stage.wait(1500);
          const dark = await stage.popup.find('input[data-setting="ui.theme"][value="dark"]');
          await stage.cursor.click(dark, { aim: dark.closest('label') });
          await stage.wait(2200);
        },
      },
      {
        title: 'Your list is yours',
        caption: 'Export your list any time: settings and channels in one small file.',
        ms: 8000,
        async setup(stage) {
          await stage.popup.load({ page: 'watch', v: PHONE, paused: 1, theme: 'dark', scene: 'settings' });
          phonePage(stage);
          await stage.camera.focus('popup');
        },
        async run(stage) {
          const button = await stage.popup.find('#settings-export');
          await stage.popup.reveal(button);
          await stage.cursor.click(button);
          await stage.wait(1800);
        },
      },
      {
        title: 'Free, and on both stores',
        caption: 'Companion for YouTube is free on the Chrome Web Store and Microsoft Edge Add-ons.',
        ms: 6000,
        async setup(stage) {
          await stage.popup.close();
          phonePage(stage);
          await stage.camera.focus('page');
          stage.cursor.hide();
        },
        async run(stage) {
          await stage.outro();
          await stage.wait(800);
        },
      },
    ],
  },
];
