# What YouTube serves — measured

The endpoints and the player API this extension relies on, with the numbers
they were measured at. The endpoints were measured with `curl` on 2026-09-11
(and the Origin rule on 2026-09-12); facts added later carry their own date.
The saved responses are
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
  40 channels ≈ 840 KB. That is the body size; gzipped on the wire it was
  **3,898 bytes** for MKBHD on 2026-09-14.
- **The feed can go down while the rest of YouTube works.** At 09:20 and
  09:28 on 2026-09-13 every feed address (`channel_id=`, `playlist_id=`,
  `user=`) answered `404`, **1,613 bytes**, for every channel, while the
  homepage and the `browse` and `player` calls below answered normally. By
  2026-09-14 the feed was back.
- A `404` cannot tell that outage from a channel that is gone: an id that
  does not exist also answers `404`, 1,613 bytes. That is why a failed feed
  is retried through the Videos tab before the channel is called broken.
- The uploads playlist (`playlist_id=UU…`, the id with `UC` swapped for `UU`)
  served the same 15 ids in the same order as the channel feed on 2026-09-14,
  21,277 bytes against 21,290. It is no backup: it was down in the same
  outage. Its title reads "Uploads from Marques Brownlee".

## Channel URL or @handle → channel id

```
POST https://www.youtube.com/youtubei/v1/navigation/resolve_url
{"context":{"client":{"clientName":"WEB","clientVersion":"2.20260911.01.00","hl":"en","gl":"US"}},
 "url":"https://www.youtube.com/@mkbhd"}
```

- `clientVersion` is what youtube.com itself sends: the homepage HTML carried
  `"INNERTUBE_CONTEXT_CLIENT_VERSION":"2.20260911.01.00"` on 2026-09-14. The
  version used before, `2.20240304.00.00`, still answered that day with the
  same results from `resolve_url` (1,170 bytes), `browse` and `player`, and
  every parser read both answers the same.

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
- `microformat.playerMicroformatRenderer.publishDate` is the upload time to
  the second, the same instant as the feed's `<published>`:
  `2026-09-10T00:29:55-07:00` for `Od6M0AXpcxQ` against `07:29:55+00:00` in
  the feed, and `2026-09-12T14:36:57-07:00` for `6D__H_DO2Xk` against
  `21:36:57+00:00`. A Videos-tab row gets its time from here.
- Also: `viewCount`, `likeCount`, `ownerChannelName`, and
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
- Adding a channel reads the header from it: avatar
  (`https://yt3.googleusercontent.com/...=s72-c-k-c0x00f`, also `s120`),
  subscribers (`"516M subscribers"`), `pageTitle`, and `externalId`.
- A check reads the video rows when the channel's feed fails. Rows are
  `richGridRenderer.contents[].richItemRenderer.content.lockupViewModel` with
  `contentType: "LOCKUP_CONTENT_TYPE_VIDEO"`, newest first, and the row's id is
  **`contentId`**. `"videoId"` appears **210 times** on nested
  `watchEndpoint`, `addToPlaylistCommand` and `offlineVideoEndpoint` objects, so
  harvesting it returns each video several times (30 `contentId` values for 31
  lockups). Grep the raw bytes: re-serialising with `json.dumps` adds a space
  after the colon and hides every match.
- The title is `lockupMetadataViewModel.title.content`. Duration is
  `thumbnailBadgeViewModel.text` (`"23:28"`); views and age are the
  `metadataParts` of `contentMetadataViewModel` (`"7.1M views"`,
  `"1 day ago"`) and are **rounded and relative only**, which is why the feed
  polls RSS and a row's exact time comes from `player`.
- **It leaves out shorts and live streams**, so it reaches further back. For
  MKBHD on 2026-09-14 its newest 15 shared 11 ids with the feed's 15; the
  feed's other 4 were all shorts (`HEAD /shorts/` answered `200` for each).
- Size, MKBHD, 2026-09-14: **369,073 bytes**, **35,475 bytes** gzipped on the
  wire — about nine times the feed.
- **A channel id that does not exist answers `200`**, 11,601 bytes, with
  `alerts` and no `metadata`.

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

## The owner line under a watch-page video

Measured in a browser on 2026-09-14. The line is
`ytd-watch-metadata ytd-video-owner-renderer`.

- **A normal video's line is a link to the channel.** For `Od6M0AXpcxQ` it
  held two `<a>`, both `href="/@mkbhd"`, the second with the text
  `Marques Brownlee`. A fresh load had no avatar stack in it.
- **A collab video's line is one name with no address.** For `PHpsdIHpLUE`
  the two `<a>` had no `href`; the second read
  `The Diary Of A CEO and StarTalk`. `ytd-channel-name` was empty, so a
  reader of `#channel-name` found no name. Beside it sat `#avatar-stack` with
  `yt-avatar-stack-view-model aria-label="Collaboration channels"`.
- **The channels of a collab exist only in the renderer's data**, which only
  the page's own JavaScript world can read: `.data.navigationEndpoint
  .showDialogCommand.panelLoadingStrategy.inlineContent.dialogViewModel
  .customContent.listViewModel.listItems[]`, the list the Collaborators
  dialog opens. Per row, `listItemViewModel.title.content` is the name,
  `title.commandRuns[0].onTap.innertubeCommand.browseEndpoint.browseId` the
  channel id, and `subtitle.content` reads `@TheDiaryOfACEO • 19.6M
  subscribers` with each part wrapped in U+200E, U+2068 and U+2069.
- The same dialog is in `/youtubei/v1/next` for the video (888,633 bytes) and
  on a search result's byline, under a `"Collaborators"` headline; a search
  for "podcast" returned 7 collab videos.
- The player's `videoDetails.channelId` is the first channel listed
  (`UCGq-a57w-aPwyi3pW7XLiHw`), so adding a collab video by its watch URL adds
  that one.
- **On an in-page move the address changes first.** Collab to normal
  (`sL6OWsT47zc`) and back: the owner text, its links, the data, the avatar
  stack and `ytd-watch-flexy`'s `video-id` attribute all changed together,
  between 0.45 s and 0.6 s later in one run and 3.8 s later with the tab in
  the background. Until then the old video's line is what shows.
- **The avatar stack stays in the page** after moving on to a normal video,
  hidden. Its presence does not mean a collab; a line whose links have no
  address does.

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
