---
"@fluxvita/saveslot-store-postgres": patch
"@fluxvita/saveslot-daemon": patch
"@fluxvita/saveslot": patch
---

Server mode says which step of a storage format upgrade failed, and nothing of the database's own message. The server log gets `upgrade_failed` with the tenant's database, the step (`5->6`) and the SQLSTATE; `server restore`, `server user` and `server init` write the same to standard error, with what to do, and exit 5, where `server restore` used to let the database's message, which may quote stored values, reach standard error. `server restore` and `server user` now log a tenant's upgrade step by step, as `server start` does. The MCP bridge no longer logs `autostart_exit_7` when the service it started is upgrading its store: that is said as `service_upgrading`.
