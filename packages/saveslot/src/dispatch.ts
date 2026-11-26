// The `saveslot` command (docs/zh-CN/spec/02-architecture.md §11, 06-cli §2 «与 HTTP、MCP 的关系»):
// it only dispatches. The service commands go to the `daemon` package, every other command to the
// `cli` package; `setup`, which spans both, to the `cli` package with the `daemon` package's steps.

import { type CliIO, doctorHosts, localSession, run } from "@fluxvita/saveslot-cli";
import {
  daemonVersion,
  homeProblem,
  init,
  initialized,
  serverCommand,
  serviceCommand,
  setupLock,
  start,
} from "@fluxvita/saveslot-daemon";

/** The commands the `daemon` package has. */
const SERVICE = new Set([
  "init",
  "start",
  "stop",
  "status",
  "config",
  "mcp",
  "service",
  "doctor",
] as const);
type ServiceName = typeof SERVICE extends Set<infer N> ? N : never;

/** Runs one command line (without the program name); resolves with its exit code. */
export function dispatch(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
  io: CliIO,
): Promise<number> {
  // `saveslot --version` (06 §4): the version the service reports on /health and `start` compares,
  // the one `status` gives as this saveslot's.
  if (argv.length === 1 && argv[0] === "--version") {
    io.out(`${daemonVersion()}\n`);
    return Promise.resolve(0);
  }
  const [first, ...rest] = argv;
  // `saveslot server …` (06 §4.1): the server mode's commands, configured by the environment.
  if (first === "server") {
    return serverCommand(rest, {
      out: (l) => io.out(`${l}\n`),
      err: (l) => io.err(`${l}\n`),
      env,
      // `server start` closed with a tenant's use given up on (06 §4.1): what holds it would keep
      // the process up, so it ends once stdout and stderr are written out.
      exit: async (code) => {
        for (const s of [process.stdout, process.stderr]) {
          await new Promise<void>((done) => s.write("", () => done()));
        }
        process.exit(code);
      },
    });
  }
  if (first !== undefined && SERVICE.has(first as ServiceName)) {
    const cmdIO = { out: (l: string) => io.out(`${l}\n`), err: (l: string) => io.err(`${l}\n`) };
    // doctor: the hosts' entries are the CLI's to look at (06 §3 step 7).
    return first === "doctor"
      ? serviceCommand("doctor", rest, cmdIO, undefined, {
          hosts: (home) =>
            doctorHosts({ env, entry: io.entry, session: () => localSession(home, env) }),
        })
      : serviceCommand(first as ServiceName, rest, cmdIO);
  }
  // `setup` spans both: the service's steps are the daemon package's own code (06 §3.3).
  return run(argv, env, io, {
    initialized,
    init: (home, lio) => init(home, { rotate: false }, lio),
    start: async (home, lio, stop) => {
      let started = false;
      const exit = await start(home, lio, {
        stop,
        onStarted: () => {
          started = true;
        },
      });
      return { exit, started };
    },
    homeProblem,
    lock: setupLock,
  });
}
