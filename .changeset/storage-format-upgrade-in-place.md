---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-pglite": patch
"@fluxvita/saveslot-store-postgres": patch
"@fluxvita/saveslot-server": patch
"@fluxvita/saveslot-daemon": patch
"@fluxvita/saveslot": patch
---

A store whose storage format is older is upgraded in place when it is opened, step by step, and a store of a newer format than this version knows is refused (`format_too_new`; one too old to upgrade, `format_too_old`). No upgrade step exists yet. While an upgrade runs, the local service's `/health` says `starting` with the step, `saveslot mcp` answers each call `unavailable` naming it, and a failed upgrade is `upgrade_failed` with its step, after which `saveslot start` exits with code 5.
