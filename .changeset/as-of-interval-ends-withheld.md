---
"@fluxvita/saveslot-contract": minor
"@fluxvita/saveslot-kernel": minor
"@fluxvita/saveslot-server": minor
"@fluxvita/saveslot-cli": minor
"@fluxvita/saveslot": minor
---

`history` `as_of` on a state table leaves out a stretch's start or end that came from content a pending deletion removed, and marks the stretch `partially_deleted`; a stretch with nothing left is not listed, and the result carries `partially_deleted`, a new optional field of `AsOfResult`. A `valid_at` hits only by the ends given. Paging positions of `as_of` on a state table have a new format, and one of the format before is answered `handle_expired` with the new reason `format_changed`: read again from the first page. MCP and the CLI write a missing end as "(deleted)". Privacy deletion is not offered in this version, so no read gives it yet.
