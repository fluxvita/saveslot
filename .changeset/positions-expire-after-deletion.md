---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-contract": patch
"@fluxvita/saveslot-contract-core": patch
"@fluxvita/saveslot-server": patch
"@fluxvita/saveslot": patch
---

A paging cursor expires once a deletion is confirmed or cancelled in the tenant after its first page: the next page is refused with `handle_expired`, reason `deletion_changed` (new), and the caller reads again from the first page. What a read leaves out changed between the pages, so one round of paging could have given a stretch twice or missed one. A deletion carried out without a confirmation or cancellation in between does not expire a cursor. Privacy deletion is not offered in this version, so no cursor expires this way yet.
