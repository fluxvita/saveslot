---
"@fluxvita/saveslot-service": patch
"@fluxvita/saveslot-daemon": patch
"@fluxvita/saveslot": patch
---

Server mode keeps at most `SAVESLOT_TENANT_CONNECTIONS` tenants open per process (default 50), each on one database connection. A tenant to be opened past the limit has the tenant idle for longest closed for it; with none idle, its request waits up to 5 seconds and then gets `unavailable` (`busy`) to retry. A database that refuses the connection as too many (SQLSTATE 53300) gets the same answer, where it used to be `internal`. How long an idle tenant stays open is now `SAVESLOT_TENANT_IDLE` (default 300 seconds). Before, every tenant used in the last five minutes held a connection, with no limit, and once the database had none left a new tenant could not be opened.
