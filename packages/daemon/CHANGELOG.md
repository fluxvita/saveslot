# @fluxvita/saveslot-daemon

## 0.2.0-rc.0

### Minor Changes

- d5d9c8f: Before the local service upgrades a storage format in place, it backs the home's data up next to the home, as a home the version before can open; saveslot never removes it. A failed backup stops the upgrade at step `backup`, and `saveslot start` says what to do. It can be skipped with `upgrade.backup = false` or `saveslot start --no-upgrade-backup`.
- 3ae6e08: Server mode can write a record for each call. With `SAVESLOT_CALL_RECORDS=on` (off by default), the server writes one line of JSON on the standard output at the end of each call that passed authentication: one per `/v1` request and one per MCP tool call. The record says who made the call (tenant, actor, how the credential came to be), what the call was (surface, operation, route), how it ended (outcome, the contract's reason, an incident), and what it did to the tenant's log (appended, replayed or none, with the operation number and restore count). It holds no content: no names, no task, no keys, no values. Every `/v1` answer to an authenticated call on a route gives the call's ID in the `Saveslot-Call` header, readable cross-origin, whether records are on or not. Records never hold a call up: past a bound, or when the output fails, they are dropped, and the drops are counted in a `call_record_failed` warning at most once a minute.
- d5d9c8f: A store whose storage format is older is upgraded in place when it is opened, step by step, and a store of a newer format than this version knows is refused (`format_too_new`; one too old to upgrade, `format_too_old`). No upgrade step exists yet. While an upgrade runs, the local service's `/health` says `starting` with the step, `saveslot mcp` answers each call `unavailable` naming it, and a failed upgrade is `upgrade_failed` with its step, after which `saveslot start` exits with code 5.

### Patch Changes

- f1fe62e: `saveslot doctor` asks the local service for the hosts' connection instances and their reads only when the service says it is ready, and gives each of these calls up after 10 seconds instead of 60. A service that accepts the connection and does not answer no longer holds `doctor` for a minute at the hosts' step.
- deabb94: `saveslot doctor` gives a reminder for a host whose connection instances have no read besides their self-check, with how that host allows saveslot's tools (Claude Code: allow them when it asks; with `claude -p`, add `--allowedTools "mcp__saveslot"`). A host that has not allowed the tools refuses the agent's calls before they reach saveslot, and without a terminal nothing asks, so a run wrote nothing and said nothing. The reminder is inferred from saveslot's own reads, so a host just connected and not yet used gets it too; it does not change the exit code.
- d5d9c8f: `saveslot init` refuses a data directory that is already there and not empty (exit code 5), before it makes anything of the home, and says how to carry data over with export and import. Before, it opened what was there, which could upgrade an older store in place without a backup and then fail.
- 1d8dfd8: Server mode has a readiness endpoint and a bounded shutdown. `GET /ready` (no token) answers 200 only while the server is ready and 503 while it starts, stops or has failed; the image's health check now asks it, and `/health` still answers 200 in every state. On SIGTERM or SIGINT the server keeps serving for `SAVESLOT_SHUTDOWN_DRAIN` seconds (default 10) with `/ready` at 503, then takes no new connections and waits at most `SAVESLOT_SHUTDOWN_TIMEOUT` seconds (default 30) for the requests in progress before closing the connections still open, then closes the tenants within 10 seconds and releases its lock. A second signal skips what is left of the waits. Before, a client that never finished sending its request body kept the server from stopping, and a request that finished during the stop kept its keep-alive connection open for another five seconds. The container's termination grace period must cover the three steps; the example compose file sets `stop_grace_period: 1m`.
- 9bf87e1: A tenant whose database connection went away (the database restarted, a middlebox or an operator ended it) is opened again on its next use, and so is a tenant whose directory now names another database: before, every request to that tenant failed with `internal` until the tenant was closed for being idle. Uses still on the old connection finish first. When opening it again cannot reach the database, the request is answered `unavailable` (`busy`, `retry_after` 1) and the next use tries once more. Each reopen is logged as the warning `tenant_reopened` with the tenant and the reason (`connection` or `database`).
- 6b8cf09: `saveslot server restore` can name the tenant by its local account's name (`--user <name>`) instead of its ID (`--tenant <tenant>`): exactly one of the two. An account that is not there is exit code 4; an account whose tenant is not made yet, or `--user` with the external login configured, is exit code 5.
- 81220c3: Server mode says which step of a storage format upgrade failed, and nothing of the database's own message. The server log gets `upgrade_failed` with the tenant's database, the step (such as `5->6`) and the SQLSTATE; `server restore`, `server user` and `server init` write the same to standard error, with what to do, and exit 5, where `server restore` used to let the database's message, which may quote stored values, reach standard error. `server restore` and `server user` now log a tenant's upgrade step by step, as `server start` does. The MCP bridge no longer logs `autostart_exit_7` when the service it started is upgrading its store: that is said as `service_upgrading`.
- 01e6898: A local service that is stopping answers `/v1` with `unavailable` reason `stopping` and a `retry_after`, and one that has failed with `stopping` and none, instead of `starting`; in server mode, a `/v1` request while the server stops or after its control database is lost gets the contract's `{error}` body (`unavailable`, `stopping`) rather than a bare 503. `GET /v1/slots/{slot}/policy` refuses `X-Task-Id`, as a management endpoint; `GET /v1/slots/{slot}/tables` with no `tables` reports it `missing`, not `malformed`.
- 7f6d922: Server mode keeps at most `SAVESLOT_TENANT_CONNECTIONS` tenants open per process (default 50), each on one database connection. A tenant to be opened past the limit has the tenant idle for longest closed for it (one whose close failed is tried again); with none idle, its request waits up to 5 seconds and then gets `unavailable` (`busy`) to retry. A request's tenant is not idle between its authentication and the end of its response. A database that refuses the connection as too many (SQLSTATE 53300) gets the same answer, where it used to be `internal`. How long an idle tenant stays open is now `SAVESLOT_TENANT_IDLE` (default 300 seconds).
  
  Tenants are created one at a time in a process, and databases dropped one at a time, so that each process holds at most four connections besides its tenants' and its imports'. A creation waiting more than 5 seconds is answered busy for now: an external login's first sign-in gets 503 with `Retry-After`, the token endpoint `temporarily_unavailable`, and `server user` and `server init` exit 7.
- Updated dependencies [d5d9c8f]
- Updated dependencies [12c23c6]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [7dd7cb1]
- Updated dependencies [4e30bbc]
- Updated dependencies [62a8144]
- Updated dependencies [d178ff0]
- Updated dependencies [d638c19]
- Updated dependencies [8740f65]
- Updated dependencies [9df0aff]
- Updated dependencies [1d85a28]
- Updated dependencies [90ab30a]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d8aa2e3]
- Updated dependencies [3ae6e08]
- Updated dependencies [7718018]
- Updated dependencies [51f75c4]
- Updated dependencies [a7d57b0]
- Updated dependencies [9bf87e1]
- Updated dependencies [81220c3]
- Updated dependencies [01e6898]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [7f6d922]
- Updated dependencies [d5d9c8f]
  - @fluxvita/saveslot-server@0.2.0-rc.0
  - @fluxvita/saveslot-store-pglite@0.2.0-rc.0
  - @fluxvita/saveslot-service@0.2.0-rc.0
  - @fluxvita/saveslot-store-postgres@0.2.0-rc.0

## 0.1.0

### Patch Changes

- 0726f63: `SAVESLOT_TRUSTED_PROXIES` takes CIDR ranges as well as single addresses, so a deployment behind a load balancer whose address changes within a subnet, or behind a CDN, can list them. An entry with bits set past its prefix, a prefix length out of range, or one covering every address is refused, and the error names it.
- Updated dependencies [73b0bf6]
- Updated dependencies [4cb4659]
- Updated dependencies [0726f63]
  - @fluxvita/saveslot-server@0.1.0
  - @fluxvita/saveslot-service@0.1.0
  - @fluxvita/saveslot-store-pglite@0.1.0
  - @fluxvita/saveslot-store-postgres@0.1.0

## 0.1.0-rc.0

### Patch Changes

- @fluxvita/saveslot-server@0.1.0-rc.0
  - @fluxvita/saveslot-service@0.1.0-rc.0
  - @fluxvita/saveslot-store-pglite@0.1.0-rc.0
  - @fluxvita/saveslot-store-postgres@0.1.0-rc.0
