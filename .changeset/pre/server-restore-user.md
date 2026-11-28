---
"@fluxvita/saveslot-daemon": patch
---

`saveslot server restore` can name the tenant by its local account's name (`--user <name>`) instead of its ID (`--tenant <tenant>`): exactly one of the two. An account that is not there is exit code 4; an account whose tenant is not made yet, or `--user` with the external login configured, is exit code 5.
