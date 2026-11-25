---
"@fluxvita/saveslot-service": patch
"@fluxvita/saveslot-daemon": patch
---

`SAVESLOT_TRUSTED_PROXIES` takes CIDR ranges as well as single addresses, so a deployment behind a load balancer whose address changes within a subnet, or behind a CDN, can list them. An entry with bits set past its prefix, a prefix length out of range, or one covering every address is refused, and the error names it.
