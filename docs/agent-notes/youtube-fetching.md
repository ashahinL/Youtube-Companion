# YouTube fetching and parsing

Read this before changing `src/lib/yt.js`, feed parsing, account import or YouTube requests.

Moved word for word from CLAUDE.md on 2026-11-09. "This file" and "the list below" can mean CLAUDE.md.

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
- **A Videos-tab row is not a feed entry.** It has no upload time (the player
  supplies it), and the tab leaves out shorts, so it reaches back past the
  feed's window to videos never seen before. Those must merge silently, or a
  feed outage turns into alerts for old uploads.
- **The first `"channelId":"UC..."` in channel HTML belongs to a different
  channel.** Use `resolve_url`; if you ever must parse HTML, trust only
  `<link rel="canonical">` or `"externalId"`.
- **`isShortsEligible` is not "is a short".** The exact test is a HEAD request
  to `/shorts/<id>`: 200 means short, 303 means normal video.
- **Innertube POSTs from the extension send `Origin: chrome-extension://…`
  and YouTube 403s that Origin.** Fetch cannot override it. A DNR rule
  rewrites Origin to `https://www.youtube.com` on this extension's own
  requests. All YouTube fetches pass `credentials: 'omit'`.
- **Stop at YouTube's pushback.** A 429 or a redirect to `google.com/sorry`
  ends the sweep and sets `pollState.backoffUntil`; nothing fetches until then,
  manual refresh included. A new request path in `src/lib/yt.js` must throw
  through `landedOnBlockPage`, or a block turns into captchas on the user's
  own YouTube.
