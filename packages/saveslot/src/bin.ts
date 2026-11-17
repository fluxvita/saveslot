// The `saveslot` executable: the command line to `dispatch`, the exit code back.
import { dispatch } from "./dispatch.ts";

process.exitCode = await dispatch(process.argv.slice(2), process.env, {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
  stdoutIsTTY: process.stdout.isTTY === true,
  stderrIsTTY: process.stderr.isTTY === true,
});
