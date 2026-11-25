---
"@fluxvita/saveslot-service": patch
---

The authorization server takes the external address with a trailing slash (`https://<domain>/`) as a `resource`, as it takes the address without one: a host that authorizes again after its connection was revoked, as Claude Code does, is no longer refused with `invalid_target`.
