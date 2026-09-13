# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

**YouTube Companion** — a Chrome/Edge **MV3** extension. Account-free YouTube
subscriptions: a merged time-sorted feed of channels you add by URL, a
per-channel sheet inside the popup, and desktop alerts on new uploads.

Sibling of `../poppo-companion` and `../bigo-companion`. Same house shape:
**no build step, no dependencies, plain ES modules.** What is in `src/` is what
Chrome loads.

Nothing is authenticated. No Google account, no API key, no OAuth. The feed
only reads public `youtube.com` endpoints. Audio mode injects an isolated
content script on youtube.com to pin the player to 144p; `#movie_player`
methods are reached through a MAIN-world bridge.

## Read DESIGN.md first

`DESIGN.md` is the agreed spec and the source of truth. It sits in the working
tree but is **not tracked** — it is a working document, not part of what ships,
so it will not be in a fresh clone. It was written with the owner, question by
question, and its decision table in §1 is **settled — do not relitigate it**.
Its §2 wire facts were measured live with `curl` on 2026-09-11, with real byte
counts; they are not guesses.

Quick map of the spec:

| § | What it holds |
|---|---|
| 1 | The settled decisions (UI shape, retention, notifications, language, shorts, …) |
| 2 | The five YouTube endpoints, measured — sizes, fields, and the traps |
| 3 | Storage keys and the exact record shapes |
| 4 | File layout and the manifest |
| 5 | The background worker: alarms, the sweep, the silent seed, alerts, badge |
| 6 | The popup's three tabs |
| 7 | The per-channel sheet |
| 8 | i18n and RTL |
| 9 | Backup format |
| 10 | The test suites |
| 11 | **Build order** — the phases |
| 12 | Tripwires |

## Where the work is

Built in the order of DESIGN.md §11. Jobs 1-9 are done and the extension is
loadable; job 10 is the remaining one. Update this table as each one lands.

| # | Job | State |
|---|---|---|
| 1 | Skeleton: manifest, package.json, locales, test harness, 3-tab popup shell | **done** |
| 2 | `lib/yt.js` + fixtures — every endpoint and parser | **done** |
| 3 | `lib/settings.js`, `lib/store.js` | **done** |
| 4 | Worker: alarms, sweep, silent seed, notifications, badge | **done** |
| 5 | Watchlist tab: add by URL/handle, filter the list, favourite, remove | **done** |
| 6 | Feeds tab: render, tags, filter, refresh, click-through | **done** |
| 7 | Channel sheet (in-popup overlay of stored videos) | **done** |
| 8 | Settings tab + `lib/backup.js` (export/import, Merge/Replace) | **done** |
| 9 | i18n + Arabic + RTL over finished markup | **done** |
| 10 | The Audio tab: player, overlay and statistics, no recorder (DESIGN.md §13) | **tab, look settings, player card, tab picker, statistics, feed-badge yield done**; open-in-audio-mode (§13.10) remains |

**Job 10 carries a provenance constraint**, recorded in DESIGN.md §13.2-13.3.
Read it before touching the audio-mode code, and keep that discussion in the
spec rather than in tracked files.

Already on disk before job 1: `DESIGN.md`, `icons/` (finished),
`test/fixtures/` (seven real captured YouTube responses), and
`test/helpers/report.js` / `test/run-all.js` / `test/check-syntax.js` copied
verbatim from `../poppo-companion` as a starting point.

## How the work gets done

Implementation is **delegated to the Grok Build CLI** via the `grok-delegate`
skill, one job per dispatch, and reviewed and committed here. The pattern:

1. Write a brief that assumes **zero** shared context — Grok sees only the text
   and the working tree. Point it at DESIGN.md, name the exact scope, and list
   what to leave alone.
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
```

`npm run check` **and** `npm test` both green before anything counts as done.

Suites run against **committed fixtures in `test/fixtures/`** and must never
touch the network.

## Code conventions

- Comments explain **why**, not what. Write them where a reader would otherwise
  be surprised.
- **No process or planning language in code or comments.** No "phase 1", "for
  now", "MVP", "TODO later", "step 3", no ticket ids. The code reads as a
  finished thing, not as a stage of a plan. Phases live in DESIGN.md and in the
  table above, nowhere else.
- ES modules, 2-space indent, single quotes, semicolons, a short block comment
  at the top of each file saying what it is for.
- No dependencies, ever. Node's own APIs only in tests.
- **Commit only when asked.** `main` is the working branch.
- Write down what you changed **and what you learned** in the same change.
  Measured facts about YouTube's wire format go into DESIGN.md §2 with the
  numbers attached; tripwires go into §12 — but only if forgetting one would
  break something.

## Tripwires — the short version

The full list is DESIGN.md §12. The ones that have teeth:

- **`DOMParser` does not exist in an MV3 service worker.** The channel-feed XML
  parser must be hand-written. This is a constraint, not a preference.
- **The channel feed has no `ETag` and no 304 path**, and is cached for 900
  seconds. A poll without `cache: 'no-cache'` returns identical bytes and looks
  like "nothing new" for 15 minutes.
- **The row id in a Videos-tab `browse` response is `contentId`, not `videoId`.**
  `videoId` is there 210 times on nested endpoint objects, so harvesting it
  returns each video several times. Nothing parses that video list now — the
  channel sheet reads the stored feed — so this is for whoever calls it next.
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
