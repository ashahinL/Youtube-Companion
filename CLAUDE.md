# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**Companion for YouTube** — a Chrome/Edge **MV3** extension. Account-free YouTube
subscriptions: a merged time-sorted feed of channels you add by URL, a
per-channel sheet inside the popup, and desktop alerts on new uploads.

The name is **Companion for YouTube** (Arabic **رفيق ليوتيوب**), never
"YouTube Companion": store review treats YouTube as the name as impersonation.
For the same reason the icon and the accent are purple, not YouTube red. The
repo and the backup file's `app` id keep the old spelling.

Sibling of `../poppo-companion` and `../bigo-companion`. Same house shape:
**no build step, no dependencies, plain ES modules.** What is in `src/` is what
Chrome loads.

Nothing is authenticated. No Google account, no API key, no OAuth. The feed
only reads public `youtube.com` endpoints. Audio mode injects an isolated
content script on youtube.com to pin the player to 144p; `#movie_player`
methods are reached through a MAIN-world bridge.

## Where things stand

**1.0.0 has shipped**: GitHub release `v1.0.0` with the store zip attached.
Both stores got the same zip on 2026-09-13 and are in review. `store/LISTING.md`
holds the store IDs and every answer given. Chrome blocks every extension from
its Web Store pages, so the Chrome dashboard is clicked through by hand from
that file; no browser automation reaches it.
When a listing goes live, its link goes in the README's install section.
Release notes are `CHANGELOG.md`.

**The next update is 1.1.0.** Its work is finished on `main` and waits
under `## Unreleased` in the CHANGELOG until both stores are done reviewing
1.0.0 and the owner says ship. The version files already read 1.1.0.

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

- **Popup**, 400×600, four tabs in this order: Audio, Feeds, Watchlist,
  Settings. It opens on Audio.
- **One list.** The Watchlist is the subscription list; Feeds is its merged
  timeline, newest first, with **no read state** and no hiding. The newest
  **500** videos are kept (a setting).
- **Adding** takes a channel URL, `@handle`, bare handle, `UC…` id, or a
  watch / shorts / youtu.be URL (its uploader). Empty Add takes the focused
  tab. **No name search, no bulk paste, no file import.** Typing in either box
  only filters.
- **Clicking a video** opens a new focused tab on youtube.com and closes the
  popup. A channel name opens the in-popup channel sheet, which shows stored
  videos and never fetches on open.
- **Alerts**: one notification per channel per check ("3 new videos"), never
  one per video. Favourites always alert while alerts are on; other channels
  only if "Notify for non-favourite channels" is on. A video alerts once.
- **Shorts** hidden by default behind a setting, tagged `SHORT` when shown.
  **Live and premieres** are shown and tagged (`LIVE` red, `PREMIERE <time>`).
- **Toolbar badge**: videos newer than the last popup open, counted with the
  same filters the Feeds tab applies. It is always the feed count, audio mode
  or not.
- **English and Arabic**, full RTL, with a language override in Settings.
- **Audio mode**: its switch lives only inside the Audio tab. No recorder. The
  overlay look is a group in Settings. With two or more YouTube tabs open, a
  picker chooses which one the player drives. The keyboard command acts on the
  active tab only.
- **Backup** exports settings and channels (merge or replace on import), not
  the feed.
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
- **Commit only when asked.** `main` is the working branch, and it is always
  ready to ship: a feature that takes many commits lives on its own branch
  until it is finished.
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
  channels fires 40 alerts.
- **A stranded `pollState.running: true` survives restarts forever.** MV3 kills
  the worker, not only the browser, without warning between raising and
  lowering a flag, and `storage.local` outlives reloads. Reconcile at every
  worker start, before any sweep reads the flag. This is the exact bug poppo
  hit.
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
  world's `console` is not the page's either. `content.js` sets a
  `data-am-beacon` attribute on `<html>` to prove which revision is live.
- **A test that asserts a call exists is not a test.** A structural grep once
  passed while the handler holding the call was unreachable. Anything that must
  actually fire on youtube.com is checked in a browser by hand.
- **Persist a durable flag the moment it changes**, not at the next convenient
  write. MV3 can kill the worker in between; clearing a flag in memory and
  letting a later batch carry it gave poppo an endless re-seed loop.
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
- **Stop at YouTube's pushback.** A 429 or a redirect to `google.com/sorry`
  ends the sweep and sets `pollState.backoffUntil`; nothing fetches until then,
  manual refresh included. A new request path in `src/lib/yt.js` must throw
  through `landedOnBlockPage`, or a block turns into captchas on the user's
  own YouTube.
- **Compressed bytes differ between Node builds.** Homebrew's Node links system
  zlib and packs the same tree to a different zip hash than a Node with its own
  zlib. Compare files or pixels, never deflate output, across machines.
- **Store screenshots are only as good as the frame the stub caught.** Open
  every image `npm run shots` writes before it ships; an empty frame went out
  in 1.0.0 and is far smaller on disk than its siblings.
