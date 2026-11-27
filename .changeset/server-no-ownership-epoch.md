---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-postgres": patch
"@fluxvita/saveslot-service": patch
"@fluxvita/saveslot-daemon": patch
---

In server mode, a tenant's PostgreSQL storage no longer has an owner. Opening it no longer raises an ownership epoch, a write no longer checks one, and no opener makes another give the tenant up (`ownership_lost`). Writes are still serialized by the tenant's lock. Each read and write now first reads the storage format and the seal, in one statement. A format newer than this version knows (another version upgraded it) refuses the call with `unavailable` (`stopping`, `retry_after` 1), and the process's `GET /ready` answers 503 from then on, with `/health` giving `reason: "storage_format_newer"`, so that a load balancer sends calls elsewhere. A sealed tenant refuses a write with `unavailable` (`importing`); nothing writes the seal yet. Local mode is unchanged.
