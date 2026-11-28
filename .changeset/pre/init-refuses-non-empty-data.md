---
"@fluxvita/saveslot-service": patch
"@fluxvita/saveslot-daemon": patch
"@fluxvita/saveslot": patch
---

`saveslot init` refuses a data directory that is already there and not empty (exit code 5), before it makes anything of the home, and says how to carry data over with export and import. Before, it opened what was there, which could upgrade an older store in place without a backup and then fail.
