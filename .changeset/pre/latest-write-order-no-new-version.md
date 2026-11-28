---
"@fluxvita/saveslot-kernel": patch
---

Changing an optional field on a stretch of a state table where the entity has no value no longer counts as a new version, and so no longer moves that entity ahead in the order of the most recently written within one request. `ver` and receipts do not change.
