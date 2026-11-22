// A second command refreshing a profile (./profile-credentials.test.ts): run as its own process
// with the home, the profile and the server; prints the access token it ends with, or the error's
// code.

import { refreshProfile } from "./profile-credentials.ts";

const [home, profile, server] = process.argv.slice(2) as [string, string, string];
refreshProfile(home, profile, server).then(
  (token) => process.stdout.write(`${token}\n`),
  (e: { code?: string }) => process.stdout.write(`error ${e.code ?? String(e)}\n`),
);
