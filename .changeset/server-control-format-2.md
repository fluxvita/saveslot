---
"@fluxvita/saveslot-service": minor
"@fluxvita/saveslot-daemon": minor
"@fluxvita/saveslot-store-postgres": minor
---

Server mode: the control database's format is 2, and `server start` and `server init` upgrade a format 1 control database while no other server runs on it (holding the server lock alone), each step logged (`control_upgrading`, `control_upgrade_step`, `control_upgraded`; `control_upgrade_failed` with the step and the SQLSTATE). `tenants` gains an `import_holder` column, written by nothing yet. `server start` records a fingerprint of the settings every process must share (trusted proxies, public URL, allowed origins, the login, the handle key IDs, the cell's PostgreSQL server) in the control database, as hashes only, and logs `config_fingerprint_changed` with the names of the settings that changed. The local accounts' login form keys are derived from the handle key file instead of made at random by each process, so a form one process gave is taken by another and a restart no longer expires it; tokens name their key. `CursorKeys.derive`, `PostgresBackend.clusterIdentity` and the fingerprint functions are added; `LocalIdentity` takes `formKeys`.
