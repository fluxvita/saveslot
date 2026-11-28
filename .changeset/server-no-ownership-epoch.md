---
"@fluxvita/saveslot-kernel": minor
"@fluxvita/saveslot-store-postgres": minor
"@fluxvita/saveslot-service": minor
"@fluxvita/saveslot-server": minor
---

In server mode, a tenant's PostgreSQL storage no longer has an owner. Opening it no longer raises an ownership epoch, a write no longer checks one, and no opener makes another give the tenant up (`ownership_lost`). Writes are still serialized by the tenant's lock. A format newer than this version knows (another version upgraded it) refuses the call with `unavailable` (`stopping`, `retry_after` 1) and logs `tenant_format_too_new`; the process goes on serving its other tenants. The OAuth endpoints answer it `503 temporarily_unavailable` with `Retry-After`, not `500`. `@fluxvita/saveslot-store-postgres` no longer exports the `ownership_lost` error code or `PostgresTenantStore.epoch`. Local mode is unchanged.
