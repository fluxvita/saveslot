---
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot": patch
---

A write sent again with its idempotency key gives back the first receipt's parts in the same order, byte for byte. Before, the receipt's `resolved` (and `premise_affected.by_reason`) of a replay could list the same fields in another order.
