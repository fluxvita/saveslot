---
"@fluxvita/saveslot-kernel": patch
---

On a field group, two writes of the same value to one field where the version seen had no value are no longer judged a conflict: a field the write did not set counts as empty there, as it does without the group.
