---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-postgres": patch
"@fluxvita/saveslot-service": patch
"@fluxvita/saveslot-daemon": patch
---

A tenant whose database connection went away (the database restarted, a middlebox or an operator ended it) is opened again on its next use, and so is a tenant whose directory now names another database: before, every request to that tenant failed with `internal` until the tenant was closed for being idle. Uses still on the old connection finish first. When opening it again cannot reach the database, the request is answered `unavailable` (`busy`, `retry_after` 1) and the next use tries once more. Each reopen is logged as the warning `tenant_reopened` with the tenant and the reason (`connection` or `database`).
