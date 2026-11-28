---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-pglite": patch
---

On a large store, writes and reads no longer spend time finding the latest restore or import by walking the whole log (0.6 s at a million events before); what they find is the same.
