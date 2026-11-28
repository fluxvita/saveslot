---
"@fluxvita/saveslot-daemon": minor
"@fluxvita/saveslot-server": patch
---

The local service process starts with V8's baseline compiler only (Node's `--liftoff-only`), a new setting `service.low_memory`, on by default: its resident memory roughly halves (idle after a load of 34k rows, about 960 MB down to about 410 MB), and SQL runs 1.3 to 2 times slower. `saveslot config set service.low_memory off` turns it off at the next start; a start-at-login job takes it at `saveslot service install`. `/health` gives `low_memory`, `saveslot status` shows it, and `saveslot doctor` reminds when the running service or the start-at-login job differs from `config.toml`.
