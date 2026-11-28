---
"@fluxvita/saveslot-kernel": patch
---

On a table with more than one field that defines "has a value", a write that continues a stretch with a value across a stretch without one, and changes only one of those fields, is no longer held for confirmation: a boundary is erased only when all of them are the same on both sides. The fields listed as erased are all of them.
