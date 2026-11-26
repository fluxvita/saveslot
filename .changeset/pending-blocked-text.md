---
"@fluxvita/saveslot-server": patch
"@fluxvita/saveslot-cli": patch
"@fluxvita/saveslot": patch
---

A pending item whose target a deletion still pending affects is no longer shown as one to decide. On MCP the list says it cannot be decided for now instead of naming decisions, and its detail says which deletions block it, when the last of them is due, and the two ways on (decide after that, or cancel the deletion first), instead of saying the connection lacks a scope. The `pending_deletion_target` refusal is said the same way. In the CLI, `saveslot pending` marks the item, `pending show` says the same, a refused decision says it too, and `pending resolve` on such an item shows it and exits 5 without asking.
