---
"@fluxvita/saveslot-cli": patch
"@fluxvita/saveslot-daemon": patch
"@fluxvita/saveslot": patch
---

`saveslot doctor` asks the local service for the hosts' connection instances and their reads only when the service says it is ready, and gives each of these calls up after 10 seconds instead of 60. A service that accepts the connection and does not answer no longer holds `doctor` for a minute at the hosts' step.
