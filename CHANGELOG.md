# Changelog

Each version here is one that went to the stores. What is finished but not
shipped yet waits under Unreleased. How a version ships:
[RELEASING.md](RELEASING.md).

## Unreleased

**New**
- Undo after removing a channel. The channel comes back with its star, its
  place in the list and its videos.
- A Follow button. Open the popup on a YouTube channel or video you don't
  follow yet, and the Audio tab shows that channel with one button to add it.
  A video made by several channels lists each one with its own button, and a
  ✔ on the ones you already follow.
- The player card in the Audio tab shows a ✔ before a channel you follow.
- A sleep timer in the Audio tab: pause after 15, 30 or 60 minutes. It keeps
  counting after you close the popup.
- Open the popup with Alt+Shift+Y. Settings lists both keyboard shortcuts
  and opens the page to change them.
- Mute alerts for one channel from its ⋯ menu. Its videos still show in
  Feeds, it can stay a favourite, and backups keep the setting.

**Safer**
- Only the popup can change your channels and settings. The script on YouTube
  pages can only ask the two audio-mode questions it needs.
- Backup files are checked: real channel ids only, channel pictures only from
  YouTube's image servers, at most 2,000 channels and 2 MB.
- When YouTube answers "too many requests" or shows its unusual-traffic page,
  checking stops and waits (15 minutes, then 30, up to 6 hours) instead of
  carrying on. The Feeds tab says when the next check is.
- Stricter page rules for the popup: it loads pictures only from YouTube's
  image servers, runs no plugins, and cannot be pointed at another base
  address.

**Fixes**
- The scrolling title in the Audio tab stays still, on two lines, when your
  system asks for reduced motion.
- When YouTube's channel feeds are down, checks still work. A channel whose
  feed fails is read from its Videos tab instead (shorts and live streams wait
  until the feed is back), and older videos found that way don't alert.
- A channel that fails says so in your language: "Check failed" on its row,
  and a plain sentence with a Retry button when you open it. No more ⚠ with an
  English tooltip.
- Checks are quicker and lighter: three channels at a time, and the channel
  list is saved once per check instead of about twice per channel.
- The popup stays quick with a big feed. Feeds shows 50 videos at a time and
  adds more as you scroll, thumbnails load as they come into view, and typing
  in a box redraws only the tab you are on.
- On a video made by several channels, the Follow card showed no name. It now
  lists each channel.
- A premiere days away is looked at a few times a day, not on every check.
- Requests to YouTube carry its current web client version.

**For contributors**
- Tests run on every push (GitHub Actions). Node 22.2 or newer is needed.
- The icon test compares pixels, so it passes on any Node build.
- `SECURITY.md` says how to report a security problem.

## 1.0.0 — 2026-09-13

The first release, on the Chrome Web Store and Edge Add-ons.

**Feeds**
- Every video from the channels you follow in one list, newest first.
- Live streams and premieres tagged; Shorts hidden unless you turn them on.
- Filter by title or channel, or show favourites only.

**Watchlist**
- Add a channel by URL or `@handle`, or press Add on the tab you are on.
- Favourites sit at the top and are checked on their own, shorter schedule.
- A per-channel sheet shows its latest videos without leaving the popup.

**Alerts**
- One desktop notification per channel per check, never one per video.
- The toolbar badge counts new videos since you last opened the popup.

**Audio mode**
- Pins the player to 144p and covers the video; switching off restores the
  quality you were watching.
- Popup player with seek, 10-second skips, speed and volume, and a picker when
  several YouTube tabs are open.
- Open feed videos straight into audio mode.
- Data used and saved, and time listened, this month and all time.
- Keyboard shortcut <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd>.

**Everything else**
- English and Arabic, with a full right-to-left layout.
- Export and import of channels and settings (merge or replace).
- A Support sheet with PayPal and InstaPay, behind a heart in the top bar.
- Named **Companion for YouTube**, with its own icon.
