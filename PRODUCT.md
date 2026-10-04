# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

People who watch YouTube in Chrome or Edge on desktop. They want to follow channels without a Google account or the recommendation algorithm, and many of them also listen rather than watch, so they care about saving data. They open a small 400×600 popup for a quick look at what is new, then go back to what they were doing. Readers of English and Arabic (full right-to-left) are both first-class.

## Product Purpose

Companion for YouTube is a Manifest V3 browser extension. It gives account-free subscriptions: a merged, time-sorted feed of the channels you add (by URL, handle or id, or imported from your own signed-in YouTube tab), a per-channel sheet inside the popup, and desktop alerts on new uploads. Audio mode pins the player to 144p with a cover over it, so listening uses far less data. Up next is a listen-later queue that stays in step with YouTube's own queue. Success: someone can follow and hear their channels with no sign-in, no tracking, and no noise.

## Positioning

No account, no tracking. Nothing is signed in by us: no API key, no OAuth, public endpoints only, no cookies, nothing collected, no dependencies. Audio mode and the queue mirror sit on top of that. A neighbouring extension that needs an account, a server or analytics could not truthfully say this.

## Operating Context

- Runs in Chrome and Edge as a MV3 extension. Plain ES modules, no build step; what is in `src/` is what the browser loads.
- Surfaces: the popup (tabs Player, Feeds, Watchlist, Settings), a welcome page shown once on a fresh install, a What's new page offered as a dismissible line after an update, an in-page audio overlay and subscription-page chips on youtube.com, desktop notifications, and `site/` (project page and uninstall page on GitHub Pages).
- Distribution is through the Chrome Web Store and Edge Add-ons; versions ship only when the owner says so (`RELEASING.md`).

## Capabilities and Constraints

- Popup tabs in this order: Player, Feeds, Watchlist, Settings. Feeds has no read state and no hiding; a small New tag marks videos newer than the last open.
- One list: the Watchlist is the subscription list. Groups, favourites, mute, search, and Shorts hiding narrow or shape the feed.
- Alerts: one notification per channel per check, never one per video.
- Hard technical limits: no `DOMParser` in the service worker; the popup shows images only from hosts in the manifest's `img-src`; no `confirm()` or `alert()` in the popup (use inline confirm rows); the audio overlay and `site/` keep their own look; theme (System, Light, Dark) applies to the popup, welcome and What's new pages.
- Full product decisions live in `CLAUDE.md` and are not repeated here.

## Brand Commitments

- The name is **Companion for YouTube** (Arabic **رفيق ليوتيوب**). Never "YouTube Companion": store review treats that as impersonation. The store name is "Companion for YouTube: Audio Only & Feeds" (under 45 characters); the popup and welcome page show the short name.
- The icon and accent are purple, not YouTube red, for the same reason.
- Both English and Arabic are first-class, with full RTL and a language override in Settings.

## Evidence on Hand

- Published and live on the Chrome Web Store and Edge Add-ons; release notes in `CHANGELOG.md`; store answers in `store/LISTING.md`.
- Real screenshots in `docs/screenshots/` and `store/images/`, generated from the real popup.
- Measured YouTube behaviour in `docs/youtube.md`.
- No testimonials, user counts or ratings are recorded; do not invent any.

## Product Principles

1. Nothing about the person leaves their device. If a feature needs an account, a key or a server, it does not ship.
2. The feed is a timeline, not a to-do list: no read state, no hiding, no engagement tricks.
3. Quiet by default: one alert per channel per check, nothing opens by itself on an update.
4. Say what is happening in plain words, in both languages, and never claim to be YouTube.
5. Small and finished: a 400×600 popup that is fast to scan and has no stages-of-a-plan language.

## Accessibility & Inclusion

Full right-to-left support and complete Arabic copy are required. No formal accessibility standard (such as WCAG level) has been set; record as undecided.
