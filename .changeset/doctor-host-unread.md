---
"@fluxvita/saveslot-cli": patch
"@fluxvita/saveslot-daemon": patch
"@fluxvita/saveslot": patch
---

`saveslot doctor` gives a reminder for a host whose connection instances have no read besides their self-check, with how that host allows saveslot's tools (Claude Code: allow them when it asks; with `claude -p`, add `--allowedTools "mcp__saveslot"`). A host that has not allowed the tools refuses the agent's calls before they reach saveslot, and without a terminal nothing asks, so a run wrote nothing and said nothing. The reminder is inferred from saveslot's own reads, so a host just connected and not yet used gets it too; it does not change the exit code.
