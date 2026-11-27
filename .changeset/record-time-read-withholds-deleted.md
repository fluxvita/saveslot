---
"@fluxvita/saveslot-kernel": minor
"@fluxvita/saveslot-store-pglite": minor
---

A read by record time (`history`'s `as_of` and `changes`, a query's later pages) leaves out a value a pending deletion removed and marks it `partially_deleted`; a `changes` entry gains `partially_deleted` as a new optional field. Privacy deletion is not offered in this version, so no read has it yet.
