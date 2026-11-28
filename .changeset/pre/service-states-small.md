---
"@fluxvita/saveslot-service": patch
"@fluxvita/saveslot-server": patch
"@fluxvita/saveslot-daemon": patch
---

A local service that is stopping answers `/v1` with `unavailable` reason `stopping` and a `retry_after`, and one that has failed with `stopping` and none, instead of `starting`; in server mode, a `/v1` request while the server stops or after its control database is lost gets the contract's `{error}` body (`unavailable`, `stopping`) rather than a bare 503. `GET /v1/slots/{slot}/policy` refuses `X-Task-Id`, as a management endpoint; `GET /v1/slots/{slot}/tables` with no `tables` reports it `missing`, not `malformed`.
