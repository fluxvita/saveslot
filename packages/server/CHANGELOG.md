# @fluxvita/saveslot-server

## 0.2.0-rc.0

### Minor Changes

- d5d9c8f: The authorization page, the device code's verification page and their error pages have a new look that fits any width down to a phone's, in English and Chinese, with nothing loaded from elsewhere. The client's host is shown as plainly as its name, who is signed in and where the answer returns are right above the buttons, and the texts are shorter.
- 12c23c6: A closed item's details leave out a value a pending deletion removed: a conflict's `effective`, an awaiting item's `current` and a flagged item's `matched_values`. Each carries `partially_deleted`, a new optional field of `ConflictDetail.effective`, `AwaitingDetail.current` and `FlaggedDetail`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
- d5d9c8f: A conflict item's `previous` leaves out a value a pending deletion removed, and carries `partially_deleted`, a new optional field of `ConflictDetail.previous`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
- 3ae6e08: Server mode can write a record for each call. With `SAVESLOT_CALL_RECORDS=on` (off by default), the server writes one line of JSON on the standard output at the end of each call that passed authentication: one per `/v1` request and one per MCP tool call. The record says who made the call (tenant, actor, how the credential came to be), what the call was (surface, operation, route), how it ended (outcome, the contract's reason, an incident), and what it did to the tenant's log (appended, replayed or none, with the operation number and restore count). It holds no content: no names, no task, no keys, no values. Every `/v1` answer to an authenticated call on a route gives the call's ID in the `Saveslot-Call` header, readable cross-origin, whether records are on or not. Records never hold a call up: past a bound, or when the output fails, they are dropped, and the drops are counted in a `call_record_failed` warning at most once a minute.
- 51f75c4: In server mode, a tenant's PostgreSQL storage no longer has an owner. Opening it no longer raises an ownership epoch, a write no longer checks one, and no opener makes another give the tenant up (`ownership_lost`). Writes are still serialized by the tenant's lock. A format newer than this version knows (another version upgraded it) refuses the call with `unavailable` (`stopping`, `retry_after` 1) and logs `tenant_format_too_new`; the process goes on serving its other tenants. The OAuth endpoints answer it `503 temporarily_unavailable` with `Retry-After`, not `500`. `@fluxvita/saveslot-store-postgres` no longer exports the `ownership_lost` error code or `PostgresTenantStore.epoch`. Local mode is unchanged.
- d5d9c8f: A store whose storage format is older is upgraded in place when it is opened, step by step, and a store of a newer format than this version knows is refused (`format_too_new`; one too old to upgrade, `format_too_old`). No upgrade step exists yet. While an upgrade runs, the local service's `/health` says `starting` with the step, `saveslot mcp` answers each call `unavailable` naming it, and a failed upgrade is `upgrade_failed` with its step, after which `saveslot start` exits with code 5.
- d5d9c8f: `TimelineResultCode` gains `removed`, for a `history` timeline item whose content a deletion removed (before, such an item came out with an empty result). MCP and the CLI write it as "(removed by a deletion)". Privacy deletion is not offered in this version, so no item has it yet.

### Patch Changes

- 4e30bbc: `saveslot_history` with `changes`, and `saveslot history changes`, no longer show a side withheld for deleted content as an empty value. In a change marked `partially_deleted`, a missing side reads "not shown" instead of `—`, which looked like the value had been cleared, or instead of giving only the new value, which looked like there had been none before. The line ends with "partly deleted: what is not shown came from content deleted since". A newly inserted row still gives only its new value. Privacy deletion is not offered in this version, so no change is marked yet.
- 62a8144: `saveslot_catalog` with no slot to see now says what to do next, by what the connection may do: draft a schema to show the user and submit it once they agree; or have the user make a slot on the command line; or, for a connection limited to some slots, use one that sees every slot. It is the same sentence the server's instructions give, for hosts that do not pass those instructions to the model: before, the answer was only "No slots yet.", and an agent on such a host stopped there instead of offering to set up a table.
- d178ff0: MCP's JSON as written: a key that a compatibility normalization (NFKC) would change has every code point past ASCII written as `\uXXXX`, so that a host normalizing the text cannot make two keys one (full-width `＜` and small `﹤` both become `<`). Keys normalization leaves alone are written as before.
- d638c19: MCP refusals that said nothing useful now give their data and a next step: too many evidence segments or premises (the bound and the count), a premise target at its fan-in bound, premises on its own record or in another slot or on an op that cannot carry them, two ops by one source key, a source key held or frozen, a write on an old schema version (what changed and the version to use), a draft on an old version, and a draft that leaves out a field (which fields). Every contract error code is shown as a code. An awaiting-confirmation mark with no proposal no longer ends in an empty "proposed:"; a next change on a day table is said with its last day inclusive; the write description no longer points at a business time the premise mark does not carry; and the schema document's description says how to drop fields and tables and how to write aliases.
- 8740f65: The MCP texts no longer lead a model to a call that is refused: a schema change's detail no longer points to `saveslot_catalog` with `draft` (not a parameter on MCP in this version); `saveslot_pending` says that schema changes awaiting confirmation are among its items; and an `insert` by source key is answered with the next step (`update` with `external_key`).
- 9df0aff: The OAuth token endpoints and pages answer `503 temporarily_unavailable` with `Retry-After`, not `500 server_error`, when the user's tenant is unavailable for now: being imported into or restored, no tenant connection free, or the tenant's database not reachable. A code redemption during an import of the same tenant in this process answered `500` before.
- 1d85a28: A pending item whose target a deletion still pending affects is no longer shown as one to decide. On MCP the list says it cannot be decided for now instead of naming decisions, and its detail says which deletions block it, when the last of them is due, and to decide after they have run, instead of saying the connection lacks a scope. The `pending_deletion_target` refusal is said the same way. In the CLI, `saveslot pending` marks the item, `pending show` says the same, a refused decision says it too, and `pending resolve` on such an item shows it and exits 5 without asking. Privacy deletion is not offered in this version, so no item is held this way yet.
- 90ab30a: A paging cursor expires once a deletion is confirmed or cancelled in the tenant after its first page: the next page is refused with `handle_expired`, reason `deletion_changed` (new), and the caller reads again from the first page. What a read leaves out changed between the pages, so one round of paging could have given a stretch twice or missed one. A deletion carried out without a confirmation or cancellation in between does not expire a cursor. Privacy deletion is not offered in this version, so no cursor expires this way yet.
- d8aa2e3: The `schema_updated` notice is a sentence on MCP (which slot, from which version to which, the tables and fields changed, at most ten named), instead of its JSON as received.
- 7718018: In server mode, a request whose tenant's connection was ended a moment before (the database restarted, a middlebox or an operator ended it) is no longer answered `internal`. A read-only call, and the authentication that reads the caller, is made once more on the tenant opened again, and answered. A write is answered `unavailable` (`busy`, `retry_after` 1), with nothing written, and goes through when sent again. A write whose `COMMIT` went unanswered, or that committed and met it while its answer was read, may have taken effect, and is answered `internal`. An MCP request of several calls is made once more only when the call that met it is its only tool call. Each time it is met, the warning `tenant_connection_lost` is logged, with the tenant and the code, also when the call then succeeds.
- 01e6898: A local service that is stopping answers `/v1` with `unavailable` reason `stopping` and a `retry_after`, and one that has failed with `stopping` and none, instead of `starting`; in server mode, a `/v1` request while the server stops or after its control database is lost gets the contract's `{error}` body (`unavailable`, `stopping`) rather than a bare 503. `GET /v1/slots/{slot}/policy` refuses `X-Task-Id`, as a management endpoint; `GET /v1/slots/{slot}/tables` with no `tables` reports it `missing`, not `malformed`.
- 7f6d922: Server mode keeps at most `SAVESLOT_TENANT_CONNECTIONS` tenants open per process (default 50), each on one database connection. A tenant to be opened past the limit has the tenant idle for longest closed for it (one whose close failed is tried again); with none idle, its request waits up to 5 seconds and then gets `unavailable` (`busy`) to retry. A request's tenant is not idle between its authentication and the end of its response. A database that refuses the connection as too many (SQLSTATE 53300) gets the same answer, where it used to be `internal`. How long an idle tenant stays open is now `SAVESLOT_TENANT_IDLE` (default 300 seconds).
  
  Tenants are created one at a time in a process, and databases dropped one at a time, so that each process holds at most four connections besides its tenants' and its imports'. A creation waiting more than 5 seconds is answered busy for now: an external login's first sign-in gets 503 with `Retry-After`, the token endpoint `temporarily_unavailable`, and `server user` and `server init` exit 7.
- Updated dependencies [12c23c6]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [90ab30a]
- Updated dependencies [3ae6e08]
- Updated dependencies [7718018]
- Updated dependencies [51f75c4]
- Updated dependencies [a7d57b0]
- Updated dependencies [9bf87e1]
- Updated dependencies [01e6898]
- Updated dependencies [d5d9c8f]
- Updated dependencies [7f6d922]
- Updated dependencies [d5d9c8f]
  - @fluxvita/saveslot-contract@0.2.0-rc.0
  - @fluxvita/saveslot-service@0.2.0-rc.0

## 0.1.0

### Patch Changes

- 73b0bf6: The authorization page ticks only reading and writing for the user, as spec 05 §15 has it: making slots and deleting are offered when the client asks for them, never ticked by default.
- Updated dependencies [4cb4659]
- Updated dependencies [0726f63]
  - @fluxvita/saveslot-service@0.1.0
  - @fluxvita/saveslot-contract@0.1.0

## 0.1.0-rc.0

### Patch Changes

- @fluxvita/saveslot-contract@0.1.0-rc.0
  - @fluxvita/saveslot-service@0.1.0-rc.0
