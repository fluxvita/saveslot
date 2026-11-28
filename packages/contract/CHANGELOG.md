# @fluxvita/saveslot-contract

## 0.2.0-rc.0

### Minor Changes

- 12c23c6: A closed item's details leave out a value a pending deletion removed: a conflict's `effective`, an awaiting item's `current` and a flagged item's `matched_values`. Each carries `partially_deleted`, a new optional field of `ConflictDetail.effective`, `AwaitingDetail.current` and `FlaggedDetail`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
- d5d9c8f: A conflict item's `previous` leaves out a value a pending deletion removed, and carries `partially_deleted`, a new optional field of `ConflictDetail.previous`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
- d5d9c8f: The `sources` reads give `total`: for a list, every source the filters take; for a search, every match, when every source the filters take fits in one call's scan (past that, no `total` is given and the next position says more may follow).
- d5d9c8f: `TimelineResultCode` gains `removed`, for a `history` timeline item whose content a deletion removed (before, such an item came out with an empty result). MCP and the CLI write it as "(removed by a deletion)". Privacy deletion is not offered in this version, so no item has it yet.

### Patch Changes

- 90ab30a: A paging cursor expires once a deletion is confirmed or cancelled in the tenant after its first page: the next page is refused with `handle_expired`, reason `deletion_changed` (new), and the caller reads again from the first page. What a read leaves out changed between the pages, so one round of paging could have given a stretch twice or missed one. A deletion carried out without a confirmation or cancellation in between does not expire a cursor. Privacy deletion is not offered in this version, so no cursor expires this way yet.
- Updated dependencies [90ab30a]
  - @fluxvita/saveslot-contract-core@0.2.0-rc.0

## 0.1.0

### Patch Changes

- @fluxvita/saveslot-contract-core@0.1.0

## 0.1.0-rc.0

### Patch Changes

- @fluxvita/saveslot-contract-core@0.1.0-rc.0
