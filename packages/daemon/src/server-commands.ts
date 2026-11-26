// `saveslot server …` (docs/zh-CN/spec/06-cli.md §4.1 «服务器自部署的运维命令», «服务器模式的配置»;
// 02-architecture §9 «自部署的前提»): the commands a deployer runs on the server. Not contract
// operations: they open the control database themselves.
//
// `init` is safe to run again: the handle key file is made when it is not there and only checked
// when it is; the control database's tables are made when it has none and only their format is
// checked when it has them: the control plane's, and the chosen identity provider's
// (server-identity.ts). The control database is the deployer's: made beforehand, owned by the
// service's role; `init` does not create it. With `--user <name>` and the local accounts, it makes
// the first account and its tenant when there is no account yet, the password read as `server
// user add` reads it (./server-user-command.ts); with accounts there, it makes none and asks for no
// password. With the external login configured, `--user` is refused before anything is made.
//
// `start` runs the server in the foreground (run-server.ts) until SIGTERM or SIGINT, or until its
// control database's connection goes away (and the server lock with it): then it closes and exits 7,
// for the process manager to start it again. `restore` is in server-restore-command.ts, `user` in
// server-user-command.ts.
//
// Exit codes (06 §6.2): 5 for a configuration, key file, identity setting or control database
// table refused, and for init's first account refused (its name or password, the external login);
// 7 when the control database cannot be reached, a server already runs on it, or its connection
// went away while serving; 2 for a usage error or a password file refused; 8 for init --user with
// no terminal and no password file; 130 at Ctrl-C at the password prompt.

import { parseArgs } from "node:util";
import {
  ControlPlaneError,
  CursorKeys,
  HandleKeyFileError,
  initControlPlane,
  initOAuthTables,
  LocalAccountsError,
  listLocalUsers,
  NAME_SHAPE,
  PASSWORD_MAX,
  PASSWORD_MIN,
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
import {
  accountRefused,
  addUser,
  openAccounts,
  type PasswordSource,
  passwordSource,
  readPassword,
  serverUser,
  type UserTarget,
  userTarget,
} from "./server-user-command.ts";
import { TEXTS } from "./texts.ts";

const SUBCOMMANDS = ["init", "start", "restore", "user"] as const;

/** `init`'s first account: its name, and the password file if one is given. */
interface FirstUser {
  readonly user?: string;
  readonly passwordFile?: string;
}

/**
 * The stop signals, SIGTERM and SIGINT: what a supervisor (systemd, a container) sends. `stopped`
 * resolves at the first. Once `whileClosing` is given its function, every later one calls it (a
 * second signal cuts the closing short, 06-cli §4.1 `saveslot server start`) instead of Node's
 * default, which would end the process with the lock and the tenants left as they were. `cancel`
 * stops listening for them.
 */
function stopSignal(): {
  readonly stopped: Promise<void>;
  whileClosing(fn: () => void): void;
  cancel(): void;
} {
  const stopped = Promise.withResolvers<void>();
  let first = true;
  let later: (() => void) | undefined;
  const on = () => {
    if (first) {
      first = false;
      stopped.resolve();
      return;
    }
    later?.();
  };
  process.on("SIGTERM", on);
  process.on("SIGINT", on);
  return {
    stopped: stopped.promise,
    whileClosing: (fn) => {
      first = false;
      later = fn;
    },
    cancel: () => {
      process.off("SIGTERM", on);
      process.off("SIGINT", on);
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
  let user: UserTarget | undefined;
  let first: FirstUser = {};
  if (sub === "restore") {
    const t = restoreTarget(rest, io);
    if (typeof t === "number") return t;
    target = t;
  } else if (sub === "user") {
    const t = userTarget(rest, io);
    if (typeof t === "number") return t;
    user = t;
  } else if (sub === "init") {
    const f = initTarget(rest, io);
    if (typeof f === "number") return f;
    first = f;
  } else {
    try {
      parseArgs({ args: [...rest], options: {}, strict: true, allowPositionals: false });
    } catch {
      // The usage, not the argument: one typed by mistake may be a password.
      io.err(TEXTS.usage(TEXTS.server.usage));
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
  try {
    if (target !== undefined) return await serverRestore(config, target, io);
    if (user !== undefined) return await serverUser(config, user, io);
    return sub === "start" ? await serverStart(config, io) : await serverInit(config, first, io);
  } catch (e) {
    // A tenant's storage format upgrade that failed (02-architecture §8): the step and the
    // SQLSTATE only, never the database's message, which may quote what the store holds.
    const { code, step, sqlState } = (e ?? {}) as {
      code?: unknown;
      step?: unknown;
      sqlState?: unknown;
    };
    if (code === "upgrade_failed") {
      io.err(
        TEXTS.server.upgradeFailed(
          typeof step === "string" ? step : undefined,
          typeof sqlState === "string" ? sqlState : undefined,
        ),
      );
      return 5;
    }
    throw e;
  }
}

/** `init`'s options; a number is the exit code of a usage error. */
function initTarget(rest: readonly string[], io: Pick<ServerCommandIO, "err">): FirstUser | number {
  let values: { user?: string[] | undefined; "password-file"?: string[] | undefined };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      // Collected, so that one given twice is refused rather than the last one taken (06 §6.2).
      options: {
        user: { type: "string", multiple: true },
        "password-file": { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch {
    // The usage, not the argument: one typed by mistake may be a password.
    io.err(TEXTS.usage(TEXTS.server.usage));
    return 2;
  }
  const users = values.user ?? [];
  const files = values["password-file"] ?? [];
  if (users.length > 1 || users[0] === "") {
    io.err(TEXTS.usage(TEXTS.server.initUserOnce));
    return 2;
  }
  if (files.length > 1 || files[0] === "") {
    io.err(TEXTS.usage(TEXTS.server.passwordFileOnce));
    return 2;
  }
  if (files.length > 0 && users.length === 0) {
    io.err(TEXTS.usage(TEXTS.server.initPasswordFileWithoutUser));
    return 2;
  }
  return {
    ...(users[0] !== undefined ? { user: users[0] } : {}),
    ...(files[0] !== undefined ? { passwordFile: files[0] } : {}),
  };
}

async function serverInit(
  config: ServerConfig,
  first: FirstUser,
  io: ServerRestoreIO,
): Promise<number> {
  // The first account's name and password source before anything is made: refused, nothing is.
  let source: PasswordSource | undefined;
  let password: string | undefined;
  if (first.user !== undefined) {
    if (config.identity !== undefined) {
      io.err(TEXTS.server.userExternal);
      return 5;
    }
    if (!NAME_SHAPE.test(first.user)) {
      return accountRefused(new LocalAccountsError("bad_name", "not a name"), first.user, io);
    }
    source = passwordSource(first.passwordFile, io);
    if (source === undefined) return 8;
    // A file is read now, and its password's length checked, before anything is made; the
    // terminal asks only when the account is to be made, after the tables: a refusal then leaves
    // them in place, and says so.
    if ("file" in source) {
      const read = await readPassword(source, io);
      if (typeof read === "number") return read;
      if (read.length < PASSWORD_MIN || read.length > PASSWORD_MAX) {
        return accountRefused(
          new LocalAccountsError("bad_password", "not a password"),
          first.user,
          io,
        );
      }
      password = read;
    }
  }
  try {
    return await initWith(config, first, source, password, io);
  } finally {
    if (source !== undefined && "terminal" in source) source.terminal.close();
  }
}

async function initWith(
  config: ServerConfig,
  first: FirstUser,
  source: PasswordSource | undefined,
  given: string | undefined,
  io: ServerRestoreIO,
): Promise<number> {
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
    try {
      await initControlPlane(db);
      await initOAuthTables(db);
      await initIdentityTables(db, external);
    } catch (e) {
      if (!(e instanceof ControlPlaneError) && !(e instanceof IdentityTablesRefused)) throw e;
      io.err(TEXTS.server.controlFormat);
      return 5;
    }
    io.out(made ? TEXTS.server.keyFileMade : TEXTS.server.keyFileKept);
    io.out(TEXTS.server.controlReady);
    if (external !== undefined) return 0;
    return await firstAccount(config, db, first, source, given, io);
  } finally {
    await db.close();
  }
}

/**
 * The local accounts' first account, made when `--user` is given and there is none yet; an account
 * of that name an earlier run left without its tenant is finished. With other accounts there,
 * nothing is made, and no password asked.
 */
async function firstAccount(
  config: ServerConfig,
  db: ControlDatabase,
  first: FirstUser,
  source: PasswordSource | undefined,
  given: string | undefined,
  io: ServerRestoreIO,
): Promise<number> {
  const opened = await openAccounts(db, io);
  if (typeof opened === "number") return opened;
  const users = await listLocalUsers(opened.accounts);
  const same = users.find((u) => u.name === first.user);
  const unfinished =
    same !== undefined && (await opened.control.tenantOf(same.user))?.state !== "active";
  if (users.length > 0 && !unfinished) {
    if (first.user !== undefined) io.out(TEXTS.server.initAccountsExist);
    return 0;
  }
  if (first.user === undefined || source === undefined) {
    io.out(TEXTS.server.initNoUser);
    return 0;
  }
  let password = given;
  if (password === undefined) {
    const read = await readPassword(source, io, TEXTS.server.initAccountNotMade);
    if (typeof read === "number") return read;
    password = read;
  }
  try {
    const { tenant } = await addUser(config, opened, first.user, password, io);
    io.out(
      unfinished
        ? TEXTS.server.initAccountFinished(first.user, tenant)
        : TEXTS.server.initFirstUser(first.user, tenant),
    );
    return 0;
  } catch (e) {
    if (e instanceof LocalAccountsError) {
      return accountRefused(e, first.user, io, TEXTS.server.initAccountNotMade);
    }
    throw e;
  }
}

/**
 * `server start` (06 §4.1): in the foreground until SIGTERM or SIGINT, then closes (in its three
 * steps; another signal cuts them short) and exits 0; or
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
  const given = io.stopped;
  const signal =
    given !== undefined
      ? {
          stopped: given(),
          whileClosing: (fn: () => void) => {
            void io.stoppedAgain?.().then(fn);
          },
          cancel: () => {},
        }
      : stopSignal();
  const lost = await Promise.race([
    signal.stopped.then(() => false),
    running.failed.then(() => true),
  ]);
  signal.whileClosing(() => running.hurry());
  let tenantsLeft: boolean;
  try {
    ({ tenantsLeft } = await running.close());
  } finally {
    signal.cancel();
  }
  if (lost) io.err(TEXTS.server.controlLost);
  else io.out(TEXTS.server.stoppedCleanly);
  const code = lost ? 7 : 0;
  // A use stuck on a tenant still holds its database connection, which would keep the process up
  // until the supervisor kills it: it ends here instead, its transaction rolled back with the
  // connection (its client was cut at step 2).
  if (tenantsLeft) await io.exit?.(code);
  return code;
}
