---
"@fluxvita/saveslot-contract": patch
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-server": patch
"@fluxvita/saveslot-cli": patch
"@fluxvita/saveslot": patch
---

A conflict item's `previous` leaves out a value a pending deletion removed, and carries `partially_deleted`, a new optional field of `ConflictDetail.previous`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
