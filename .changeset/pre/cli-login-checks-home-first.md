---
"@fluxvita/saveslot-cli": patch
"@fluxvita/saveslot": patch
---

`saveslot login` checks that the home, `credentials/` and the profile's credentials file are private before it signs in, and the refusal names the directory or file. Before, it checked them only after the sign-in in the browser, and a home open to others threw the new session away.
