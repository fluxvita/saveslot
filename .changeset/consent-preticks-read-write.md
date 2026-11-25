---
"@fluxvita/saveslot-server": patch
---

The authorization page ticks only reading and writing for the user, as spec 05 §15 has it: making slots and deleting are offered when the client asks for them, never ticked by default.
