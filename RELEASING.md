# Releasing

How a version of Companion for YouTube gets from `main` to the stores.

## The rule

**A version number is what users get from the stores.** Nothing else gets
one.

- Work lands on `main` all the time. Each store reviews one version at a
  time, and a review can take days, so the stores are usually behind `main`.
  That is normal.
- A version, its tag, its GitHub release and its store upload all happen on
  the same day. There is no tag that never shipped, and no store version
  without a tag.
- Planned groups of work (Safety basics, Steadier checks, …) are not
  versions. On ship day, everything finished on `main` goes out together.

## Between ships

- **`main` is always ready to ship.** `npm run check` and `npm test` pass at
  every commit, and nothing half-built lands. A feature that takes many
  commits lives on its own branch and merges when it is finished.
- Every change adds its line under `## Unreleased` at the top of
  `CHANGELOG.md`, in the groups New, Safer, Fixes, For contributors.
- The version in `manifest.json` and `package.json` changes only on ship day.

## When to ship

When the owner says so, and only when **neither store has a version in
review**. Both stores always get the same zip, so if one is still reviewing,
wait for it.

To send a new version while one is in review, you have to cancel that review
and wait in line again. Do that only for a fix that cannot wait.

## The number

- New things or changes: next minor. `1.1.0` → `1.2.0`.
- Only bug fixes: next patch. `1.1.0` → `1.1.1`.
- `2.0.0` is kept for the listen-later queue and the launch.
- Numbers go up by one and never skip.
- `manifest.json` takes numbers and dots only. No `-beta`.

## Ship day

1. **Check `main`.** Clean `git status`, `npm run check` and `npm test` green,
   and the last GitHub Actions run green.
2. **Test by hand on youtube.com.** Reload the extension first (reloading
   YouTube is not enough; check `data-am-beacon` on `<html>`). Then:
   - audio mode on and off
   - a feed video opened in audio mode
   - add a channel, remove it, undo
   - an alert for a new upload
   - anything this version changed
3. **Images.** If the popup looks different, run `npm run shots` and open
   every image before using it (`store/LISTING.md` → Images).
4. **Set the version** in `manifest.json` and `package.json`.
5. **Date the changelog.** Rename `## Unreleased` to `## X.Y.Z — YYYY-MM-DD`
   and start a new empty `## Unreleased` above it.
6. **Update where things stand.** The "Where things stand" section of
   `CLAUDE.md`, and the store table in `store/LISTING.md`.
7. **Commit and tag.**
   ```bash
   git commit -am "Version X.Y.Z"
   git tag -a vX.Y.Z -m "Companion for YouTube X.Y.Z"
   git push origin main vX.Y.Z
   ```
8. **Pack and release.** `npm run pack` from that clean tree, then make the
   GitHub release `vX.Y.Z`, titled "Companion for YouTube X.Y.Z", with that
   version's changelog section as the notes and
   `dist/companion-for-youtube-X.Y.Z.zip` attached.
9. **Upload to both stores.** Upload the zip as a new package on the
   existing item, not a new item. Change the listing text or images only if
   they changed; the words to paste are in `store/LISTING.md`.
10. **Write it down.** In `store/LISTING.md`: the date each store got it, and
    the zip's size and SHA-256.

## After review

- **Approved:** update the store table in `store/LISTING.md`. The first time a
  listing goes live, put its link in the README's install section.
- **Rejected:** write the reason in `store/LISTING.md`, fix it on `main`, and
  ship the fix as the next patch version.
