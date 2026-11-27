# @fluxvita/saveslot-daemon

## 0.1.0

### Patch Changes

- 0726f63: `SAVESLOT_TRUSTED_PROXIES` takes CIDR ranges as well as single addresses, so a deployment behind a load balancer whose address changes within a subnet, or behind a CDN, can list them. An entry with bits set past its prefix, a prefix length out of range, or one covering every address is refused, and the error names it.
- Updated dependencies [73b0bf6]
- Updated dependencies [4cb4659]
- Updated dependencies [0726f63]
  - @fluxvita/saveslot-server@0.1.0
  - @fluxvita/saveslot-service@0.1.0
  - @fluxvita/saveslot-store-pglite@0.1.0
  - @fluxvita/saveslot-store-postgres@0.1.0

## 0.1.0-rc.0

### Patch Changes

- @fluxvita/saveslot-server@0.1.0-rc.0
  - @fluxvita/saveslot-service@0.1.0-rc.0
  - @fluxvita/saveslot-store-pglite@0.1.0-rc.0
  - @fluxvita/saveslot-store-postgres@0.1.0-rc.0
