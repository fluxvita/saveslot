# @fluxvita/saveslot-cli

## 0.2.0-rc.0

### Minor Changes

- 12c23c6: A closed item's details leave out a value a pending deletion removed: a conflict's `effective`, an awaiting item's `current` and a flagged item's `matched_values`. Each carries `partially_deleted`, a new optional field of `ConflictDetail.effective`, `AwaitingDetail.current` and `FlaggedDetail`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
- d5d9c8f: A conflict item's `previous` leaves out a value a pending deletion removed, and carries `partially_deleted`, a new optional field of `ConflictDetail.previous`; MCP and the CLI say so where it is set. Privacy deletion is not offered in this version, so no item has it yet.
- d5d9c8f: `TimelineResultCode` gains `removed`, for a `history` timeline item whose content a deletion removed (before, such an item came out with an empty result). MCP and the CLI write it as "(removed by a deletion)". Privacy deletion is not offered in this version, so no item has it yet.

### Patch Changes

- d5d9c8f: `saveslot connect cursor` on a server profile says to issue a static token with `saveslot connect http` and prints the entry with the place for that token in its header. Before, it printed an entry with the address only, which Cursor cannot use: its remote sign-in needs dynamic client registration, which this version does not offer.
- d5d9c8f: `saveslot login` checks that the home, `credentials/` and the profile's credentials file are private before it signs in, and the refusal names the directory or file. Before, it checked them only after the sign-in in the browser, and a home open to others threw the new session away.
- 0bf18e5: `saveslot pending show` writes when an item was opened as "opened 3 h ago", no longer "open 3 h" right after its state. `saveslot connect` on a server profile with `--name`, `--scope` or `--slots` ends its usage error with one full stop instead of two.
- f1fe62e: `saveslot doctor` asks the local service for the hosts' connection instances and their reads only when the service says it is ready, and gives each of these calls up after 10 seconds instead of 60. A service that accepts the connection and does not answer no longer holds `doctor` for a minute at the hosts' step.
- deabb94: `saveslot doctor` gives a reminder for a host whose connection instances have no read besides their self-check, with how that host allows saveslot's tools (Claude Code: allow them when it asks; with `claude -p`, add `--allowedTools "mcp__saveslot"`). A host that has not allowed the tools refuses the agent's calls before they reach saveslot, and without a terminal nothing asks, so a run wrote nothing and said nothing. The reminder is inferred from saveslot's own reads, so a host just connected and not yet used gets it too; it does not change the exit code.
- 52344f1: `saveslot --help` lists `profile list | use <name>`, the options `--home <dir>` and `--profile <name>`, and `vscode` among the hosts of `connect`. All of them worked already; the help did not say so.
- 4e30bbc: `saveslot_history` with `changes`, and `saveslot history changes`, no longer show a side withheld for deleted content as an empty value. In a change marked `partially_deleted`, a missing side reads "not shown" instead of `—`, which looked like the value had been cleared, or instead of giving only the new value, which looked like there had been none before. The line ends with "partly deleted: what is not shown came from content deleted since". A newly inserted row still gives only its new value. Privacy deletion is not offered in this version, so no change is marked yet.
- 1d85a28: A pending item whose target a deletion still pending affects is no longer shown as one to decide. On MCP the list says it cannot be decided for now instead of naming decisions, and its detail says which deletions block it, when the last of them is due, and to decide after they have run, instead of saying the connection lacks a scope. The `pending_deletion_target` refusal is said the same way. In the CLI, `saveslot pending` marks the item, `pending show` says the same, a refused decision says it too, and `pending resolve` on such an item shows it and exits 5 without asking. Privacy deletion is not offered in this version, so no item is held this way yet.
- @fluxvita/saveslot-client@0.2.0-rc.0

## 0.1.0

### Patch Changes

- @fluxvita/saveslot-client@0.1.0

## 0.1.0-rc.0

### Patch Changes

- @fluxvita/saveslot-client@0.1.0-rc.0
