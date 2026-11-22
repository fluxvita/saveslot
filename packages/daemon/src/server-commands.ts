// `saveslot server …` (docs/zh-CN/spec/06-cli.md §4.1 «服务器自部署的运维命令», «服务器模式的配置»;
// 02-architecture §9 «自部署的前提»): the commands a deployer runs on the server. Not contract
// operations: they open the control database themselves.
//
// `init` is safe to run again: the handle key file is made when it is not there and only checked
// when it is; the control database's tables are made when it has none and only their format is
// checked when it has them. The control database is the deployer's: made beforehand, owned by the
// service's role; `init` does not create it.
//
// Exit codes (06 §6.2): 5 for a configuration, key file or control database format refused; 7 when
// the control database cannot be reached; 2 for a usage error.

import { parseArgs } from "node:util";
import {
  ControlPlaneError,
  CursorKeys,
  HandleKeyFileError,
  initControlPlane,
} from "@fluxvita/saveslot-service";
import { type ControlDatabase, openControlDatabase } from "@fluxvita/saveslot-store-postgres";
import type { CommandIO } from "./commands.ts";
import {
  type DatabaseAt,
  readServerConfig,
  type ServerConfig,
  ServerConfigInvalid,
} from "./server-config.ts";
import { TEXTS } from "./texts.ts";

export interface ServerCommandIO extends CommandIO {
  /** The process's environment: where the configuration is read from. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Opens the control database (a test gives one of its own backend's). */
  readonly openControl?: (at: DatabaseAt) => Promise<ControlDatabase>;
}

const SUBCOMMANDS = ["init"] as const;

/** Runs `saveslot server <argv…>`; resolves with the exit code. */
export async function serverCommand(argv: readonly string[], io: ServerCommandIO): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === undefined || !(SUBCOMMANDS as readonly string[]).includes(sub)) {
    io.err(TEXTS.usage(TEXTS.server.usage));
    return 2;
  }
  try {
    parseArgs({ args: [...rest], options: {}, strict: true, allowPositionals: false });
  } catch (e) {
    io.err(TEXTS.usage((e as Error).message));
    return 2;
  }
  let config: ServerConfig;
  try {
    config = readServerConfig(io.env);
  } catch (e) {
    if (!(e instanceof ServerConfigInvalid)) throw e;
    for (const p of e.problems) io.err(TEXTS.server.configProblem(p));
    return 5;
  }
  return serverInit(config, io);
}

async function serverInit(config: ServerConfig, io: ServerCommandIO): Promise<number> {
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
  } catch (e) {
    if (!(e instanceof ControlPlaneError)) throw e;
    io.err(TEXTS.server.controlFormat);
    return 5;
  } finally {
    await db.close();
  }
  io.out(made ? TEXTS.server.keyFileMade : TEXTS.server.keyFileKept);
  io.out(TEXTS.server.controlReady);
  return 0;
}
