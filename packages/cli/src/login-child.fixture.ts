// A sign-in run as its own process (./login.test.ts): the home, the server and the mode. It prints
// the result on stdout and returns without process.exit, as the CLI's entry does: a timer left
// pending keeps it running.

import { type SignInMode, signIn } from "./login.ts";

const [home, server, mode] = process.argv.slice(2) as [string, string, SignInMode];
const r = await signIn({
  home,
  profile: "lab",
  server,
  io: { err: (s) => process.stderr.write(s), stderrIsTTY: false },
  mode,
});
process.stdout.write(`${JSON.stringify(r)}\n`);
