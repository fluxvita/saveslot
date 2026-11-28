---
"@fluxvita/saveslot-kernel": patch
---

A write by `entity_key` reads a table's keys once a request instead of once a lookup, and the key of one entity is read from its own creating event. A request of many ops by key no longer reads the whole table's keys for each op: at 8,000 entities, a write of 200 ops by key took about 71 s and takes about 4 s; creating one entity by key, about 0.76 s and 0.23 s. Results are unchanged.
