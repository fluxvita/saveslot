---
"@fluxvita/saveslot-service": patch
"@fluxvita/saveslot-server": patch
---

In server mode, a request whose tenant's connection was ended a moment before (the database restarted, a middlebox or an operator ended it) is no longer answered `internal`. A read-only call, and the authentication that reads the caller, is made once more on the tenant opened again, and answered. A write is answered `unavailable` (`busy`, `retry_after` 1), with nothing written, and goes through when sent again. A write whose `COMMIT` went unanswered, or that committed and met it while its answer was read, may have taken effect, and is answered `internal`. An MCP request of several calls is made once more only when the call that met it is its only tool call. Each time it is met, the warning `tenant_connection_lost` is logged, with the tenant and the code, also when the call then succeeds.
