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
public `youtube.com` endpoints, without cookies. The person's own YouTube
session is used only in their own tab, for two things: Import from YouTube, which reads
`/feed/channels` (and the account switcher, for the accounts' names) only
when they press it, and the Up next mirror, which asks the Player tab's page
to edit its own queue with the page's own actions. Audio mode injects an isolated
content script on youtube.com to pin the player to 144p; `#movie_player`
methods are reached through a MAIN-world bridge.

## Shipping

Nothing ships until the owner says so, and not while a store still has a version in review.
Finished work waits under `## Unreleased` in the CHANGELOG. The version files change only on
ship day. How versions work: `RELEASING.md`. What has shipped: `docs/agent-notes/release-state.md`.

`docs/youtube.md` is what YouTube actually serves, measured with byte counts —
read it before touching `src/lib/yt.js` or the audio-mode player calls.

The audio-mode engine passed a code-provenance audit before publishing; the
owner keeps that record outside the repo. Ask the owner before bringing code
from any other extension into `src/`, and keep that discussion out of tracked
files.

## How the work gets done

Implementation is **delegated to the Grok Build CLI** via the `grok-delegate`
skill, one job per dispatch, and reviewed and committed here. The pattern:

1. Write a brief that assumes **zero** shared context — Grok sees only the text
   and the working tree. Point it at this file and the files in scope, name the
   exact scope, and list what to leave alone.
2. Dispatch with `relay.mjs --brief … --cd <repo> --lane feature --timeout 1h`. Follow the global rules on delegating.
3. **Re-run the gates here.** Never accept "gates passed" from the report.
4. Read the diff against the brief — scope creep in both directions.
5. Commit it here. Grok never commits.

Rework goes out as a delta brief with `--resume-last`, not a restatement.

Which model does what is set by the global fleet rules and `~/.config/delegate-skills/config.json`.

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
  the date attached. A tripwire goes in a comment at the line it protects, or in the
  matching `docs/agent-notes/` file when it spans files — but only if forgetting it would
  break something.

## Where the code is

| Path | Job |
| --- | --- |
| `src/background/service-worker.js` | the worker: checks, alerts, messages, multi-step writes |
| `src/popup/popup.js`, `popup.html`, `popup.css` | the popup and all four tabs |
| `src/content/content.js`, `core.js`, `inject.js` | YouTube-page scripts; `inject.js` is the MAIN world |
| `src/lib/yt.js` | every YouTube fetch and parser; see `docs/youtube.md` first |
| `src/lib/store.js` | stored lists and their locks |
| `src/lib/queue-sync.js` | the Up next mirror |
| `src/lib/backup.js`, `view.js` | backup; shared page text and `errorText` |
| `src/welcome/`, `src/whatsnew/`, `site/` | welcome, What's new, uninstall, feedback, tour |
| `server/feedback/` | the Cloudflare feedback worker |
| `test/`, `test/fixtures/`, `test/popup-run.js` | suites, fixtures, real-popup tests |
| `store/LISTING.md` | store IDs, answers and listing state |
| `scripts/shots/` | screenshots from the real popup |

## Hard rules

Most tripwires live as comments at the line they protect. The reasons for these rules are in
`docs/agent-notes/`.

- Product decisions in `docs/agent-notes/product-decisions.md` are settled. Read that file before
  changing UI or behaviour. Change one only when the owner asks.
- No `confirm()` or `alert()` in a popup. Use inline confirm rows.
- Never notify on the seed. A new channel's backfill is marked as already alerted, silently.
- Every read-change-write of stored lists goes through its lock (`withListLock` for channels and
  feed). A job must never call a helper that takes the same lock.
- Stop at YouTube's pushback. A new request path in `src/lib/yt.js` must throw through
  `landedOnBlockPage`.
- `DOMParser` does not exist in the service worker. All YouTube fetches pass `credentials: 'omit'`.
- Persist a durable flag the moment it changes. MV3 can kill the worker at any time.
- A worker reply's `error` is a code, never a sentence. A new code a page can show gets a key
  for `errorText`, in both locales.
- A message sent from `src/content/` must be added to `CONTENT_SCRIPT_MESSAGES`, and only if a
  compromised youtube.com page could not misuse it.
- `WHATS_NEW_VERSION` is bumped by hand and is not the manifest version.
- Never rename or move `site/uninstall.html`. Installed copies link to it forever.
- A test must exercise behaviour. Popup behaviour goes in `test/popup-run.js`.
- Files stay LF. CRLF breaks tests.

## Read before changing

Read the matching file in `docs/agent-notes/` before changing that area.

| Area | File |
| --- | --- |
| UI and product behaviour | `product-decisions.md` |
| YouTube requests, parsing, account import | `youtube-fetching.md` |
| Worker, storage, alarms, alerts | `worker-and-storage.md` |
| Up next, content scripts, audio-mode cover | `queue-and-content.md` |
| Popup, site pages, tests, screenshots, packing | `popup-and-tools.md` |
| Releases and store state | `release-state.md` |
