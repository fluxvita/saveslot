---
"@fluxvita/saveslot-kernel": patch
---

An `undo` of a confirmation now records every field and existence the confirmed write wrote, as spec 09 §5.7 says, not only those the confirmation put into effect then. Before, when a write was partly awaiting and partly a candidate (or already in effect), undoing its confirmation left the other fields out of the record, so a later deletion that put one of them into effect through that confirmation would not have had it taken back by the undo. What an undo writes back now is unchanged; records already in the log are not rewritten.
