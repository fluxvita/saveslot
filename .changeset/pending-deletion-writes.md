---
"@fluxvita/saveslot-kernel": patch
---

While a deletion is pending: an `undo` whose row the deletion leaves as it was (only an operation's evidence deleted) is no longer refused with `pending_deletion_target`; an `undo` on a row the deletion removed whole answers `not_found` first, and `not_found` on such a row names the pending deletions; a write to an entity whose interval block the deletion lists is refused as not implemented instead of failing with a `TypeError`. Privacy deletion is not offered in this version, so no user reaches these yet.
