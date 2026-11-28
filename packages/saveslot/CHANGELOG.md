# @fluxvita/saveslot

## 0.2.0-rc.0

### Minor Changes

- 12c23c6: A closed item's details leave out a value a pending deletion removed: a conflict's `effective`, an awaiting item's `current` and a flagged item's `matched_values`. Each carries `partially_deleted`, a new optional field of `ConflictDetail.effective`, `AwaitingDetail.current` and `FlaggedDetail`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
- d5d9c8f: A conflict item's `previous` leaves out a value a pending deletion removed, and carries `partially_deleted`, a new optional field of `ConflictDetail.previous`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
- d5d9c8f: Before the local service upgrades a storage format in place, it backs the home's data up next to the home, as a home the version before can open; saveslot never removes it. A failed backup stops the upgrade at step `backup`, and `saveslot start` says what to do. It can be skipped with `upgrade.backup = false` or `saveslot start --no-upgrade-backup`.
- d5d9c8f: A store whose storage format is older is upgraded in place when it is opened, step by step, and a store of a newer format than this version knows is refused (`format_too_new`; one too old to upgrade, `format_too_old`). No upgrade step exists yet. While an upgrade runs, the local service's `/health` says `starting` with the step, `saveslot mcp` answers each call `unavailable` naming it, and a failed upgrade is `upgrade_failed` with its step, after which `saveslot start` exits with code 5.
- d5d9c8f: `TimelineResultCode` gains `removed`, for a `history` timeline item whose content a deletion removed (before, such an item came out with an empty result). MCP and the CLI write it as "(removed by a deletion)". Privacy deletion is not offered in this version, so no item has it yet.

### Patch Changes

- d5d9c8f: `saveslot connect cursor` on a server profile says to issue a static token with `saveslot connect http` and prints the entry with the place for that token in its header. Before, it printed an entry with the address only, which Cursor cannot use: its remote sign-in needs dynamic client registration, which this version does not offer.
- d5d9c8f: `saveslot login` checks that the home, `credentials/` and the profile's credentials file are private before it signs in, and the refusal names the directory or file. Before, it checked them only after the sign-in in the browser, and a home open to others threw the new session away.
- 0bf18e5: `saveslot pending show` writes when an item was opened as "opened 3 h ago", no longer "open 3 h" right after its state. `saveslot connect` on a server profile with `--name`, `--scope` or `--slots` ends its usage error with one full stop instead of two.
- f1fe62e: `saveslot doctor` asks the local service for the hosts' connection instances and their reads only when the service says it is ready, and gives each of these calls up after 10 seconds instead of 60. A service that accepts the connection and does not answer no longer holds `doctor` for a minute at the hosts' step.
- deabb94: `saveslot doctor` gives a reminder for a host whose connection instances have no read besides their self-check, with how that host allows saveslot's tools (Claude Code: allow them when it asks; with `claude -p`, add `--allowedTools "mcp__saveslot"`). A host that has not allowed the tools refuses the agent's calls before they reach saveslot, and without a terminal nothing asks, so a run wrote nothing and said nothing. The reminder is inferred from saveslot's own reads, so a host just connected and not yet used gets it too; it does not change the exit code.
- 52344f1: `saveslot --help` lists `profile list | use <name>`, the options `--home <dir>` and `--profile <name>`, and `vscode` among the hosts of `connect`. All of them worked already; the help did not say so.
- d5d9c8f: `saveslot init` refuses a data directory that is already there and not empty (exit code 5), before it makes anything of the home, and says how to carry data over with export and import. Before, it opened what was there, which could upgrade an older store in place without a backup and then fail.
- 7dd7cb1: `saveslot --version` and `saveslot --help` work on musl distributions such as Alpine. Before, every command exited with a stack trace there, because the addon behind local mode's writer lock, which has prebuilds for glibc only, was loaded when the command started; it is now loaded when a lock is first taken. Commands that take the lock still fail on musl.
- 5eb9521: The package describes saveslot as the open-source database all your AI tools share, links to saveslot.ai as its home page, and carries keywords that match the repository's topics.
- 1d85a28: A pending item whose target a deletion still pending affects is no longer shown as one to decide. On MCP the list says it cannot be decided for now instead of naming decisions, and its detail says which deletions block it, when the last of them is due, and to decide after they have run, instead of saying the connection lacks a scope. The `pending_deletion_target` refusal is said the same way. In the CLI, `saveslot pending` marks the item, `pending show` says the same, a refused decision says it too, and `pending resolve` on such an item shows it and exits 5 without asking. Privacy deletion is not offered in this version, so no item is held this way yet.
- 90ab30a: A paging cursor expires once a deletion is confirmed or cancelled in the tenant after its first page: the next page is refused with `handle_expired`, reason `deletion_changed` (new), and the caller reads again from the first page. What a read leaves out changed between the pages, so one round of paging could have given a stretch twice or missed one. A deletion carried out without a confirmation or cancellation in between does not expire a cursor. Privacy deletion is not offered in this version, so no cursor expires this way yet.
- fc9a36e: A write sent again with its idempotency key gives back the first receipt's parts in the same order, byte for byte. Before, the receipt's `resolved` (and `premise_affected.by_reason`) of a replay could list the same fields in another order.
- 1d8dfd8: Server mode has a readiness endpoint and a bounded shutdown. `GET /ready` (no token) answers 200 only while the server is ready and 503 while it starts, stops or has failed; the image's health check now asks it, and `/health` still answers 200 in every state. On SIGTERM or SIGINT the server keeps serving for `SAVESLOT_SHUTDOWN_DRAIN` seconds (default 10) with `/ready` at 503, then takes no new connections and waits at most `SAVESLOT_SHUTDOWN_TIMEOUT` seconds (default 30) for the requests in progress before closing the connections still open, then closes the tenants within 10 seconds and releases its lock. A second signal skips what is left of the waits. Before, a client that never finished sending its request body kept the server from stopping, and a request that finished during the stop kept its keep-alive connection open for another five seconds. The container's termination grace period must cover the three steps; the example compose file sets `stop_grace_period: 1m`.
- 81220c3: Server mode says which step of a storage format upgrade failed, and nothing of the database's own message. The server log gets `upgrade_failed` with the tenant's database, the step (such as `5->6`) and the SQLSTATE; `server restore`, `server user` and `server init` write the same to standard error, with what to do, and exit 5, where `server restore` used to let the database's message, which may quote stored values, reach standard error. `server restore` and `server user` now log a tenant's upgrade step by step, as `server start` does. The MCP bridge no longer logs `autostart_exit_7` when the service it started is upgrading its store: that is said as `service_upgrading`.
- 7f6d922: Server mode keeps at most `SAVESLOT_TENANT_CONNECTIONS` tenants open per process (default 50), each on one database connection. A tenant to be opened past the limit has the tenant idle for longest closed for it (one whose close failed is tried again); with none idle, its request waits up to 5 seconds and then gets `unavailable` (`busy`) to retry. A request's tenant is not idle between its authentication and the end of its response. A database that refuses the connection as too many (SQLSTATE 53300) gets the same answer, where it used to be `internal`. How long an idle tenant stays open is now `SAVESLOT_TENANT_IDLE` (default 300 seconds).
  
  Tenants are created one at a time in a process, and databases dropped one at a time, so that each process holds at most four connections besides its tenants' and its imports'. A creation waiting more than 5 seconds is answered busy for now: an external login's first sign-in gets 503 with `Retry-After`, the token endpoint `temporarily_unavailable`, and `server user` and `server init` exit 7.
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [0bf18e5]
- Updated dependencies [12c23c6]
- Updated dependencies [d5d9c8f]
- Updated dependencies [f1fe62e]
- Updated dependencies [deabb94]
- Updated dependencies [52344f1]
- Updated dependencies [d5d9c8f]
- Updated dependencies [d5d9c8f]
- Updated dependencies [4e30bbc]
- Updated dependencies [1d85a28]
- Updated dependencies [3ae6e08]
- Updated dependencies [1d8dfd8]
- Updated dependencies [9bf87e1]
- Updated dependencies [6b8cf09]
- Updated dependencies [81220c3]
- Updated dependencies [01e6898]
- Updated dependencies [d5d9c8f]
- Updated dependencies [7f6d922]
- Updated dependencies [d5d9c8f]
  - @fluxvita/saveslot-cli@0.2.0-rc.0
  - @fluxvita/saveslot-daemon@0.2.0-rc.0

## 0.1.0

### Minor Changes

- 060c17c: The first release: the `saveslot` command and its service, in local mode (one computer's agents share it) and in server mode (hosted or self-hosted, with accounts, OAuth and remote MCP).

### Patch Changes

- Updated dependencies [0726f63]
  - @fluxvita/saveslot-daemon@0.1.0
  - @fluxvita/saveslot-cli@0.1.0

## 0.1.0-rc.0

### Minor Changes

- The first release: the `saveslot` command and its service, in local mode (one computer's agents share it) and in server mode (hosted or self-hosted, with accounts, OAuth and remote MCP).

### Patch Changes

- @fluxvita/saveslot-cli@0.1.0-rc.0
  - @fluxvita/saveslot-daemon@0.1.0-rc.0
