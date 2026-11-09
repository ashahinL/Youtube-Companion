# Settled product decisions

Read this before changing any UI or product behaviour. Agreed with the owner, question by question. Change one only when the owner asks.

Moved word for word from CLAUDE.md on 2026-11-09. "This file" and "the list below" can mean CLAUDE.md.

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
  There is no groups screen in Settings. At most 20 groups, 8 on one channel, 24 characters a name.
  Groups ride along in backups. The same groups show as chips on YouTube's
  own `/feed/subscriptions` page whenever the list has groups (no switch); a chip
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
  no undo; the result names the first three channels it removed). Takeout
  stays add-only. Imported channels start unseeded, so their
  first check is silent; pictures fill in a few per check, more in the
  first day after they were added.
- **Welcome page** opens once on a fresh install, never on an update: import
  or follow channels, try audio mode, pin the icon.
- **What's new page** (`src/whatsnew/`) is the update half of that. **No tab
  opens by itself on an update** — a browser updates quietly in the
  background, so a tab would interrupt. Instead the popup shows one
  dismissible line above the panels, and the bottom of Settings reopens the
  page at any time. It carries the headline features with a picture each,
  three of them, in both languages, and links to the CHANGELOG for the rest.
- **Uninstall and feedback pages** are `site/uninstall.html` and
  `site/feedback.html` on GitHub Pages, published from `main`; Settings'
  Send feedback link opens the second. Their address carries only the
  language and version. Each is one text box and Send, with no GitHub
  account and no email: the page posts the text, version and language to
  the Cloudflare Worker in `server/feedback/`
  (`feedback.ammarshahin.dev`), which opens an issue in the private repo
  `ashahinL/companion-feedback`. Spam is stopped by Turnstile, a 2000
  character cap and a per-IP rate limit; no IP is stored and the worker's
  logs are off. The extension itself never sends anything there.
- **Settings**, top to bottom: Appearance (Language, Theme as segmented
  rows), Notifications, Feed (check interval, keep-newest), Audio mode (the
  open-in-audio switch, the shortcut with Change, and Overlay look folded),
  Backup, then one line of links: Support ♥ · Send feedback · What's new.
  No Advanced part. One check interval for every channel; alerts always use
  the channel picture; the only keyboard command is audio mode's.
- **Follow card**: when the focused tab is a YouTube channel or video whose
  channel is not on the list, the top of the Player tab names it with a Follow
  button. It is the same add; deciding whether to show it fetches nothing. A
  collab video lists every channel, each with its own Follow button, and a
  check before the ones already followed; the card goes once all are.
- **Followed mark**: the Player tab's player card puts the same check before
  each channel name that is on the list.
- **A failed channel** reads "Check failed" on its Watchlist row; its sheet
  says why in a translated sentence, with Retry. While any channel is
  failing, an "N failing" chip on the Watchlist narrows the list to them,
  for this open only.
- **Clicking a video** opens a new focused tab on youtube.com and closes the
  popup. A channel name opens the in-popup channel sheet, which shows stored
  videos and never fetches on open: its feed rows plus the channel's own
  newest 5 normal videos (`channel.recent`, kept outside the feed cap,
  refreshed only from the RSS feed, not in backups). **See more** fetches
  older ones from the Videos tab, a page at a time, only when pressed, and
  honours the backoff. Its ↗ opens the channel's own page on youtube.com the
  same way.
- **Alerts**: one notification per check, never one per video or per channel.
  One channel with new videos gets its own alert ("3 new videos"); two or
  more share one ("5 new videos", channel names as the body, extension icon),
  and its click, Listen and Add to Up next act on the newest video. Favourites always alert while alerts are on;
  other channels only if "Notify for non-favourite channels" is on. A video alerts once. A
  channel muted from its ⋯ menu never alerts, favourite or not, and stays in
  the feed. The mute goes into backups. An alert has two buttons, Listen
  (audio mode) and Add to Up next, both for the newest video; a live or
  premiere alert has none.
- **Shorts** are stored but never shown, counted or alerted (no setting).
  **Live and premieres** are shown and tagged (`LIVE` red, `PREMIERE <time>`).
  A premiere past its start leaves Feeds and the badge once its channel is
  live on another video, or an hour after its start; it stays stored and
  comes back as live if it does start.
- **Toolbar badge**: videos newer than the last popup open, counted with the
  same filters the Feeds tab applies. It is always the feed count, audio mode
  or not. The icon's tooltip says the same in words ("3 new videos").
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
  naming the count, with Export my list first, then every channel and the
  whole feed go. Alert history
  stays, so channels added back never alert twice. There is no undo; Export
  is the way back.
- **Up next** is a listen-later queue in the Player tab, under the player
  card and above the stats, collapsible, with the open/closed choice
  remembered. Auto-advance plays the list in one YouTube tab, audio mode
  on or off. Add from a feed row (and so the channel sheet) or an alert's
  button. Rows can be reordered by dragging their handle or with the arrow
  keys on it. The video playing in the Player tab is never shown in Up next;
  the player card already shows it, and Play all starts after it. Cap 100.
  On the Player tab, Up next and YouTube's own queue mirror each other
  live, both ways: the page holds Up next minus the playing video, and a
  video leaves Up next once it starts playing. Only that one tab is read;
  the popup tells the worker which it is, and Play all's tab becomes it.
  Joining a tab (or a reload) merges the two lists and never removes;
  only a normal page change, or the person pressing Clear on YouTube's
  queue, removes rows. While the page has a queue, YouTube advances it.
  Not in backups. Live streams and premieres cannot be queued from a feed row.
- **Name, icon, accent**: see the top of this file. **Support**: a heart in the
  popup header and a Support ♥ link at the bottom of Settings open one sheet
  (PayPal, InstaPay with address, Copy and QR); the README and store text
  mention it. No `.github/FUNDING.yml`.
