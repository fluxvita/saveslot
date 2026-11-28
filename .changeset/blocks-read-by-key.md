---
"@fluxvita/saveslot-kernel": patch
---

The blocks of a list of events are read one event at a time by the log's key, wherever the kernel reads them (a write's receipt among them), so the plan no longer depends on the planner's statistics. On a large local store, the planner's estimate of an event's blocks had grown far too high, and a write of many rows read the whole log: about 30 s for a 1,000-row write at 2 million rows, about 5 s now. Results are unchanged.
