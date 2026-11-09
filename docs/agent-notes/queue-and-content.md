# Up next and content scripts

Read this before changing `src/content/`, `src/lib/queue-sync.js`, Up next, audio-mode cover or content-script messages.

Moved word for word from CLAUDE.md on 2026-11-09. "This file" and "the list below" can mean CLAUDE.md.

- **A collab video's channels are not in the DOM.** Its owner line is one
  link with no address, "A and B", or "A and 2 more" with three or more
  channels, so only the first name can be checked against it; the ids exist only in the owner renderer's
  `.data`, which only `inject.js` (the MAIN world) can read. The avatar stack
  stays in the page after moving on to a normal video, and on an in-page move
  the address changes before the owner line does, so `content.js` trusts the
  line only when `ytd-watch-flexy`'s `video-id` matches the address.
- **Reloading a YouTube page does not load new content-script code**; only
  reloading the extension does, and the version on the extensions page follows
  the manifest, so it can look current while a stale script runs. The isolated
  world's `console` is not the page's either. Confirm the new code by Reload on
  `chrome://extensions` (the version there) and by inspecting the content
  scripts in DevTools' "Content scripts" section.
- **The audio-mode cover is a `data:image/` URL on its own storage key, never
  an https address.** A leftover `settings.audio.imageUrl` from 1.x is
  migrated when it is already a data URL, and dropped when it is https, so
  the YouTube page never loads a third-party picture. The cover is not in
  backups.
- **A new runtime message is popup-only until listed.** The worker refuses any
  message from a content script unless its type is in
  `CONTENT_SCRIPT_MESSAGES`, so a new message sent from `src/content/` fails
  with `not allowed` until it is added there. Add it only if a compromised
  youtube.com page could not misuse it.
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
- **YouTube's queue is the `TLPQ…` playlist panel, and its rows are the
  truth.** `#movie_player.getPlaylist()` goes stale (it kept four ids after
  Clear) and `getPlaylistId()` is null where the queue was made. The
  playing row is the `selected` one, or the row with no
  `playlistSetVideoId` before the queue has played into its own videos;
  rows above it are already played and are not queued. Edits need the set
  id, so it stays inside `inject.js` and never reaches the worker. A scripted move or
  remove reaches the server but the panel shows it only after
  `yt-refresh-playlist-command`. Measured in `docs/youtube.md`.
- **The mirror syncs by ops, never by copying lists.** Copying let a stale
  page snapshot that arrived during our own edit wipe adds and bring back
  removes. `src/lib/queue-sync.js` keeps a shadow and the ops in flight;
  a snapshot with an older `seq` loses, one from a non-watch page changes
  nothing, and one with no queue (`listId ''` without `cleared`) can only
  add. Only
  `queue.snapshot` from the mirrored tab id is honoured.
