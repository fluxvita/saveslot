---
"@fluxvita/saveslot-kernel": minor
"@fluxvita/saveslot-service": minor
"@fluxvita/saveslot-server": minor
"@fluxvita/saveslot-daemon": minor
---

Server mode can write a record for each call. With `SAVESLOT_CALL_RECORDS=on` (off by default), the server writes one line of JSON on the standard output at the end of each call that passed authentication: one per `/v1` request and one per MCP tool call. The record says who made the call (tenant, actor, how the credential came to be), what the call was (surface, operation, route), how it ended (outcome, the contract's reason, an incident), and what it did to the tenant's log (appended, replayed or none, with the operation number and restore count). It holds no content: no names, no task, no keys, no values. Every `/v1` answer to an authenticated call on a route gives the call's ID in the `Saveslot-Call` header, readable cross-origin, whether records are on or not. Records never hold a call up: past a bound, or when the output fails, they are dropped, and the drops are counted in a `call_record_failed` warning at most once a minute.
