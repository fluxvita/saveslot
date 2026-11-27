---
"@fluxvita/saveslot-server": patch
"@fluxvita/saveslot-cli": patch
---

`saveslot_history` with `changes`, and `saveslot history changes`, no longer show a side withheld for deleted content as an empty value. In a change marked `partially_deleted`, a missing side reads "not shown" instead of `—`, which looked like the value had been cleared, or instead of giving only the new value, which looked like there had been none before. The line ends with "partly deleted: what is not shown came from content deleted since". A newly inserted row still gives only its new value.
