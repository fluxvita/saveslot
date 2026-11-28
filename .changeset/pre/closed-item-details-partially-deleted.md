---
"@fluxvita/saveslot-contract": minor
"@fluxvita/saveslot-kernel": minor
"@fluxvita/saveslot-server": minor
"@fluxvita/saveslot-cli": minor
"@fluxvita/saveslot": minor
---

A closed item's details leave out a value a pending deletion removed: a conflict's `effective`, an awaiting item's `current` and a flagged item's `matched_values`. Each carries `partially_deleted`, a new optional field of `ConflictDetail.effective`, `AwaitingDetail.current` and `FlaggedDetail`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
