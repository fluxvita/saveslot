---
"@fluxvita/saveslot-server": patch
---

MCP's JSON as written: a key that a compatibility normalization (NFKC) would change has every code point past ASCII written as `\uXXXX`, so that a host normalizing the text cannot make two keys one (full-width `＜` and small `﹤` both become `<`). Keys normalization leaves alone are written as before.
