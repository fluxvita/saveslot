---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-postgres": patch
"@fluxvita/saveslot-service": patch
---

In server mode a read is recorded before it is answered: its read records are written into the tenant's database in a transaction of their own, which takes no tenant lock, instead of waiting in the process for the tenant's next write or close. A read is no longer lost when the process exits or its connection goes away, and a write without `ver` falls back to it even when it comes after the tenant was opened again. When the records cannot be written, the read is answered `unavailable` (`busy`, `retry_after` 1) and its content is not given. The version last read and `since: "my_last_read"` now follow the latest position read, not the latest record written. Local mode keeps its read buffer as before.
