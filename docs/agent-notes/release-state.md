# Release state

Read this before changing a release, a store listing, the version files or the site tour.

Moved word for word from CLAUDE.md on 2026-11-09. "This file" and "the list below" can mean CLAUDE.md.

**1.0.0 has shipped**: GitHub release `v1.0.0` with the store zip attached.
Both stores got the same zip on 2026-09-13. Chrome published it on
2026-09-14; Edge had it live by 2026-09-16. `store/LISTING.md`
holds the store IDs and every answer given. Chrome blocks every extension from
its Web Store pages, so the Chrome dashboard is clicked through by hand from
that file; no browser automation reaches it.
When a listing goes live, its link goes in the README's install section.
Release notes are `CHANGELOG.md`.

**2.0.0 was tagged and released on 2026-09-19**, after the owner hand-tested
it. Chrome published it on 2026-09-20; Edge had it live by 2026-09-26.

**2.1.0 was tagged and released on 2026-09-26**: Import from YouTube, groups
on YouTube's own Subscriptions page, the theme setting, and the audit's
fixes. Chrome had it live by 2026-10-02; Edge by 2026-10-10.

**2.2.0 was tagged and released on 2026-10-11**: Up next mirrored with
YouTube's own queue, one alert per check, Send feedback, the shorter
Settings, and the new icon. It never went to a store: a review found
fixes first, and **2.2.1, tagged and released on 2026-10-16**, is the
first store build of 2.2. The store uploads are clicked through by hand
from `store/LISTING.md`, which records where each store stands. The version
files read 2.2.1 and do not change again until the next ship day. Nothing
ships until the owner says so, and not while a store still has a version in
review. Finished work waits under `## Unreleased` in the CHANGELOG.

The tour on the site (`site/tour/`) plays the real popup through every
feature; `npm run tour:record` turns it into the MP4 for YouTube and the
store listings.

**How versions work: `RELEASING.md`.** A version number is what users get
from the stores. The version, its tag, its GitHub release and its store upload
happen on the same day, only when the owner says so. Planned groups of work
are not versions, and no tag is made between ships.
