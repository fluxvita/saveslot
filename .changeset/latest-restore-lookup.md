---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-pglite": patch
---

Finding the latest restore or import no longer walks the whole log on a large store (0.6 s at a million events before); what it finds is the same.
