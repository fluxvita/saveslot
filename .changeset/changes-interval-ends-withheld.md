---
"@fluxvita/saveslot-contract": minor
"@fluxvita/saveslot-kernel": minor
"@fluxvita/saveslot-server": minor
"@fluxvita/saveslot-cli": minor
"@fluxvita/saveslot": minor
---

`history` `changes` on a state table leaves out an end of a changed stretch that came from content a pending deletion removed, and marks the entry `partially_deleted`; stretches cut only inside removed content run together. An entry's `valid` is a `ChangeInterval`, new: an `Interval` whose ends may be missing. MCP and the CLI write a missing end as "(deleted)". Privacy deletion is not offered in this version, so no read gives it yet.
