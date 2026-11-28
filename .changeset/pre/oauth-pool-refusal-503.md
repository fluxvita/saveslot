---
"@fluxvita/saveslot-server": patch
---

The OAuth token endpoints and pages answer `503 temporarily_unavailable` with `Retry-After`, not `500 server_error`, when the user's tenant is unavailable for now: being imported into or restored, no tenant connection free, or the tenant's database not reachable. A code redemption during an import of the same tenant in this process answered `500` before.
