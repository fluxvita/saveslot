---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-store-pglite": patch
---

A write recomputes a derived table only for the groups its rows were or are in, when the rule reads one event or timeless table on its own as a grouped or whole aggregate; other rules are recomputed whole as before. The derived rows are the same. A rule that fails on the data fails the write as `validation_failed` (`rule_eval_failed`) wherever it is evaluated.
