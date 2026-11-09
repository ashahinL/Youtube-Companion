# Popup, site, tests and tools

Read this before changing `src/popup/`, What's new, `site/`, tests, screenshots or packing.

Moved word for word from CLAUDE.md on 2026-11-09. "This file" and "the list below" can mean CLAUDE.md.

- **`confirm()` / `alert()` in a popup** blocks it and can wedge the extension.
  Use inline confirm rows.
- **Headless Chromium will not lay out narrower than its minimum window
  width**, whatever `--window-size` says. A 400px popup rendered directly
  gets `position: fixed` sheets that run off its edge. `npm run shots`
  renders the popup inside a 400×600 iframe for that reason.
- **CRLF breaks tests.** Several popup checks regex the source with a length
  bound (`[\s\S]{0,240}`), and a Windows `core.autocrlf` checkout adds a byte
  per line. `.gitattributes` pins LF; a checkout made before it needs its
  files rewritten with LF once.
- **A test that asserts a call exists is not a test.** A structural grep once
  passed while the handler holding the call was unreachable. Popup behaviour
  goes in `test/popup-run.js`, which loads the real `popup.html` into a fake
  DOM (`test/helpers/fake-dom.js`) and clicks it. Anything that must
  actually fire on youtube.com is checked in a browser by hand.
- **An extension cannot assign its own keyboard shortcut.** `suggested_key`
  applies only at install, and when the combination is taken Chrome registers
  the command with no shortcut, silently (Dark Reader had `Alt+Shift+A`).
  Anything that shows the shortcut reads `chrome.commands.getAll()` and must
  make sense when it is empty.
- **`WHATS_NEW_VERSION` is bumped by hand and is not the manifest version.**
  It says which release the What's new page is about, so bumping the manifest
  for a fixes-only patch does not ask everyone to look at an unchanged page.
  Change it in the same commit that rewrites the page's content, and change
  the copy in both locales.
- **`render()` draws only the open tab.** A hidden tab's DOM is whatever it
  was when it was last open, and `activate()` draws a tab as it opens. Code
  that reads a hidden tab's elements after `render()` reads stale ones, and
  `scripts/shots/stub.js` waits on the Player tab's first draw for that reason.
- **`popupOpened` moves `lastSeenAt` before it replies.** The popup's "new"
  dots need the value from the previous visit, so the reply carries
  `previousLastSeenAt` and the popup holds it for as long as it is open.
  Reading `pollState.lastSeenAt` from that same reply marks nothing as new.
- **The popup loads images only from hosts in the manifest's `img-src`.**
  A picture from any other host is blocked without an error in the page;
  `test/skeleton.test.js` checks the policy against `thumbUrl` and
  `isAvatarUrl`, so a new image host goes into both.
- **Installed copies link to `site/uninstall.html` forever.** The worker's
  `UNINSTALL_PAGE` is set in every install, so renaming or moving that page,
  or turning off GitHub Pages, breaks the link for everyone who already has
  the extension. Its Send needs the feedback worker live and
  `TURNSTILE_SITE_KEY` set in `site/feedback.js`; without them Send stays
  off, so neither goes to `main` before the worker is deployed.
- **Compressed bytes differ between Node builds.** Homebrew's Node links system
  zlib and packs the same tree to a different zip hash than a Node with its own
  zlib. Compare files or pixels, never deflate output, across machines.
- **Store screenshots are only as good as the frame the stub caught.** Open
  every image `npm run shots` writes before it ships; an empty frame went out
  in 1.0.0 and is far smaller on disk than its siblings.
