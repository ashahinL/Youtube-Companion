# Releasing

How a version of Companion for YouTube gets from `dev` to `main` and the stores.

## The rule

**A version number is what users get from the stores.** Nothing else gets
one.

- Work lands on `dev` all the time. Each store reviews one version at a
  time, and a review can take days, so the stores are usually behind `dev`.
  That is normal.
- A version, its tag, its GitHub release and its store upload all happen on
  the same day. There is no tag that never shipped, and no store version
  without a tag.
- Planned groups of work (Safety basics, Steadier checks, …) are not
  versions. On ship day, everything finished on `dev` goes out together.

## Branches

- **`main` holds only what has shipped.** Every commit on it is a released
  version, or a note about one (a store link, the store table). GitHub shows
  `main`, so its README matches what people can install.
- **`dev` is where work happens.** `npm run check` and `npm test` pass at
  every commit, and nothing half-built lands. A feature that takes many
  commits lives on its own branch off `dev` and merges into `dev` when it is
  finished.
- A note that goes straight to `main` is merged into `dev` right after, so
  `main` never has a commit `dev` lacks.

## Between ships

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

- The next ship is `2.0.0`. It jumps from the store's `1.0.0`. The files
  still say `1.1.0` from an earlier plan; that number never shipped, and it
  changes to `2.0.0` on ship day, not before.
- After `2.0.0`, new things or changes: next minor. `2.0.0` → `2.1.0`.
- After `2.0.0`, only bug fixes: next patch. `2.0.0` → `2.0.1`.
- After `2.0.0`, numbers go up by one and never skip.
- `manifest.json` takes numbers and dots only. No `-beta`.

## Ship day

1. **Check `dev`.** Clean `git status`, `npm run check` and `npm test` green,
   and the last GitHub Actions run on `dev` green. Steps 2 to 6 happen on
   `dev`.
2. **Test by hand on youtube.com.** Reload the extension on
   `chrome://extensions` first, then reload the YouTube tab (reloading
   YouTube alone does not load the new script). Confirm the live scripts
   by the version on that page after Reload, and by inspecting them in
   DevTools → Sources → Content scripts — not a mark on the YouTube page.
   Then:
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
7. **Commit, move `main` up to it, and tag.**
   ```bash
   git commit -am "Version X.Y.Z"
   git switch main
   git merge --ff-only dev
   git tag -a vX.Y.Z -m "Companion for YouTube X.Y.Z"
   git push origin main dev vX.Y.Z
   git switch dev
   ```
   If `--ff-only` refuses, `main` has a commit `dev` lacks: merge `main` into
   `dev`, run the gates again, and repeat this step.

   If `site/` changed, the push publishes it to GitHub Pages
   (`.github/workflows/pages.yml`). Check that run is green and that
   <https://ashahinl.github.io/Youtube-Companion/> and
   <https://ashahinl.github.io/Youtube-Companion/uninstall.html> open: the
   home page is what the stores and the README link to, and every installed
   copy sends people to the uninstall page when they remove the extension.
   Pages must be on in the repository settings (Source: GitHub Actions)
   before the first such push.
8. **Pack and release.** `npm run pack` from `main` at the tag, then make the
   GitHub release `vX.Y.Z`, titled "Companion for YouTube X.Y.Z", with that
   version's changelog section as the notes and
   `dist/companion-for-youtube-X.Y.Z.zip` attached.
9. **Upload to both stores.** Upload the zip as a new package on the
   existing item, not a new item. Change the listing text or images only if
   they changed; the words to paste are in `store/LISTING.md`.
10. **Write it down.** In `store/LISTING.md`: the date each store got it, and
    the zip's size and SHA-256.

## After review

- **Approved:** update the store table in `store/LISTING.md` on `main`. The
  first time a listing goes live, put its link in the README's install
  section. Drop the `*(coming in X.Y)*` markers this version made true — the
  README on `main` describes what people can install, so they come off when
  both stores have published, not when the tag is made. Merge `main` into
  `dev`.
- **Rejected:** write the reason in `store/LISTING.md`, fix it on a branch
  from `main`, ship the fix alone as the next patch version, and merge `main`
  into `dev`.
