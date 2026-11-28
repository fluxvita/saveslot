---
"@fluxvita/saveslot-server": patch
---

The MCP texts no longer lead a model to a call that is refused: a schema change's detail no longer points to `saveslot_catalog` with `draft` (not a parameter on MCP in this version); `saveslot_pending` says that schema changes awaiting confirmation are among its items; and an `insert` by source key is answered with the next step (`update` with `external_key`).
