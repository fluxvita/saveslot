// The `saveslot` executable: the command line to `dispatch`, the exit code back. A question is
// written to stderr and its answer read from stdin, a line at a time (./ask.ts).
import { lineAsker } from "./ask.ts";
import { dispatch } from "./dispatch.ts";

const asker = lineAsker(process.stdin, process.stderr);
// A closed stdout or stderr (EPIPE) is no crash: a write that fails says so to the command.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
try {
  process.exitCode = await dispatch(process.argv.slice(2), process.env, {
    out: (s) => new Promise<boolean>((done) => process.stdout.write(s, (e) => done(e == null))),
    err: (s) => process.stderr.write(s),
    stdoutIsTTY: process.stdout.isTTY === true,
    stderrIsTTY: process.stderr.isTTY === true,
    stdinIsTTY: process.stdin.isTTY === true,
    ask: asker.ask,
    // As started: absolute, links kept (06-cli §3.2: the path the host is to start saveslot by).
    ...(process.argv[1] !== undefined ? { entry: process.argv[1] } : {}),
  });
} finally {
  asker.close();
}
