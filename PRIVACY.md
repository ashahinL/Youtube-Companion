# Privacy policy — Companion for YouTube

_Effective 13 September 2026._

_Changes for 2.0 take effect when 2.0 is published._

_Import from your signed-in YouTube tab, and your groups on YouTube's
Subscriptions page, take effect when the next version is published._

Companion for YouTube is a browser extension for Chrome and Edge. It has no
server, no account and no analytics. This page says exactly what it touches.

## What it stores

Everything stays in your browser's extension storage, on your device:

- the channels you add, which ones you starred, and which ones you muted
  (mute turns off that channel's alerts; backups keep it);
- the recent videos from those channels (title, publish time, length, view
  count), capped at the number you choose in Settings;
- your settings;
- audio-mode listening totals (seconds listened, by day, kept for 90 days,
  plus running totals);
- the audio-mode cover picture you choose (it stays on this device and is
  not in backups).

Nothing is copied off your device. Removing the extension deletes all of it.
**Export** in Settings writes a file to your computer; nothing else sees it.

**Import from YouTube** runs in your own YouTube tab, only when you press it.
It opens your All subscriptions page (`www.youtube.com/feed/channels`) there,
signed in as you already are, and reads the channels listed on it. If more
than one Google account is signed in to your browser, it loads that same page
once for each account so you can choose one, and asks YouTube's own account
switcher for the accounts' names, the same list YouTube shows when you click
your picture. For each account it shows its name, picture and how many
channels it follows, never its email address. The names are shown on that page
only: they are not stored and not sent anywhere. The extension keeps only each
imported channel's id, name and handle. It does not sign in to Google itself, and the list is not sent
anywhere.

If you are signed out of YouTube, a Google Takeout file works too: you
download `subscriptions.csv` from Google Takeout yourself, and the extension
reads it on your device and keeps only each channel's id and name.

## What it requests from the internet

- **`www.youtube.com`** — public channel feeds and public video details, the
  same pages anyone can open without signing in. These requests are sent
  **without your YouTube cookies**, so YouTube cannot tie them to your
  account.
- **`i.ytimg.com`, `yt3.ggpht.com`, `yt3.googleusercontent.com`** — video
  thumbnails and channel pictures, loaded as images, including the channel
  picture on an alert.

The one request made with your YouTube session is **Import from YouTube**
(above): it reads your own subscriptions page from inside your YouTube tab,
the way YouTube loads that page for you.

It sends nothing to any other server, and it never sends your channel list,
settings, listening totals or cover picture anywhere.

**When you remove the extension**, your browser opens a short page at
`ashahinl.github.io` on GitHub Pages. Visiting it is a normal GitHub Pages
visit: GitHub may log the address, which carries only the extension's
language and version. Nothing is sent unless you post the GitHub issue the
page fills in for you.

## On YouTube pages

Audio mode runs a script on `www.youtube.com` pages so it can lower the video
quality, cover the video and control playback. It reads the title and channel
of the video you are playing to show them in the popup. That information stays
on your device.

When you press **Import from YouTube**, a script on your All subscriptions
page reads the channels listed there, as described above.

On YouTube's Subscriptions page, the extension shows your groups as buttons
above the videos. To hide the videos of channels outside the group you pick,
it reads the channel name and handle on each video and compares them with your
list, on your device. Nothing is sent anywhere. A switch in Settings turns
this off.

## What it does not do

- No sign-in of its own and no API key. It never sees your Google password.
- No analytics, no crash reporting, no ads, no tracking.
- No selling or sharing of data — there is no data to share.
- No reading of your browsing outside `www.youtube.com`.

## Donations

The popup's Support sheet links to PayPal and shows an InstaPay address. The
extension does not record whether you open it. If you choose to donate, that
happens on PayPal's or your bank's own service, under their privacy policies.

## Permissions

| Permission | Used for |
|---|---|
| `storage` | Keeping the data listed above on your device. |
| `alarms` | Checking your channels on the schedule you choose. |
| `notifications` | Telling you when a channel uploads. |
| `activeTab` | Adding the channel of the tab you are on, only when you press **Add**. |
| `declarativeNetRequestWithHostAccess` | YouTube rejects requests that come from an extension address. One rule sets the origin and referrer of this extension's own `www.youtube.com` requests to YouTube's, and touches no other request. |
| `https://www.youtube.com/*` | Reading public channel data, running audio mode on YouTube pages, reading your All subscriptions page when you import, and showing your groups on YouTube's Subscriptions page. |

## Changes and contact

Changes to this policy are published in this file, with its history, at
<https://github.com/ashahinL/Youtube-Companion/blob/main/PRIVACY.md>.
Questions: open an issue at
<https://github.com/ashahinL/Youtube-Companion/issues>.

Companion for YouTube is not affiliated with, endorsed by or sponsored by
YouTube or Google. YouTube is a trademark of Google LLC.
