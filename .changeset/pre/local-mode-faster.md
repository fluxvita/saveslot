---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-pglite": patch
---

Local mode is faster on large stores: the store gathers the database planner's statistics itself when they are stale (none of the user's content goes into them), a write's receipt no longer scans all stored content, and opening a store after a crash makes about half the file syncs it did.
