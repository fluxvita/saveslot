# @fluxvita/saveslot-contract-core

## 0.2.0-rc.0

### Patch Changes

- 90ab30a: A paging cursor expires once a deletion is confirmed or cancelled in the tenant after its first page: the next page is refused with `handle_expired`, reason `deletion_changed` (new), and the caller reads again from the first page. What a read leaves out changed between the pages, so one round of paging could have given a stretch twice or missed one. A deletion carried out without a confirmation or cancellation in between does not expire a cursor. Privacy deletion is not offered in this version, so no cursor expires this way yet.

## 0.1.0

No changes in this release.

## 0.1.0-rc.0

No changes in this release.
