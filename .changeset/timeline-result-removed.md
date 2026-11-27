---
"@fluxvita/saveslot-contract": patch
"@fluxvita/saveslot-kernel": patch
"@fluxvita/saveslot-server": patch
"@fluxvita/saveslot-cli": patch
"@fluxvita/saveslot": patch
---

`TimelineResultCode` gains `removed`, for a `history` timeline item whose content a deletion removed (before, such an item came out with an empty result). MCP and the CLI write it as "(removed by a deletion)". Privacy deletion is not offered in this version, so no item has it yet.
