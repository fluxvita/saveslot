---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-pglite": patch
"@fluxvita/saveslot-store-postgres": patch
---

The storage port's `purgeResidue(tables)` cleans up the residue a physical deletion leaves, in place, on both backends: the tables rewritten, the statistics and the write-ahead log, then a check. It answers whether it got done (`ok: false` with `dead_not_removable` or `snapshot_timeout` is no failure), and refuses a name that is not one of the tenant's tables. PGlite now runs with `wal_recycle=off`. A PostgreSQL store reports at open whether its role and instance allow the in-place clean-up (`residueMode`), and a step refused for want of a grant throws `purge_permission`. Nothing calls it yet: privacy deletion is not offered in this version.
