# Changelog

Each version here is one that went to the stores. What is finished but not
shipped yet waits under Unreleased. How a version ships:
[RELEASING.md](RELEASING.md).

## Unreleased

**New**
- Your groups show up as chips on YouTube's own subscriptions page. Pick
  one to hide videos from other channels, or All to show everything again.
  Turn it off under Settings → My groups on YouTube.
- Import your subscriptions straight from a YouTube tab you're signed in to.
  **Import from YouTube** opens All subscriptions. If more than one Google
  account is signed in, you pick which one — each is shown with its name,
  picture and how many channels it has. The extension reads that account's list and
  adds the ones you don't have yet. If your watchlist has channels that
  account is not subscribed to, you choose whether to add the new ones or
  replace your list, and you can export your list first. Nothing signs in,
  and nothing leaves the device. A Google Takeout file is still there for
  when you're signed out.
- With several YouTube tabs open, each one in the Player tab's list has a
  ↗ button that takes you straight to that tab, even in another window.
- Theme and Language in Settings are each a group of three cards (Light,
  Dark, System; English, العربية, System). Theme also applies to the
  welcome page and the What's new page.
- Channel groups can be renamed and deleted from the Groups sheet: renaming
  onto an existing name merges the two, and deleting asks inline first.

**Changes**
- The four statistics cards in the Player tab now sit in one row, so the
  block takes two rows instead of three.
- Long numbers in the statistics cards now shrink to fit instead of being
  cut off.

**Fixes**
- Clicking a new-video alert now closes it. Clicking it again, or a copy
  left in the notification center, takes you to the tab it already opened
  instead of opening the video once more.
- The **New** marker on a feed row moved from in front of the title to the
  top of the row, above the buttons. In front of the title it pushed the
  whole title across, so new rows did not line up with the rest of the feed.
- Background checks stop while the watchlist is empty, instead of running an
  empty sweep on every schedule.
- Clear watchlist also drops stored video details. Alert history is kept, so
  channels added back still never alert twice.

## 2.0.0 — 2026-09-19

**New**
- A **What's new** page. After an update the popup shows one line at the top;
  open it to see what the release added, or dismiss it. It never opens a tab
  on its own, and the bottom of Settings can reopen it any time.
- **Up next** in the Player tab: add videos from Feeds or the player, press
  Play all, and they play one after another in one tab. Up to 100 videos,
  and it is not in backups.
- The Audio tab is now called **Player**. The popup opens on it only when a
  YouTube tab has a video playing or paused partway through, or when audio
  mode is on. Otherwise it opens on Feeds.
- Videos that arrived since you last opened the popup wear a **New** tag. It
  means the same thing as the toolbar badge, and it is not a read state:
  open again and yesterday's tags are gone.
- Channel groups. From a channel's ⋯ menu you can put it in one or more
  named groups. Feeds gets a row of chips to show one group at a time.
- Audio mode's cover is a picture you choose on your device, not a web
  address. It stays on the device and is not in backups.
- After audio mode has saved over 1 GB, the Player tab asks once for a
  rating. Either button hides that for good.
- A clearer name in the stores: **Companion for YouTube: Audio Only & Feeds**.
- Undo after removing a channel. The channel comes back with its star, its
  place in the list and its videos.
- A Follow button. Open the popup on a YouTube channel or video you don't
  follow yet, and the Player tab shows that channel with one button to add it.
  A video made by several channels lists each one with its own button, and a
  ✔ on the ones you already follow. Follow and Add return right away; the
  channel's videos load in the background with no alerts, so you can press
  Follow on every channel of a collab video one after another.
- The player card in the Player tab shows a ✔ before a channel you follow.
- A sleep timer in the Player tab: pause after 15, 30 or 60 minutes. It keeps
  counting after you close the popup.
- Open the popup with Alt+Shift+Y. Settings lists both keyboard shortcuts
  and opens the page to change them.
- Mute alerts for one channel from its ⋯ menu. Its videos still show in
  Feeds, it can stay a favourite, and backups keep the setting.
- Import your YouTube subscriptions. Download `subscriptions.csv` from Google
  Takeout and pick it on the welcome page (or with **Import from YouTube** in
  the popup). The file is read on your device, nothing signs in, and the
  channels fill in without alerts. Their pictures arrive over the next few
  checks. If a check is already running, imported channels load right after
  it instead of waiting for the next one.
- **Clear watchlist** in Settings → Backup removes every channel and its
  videos in one go, after asking. Handy after importing the wrong list, or
  before restoring a backup.
- A welcome page on first install, in three steps: bring your channels, try
  audio mode, pin the icon. It never opens on an update.
- Removing the extension opens a short page that asks why. It links to both
  the Chrome Web Store and Edge Add-ons. Nothing is sent unless you post the
  answers as a GitHub issue yourself.
- Settings' on/off options are toggle switches now, the same ones audio mode
  uses, instead of tick boxes.

**Safer**
- YouTube pages can no longer tell the extension is installed by loading its
  files or reading a mark on the page.
- Only the popup can change your channels and settings. The script on YouTube
  pages can only ask the two audio-mode questions it needs.
- Backup files are checked: real channel ids only, channel pictures only from
  YouTube's image servers, at most 2,000 channels and 2 MB. Merging a backup
  that would take the list past 2,000 channels is refused, with a clear
  message.
- When YouTube answers "too many requests" or shows its unusual-traffic page,
  checking stops and waits (15 minutes, then 30, up to 6 hours) instead of
  carrying on. The Feeds tab says when the next check is. After an import,
  the welcome page says so too.
- Stricter page rules for the popup: it loads pictures only from YouTube's
  image servers, runs no plugins, and cannot be pointed at another base
  address.
- Channel pictures and handles fill in 10 per check instead of 20.
- Adding a channel only keeps a picture from YouTube's image servers, same
  as a backup.
- If YouTube refuses several player requests in one check, checking stops
  and waits — the same pause as for "too many requests" — instead of
  leaving the feed looking stuck.

**Fixes**
- The scrolling title in the Player tab stays still, on two lines, when your
  system asks for reduced motion.
- In Arabic, the sleep timer no longer runs off the edge of the Player tab.
  Speed, volume and the timer drop to their own line when the words are too
  wide for one.
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
- On a video made by several channels, the Follow card showed no name — and
  with three or more, no list at all. It now lists each channel.
- A premiere days away is looked at a few times a day, not on every check.
- A long list of channels no longer makes every check ask YouTube about
  thousands of videos: only the ones new enough to stay in the feed are looked
  up.
- Removing a channel no longer lets older videos from your other channels
  back into the feed as alerts.
- Removing, clearing or re-adding channels while a check is running no
  longer brings old videos or alerts back when the check ends.
- Adding a channel names it: "Added Marques Brownlee to your watchlist."
  instead of "Channel added successfully".
- Removing a channel low in the Watchlist no longer jumps you to the top.
  The Undo bar now sits at the bottom of the popup, where you are.
- A check of hundreds of channels keeps going to the end instead of stopping
  when the browser puts the extension to sleep.
- Requests to YouTube carry its current web client version.
- The −10 and +10 buttons in the Player tab fit their labels.
- Starring or unstarring a channel updates the toolbar badge right away.
- A check that was cut off can no longer leave checks stuck until the
  browser restarts.
- A video whose upload time is missing from YouTube's feed no longer
  disappears.
- A scheduled check that comes due while another is running now runs right
  after it.
- Restoring a backup alerts for uploads made after the backup was saved.
- The seek slider and Follow list are named for screen readers. The ⋯ menu
  works with the arrow keys and Escape. Feed rows no longer nest buttons
  inside a focusable row.
- English no longer says "1 channels" or "1 videos".
- A live stream or premiere that has already left the feed is not looked
  up again every check.
- A new video that does not fit in the feed no longer raises an alert.
- The welcome page says when no keyboard shortcut is assigned, instead of
  hiding the line.

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
