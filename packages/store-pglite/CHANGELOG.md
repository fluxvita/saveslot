# @fluxvita/saveslot-store-pglite

## 0.2.0-rc.0

### Minor Changes

- d5d9c8f: Before the local service upgrades a storage format in place, it backs the home's data up next to the home, as a home the version before can open; saveslot never removes it. A failed backup stops the upgrade at step `backup`, and `saveslot start` says what to do. It can be skipped with `upgrade.backup = false` or `saveslot start --no-upgrade-backup`.
- d5d9c8f: A query reads only the page it returns, instead of every matching row: the first page on event tables and on state tables read at a point, the first page of a state table read over an interval with no order asked for, and later pages where they can be. Large tables page much faster; the rows, their order, `total` and the pages are the same. A later page's position now carries `total`, so an earlier build does not read a position made by this one.
- d5d9c8f: A read by record time (`history`'s `as_of` and `changes`, a query's later pages) leaves out a value a pending deletion removed and marks it `partially_deleted`; a `changes` entry gains `partially_deleted` as a new optional field. Privacy deletion is not offered in this version, so no read has it yet.
- d5d9c8f: The `sources` reads give `total`: for a list, every source the filters take; for a search, every match, when every source the filters take fits in one call's scan (past that, no `total` is given and the next position says more may follow).
- d5d9c8f: A store whose storage format is older is upgraded in place when it is opened, step by step, and a store of a newer format than this version knows is refused (`format_too_new`; one too old to upgrade, `format_too_old`). No upgrade step exists yet. While an upgrade runs, the local service's `/health` says `starting` with the step, `saveslot mcp` answers each call `unavailable` naming it, and a failed upgrade is `upgrade_failed` with its step, after which `saveslot start` exits with code 5.

### Patch Changes

- d5d9c8f: A write recomputes a derived table only for the groups its rows were or are in, when the rule reads one event or timeless table on its own as a grouped or whole aggregate; other rules are recomputed whole as before. The derived rows are the same. A rule that fails on the data fails the write as `validation_failed` (`rule_eval_failed`) wherever it is evaluated.
- d5d9c8f: On a large store, writes and reads no longer spend time finding the latest restore or import by walking the whole log (0.6 s at a million events before); what they find is the same.
- d5d9c8f: Local mode is faster on large stores: the store gathers the database planner's statistics itself when they are stale (none of the user's content goes into them), a write's receipt no longer scans all stored content, and opening a store after a crash makes about half the file syncs it did.
- 7dd7cb1: `saveslot --version` and `saveslot --help` work on musl distributions such as Alpine. Before, every command exited with a stack trace there, because the addon behind local mode's writer lock, which has prebuilds for glibc only, was loaded when the command started; it is now loaded when a lock is first taken. Commands that take the lock still fail on musl.
- Updated dependencies [12c23c6]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [90ab30a]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [fc9a36e]
- Updated dependencies [3ae6e08]
- Updated dependencies [51f75c4]
- Updated dependencies [a7d57b0]
- Updated dependencies [9bf87e1]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d2a3d6b]
  - @fluxvita/saveslot-kernel@0.2.0-rc.0

## 0.1.0

### Patch Changes

- @fluxvita/saveslot-kernel@0.1.0

## 0.1.0-rc.0

### Patch Changes

- @fluxvita/saveslot-kernel@0.1.0-rc.0
