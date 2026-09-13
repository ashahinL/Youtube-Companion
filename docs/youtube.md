# What YouTube serves — measured

The endpoints and the player API this extension relies on, with the numbers
they were measured at. The endpoints were measured with `curl` on 2026-09-11
(and the Origin rule on 2026-09-12); the saved responses are
`test/fixtures/`. When something stops working, compare a live response
against these before changing a parser. The rules that follow from each fact
sit as comments in `src/lib/yt.js` and `src/content/`.

Every endpoint answers **without cookies and without an API key**.

## Channel feed — what the sweep polls

```
GET https://www.youtube.com/feeds/videos.xml?channel_id=UC...
```

- `200`, **21,227 bytes** for MKBHD, always exactly **15 entries**.
- Per entry: `yt:videoId`, `title`, `published` (exact ISO 8601), `updated`,
  `media:thumbnail`, `media:description`, `media:statistics views`,
  `media:starRating`.
- The feed-level `<yt:channelId>` (and `<id>yt:channel:…</id>`) carries the id
  **without its `UC` prefix** — `BJycsmduvYEL83R_U4JriQ` for
  `UCBJycsmduvYEL83R_U4JriQ`. Entries and the self-link carry the full id. A
  22-character value is the prefix-less form, not another channel.
- **Shorts are mixed in with no flag.** Of MrBeast's 5 newest entries,
  `5mU6SRS2Bxo` and `LiH-P4rSkLI` were shorts.
- **No `ETag`, no `Last-Modified`, no 304.** A conditional GET with
  `If-Modified-Since` returned `200` and the full body. The only caching header
  is `cache-control: public, max-age=900`, so without `cache: 'no-cache'` the
  browser serves the same bytes for 15 minutes.
- A sweep therefore costs about 21 KB per channel with no way to shrink it:
  40 channels ≈ 840 KB.

## Channel URL or @handle → channel id

```
POST https://www.youtube.com/youtubei/v1/navigation/resolve_url
{"context":{"client":{"clientName":"WEB","clientVersion":"2.20240304.00.00","hl":"en","gl":"US"}},
 "url":"https://www.youtube.com/@mkbhd"}
```

- `200`, **1,170 bytes**. The id is `endpoint.browseEndpoint.browseId`.
- `endpoint.commandMetadata.resolveUrlCommandMetadata.isVanityUrl` tells a
  handle from a `/channel/UC…` URL.
- **`Origin: chrome-extension://…` gets a 403** and Google's "automated
  queries" page, even with the Innertube key and
  `Referer: https://www.youtube.com/`. The same POST is `200` with no Origin,
  `Origin: null`, or `Origin: https://www.youtube.com` (measured on
  `@GameHopping`, `UCdNuKbEDUrYJVod-SUH5HrQ`). The RSS GET and
  `HEAD /shorts/` do not care. `fetch` cannot set Origin, hence the worker's
  DNR rule.
- A request carrying the user's YouTube cookies without `SAPISIDHASH` is a
  different request that often answers 401, hence `credentials: 'omit'`
  everywhere.
- **Do not scrape the channel page for the id.** It is **2,649,019 bytes**, and
  its first `"channelId":"UC…"` belongs to another channel embedded in the page
  data. The only trustworthy anchors are
  `<link rel="canonical" href=".../channel/UC...">` and `"externalId":"UC..."`.

## One video — duration, live, premiere

```
POST https://www.youtube.com/youtubei/v1/player
{"context":{...},"videoId":"Od6M0AXpcxQ"}
```

- `200`, **9,623 bytes**, with no `?key=` at all. The key is still readable
  from `"INNERTUBE_API_KEY"` in the youtube.com homepage HTML if a future
  change ever demands one.
- `videoDetails.lengthSeconds`: `"1034"` for a normal video, `"0"` while live.
- `videoDetails.isLive` is `true` on a live stream, absent otherwise;
  `videoDetails.isUpcoming` is `true` on a premiere or scheduled stream.
- `microformat.playerMicroformatRenderer.liveBroadcastDetails` —
  `{"isLiveNow":true,"startTimestamp":"2026-09-11T10:38:47+00:00"}` — is where a
  premiere's start time comes from.
- Also: `viewCount`, `likeCount`, `publishDate`, `ownerChannelName`, and
  `videoDetails.channelId`, which is how a watch, shorts or youtu.be URL turns
  into its uploader.
- **`isShortsEligible` is not "is a short"**; it means the video could be shown
  as one.

## Is it a short

```
HEAD https://www.youtube.com/shorts/<videoId>
```

- `200` → a short. `303` with `location: /watch?v=<id>` → a normal video.
- Verified on five MrBeast ids: `gTKS8SAwUzE` 303, `5mU6SRS2Bxo` 200,
  `Qtl8lJwbd4g` 303, `LiH-P4rSkLI` 200, `Af6i6ChAVTw` 303 — the two 200s are
  the two real shorts.
- With `redirect: 'manual'` the response is opaque and its status unreadable;
  follow the redirect and read `response.redirected` / `response.url`.
- Nothing longer than 180 seconds is a short, so longer videos skip the HEAD.

## Channel header and Videos tab

```
POST https://www.youtube.com/youtubei/v1/browse
{"context":{...},"browseId":"UC...","params":"EgZ2aWRlb3PyBgQKAjoA"}
```

- `params` `EgZ2aWRlb3PyBgQKAjoA` is the Videos tab. `200`, ~339 KB, 31
  `richItemRenderer` items, **no shorts** (they have their own tab).
- The extension reads only the header from it: avatar
  (`https://yt3.googleusercontent.com/...=s72-c-k-c0x00f`, also `s120`),
  subscribers (`"516M subscribers"`), `pageTitle`, and `externalId`.
- If the video list is ever parsed: rows are `lockupViewModel`, and the row's id
  is **`contentId`**. `"videoId"` appears **210 times** on nested
  `watchEndpoint`, `addToPlaylistCommand` and `offlineVideoEndpoint` objects, so
  harvesting it returns each video several times (30 `contentId` values for 31
  lockups). Grep the raw bytes: re-serialising with `json.dumps` adds a space
  after the colon and hides every match.
- Duration is `thumbnailBadgeViewModel.text` (`"23:28"`); views and age come
  from `contentMetadataViewModel` and are **relative only** (`"6 days ago"`),
  which is why the feed polls RSS instead.

## Channel search by name — not used

```
POST https://www.youtube.com/youtubei/v1/search
{"context":{...},"query":"marques brownlee","params":"EgIQAg%3D%3D"}
```

Add takes a URL or handle only, so nothing calls this. For whoever does:

- `EgIQAg%3D%3D` is the channels-only filter; ~107 KB.
- Each hit repeats its `browseId` three times (navigation and two byline
  endpoints): 21 `channelRenderer` objects, 20 channels, 60 `browseId`s.
  Dedupe by channel id.
- Avatars are mostly on `yt3.ggpht.com` (24 against 16 on
  `yt3.googleusercontent.com`) and protocol-relative (`//yt3.ggpht.com/…`).
- The count fields are swapped: `subscriberCountText` held `"@mkbhd"` and
  `videoCountText` held `"21.2M subscribers"`. Match the text against
  `/subscriber/i`, not the key name.

## The watch-page player

The player is `#movie_player`. Its methods exist only in the page's own
JavaScript world; an isolated content script sees the element but not the
methods, which is why `src/content/inject.js` exists. The table is the
contract audio mode is built against, not a measurement; confirm any change
to it in a browser by hand. The bullets under it were measured.

| Call | Use |
|---|---|
| `setPlaybackQualityRange(min, max)` | The one that sticks. `'tiny'` for both pins 144p. |
| `setPlaybackQuality(q)` | Advisory on its own and gets overridden. Send it after the range, never instead. |
| `getPlaybackQuality()` | What is playing now. |
| `getAvailableQualityLevels()` | Best first. No `'tiny'` means 144p is not offered; audio mode takes `'small'` (240p). |
| `playVideo()` / `pauseVideo()` | Play, pause. |
| `seekTo(seconds)` | A finite number ≥ 0. |
| `setPlaybackRate(rate)` | `0.25`, `0.5`, `0.75`, `1`, `1.25`, `1.5`, `1.75` or `2`. |
| `setVolume(n)` | Integer 0–100. **Does not unmute**: after `mute()`, `setVolume(50)` left `isMuted()` true. |
| `mute()` / `unMute()` | Mute keeps the level. |

- Quality strings, smallest first: `tiny` (144p), `small` (240p), `medium`
  (360p), `large` (480p), `hd720`, `hd1080`, `hd1440`, `hd2160`, `highres`,
  plus `auto`. Changes arrive through `onPlaybackQualityChange`.
- **A fresh page reports `tiny` or `small` for its first seconds** while
  adaptive streaming climbs, even when `getAvailableQualityLevels()` already
  lists `hd2160`. Audio mode switched on a few seconds into a load, then off,
  then six seconds of playback: still `tiny`.
- **`<video>.volume` is not YouTube's volume.** `setVolume(100)` left it at
  **0.4629** on one video and `setVolume(25)` at **0.1157**; the factor differs
  per video. `.ytp-volume-panel` `aria-valuenow` and `getVolume()` both give the
  integer 0–100.
- `currentTime`, `duration`, `paused`, `playbackRate` and `muted` read fine from
  the `<video>` element in the isolated world.
- **`#movie_player` and its `<video>` stay in the DOM after navigating away**
  (logo click to `/`), with `currentSrc` empty, `duration` NaN, `paused` true.
- **`.html5-video-container` is 1879×0** on a live watch page: its `<video>` is
  absolutely positioned. `#movie_player` measured 1879×995, and an overlay
  there 1708×889.
- **YouTube sets the root font size to 10px**, so `rem` in a content-script
  stylesheet is 62.5% of what it means elsewhere (a 3.25rem icon measured
  32.5px).
- When the API is ignored, the fallback drives the player's own settings menu
  (gear → quality → level). It depends on YouTube's class names and is the
  first thing to check when audio mode stops pinning.

Not measured yet: that `#movie_player` exists at `document_idle` on a fresh
watch page, how much video has buffered by then, and that a short plays in the
ordinary player at `/watch?v=`.
