# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Companion for YouTube** — a Chrome/Edge **MV3** extension. Account-free YouTube
subscriptions: a merged time-sorted feed of channels you add by URL, a
per-channel sheet inside the popup, and desktop alerts on new uploads.

The name is **Companion for YouTube** (Arabic **رفيق ليوتيوب**), never
"YouTube Companion": store review treats YouTube as the name as impersonation.
For the same reason the icon and the accent are purple, not YouTube red. From 2.0 the
store name is **Companion for YouTube: Audio Only & Feeds** (`extName`, kept
under 45 characters); the popup and welcome page show the short `appName`. The
repo and the backup file's `app` id keep the old spelling.

Sibling of `../poppo-companion` and `../bigo-companion`. Same house shape:
**no build step, no dependencies, plain ES modules.** What is in `src/` is what
Chrome loads.

Nothing is authenticated by us. No API key, no OAuth, and the feed only reads
public `youtube.com` endpoints, without cookies. The one use of the person's
own YouTube session is Import from YouTube, which reads `/feed/channels`
(and the account switcher, for the accounts' names) inside their signed-in
tab, only when they press it. Audio mode injects an isolated
content script on youtube.com to pin the player to 144p; `#movie_player`
methods are reached through a MAIN-world bridge.

## Where things stand

**1.0.0 has shipped**: GitHub release `v1.0.0` with the store zip attached.
Both stores got the same zip on 2026-09-13. Chrome published it on
2026-09-14; Edge had it live by 2026-09-16. `store/LISTING.md`
holds the store IDs and every answer given. Chrome blocks every extension from
its Web Store pages, so the Chrome dashboard is clicked through by hand from
that file; no browser automation reaches it.
When a listing goes live, its link goes in the README's install section.
Release notes are `CHANGELOG.md`.

**2.0.0 was tagged and released on 2026-09-19**, after the owner hand-tested
it. The store uploads are clicked through by hand from `store/LISTING.md`,
which records where each store stands. The version files read 2.0.0 and do not
change again until the next ship day.

**The next store version is 2.1.0 or 2.0.1**, depending on whether it carries
new things or only fixes. Nothing ships until the owner says so, and not while
a store still has 2.0.0 in review. Finished work waits under `## Unreleased`
in the CHANGELOG.

**How versions work: `RELEASING.md`.** A version number is what users get
from the stores. The version, its tag, its GitHub release and its store upload
happen on the same day, only when the owner says so. Planned groups of work
are not versions, and no tag is made between ships.

`docs/youtube.md` is what YouTube actually serves, measured with byte counts —
read it before touching `src/lib/yt.js` or the audio-mode player calls.

The audio-mode engine passed a code-provenance audit before publishing; the
owner keeps that record outside the repo. Ask the owner before bringing code
from any other extension into `src/`, and keep that discussion out of tracked
files.

## Settled product decisions — do not relitigate

Agreed with the owner, question by question. Change one only when the owner
asks.

- **Popup**, 400×600, four tabs in this order: Player, Feeds, Watchlist,
  Settings. From 2.0 the first tab reads **Player** (Arabic مشغّل); its ids,
  classes and message types keep the `audio` spelling, because the tab is
  still audio mode's home. It opens on Player only when a YouTube tab has a
  video playing or paused partway, or audio mode is on, and on Feeds
  otherwise — decided once per open, from a player probe with a 250 ms
  window, and nothing moves the user afterwards.
- **One list.** The Watchlist is the subscription list; Feeds is its merged
  timeline, newest first, with **no read state** and no hiding. The newest
  **500** videos are kept (a setting). Feeds draws them 50 at a time; more
  come with scrolling or **Show more**. A video newer than the last popup
  open wears a small accent **New** tag — the same rule as the badge, and
  still not a read state: nothing is stored per video and nothing hides.
- **Groups**: a channel can be in several named groups, put there from its ⋯
  menu; Feeds narrows to one group with a row of chips, alongside the search
  box and Favourites only, and the badge counts the same way. A group exists
  only while a channel is in it. Rename and delete live in the Groups sheet:
  renaming onto an existing name merges the two, and delete asks inline.
  There is no Settings screen. At most 20 groups, 8 on one channel, 24 characters a name.
  Groups ride along in backups. The same groups show as chips on YouTube's
  own `/feed/subscriptions` page (a Settings switch, on by default); a chip
  hides the cards of channels outside it, matched by handle, then by name.
  Its choice is its own key, not the popup's Feeds chip.
- **Adding** takes a channel URL, `@handle`, bare handle, `UC…` id, or a
  watch / shorts / youtu.be URL (its uploader). Empty Add takes the focused
  tab. **No name search, no bulk paste.** Typing in either box only filters.
- **Import from YouTube**: the popup and the welcome page open the signed-in
  YouTube tab on `/feed/channels` and read the subscription list there, on
  the device, with no sign-in of ours. When more than one Google account is
  signed in, the person picks which account to read, by name when the
  account switcher gives one (names stay in the tab); an account with no
  subscriptions is shown but not scanned. One account with subscriptions is
  read without an extra click. Google Takeout's `subscriptions.csv` stays
  on the welcome page for people who are signed out. Only channel ids,
  titles and handles are kept. When the watchlist has channels the account
  is not subscribed to, the person chooses Add new (merge) or Replace (an
  inline warning that the current list will be deleted, with Export my list
  first; channels in both lists keep favourite, mute and groups; there is
  no undo). Takeout stays add-only. Imported channels start unseeded, so their
  first check is silent; pictures fill in a few per check.
- **Welcome page** opens once on a fresh install, never on an update: import
  or follow channels, try audio mode, pin the icon.
- **What's new page** (`src/whatsnew/`) is the update half of that. **No tab
  opens by itself on an update** — a browser updates quietly in the
  background, so a tab would interrupt. Instead the popup shows one
  dismissible line above the panels, and the bottom of Settings reopens the
  page at any time. It carries the headline features with a picture each,
  three of them, in both languages, and links to the CHANGELOG for the rest.
- **Uninstall page** is `site/uninstall.html` on GitHub Pages, published from
  `main`. Its address carries only the language and version. Its tick boxes
  fill in a GitHub issue that the person posts themselves; nothing is
  collected.
- **Follow card**: when the focused tab is a YouTube channel or video whose
  channel is not on the list, the top of the Player tab names it with a Follow
  button. It is the same add; deciding whether to show it fetches nothing. A
  collab video lists every channel, each with its own Follow button, and a
  check before the ones already followed; the card goes once all are.
- **Followed mark**: the Player tab's player card puts the same check before
  each channel name that is on the list.
- **A failed channel** reads "Check failed" on its Watchlist row; its sheet
  says why in a translated sentence, with Retry.
- **Clicking a video** opens a new focused tab on youtube.com and closes the
  popup. A channel name opens the in-popup channel sheet, which shows stored
  videos and never fetches on open.
- **Alerts**: one notification per channel per check ("3 new videos"), never
  one per video. Favourites always alert while alerts are on; other channels
  only if "Notify for non-favourite channels" is on. A video alerts once. A
  channel muted from its ⋯ menu never alerts, favourite or not, and stays in
  the feed. The mute goes into backups.
- **Shorts** hidden by default behind a setting, tagged `SHORT` when shown.
  **Live and premieres** are shown and tagged (`LIVE` red, `PREMIERE <time>`).
- **Toolbar badge**: videos newer than the last popup open, counted with the
  same filters the Feeds tab applies. It is always the feed count, audio mode
  or not.
- **English and Arabic**, full RTL, with a language override in Settings.
- **Theme**: System, Light or Dark in Settings; it applies to the popup,
  welcome and What's new pages; the audio overlay and site/ keep their own
  look; a localStorage mirror only prevents a flash, settings are the truth.
- **Audio mode**: its switch lives only inside the Player tab. No recorder. The
  overlay look is a group in Settings; Image uses a picture you pick on the
  device, stored outside settings so it is not in backups. With two or more
  YouTube tabs open, a picker chooses which one the player drives. The
  keyboard command acts on the active tab only. The sleep timer (15, 30 or 60
  minutes) sits in the player card and runs in the YouTube tab, not the popup
  or the worker. After audio mode has saved 1 GB, the Player tab offers a
  one-time store rating; either button dismisses it for good, and that flag
  is not in backups. Each picker row has a go-to button that activates that
  tab and focuses its window, then closes the popup; it does not change
  which tab the player drives.
- **Backup** exports settings and channels (merge or replace on import), not
  the feed. **Clear watchlist** sits in the same group: an inline confirm
  naming the count, then every channel and the whole feed go. Alert history
  stays, so channels added back never alert twice. There is no undo; Export
  is the way back.
- **Up next** is a listen-later queue in the Player tab, under the player
  card and above the stats, collapsible, with the open/closed choice
  remembered. Auto-advance plays the list in one YouTube tab, audio mode
  on or off. Add from a feed row (and so the channel sheet), or from the
  player card for what is playing now. Cap 100. Not in backups. Live
  streams and premieres cannot be queued from a feed row.
- **Name, icon, accent**: see the top of this file. **Support**: a heart in the
  popup header and a Support group at the bottom of Settings open one sheet
  (PayPal, InstaPay with address, Copy and QR); the README and store text
  mention it. No `.github/FUNDING.yml`.

## How the work gets done

Implementation is **delegated to the Grok Build CLI** via the `grok-delegate`
skill, one job per dispatch, and reviewed and committed here. The pattern:

1. Write a brief that assumes **zero** shared context — Grok sees only the text
   and the working tree. Point it at this file and the files in scope, name the
   exact scope, and list what to leave alone.
2. Dispatch with `relay.mjs --brief … --cd <repo> --timeout 1h`, backgrounded.
3. **Re-run the gates here.** Never accept "gates passed" from the report.
4. Read the diff against the brief — scope creep in both directions.
5. Commit it here. Grok never commits.

Rework goes out as a delta brief with `--resume-last`, not a restatement.

**Lanes** (in `~/.config/delegate-skills/config.json`): `feature` is Grok, the
first choice; `complex` is Claude; the third is the `opencode` lane, **Muse
Spark 1.3 Free** (`opencode/muse-spark-1.3-contributor-free`, dispatched with
`opencode-delegate`). Muse Spark is Grok's fallback, not a peer: use it only
when the owner explicitly says to use opencode, or when Grok is not available
(not signed in, sandbox error, out of quota). Then send the job to Muse Spark
with the same brief and the same review. Do not pick a paid `opencode/*` model: the account has no funds
and those fail with 402.

## Commands

```bash
npm test             # every suite, terse summary — use this by default
npm run test:verbose # every assertion, for debugging a failure
npm run test:json    # machine-readable
npm run check        # manifest valid, every file parses, popup asset refs resolve
npm run pack         # dist/companion-for-youtube-<version>.zip, the store upload
npm run shots        # docs/screenshots + store/images from the real popup (needs Chrome/Edge, loads thumbnails)
node scripts/draw-icon.js  # re-render icons/ after changing the geometry
```

`npm run check` **and** `npm test` both green before anything counts as done.
They need Node 22.2 or newer (`zlib.crc32`), and run on every push in
`.github/workflows/test.yml`.

Suites run against **committed fixtures in `test/fixtures/`** and must never
touch the network.

## Code conventions

- Comments explain **why**, not what. Write them where a reader would otherwise
  be surprised.
- **No process or planning language in code or comments.** No "phase 1", "for
  now", "MVP", "TODO later", "step 3", no ticket ids. The code reads as a
  finished thing, not as a stage of a plan.
- ES modules, 2-space indent, single quotes, semicolons, a short block comment
  at the top of each file saying what it is for.
- No dependencies, ever. Node's own APIs only in tests.
- **Commit only when asked.** Work goes on `dev`; `main` gets only what
  ships, on ship day (`RELEASING.md` → Branches). A feature that takes many
  commits lives on its own branch off `dev` until it is finished.
- Write down what you changed **and what you learned** in the same change.
  Measured facts about YouTube go into `docs/youtube.md` with the numbers and
  the date attached. A tripwire goes in a comment at the line it protects, or
  in the list below when it spans files — but only if forgetting it would
  break something.

## Tripwires

Most live as comments at the line they protect. These span files or tools:

- **`DOMParser` does not exist in an MV3 service worker.** The channel-feed XML
  parser must be hand-written. This is a constraint, not a preference.
- **The channel feed has no `ETag` and no 304 path**, and is cached for 900
  seconds. A poll without `cache: 'no-cache'` returns identical bytes and looks
  like "nothing new" for 15 minutes.
- **The row id in a Videos-tab `browse` response is `contentId`, not `videoId`.**
  `videoId` is there 210 times on nested endpoint objects, so harvesting it
  returns each video several times. `parseChannelVideos` reads the rows when a
  channel's feed fails.
- **Plain youtube.com is not the first Google account.** With several
  accounts signed in, the tab can open on a later one (`SESSION_INDEX` was
  1 on a browser whose first account held the real list).
  `/feed/channels?authuser=N` selects account N. Past the last account
  YouTube answers 200 and falls back to account 0, so a `SESSION_INDEX`
  that is not N is the end of the list, not an error. `tabs.update` to
  another account returns before the old page is gone, and that page is
  on `/feed/channels` too, with its rows loaded: the scan names the
  account it wants, and a page on another one answers `wrongAccount`
  so the worker asks again.
- **Subscription shelves on `/feed/channels` are translated and have no
  stable id.** Take every `ytd-channel-renderer` whose
  `.data.subscriptionButton.subscribed` is true. Matching the heading
  "Subscribed" drops the list in Arabic, and it drops a purchased channel
  the account is still subscribed to. `.data` is only readable from the
  MAIN world, the same as a collab video's channel list.
- **A collab video's channels are not in the DOM.** Its owner line is one
  link with no address, "A and B", or "A and 2 more" with three or more
  channels, so only the first name can be checked against it; the ids exist only in the owner renderer's
  `.data`, which only `inject.js` (the MAIN world) can read. The avatar stack
  stays in the page after moving on to a normal video, and on an in-page move
  the address changes before the owner line does, so `content.js` trusts the
  line only when `ytd-watch-flexy`'s `video-id` matches the address.
- **A Videos-tab row is not a feed entry.** It has no upload time (the player
  supplies it), and the tab leaves out shorts, so it reaches back past the
  feed's window to videos never seen before. Those must merge silently, or a
  feed outage turns into alerts for old uploads.
- **The first `"channelId":"UC..."` in channel HTML belongs to a different
  channel.** Use `resolve_url`; if you ever must parse HTML, trust only
  `<link rel="canonical">` or `"externalId"`.
- **`isShortsEligible` is not "is a short".** The exact test is a HEAD request
  to `/shorts/<id>`: 200 means short, 303 means normal video.
- **Never notify on the seed.** A newly added channel backfills up to 15
  videos; those must be marked as already-alerted silently, or adding 40
  channels fires 40 alerts. Add replies once the channel is stored; the seed
  runs after. A kill between them is fine: the row stays unseeded, and the
  next check fills it without alerts. Ids added during a check are queued
  for one follow-up seed.
- **A stranded `pollState.running: true` survives restarts forever.** MV3 kills
  the worker, not only the browser, without warning between raising and
  lowering a flag, and `storage.local` outlives reloads. Reconcile at every
  worker start, before any sweep reads the flag. This is the exact bug poppo
  hit. If that first write fails, a later sweep still treats stored
  `running` as leftover when this worker is not sweeping.
- **A listing is its `addedAt`.** A check that already snapshotted the list
  must drop rows, stamps, and alerts for an id that was removed or added
  again before it wrote. Re-read the list in the same storage get as the
  feed write.
- **Only `at > 0` is a real upload time.** A missing RSS `<published>` is
  `at: 0`. Treating 0 as finite overwrites the player's time, and that id
  is never classified again.
- **`confirm()` / `alert()` in a popup** blocks it and can wedge the extension.
  Use inline confirm rows.
- **`alarms.create` on an existing name restarts its countdown from now.**
  Recreating alarms on every settings write meant any settings change pushed
  the next check a full interval away.
- **Chrome floors alarm periods at 1 minute** and silently clamps anything
  lower.
- **Innertube POSTs from the extension send `Origin: chrome-extension://…`
  and YouTube 403s that Origin.** Fetch cannot override it. A DNR rule
  rewrites Origin to `https://www.youtube.com` on this extension's own
  requests. All YouTube fetches pass `credentials: 'omit'`.
- **Headless Chromium will not lay out narrower than its minimum window
  width**, whatever `--window-size` says. A 400px popup rendered directly
  gets `position: fixed` sheets that run off its edge. `npm run shots`
  renders the popup inside a 400×600 iframe for that reason.
- **CRLF breaks tests.** Several popup checks regex the source with a length
  bound (`[\s\S]{0,240}`), and a Windows `core.autocrlf` checkout adds a byte
  per line. `.gitattributes` pins LF; a checkout made before it needs its
  files rewritten with LF once.
- **Reloading a YouTube page does not load new content-script code**; only
  reloading the extension does, and the version on the extensions page follows
  the manifest, so it can look current while a stale script runs. The isolated
  world's `console` is not the page's either. Confirm the new code by Reload on
  `chrome://extensions` (the version there) and by inspecting the content
  scripts in DevTools' "Content scripts" section.
- **A test that asserts a call exists is not a test.** A structural grep once
  passed while the handler holding the call was unreachable. Anything that must
  actually fire on youtube.com is checked in a browser by hand.
- **Persist a durable flag the moment it changes**, not at the next convenient
  write. MV3 can kill the worker in between; clearing a flag in memory and
  letting a later batch carry it gave poppo an endless re-seed loop.
- **The audio-mode cover is a `data:image/` URL on its own storage key, never
  an https address.** A leftover `settings.audio.imageUrl` from 1.x is
  migrated when it is already a data URL, and dropped when it is https, so
  the YouTube page never loads a third-party picture. The cover is not in
  backups.
- **An extension cannot assign its own keyboard shortcut.** `suggested_key`
  applies only at install, and when the combination is taken Chrome registers
  the command with no shortcut, silently (Dark Reader had `Alt+Shift+A`).
  Anything that shows the shortcut reads `chrome.commands.getAll()` and must
  make sense when it is empty.
- **A new runtime message is popup-only until listed.** The worker refuses any
  message from a content script unless its type is in
  `CONTENT_SCRIPT_MESSAGES`, so a new message sent from `src/content/` fails
  with `not allowed` until it is added there. Add it only if a compromised
  youtube.com page could not misuse it.
- **`WHATS_NEW_VERSION` is bumped by hand and is not the manifest version.**
  It says which release the What's new page is about, so bumping the manifest
  for a fixes-only patch does not ask everyone to look at an unchanged page.
  Change it in the same commit that rewrites the page's content, and change
  the copy in both locales.
- **`queue.ended` is gated on the tab id and the video id.** The worker
  honours it only when `sender.tab.id` is the tab it wrote into
  `queuePlay` and `msg.v` is the video it handed that tab. Any other tab
  or id is ignored, so a compromised youtube.com page cannot drain the
  queue or redirect some other tab.
- **The content script listens for `ended` in the capture phase on
  `document`.** A media `ended` event does not bubble, but capture still
  sees it, and it keeps working across YouTube's in-page navigations
  without tracking which `<video>` is current. Guard it: `event.target`
  must be `findVideo()`, and the id sent is `readVideoId()`, not
  anything from the event. Ads and preview players fire `ended` too.
- **`render()` draws only the open tab.** A hidden tab's DOM is whatever it
  was when it was last open, and `activate()` draws a tab as it opens. Code
  that reads a hidden tab's elements after `render()` reads stale ones, and
  `scripts/shots/stub.js` waits on the Player tab's first draw for that reason.
- **`popupOpened` moves `lastSeenAt` before it replies.** The popup's "new"
  dots need the value from the previous visit, so the reply carries
  `previousLastSeenAt` and the popup holds it for as long as it is open.
  Reading `pollState.lastSeenAt` from that same reply marks nothing as new.
- **The popup loads images only from hosts in the manifest's `img-src`.**
  A picture from any other host is blocked without an error in the page;
  `test/skeleton.test.js` checks the policy against `thumbUrl` and
  `isAvatarUrl`, so a new image host goes into both.
- **Stop at YouTube's pushback.** A 429 or a redirect to `google.com/sorry`
  ends the sweep and sets `pollState.backoffUntil`; nothing fetches until then,
  manual refresh included. A new request path in `src/lib/yt.js` must throw
  through `landedOnBlockPage`, or a block turns into captchas on the user's
  own YouTube.
- **A list of hundreds of channels costs per check, not per add.** Each
  channel brings 15 uploads; a check classifies only the ones new enough to
  stay in the capped feed (`feedFloor`), and a channel's `lastVideoAt` never
  goes down, because it is what keeps old rows quiet when a removed channel
  makes room for them. A check also calls an extension API every 25 seconds:
  Chrome stops a worker that only has fetches in flight.
- **Installed copies link to `site/uninstall.html` forever.** The worker's
  `UNINSTALL_PAGE` is set in every install, so renaming or moving that page,
  or turning off GitHub Pages, breaks the link for everyone who already has
  the extension.
- **Compressed bytes differ between Node builds.** Homebrew's Node links system
  zlib and packs the same tree to a different zip hash than a Node with its own
  zlib. Compare files or pixels, never deflate output, across machines.
- **Store screenshots are only as good as the frame the stub caught.** Open
  every image `npm run shots` writes before it ships; an empty frame went out
  in 1.0.0 and is far smaller on disk than its siblings.
