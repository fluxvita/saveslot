---
"@fluxvita/saveslot-server": patch
"@fluxvita/saveslot-service": patch
"@fluxvita/saveslot-daemon": patch
---

When the authorization page refuses a request because its client could not be resolved, the request's log line says why: `client_problem` with the error's code, and `client_status` with the status the client's host answered the fetch with, when it answered. The page the user sees is unchanged. The fetch of a client document now sends `User-Agent: saveslot/<version>`.
