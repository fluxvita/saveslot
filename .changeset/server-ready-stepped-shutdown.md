---
"@fluxvita/saveslot-daemon": patch
"@fluxvita/saveslot": patch
---

Server mode has a readiness endpoint and a bounded shutdown. `GET /ready` (no token) answers 200 only while the server is ready and 503 while it starts, stops or has failed; the image's health check now asks it, and `/health` still answers 200 in every state. On SIGTERM or SIGINT the server keeps serving for `SAVESLOT_SHUTDOWN_DRAIN` seconds (default 10) with `/ready` at 503, then takes no new connections and waits at most `SAVESLOT_SHUTDOWN_TIMEOUT` seconds (default 30) for the requests in progress before closing the connections still open, then closes the tenants within 10 seconds and releases its lock. A second signal skips what is left of the waits. Before, a client that never finished sending its request body kept the server from stopping, and a request that finished during the stop kept its keep-alive connection open for another five seconds. The container's termination grace period must cover the three steps; the example compose file sets `stop_grace_period: 1m`.
