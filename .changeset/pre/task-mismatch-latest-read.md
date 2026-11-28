---
"@fluxvita/saveslot-kernel": patch
---

`read_first`'s `task_mismatch` names the latest read made under another task, and the least task by code point when two are at the same position. Before, it named whichever such read the query met first.
