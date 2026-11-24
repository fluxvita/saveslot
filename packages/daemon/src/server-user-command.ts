// `saveslot server user add | list | disable | enable | passwd` (docs/zh-CN/spec/06-cli.md §4.1
// «服务器自部署的运维命令»): the deployer's commands for the built-in local accounts, on the control
// database, through the local accounts' own operations (service's local-accounts.ts). There is no
// sign-up: an account is made here or by `server init --user`.
//
// - `add <name>` makes the account and its tenant.
// - `list` gives each account's name, state and tenant, by name.
// - `disable <name>` / `enable <name>` change its state only: while disabled, every credential of
//   its tenant is refused at authentication; nothing is revoked, nothing written to its log.
// - `passwd <name>` sets its password through `setLocalPassword`, which ends its web logins and user
//   sessions in the same transaction (and refreshes of sessions granted until now); its connections
//   keep authenticating.
//
// Only for the local accounts: with the external login configured, every subcommand is refused
// before the control database is opened. The password is read before it is opened, too
// (./server-password.ts). They do not take the server-running lock: the server reads these tables
// on each request, so they work while it runs.
//
// Exit codes (06 §6.2): 2 for a usage error or a password file refused; 4 for an account that is
// not there; 5 for a configuration refused, the external login configured, the tables missing or of
// another format, a name taken or not valid, a password not valid; 7 when the control database
// cannot be reached; 8 with no terminal and no password file; 130 at Ctrl-C at the prompt.

import { parseArgs } from "node:util";
import {
  addLocalUser,
  ControlPlaneError,
  disableLocalUser,
  enableLocalUser,
  type LocalAccounts,
  LocalAccountsError,
  listLocalUsers,
  openControlPlane,
  openLocalAccounts,
  type ServerControlPlane,
  setLocalPassword,
} from "@fluxvita/saveslot-service";
import {
  type ControlDatabase,
  openControlDatabase,
  PostgresBackend,
} from "@fluxvita/saveslot-store-postgres";
import type { ServerConfig } from "./server-config.ts";
import {
  openControllingTerminal,
  PasswordFileRefused,
  PasswordInterrupted,
  PasswordsDiffer,
  type PasswordTerminal,
  passwordFromFile,
  passwordFromTerminal,
} from "./server-password.ts";
import type { ServerRestoreIO } from "./server-restore-command.ts";
import { TEXTS } from "./texts.ts";

export type UserTarget =
  | { readonly sub: "add" | "passwd"; readonly name: string; readonly passwordFile?: string }
  | { readonly sub: "disable" | "enable"; readonly name: string }
  | { readonly sub: "list" };

const USER_SUBCOMMANDS = ["add", "list", "disable", "enable", "passwd"] as const;

/** The subcommand asked for, from `user`'s arguments; a number is the exit code of a usage error. */
export function userTarget(
  rest: readonly string[],
  io: Pick<ServerRestoreIO, "err">,
): UserTarget | number {
  const [sub, ...args] = rest;
  if (sub === undefined || !(USER_SUBCOMMANDS as readonly string[]).includes(sub)) {
    io.err(TEXTS.usage(TEXTS.server.userUsage));
    return 2;
  }
  const takesPassword = sub === "add" || sub === "passwd";
  let values: { "password-file"?: string[] | undefined };
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args,
      // Collected, so that one given twice is refused rather than the last one taken (06 §6.2).
      options: { "password-file": { type: "string", multiple: true } },
      strict: true,
      allowPositionals: true,
    }));
  } catch (e) {
    io.err(TEXTS.usage((e as Error).message));
    return 2;
  }
  const files = values["password-file"] ?? [];
  if (!takesPassword && files.length > 0) {
    io.err(TEXTS.usage(TEXTS.server.userUsage));
    return 2;
  }
  if (files.length > 1 || files[0] === "") {
    io.err(TEXTS.usage(TEXTS.server.passwordFileOnce));
    return 2;
  }
  if (sub === "list") {
    if (positionals.length > 0) {
      io.err(TEXTS.usage(TEXTS.server.userUsage));
      return 2;
    }
    return { sub };
  }
  const name = positionals.length === 1 ? positionals[0] : undefined;
  if (name === undefined || name === "") {
    io.err(TEXTS.usage(TEXTS.server.userTakesName(sub)));
    return 2;
  }
  if (sub === "add" || sub === "passwd") {
    return { sub, name, ...(files[0] !== undefined ? { passwordFile: files[0] } : {}) };
  }
  return { sub: sub as "disable" | "enable", name };
}

/** Where a new password comes from: a file, or the terminal. */
export type PasswordSource = { readonly file: string } | { readonly terminal: PasswordTerminal };

/** The source to read a password from; undefined, said on stderr, when there is none (exit 8). */
export function passwordSource(
  file: string | undefined,
  io: Pick<ServerRestoreIO, "err" | "terminal">,
): PasswordSource | undefined {
  if (file !== undefined) return { file };
  const terminal = (io.terminal ?? openControllingTerminal)();
  if (terminal === undefined) {
    io.err(TEXTS.server.noPasswordSource);
    return undefined;
  }
  return { terminal };
}

/**
 * The password from `source`; a number is the exit code it was refused with, said on stderr with
 * what was left (`after`). The terminal is left open: its opener closes it.
 */
export async function readPassword(
  source: PasswordSource,
  io: Pick<ServerRestoreIO, "err">,
  after: string = TEXTS.server.nothingDone,
): Promise<string | number> {
  try {
    if ("file" in source) return await passwordFromFile(source.file);
    return await passwordFromTerminal(source.terminal);
  } catch (e) {
    if (e instanceof PasswordFileRefused) {
      io.err(TEXTS.server.passwordFileRefused(e.code));
      return 2;
    }
    if (e instanceof PasswordsDiffer) {
      io.err(TEXTS.server.passwordsDiffer(after));
      return 2;
    }
    if (e instanceof PasswordInterrupted) {
      io.err(TEXTS.server.passwordInterrupted(after));
      return 130;
    }
    throw e;
  }
}

/**
 * The control plane and the local accounts of `db`, their tables checked; a number is the exit
 * code they were refused with (5), said on stderr.
 */
export async function openAccounts(
  db: ControlDatabase,
  io: Pick<ServerRestoreIO, "err">,
): Promise<{ readonly control: ServerControlPlane; readonly accounts: LocalAccounts } | number> {
  let control: ServerControlPlane;
  try {
    control = await openControlPlane(db);
  } catch (e) {
    if (!(e instanceof ControlPlaneError)) throw e;
    if (e.code !== "control_not_initialized" && e.code !== "control_format_mismatch") throw e;
    io.err(
      TEXTS.server.startRefused(
        "control",
        e.code === "control_format_mismatch" ? "format" : "not_initialized",
      ),
    );
    return 5;
  }
  try {
    return { control, accounts: await openLocalAccounts(db) };
  } catch (e) {
    if (!(e instanceof LocalAccountsError)) throw e;
    if (e.code !== "accounts_not_initialized" && e.code !== "accounts_format_mismatch") throw e;
    io.err(
      TEXTS.server.startRefused(
        "accounts",
        e.code === "accounts_format_mismatch" ? "format" : "not_initialized",
      ),
    );
    return 5;
  }
}

/** An account operation refused: said on stderr, with what was left (`after`); its exit code. */
export function accountRefused(
  e: LocalAccountsError,
  name: string,
  io: Pick<ServerRestoreIO, "err">,
  after: string = TEXTS.server.nothingDone,
) {
  io.err(TEXTS.server.accountRefused(e.code, name, after));
  return e.code === "unknown_user" ? 4 : 5;
}

/** Makes `name`'s account and its tenant in the configured cell. */
export function addUser(
  config: ServerConfig,
  opened: { readonly control: ServerControlPlane; readonly accounts: LocalAccounts },
  name: string,
  password: string,
  io: Pick<ServerRestoreIO, "backend" | "now">,
) {
  return addLocalUser(opened.accounts, {
    control: opened.control,
    backend: io.backend ?? new PostgresBackend({ cells: { [config.cellName]: config.cell } }),
    name,
    password,
    cell: config.cellName,
    cells: new Set([config.cellName]),
    now: (io.now ?? (() => new Date().toISOString()))(),
  });
}

/** Runs `saveslot server user …` as `target` asks; resolves with the exit code. */
export async function serverUser(
  config: ServerConfig,
  target: UserTarget,
  io: ServerRestoreIO,
): Promise<number> {
  // The accounts are the external platform's: refused before anything is opened or asked.
  if (config.identity !== undefined) {
    io.err(TEXTS.server.userExternal);
    return 5;
  }
  let password: string | undefined;
  if (target.sub === "add" || target.sub === "passwd") {
    const source = passwordSource(target.passwordFile, io);
    if (source === undefined) return 8;
    let read: string | number;
    try {
      read = await readPassword(source, io);
    } finally {
      if ("terminal" in source) source.terminal.close();
    }
    if (typeof read === "number") return read;
    password = read;
  }
  let db: ControlDatabase;
  try {
    db = await (io.openControl ?? ((at) => openControlDatabase(at.cell, at.database)))(
      config.control,
    );
  } catch {
    io.err(TEXTS.server.controlUnreachable);
    return 7;
  }
  try {
    const opened = await openAccounts(db, io);
    if (typeof opened === "number") return opened;
    try {
      switch (target.sub) {
        case "add": {
          const { tenant } = await addUser(config, opened, target.name, password as string, io);
          io.out(TEXTS.server.userAdded(target.name, tenant));
          return 0;
        }
        case "list": {
          const users = await listLocalUsers(opened.accounts);
          if (users.length === 0) {
            io.out(TEXTS.server.userNone);
            return 0;
          }
          const rows = await Promise.all(
            users.map(async (u) => {
              const t = await opened.control.tenantOf(u.user);
              return [u.name, u.state, t?.state === "active" ? t.id : TEXTS.server.userNoTenant];
            }),
          );
          const width = Math.max(...rows.map((r) => r[0]?.length ?? 0));
          for (const [name, state, tenant] of rows) {
            io.out(`${(name ?? "").padEnd(width)}  ${(state ?? "").padEnd(8)}  ${tenant}`);
          }
          return 0;
        }
        case "disable":
          await disableLocalUser(opened.accounts, { name: target.name });
          io.out(TEXTS.server.userDisabled(target.name));
          return 0;
        case "enable":
          await enableLocalUser(opened.accounts, { name: target.name });
          io.out(TEXTS.server.userEnabled(target.name));
          return 0;
        case "passwd":
          // Only through the accounts' own operation: it ends the web logins and user sessions.
          await setLocalPassword(opened.accounts, {
            name: target.name,
            password: password as string,
            now: (io.now ?? (() => new Date().toISOString()))(),
          });
          io.out(TEXTS.server.passwordChanged(target.name));
          return 0;
      }
    } catch (e) {
      if (e instanceof LocalAccountsError)
        return accountRefused(e, "name" in target ? target.name : "", io);
      throw e;
    }
  } finally {
    await db.close();
  }
}
