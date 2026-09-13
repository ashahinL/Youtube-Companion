<p align="center">
  <img src="icons/icon128.png" width="96" height="96" alt="YouTube Companion icon" />
</p>

<h1 align="center">YouTube Companion</h1>

<p align="center">
  Follow YouTube channels without a Google account.<br />
  One merged feed, alerts on new uploads, and an audio-only mode that saves data.
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome%20%2F%20Edge-Manifest%20V3-1f6feb" alt="Chrome / Edge, Manifest V3" />
  <img src="https://img.shields.io/badge/account-not%20needed-2ea043" alt="No account needed" />
  <img src="https://img.shields.io/badge/dependencies-none-2ea043" alt="No dependencies" />
  <img src="https://img.shields.io/badge/languages-English%20%7C%20%D8%A7%D9%84%D8%B9%D8%B1%D8%A8%D9%8A%D8%A9-8250df" alt="English and Arabic" />
</p>

<table align="center">
  <tr>
    <td align="center"><img src="docs/screenshots/audio.png" width="260" alt="Audio tab" /><br /><sub>Audio</sub></td>
    <td align="center"><img src="docs/screenshots/feeds.png" width="260" alt="Feeds tab" /><br /><sub>Feeds</sub></td>
    <td align="center"><img src="docs/screenshots/watchlist.png" width="260" alt="Watchlist tab" /><br /><sub>Watchlist</sub></td>
  </tr>
  <tr>
    <td align="center"><img src="docs/screenshots/sheet.png" width="260" alt="Channel sheet" /><br /><sub>Channel sheet</sub></td>
    <td align="center"><img src="docs/screenshots/settings.png" width="260" alt="Settings tab" /><br /><sub>Settings</sub></td>
    <td align="center"><img src="docs/screenshots/feeds-ar.png" width="260" alt="Feeds tab in Arabic" /><br /><sub>Arabic, right to left</sub></td>
  </tr>
</table>

## What it does

**Audio**
- Turn on audio mode for a YouTube tab. The video drops to 144p and a cover
  goes over it. You keep the sound and use about 8× less data than 720p.
- Turn it off and the video goes back to the quality you were watching.
- Control playback from the popup: seek, back and forward 10 seconds, play
  and pause, speed, and volume.
- With more than one YouTube tab open, pick which one to control.
- See how much data you used and saved, and how long you listened, this
  month or all time.
- Keyboard shortcut: <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>A</kbd> (change it
  at `chrome://extensions/shortcuts`).

**Feeds**
- Every video from your channels in one list, newest first.
- Live streams and premieres are tagged. Shorts are hidden unless you turn
  them on.
- Type to filter by title or channel. Tick **Favourites only** to narrow it
  down.

**Watchlist**
- Add a channel by pasting its URL or `@handle`, or press **Add** with an
  empty box to add the channel of the tab you are on.
- Star your favourites. They sit at the top and are checked more often.
- Click a channel to see its latest videos without leaving the popup.

**Alerts**
- A desktop notification when a channel uploads. One alert per channel, even
  if it posted several videos.
- The toolbar badge counts new videos since you last opened the popup.

**Settings**
- How often to check, how many videos to keep, and which alerts you want.
- The look of the audio mode cover: six colour presets, your own colour, or
  an image.
- English or Arabic, with a full right-to-left layout.
- Export your channels and settings to a file, and import them back (merge or
  replace).

## Install

It is not on the Chrome Web Store. Load it from source:

1. Download this repo (**Code → Download ZIP**) and unzip it, or clone it.
2. Open `chrome://extensions` (or `edge://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and pick the folder that holds `manifest.json`.
5. Pin the icon to your toolbar.

There is no build step. The folder is the extension.

## Privacy

- No sign-in, no Google account, no API key.
- Channel and video data comes only from public `www.youtube.com` endpoints
  that anyone can open. Those requests go out without your YouTube cookies.
- Thumbnails and channel pictures load from YouTube's own image servers.
- Your channels, feed, settings and stats stay in your browser's extension
  storage. Nothing is sent anywhere else. There are no analytics.

### Permissions

| Permission | Why |
|---|---|
| `storage` | Keep your channels, feed, settings and stats. |
| `alarms` | Check your channels on a schedule. |
| `notifications` | Tell you about new uploads. |
| `activeTab` | Add the channel of the tab you are on, when you press Add. |
| `declarativeNetRequestWithHostAccess` | YouTube rejects requests that come from an extension address. One rule sets the request origin to `youtube.com`, for this extension's own requests only. |
| `https://www.youtube.com/*` | Read public channel data, and run audio mode on YouTube pages. |

## Development

Plain JavaScript modules. No dependencies, nothing to install.

```bash
npm test        # run every test suite
npm run check   # manifest is valid, every file parses, popup links resolve
```

Both must pass before a change counts as done. Tests run on saved YouTube
responses in `test/fixtures/` and never touch the network.

```
src/
  background/   service worker: scheduled checks, alerts, badge
  content/      audio mode on youtube.com pages
  lib/          YouTube parsing, storage, settings, backup, i18n
  popup/        the popup: Audio, Feeds, Watchlist, Settings
_locales/       English and Arabic strings
test/           test suites and fixtures
```

[DESIGN.md](DESIGN.md) is the full spec: how each YouTube endpoint behaves,
the storage format, and the things that are easy to get wrong.
