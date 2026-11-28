# @fluxvita/saveslot-service

## 0.2.0-rc.0

### Minor Changes

- d5d9c8f: Before the local service upgrades a storage format in place, it backs the home's data up next to the home, as a home the version before can open; saveslot never removes it. A failed backup stops the upgrade at step `backup`, and `saveslot start` says what to do. It can be skipped with `upgrade.backup = false` or `saveslot start --no-upgrade-backup`.
- 3ae6e08: Server mode can write a record for each call. With `SAVESLOT_CALL_RECORDS=on` (off by default), the server writes one line of JSON on the standard output at the end of each call that passed authentication: one per `/v1` request and one per MCP tool call. The record says who made the call (tenant, actor, how the credential came to be), what the call was (surface, operation, route), how it ended (outcome, the contract's reason, an incident), and what it did to the tenant's log (appended, replayed or none, with the operation number and restore count). It holds no content: no names, no task, no keys, no values. Every `/v1` answer to an authenticated call on a route gives the call's ID in the `Saveslot-Call` header, readable cross-origin, whether records are on or not. Records never hold a call up: past a bound, or when the output fails, they are dropped, and the drops are counted in a `call_record_failed` warning at most once a minute.
- 51f75c4: In server mode, a tenant's PostgreSQL storage no longer has an owner. Opening it no longer raises an ownership epoch, a write no longer checks one, and no opener makes another give the tenant up (`ownership_lost`). Writes are still serialized by the tenant's lock. A format newer than this version knows (another version upgraded it) refuses the call with `unavailable` (`stopping`, `retry_after` 1) and logs `tenant_format_too_new`; the process goes on serving its other tenants. The OAuth endpoints answer it `503 temporarily_unavailable` with `Retry-After`, not `500`. `@fluxvita/saveslot-store-postgres` no longer exports the `ownership_lost` error code or `PostgresTenantStore.epoch`. Local mode is unchanged.

### Patch Changes

- d5d9c8f: `saveslot init` refuses a data directory that is already there and not empty (exit code 5), before it makes anything of the home, and says how to carry data over with export and import. Before, it opened what was there, which could upgrade an older store in place without a backup and then fail.
- 7718018: In server mode, a request whose tenant's connection was ended a moment before (the database restarted, a middlebox or an operator ended it) is no longer answered `internal`. A read-only call, and the authentication that reads the caller, is made once more on the tenant opened again, and answered. A write is answered `unavailable` (`busy`, `retry_after` 1), with nothing written, and goes through when sent again. A write whose `COMMIT` went unanswered, or that committed and met it while its answer was read, may have taken effect, and is answered `internal`. An MCP request of several calls is made once more only when the call that met it is its only tool call. Each time it is met, the warning `tenant_connection_lost` is logged, with the tenant and the code, also when the call then succeeds.
- a7d57b0: In server mode a read is recorded before it is answered: its read records are written into the tenant's database in a transaction of their own, which takes no tenant lock, instead of waiting in the process for the tenant's next write or close. A read is no longer lost when the process exits or its connection goes away, and a write without `ver` falls back to it even when it comes after the tenant was opened again. When the records cannot be written, the read is answered `unavailable` (`busy`, `retry_after` 1) and its content is not given. The version last read and `since: "my_last_read"` now follow the latest position read, not the latest record written. Local mode keeps its read buffer; there too, `my_last_read` and the version last read are the read of the greatest position, buffered and written together, so they no longer depend on whether the buffer was written out in between.
- 9bf87e1: A tenant whose database connection went away (the database restarted, a middlebox or an operator ended it) is opened again on its next use, and so is a tenant whose directory now names another database: before, every request to that tenant failed with `internal` until the tenant was closed for being idle. Uses still on the old connection finish first. When opening it again cannot reach the database, the request is answered `unavailable` (`busy`, `retry_after` 1) and the next use tries once more. Each reopen is logged as the warning `tenant_reopened` with the tenant and the reason (`connection` or `database`).
- 01e6898: A local service that is stopping answers `/v1` with `unavailable` reason `stopping` and a `retry_after`, and one that has failed with `stopping` and none, instead of `starting`; in server mode, a `/v1` request while the server stops or after its control database is lost gets the contract's `{error}` body (`unavailable`, `stopping`) rather than a bare 503. `GET /v1/slots/{slot}/policy` refuses `X-Task-Id`, as a management endpoint; `GET /v1/slots/{slot}/tables` with no `tables` reports it `missing`, not `malformed`.
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
  - @fluxvita/saveslot-contract@0.2.0-rc.0
  - @fluxvita/saveslot-kernel@0.2.0-rc.0
  - @fluxvita/saveslot-contract-core@0.2.0-rc.0

## 0.1.0

### Patch Changes

- 4cb4659: The authorization server takes the external address with a trailing slash (`https://<domain>/`) as a `resource`, as it takes the address without one: a host that authorizes again after its connection was revoked, as Claude Code does, is no longer refused with `invalid_target`.
- 0726f63: `SAVESLOT_TRUSTED_PROXIES` takes CIDR ranges as well as single addresses, so a deployment behind a load balancer whose address changes within a subnet, or behind a CDN, can list them. An entry with bits set past its prefix, a prefix length out of range, or one covering every address is refused, and the error names it.
- @fluxvita/saveslot-contract@0.1.0
  - @fluxvita/saveslot-contract-core@0.1.0
  - @fluxvita/saveslot-kernel@0.1.0

## 0.1.0-rc.0

### Patch Changes

- @fluxvita/saveslot-contract@0.1.0-rc.0
  - @fluxvita/saveslot-contract-core@0.1.0-rc.0
  - @fluxvita/saveslot-kernel@0.1.0-rc.0
