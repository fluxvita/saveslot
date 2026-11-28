# @fluxvita/saveslot-store-postgres

## 0.2.0-rc.0

### Minor Changes

- 51f75c4: In server mode, a tenant's PostgreSQL storage no longer has an owner. Opening it no longer raises an ownership epoch, a write no longer checks one, and no opener makes another give the tenant up (`ownership_lost`). Writes are still serialized by the tenant's lock. A format newer than this version knows (another version upgraded it) refuses the call with `unavailable` (`stopping`, `retry_after` 1) and logs `tenant_format_too_new`; the process goes on serving its other tenants. The OAuth endpoints answer it `503 temporarily_unavailable` with `Retry-After`, not `500`. `@fluxvita/saveslot-store-postgres` no longer exports the `ownership_lost` error code or `PostgresTenantStore.epoch`. Local mode is unchanged.
- d5d9c8f: A store whose storage format is older is upgraded in place when it is opened, step by step, and a store of a newer format than this version knows is refused (`format_too_new`; one too old to upgrade, `format_too_old`). No upgrade step exists yet. While an upgrade runs, the local service's `/health` says `starting` with the step, `saveslot mcp` answers each call `unavailable` naming it, and a failed upgrade is `upgrade_failed` with its step, after which `saveslot start` exits with code 5.

### Patch Changes

- a7d57b0: In server mode a read is recorded before it is answered: its read records are written into the tenant's database in a transaction of their own, which takes no tenant lock, instead of waiting in the process for the tenant's next write or close. A read is no longer lost when the process exits or its connection goes away, and a write without `ver` falls back to it even when it comes after the tenant was opened again. When the records cannot be written, the read is answered `unavailable` (`busy`, `retry_after` 1) and its content is not given. The version last read and `since: "my_last_read"` now follow the latest position read, not the latest record written. Local mode keeps its read buffer; there too, `my_last_read` and the version last read are the read of the greatest position, buffered and written together, so they no longer depend on whether the buffer was written out in between.
- 9bf87e1: A tenant whose database connection went away (the database restarted, a middlebox or an operator ended it) is opened again on its next use, and so is a tenant whose directory now names another database: before, every request to that tenant failed with `internal` until the tenant was closed for being idle. Uses still on the old connection finish first. When opening it again cannot reach the database, the request is answered `unavailable` (`busy`, `retry_after` 1) and the next use tries once more. Each reopen is logged as the warning `tenant_reopened` with the tenant and the reason (`connection` or `database`).
- 81220c3: Server mode says which step of a storage format upgrade failed, and nothing of the database's own message. The server log gets `upgrade_failed` with the tenant's database, the step (such as `5->6`) and the SQLSTATE; `server restore`, `server user` and `server init` write the same to standard error, with what to do, and exit 5, where `server restore` used to let the database's message, which may quote stored values, reach standard error. `server restore` and `server user` now log a tenant's upgrade step by step, as `server start` does. The MCP bridge no longer logs `autostart_exit_7` when the service it started is upgrading its store: that is said as `service_upgrading`.
- 7f6d922: Server mode keeps at most `SAVESLOT_TENANT_CONNECTIONS` tenants open per process (default 50), each on one database connection. A tenant to be opened past the limit has the tenant idle for longest closed for it (one whose close failed is tried again); with none idle, its request waits up to 5 seconds and then gets `unavailable` (`busy`) to retry. A request's tenant is not idle between its authentication and the end of its response. A database that refuses the connection as too many (SQLSTATE 53300) gets the same answer, where it used to be `internal`. How long an idle tenant stays open is now `SAVESLOT_TENANT_IDLE` (default 300 seconds).
  
  Tenants are created one at a time in a process, and databases dropped one at a time, so that each process holds at most four connections besides its tenants' and its imports'. A creation waiting more than 5 seconds is answered busy for now: an external login's first sign-in gets 503 with `Retry-After`, the token endpoint `temporarily_unavailable`, and `server user` and `server init` exit 7.
- Updated dependencies [12c23c6]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [90ab30a]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [fc9a36e]
- Updated dependencies [3ae6e08]
- Updated dependencies [51f75c4]
- Updated dependencies [a7d57b0]
- Updated dependencies [9bf87e1]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d2a3d6b]
  - @fluxvita/saveslot-kernel@0.2.0-rc.0

## 0.1.0

### Patch Changes

- @fluxvita/saveslot-kernel@0.1.0

## 0.1.0-rc.0

### Patch Changes

- @fluxvita/saveslot-kernel@0.1.0-rc.0
