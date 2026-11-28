---
"@fluxvita/saveslot-daemon": minor
---

With the external login configured, an operator can disable and enable an account: `saveslot server user disable --subject <account ID>` (and `enable`), with `--issuer` defaulting to the configured issuer. While it is disabled, every credential of its tenant (CLI sessions, their refresh, connection instances) is refused as `account_disabled`; enabled, the same tokens work again. An account not there gives exit code 4. It runs while the server is running.
