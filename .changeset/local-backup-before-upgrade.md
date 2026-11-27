---
"@fluxvita/saveslot-store-pglite": minor
"@fluxvita/saveslot-service": minor
"@fluxvita/saveslot-daemon": minor
"@fluxvita/saveslot": minor
---

Before the local service upgrades a storage format in place, it backs the home's data up next to the home, as a home the version before can open; saveslot never removes it. A failed backup stops the upgrade at step `backup`, and `saveslot start` says what to do. It can be skipped with `upgrade.backup = false` or `saveslot start --no-upgrade-backup`.
