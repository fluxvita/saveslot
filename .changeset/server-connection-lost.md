---
"@fluxvita/saveslot-service": patch
"@fluxvita/saveslot-server": patch
---

In server mode, a request whose tenant's connection was ended a moment before (the database restarted, a middlebox or an operator ended it) is no longer answered `internal`. A read-only call, and the authentication that reads the caller, is made once more on the tenant opened again, and answered. A write is answered `unavailable` (`busy`, `retry_after` 1), with nothing written, and goes through when sent again. A write whose `COMMIT` went unanswered may have been committed, and is still answered `internal`. Both are logged as the warning `tenant_connection_lost`, with the tenant and the code.
