---
"@fluxvita/saveslot-contract": minor
"@fluxvita/saveslot-kernel": minor
"@fluxvita/saveslot-server": minor
"@fluxvita/saveslot-cli": minor
"@fluxvita/saveslot": minor
---

A conflict item's `previous` leaves out a value a pending deletion removed, and carries `partially_deleted`, a new optional field of `ConflictDetail.previous`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
