// `saveslot server …` (docs/zh-CN/spec/06-cli.md §4.1 «服务器自部署的运维命令», «服务器模式的配置»;
// 02-architecture §9 «自部署的前提»): the commands a deployer runs on the server. Not contract
// operations: they open the control database themselves.
//
// `init` is safe to run again: the handle key file is made when it is not there and only checked
// when it is; the control database's tables are made when it has none and only their format is
// checked when it has them: the control plane's, and the chosen identity provider's
// (server-identity.ts). The control database is the deployer's: made beforehand, owned by the
// service's role; `init` does not create it.
//
// `start` runs the server in the foreground (run-server.ts) until SIGTERM or SIGINT, or until its
// control database's connection goes away (and the server lock with it): then it closes and exits 7,
// for the process manager to start it again. `restore` is in server-restore-command.ts.
//
// Exit codes (06 §6.2): 5 for a configuration, key file, identity setting or control database
// table refused; 7 when the control database cannot be reached, a server already runs on it, or
// its connection went away while serving; 2 for a usage error.

import { parseArgs } from "node:util";
import {
  ControlPlaneError,
  CursorKeys,
  HandleKeyFileError,
  initControlPlane,
} from "@fluxvita/saveslot-service";
import { type ControlDatabase, openControlDatabase } from "@fluxvita/saveslot-store-postgres";
import { daemonVersion } from "./main.ts";
import {
  ControlUnreachable,
  type RunningServer,
  runServer,
  ServerAlreadyRunning,
  ServerStartRefused,
} from "./run-server.ts";
import type { ServerCommandIO } from "./server-command-io.ts";
import { readServerConfig, type ServerConfig, ServerConfigInvalid } from "./server-config.ts";
import {
  IdentityTablesRefused,
  initIdentityTables,
  readIdentity,
  ServerIdentityRefused,
} from "./server-identity.ts";
import { restoreTarget, type ServerRestoreIO, serverRestore } from "./server-restore-command.ts";
import { TEXTS } from "./texts.ts";

const SUBCOMMANDS = ["init", "start", "restore"] as const;

/**
 * Resolves at the first SIGTERM or SIGINT: what a supervisor (systemd, a container) sends. `cancel`
 * stops listening for them.
 */
function stopSignal(): { readonly stopped: Promise<void>; cancel(): void } {
  let done!: () => void;
  const stopped = new Promise<void>((resolve) => {
    done = () => {
      process.off("SIGTERM", done);
      process.off("SIGINT", done);
      resolve();
    };
  });
  process.once("SIGTERM", done);
  process.once("SIGINT", done);
  return {
    stopped,
    cancel: () => {
      process.off("SIGTERM", done);
      process.off("SIGINT", done);
    },
  };
}

/** Runs `saveslot server <argv…>`; resolves with the exit code. */
export async function serverCommand(argv: readonly string[], io: ServerRestoreIO): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    io.err(TEXTS.usage(TEXTS.server.usage));
    return 2;
  }
  let target: Exclude<ReturnType<typeof restoreTarget>, number> | undefined;
  if (sub === "restore") {
    const t = restoreTarget(rest, io);
    if (typeof t === "number") return t;
    target = t;
  } else {
    try {
      parseArgs({ args: [...rest], options: {}, strict: true, allowPositionals: false });
    } catch (e) {
      io.err(TEXTS.usage((e as Error).message));
      return 2;
    }
  }
  let config: ServerConfig;
  try {
    config = readServerConfig(io.env);
  } catch (e) {
    if (!(e instanceof ServerConfigInvalid)) throw e;
    for (const p of e.problems) io.err(TEXTS.server.configProblem(p));
    return 5;
  }
  if (target !== undefined) return serverRestore(config, target, io);
  return sub === "start" ? serverStart(config, io) : serverInit(config, io);
}

async function serverInit(config: ServerConfig, io: ServerCommandIO): Promise<number> {
  // The external login's settings before anything is made: a key file it cannot use refuses init
  // as it would refuse start.
  let external: Awaited<ReturnType<typeof readIdentity>>;
  try {
    external = await readIdentity(config);
  } catch (e) {
    if (!(e instanceof ServerIdentityRefused)) throw e;
    io.err(TEXTS.server.identityRefused(e.message));
    return 5;
  }
  let made: boolean;
  try {
    made = (await CursorKeys.createFile(config.handleKeyFile)).created;
  } catch (e) {
    if (e instanceof HandleKeyFileError) {
      io.err(TEXTS.server.keyFileProblem(e.code));
      return 5;
    }
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      io.err(TEXTS.server.keyFileNoDirectory);
      return 5;
    }
    throw e;
  }
  let db: ControlDatabase;
  try {
    db = await (io.openControl ?? ((at) => openControlDatabase(at.cell, at.database)))(
      config.control,
    );
  } catch {
    // The driver's message may name the host or the role: the variable is named instead.
    io.err(TEXTS.server.controlUnreachable);
    return 7;
  }
  try {
    await initControlPlane(db);
    await initIdentityTables(db, external);
  } catch (e) {
    if (!(e instanceof ControlPlaneError) && !(e instanceof IdentityTablesRefused)) throw e;
    io.err(TEXTS.server.controlFormat);
    return 5;
  } finally {
    await db.close();
  }
  io.out(made ? TEXTS.server.keyFileMade : TEXTS.server.keyFileKept);
  io.out(TEXTS.server.controlReady);
  return 0;
}

/**
 * `server start` (06 §4.1): in the foreground until SIGTERM or SIGINT, then closes and exits 0; or
 * until the control database's connection goes away, then closes and exits 7. Each request is a
 * line on stdout; warnings go to stderr.
 */
async function serverStart(config: ServerConfig, io: ServerRestoreIO): Promise<number> {
  let running: RunningServer;
  try {
    running = await runServer({
      config,
      version: daemonVersion(),
      ...(io.openControl !== undefined ? { openControl: io.openControl } : {}),
      ...(io.backend !== undefined ? { backend: io.backend } : {}),
      log: (fields) => io.out(JSON.stringify(fields)),
      warn: (event, fields) => io.err(JSON.stringify({ warning: event, ...fields })),
    });
  } catch (e) {
    if (e instanceof ControlUnreachable) {
      io.err(TEXTS.server.controlUnreachable);
      return 7;
    }
    if (e instanceof ServerAlreadyRunning) {
      io.err(TEXTS.server.alreadyRunning);
      return 7;
    }
    if (e instanceof ServerStartRefused || e instanceof IdentityTablesRefused) {
      io.err(TEXTS.server.startRefused(e.set, e.reason));
      return 5;
    }
    if (e instanceof ServerIdentityRefused) {
      io.err(TEXTS.server.identityRefused(e.message));
      return 5;
    }
    if (e instanceof HandleKeyFileError) {
      io.err(TEXTS.server.keyFileProblem(e.code));
      return 5;
    }
    throw e;
  }
  io.out(TEXTS.server.listening(running.address.host, running.address.port));
  const signal =
    io.stopped !== undefined ? { stopped: io.stopped(), cancel: () => {} } : stopSignal();
  const lost = await Promise.race([
    signal.stopped.then(() => false),
    running.failed.then(() => true),
  ]);
  signal.cancel();
  await running.close();
  if (lost) {
    io.err(TEXTS.server.controlLost);
    return 7;
  }
  io.out(TEXTS.server.stoppedCleanly);
  return 0;
}
