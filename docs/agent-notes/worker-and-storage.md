# Worker and storage

Read this before changing `src/background/service-worker.js`, `src/lib/store.js`, alarms, alerts or stored flags.

Moved word for word from CLAUDE.md on 2026-11-09. "This file" and "the list below" can mean CLAUDE.md.

- **Never notify on the seed.** A newly added channel backfills up to 15
  videos; those must be marked as already-alerted silently, or adding 40
  channels fires 40 alerts. Add replies once the channel is stored; the seed
  runs after. A kill between them is fine: the row stays unseeded, and the
  next check fills it without alerts. Ids added during a check are queued
  for one follow-up seed.
- **A stranded `pollState.running: true` survives restarts forever.** MV3 kills
  the worker, not only the browser, without warning between raising and
  lowering a flag, and `storage.local` outlives reloads. Reconcile at every
  worker start, before any sweep reads the flag. This is the exact bug poppo
  hit. If that first write fails, a later sweep still treats stored
  `running` as leftover when this worker is not sweeping.
- **A listing is its `addedAt`.** A check that already snapshotted the list
  must drop rows, stamps, and alerts for an id that was removed or added
  again before it wrote. Re-read the list in the same storage get as the
  feed write.
- **Every read-change-write of stored lists goes through a lock.**
  `store.js` runs changes to the channel list and feed on one chain
  (`withListLock`), and poll state and Up next on their own. Two messages
  at once used to read the same old list, and the second write wiped the
  first change. The worker's multi-step writes (import, replace, undo,
  clear, backup) take `withListLock` too. A job must never call a helper
  that takes the same lock, or it waits on itself forever; a test that
  injects a change inside a locked read hangs the same way.
- **Only `at > 0` is a real upload time.** A missing RSS `<published>` is
  `at: 0`. Treating 0 as finite overwrites the player's time, and that id
  is never classified again.
- **`alarms.create` on an existing name restarts its countdown from now.**
  Recreating alarms on every settings write meant any settings change pushed
  the next check a full interval away.
- **Chrome floors alarm periods at 1 minute** and silently clamps anything
  lower.
- **Persist a durable flag the moment it changes**, not at the next convenient
  write. MV3 can kill the worker in between; clearing a flag in memory and
  letting a later batch carry it gave poppo an endless re-seed loop.
- **A worker reply's `error` is a code, never a sentence.** The pages put
  it into words through `errorText` in `src/lib/view.js`; a new code a page
  can show gets a key there, in both locales, or it reads as "Something
  went wrong". A thrown error other than a `YtError` is logged in the worker
  and answered as `failed`.
- **A list of hundreds of channels costs per check, not per add.** Each
  channel brings 15 uploads; a check classifies only the ones new enough to
  stay in the capped feed (`feedFloor`), and a channel's `lastVideoAt` never
  goes down, because it is what keeps old rows quiet when a removed channel
  makes room for them. A check also calls an extension API every 25 seconds:
  Chrome stops a worker that only has fetches in flight.
  A check writes the feed and that batch's channel patches every 25
  channels (`SWEEP_BATCH`), and alerts once at the end, only for rows
  still in the feed; a channel's `seeded` can therefore be stored before
  its check's alert goes out.
