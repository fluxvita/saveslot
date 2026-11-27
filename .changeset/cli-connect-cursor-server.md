---
"@fluxvita/saveslot-cli": patch
"@fluxvita/saveslot": patch
---

`saveslot connect cursor` on a server profile says to issue a static token with `saveslot connect http` and prints the entry with the place for that token in its header. Before, it printed an entry with the address only, which Cursor cannot use: its remote sign-in needs dynamic client registration, which this version does not offer.
