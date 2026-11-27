---
"@fluxvita/saveslot-kernel": minor
"@fluxvita/saveslot-store-postgres": minor
"@fluxvita/saveslot-service": minor
"@fluxvita/saveslot-daemon": minor
---

Server mode: an import holds its tenant across processes. Step ④ seals the target database (`PostgresTenantStore.seal`, a write under the tenant's lock that checks the log holds the genesis event only): from then on a write of the tenant from any process is refused (`unavailable`, `importing`), one waiting on the lock included. Before step ①, the import takes the tenant's holder lock on a control database connection of its own and writes `tenants.import_holder`; another process's import is `rate_limited` (`busy`), and a use of the tenant elsewhere reads the mark and gets `importing` while the lock is held. When the import's process ended midway, the next use takes the lock, finishes or rolls the import back by the re-entry rules, lifts the seal, and clears the mark last. A staging database is dropped on opening only with no holder; the database a swap replaced no longer pushes the high water when closed. Each import uses one more connection to the control database. The kernel's `TenantStore` port gains the optional `seal` and `unseal`, `abortImportOnOpen` an optional `unseal`, `TenantPool` the `holders` option, and `TenantEntry` `importHolder`; `controlImportHolders` and `holderLockKey` are added.
