---
"@fluxvita/saveslot-store-pglite": patch
"@fluxvita/saveslot": patch
---

`saveslot --version` and `saveslot --help` work on musl distributions such as Alpine. Before, every command exited with a stack trace there, because the addon behind local mode's writer lock, which has prebuilds for glibc only, was loaded when the command started; it is now loaded when a lock is first taken. Commands that take the lock still fail on musl.
