// The `saveslot` command (docs/zh-CN/spec/02-architecture.md §11, 06-cli §2 «与 HTTP、MCP 的关系»):
// it only dispatches. The service commands go to the `daemon` package, every other command to the
// `cli` package. `setup`, which spans both, is not in this version yet.

import { type CliIO, run } from "@fluxvita/saveslot-cli";
import { serviceCommand } from "@fluxvita/saveslot-daemon";

/** The commands the `daemon` package has. */
const SERVICE = new Set(["init", "start", "stop", "status", "config", "mcp"] as const);
type ServiceName = typeof SERVICE extends Set<infer N> ? N : never;

/** Runs one command line (without the program name); resolves with its exit code. */
export function dispatch(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIO,
): Promise<number> {
  const [first, ...rest] = argv;
  if (first !== undefined && SERVICE.has(first as ServiceName)) {
    return serviceCommand(first as ServiceName, rest, {
      out: (l) => io.out(`${l}\n`),
      err: (l) => io.err(`${l}\n`),
    });
  }
  return run(argv, env, io);
}
