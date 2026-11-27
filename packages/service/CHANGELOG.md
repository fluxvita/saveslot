# @fluxvita/saveslot-service

## 0.1.0

### Patch Changes

- 4cb4659: The authorization server takes the external address with a trailing slash (`https://<domain>/`) as a `resource`, as it takes the address without one: a host that authorizes again after its connection was revoked, as Claude Code does, is no longer refused with `invalid_target`.
- 0726f63: `SAVESLOT_TRUSTED_PROXIES` takes CIDR ranges as well as single addresses, so a deployment behind a load balancer whose address changes within a subnet, or behind a CDN, can list them. An entry with bits set past its prefix, a prefix length out of range, or one covering every address is refused, and the error names it.
- @fluxvita/saveslot-contract@0.1.0
  - @fluxvita/saveslot-contract-core@0.1.0
  - @fluxvita/saveslot-kernel@0.1.0

## 0.1.0-rc.0

### Patch Changes

- @fluxvita/saveslot-contract@0.1.0-rc.0
  - @fluxvita/saveslot-contract-core@0.1.0-rc.0
  - @fluxvita/saveslot-kernel@0.1.0-rc.0
