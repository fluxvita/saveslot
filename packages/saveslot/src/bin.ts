// The `saveslot` executable: the command line to `dispatch`, the exit code back. A question is
// written to stderr and its answer read from stdin, a line at a time.
import { createInterface } from "node:readline/promises";
import { dispatch } from "./dispatch.ts";

async function ask(prompt: string): Promise<string | undefined> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  process.stderr.write(prompt);
  try {
    for await (const line of rl) return line;
    return undefined;
  } finally {
    rl.close();
  }
}

process.exitCode = await dispatch(process.argv.slice(2), process.env, {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  stdoutIsTTY: process.stdout.isTTY === true,
  stderrIsTTY: process.stderr.isTTY === true,
  stdinIsTTY: process.stdin.isTTY === true,
  ask,
});
