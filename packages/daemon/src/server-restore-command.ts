// `saveslot server restore` (docs/zh-CN/spec/06-cli.md §4.1 «服务器自部署的运维命令»; 02-architecture
// §8 «恢复备份、快照、冷租户归档之后必须走恢复流程»): after the deployer has put one tenant's database
// back from a backup, runs the restore flow on it before it serves again. The tenant is named by its
// ID (`--tenant`), or, with the built-in local accounts, by its account's name (`--user`): exactly
// one of the two. An account is looked up under the lock below, by name as `server user` finds one
// (a name no account can have is no account); a disabled one is restored all the same, disabling
// being about authentication only.
//
// Only while no server runs on the control database: the command tries the server-running lock and,
// held by a server, does nothing. It holds the lock until it ends, so a server started meanwhile
// does not start.
//
// Exit codes (06 §6.2): 2 for a usage error; 4 for a tenant the control database does not have, or
// an account that is not there; 5 for a configuration or a control database refused, `--user` with
// the external login configured, an account whose tenant is not made yet, or a tenant the flow
// cannot run on; 7 when the control database cannot be reached or a server is running on it.

import { parseArgs } from "node:util";
import {
  listLocalUsers,
  openControlPlane,
  RestoreError,
  restoreTenantFromBackup,
  type ServerControlPlane,
  ServerRestoreError,
  type TenantId,
} from "@fluxvita/saveslot-service";
import { type ControlDatabase, openControlDatabase } from "@fluxvita/saveslot-store-postgres";
import { cellBackend } from "./run-server.ts";
import { logLine, type ServerCommandIO, type ServerRestoreIO } from "./server-command-io.ts";
import type { ServerConfig } from "./server-config.ts";
import { releaseServerLock, takeServerLock } from "./server-lock.ts";
import { openAccounts } from "./server-user-command.ts";
import { TEXTS } from "./texts.ts";

export type { ServerRestoreIO } from "./server-command-io.ts";

/** The tenant asked for, by its ID or by its local account's name. */
export type RestoreTarget = { readonly tenant: string } | { readonly user: string };

/** The tenant asked for, from `restore`'s arguments; a number is the exit code of a usage error. */
export function restoreTarget(
  rest: readonly string[],
  io: Pick<ServerCommandIO, "err">,
): RestoreTarget | number {
  let values: { tenant?: string[] | undefined; user?: string[] | undefined };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      // Collected, so that one given twice is refused rather than the last one taken (06 §6.2).
      options: {
        tenant: { type: "string", multiple: true },
        user: { type: "string", multiple: true },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err(TEXTS.usage((e as Error).message));
    return 2;
  }
  const tenants = values.tenant ?? [];
  const users = values.user ?? [];
  // Exactly one of the two, once, not empty.
  if (tenants.length + users.length !== 1 || [...tenants, ...users][0] === "") {
    io.err(TEXTS.usage(TEXTS.server.restoreTakesTenant));
    return 2;
  }
  return tenants.length === 1 ? { tenant: tenants[0] as string } : { user: users[0] as string };
}

/** Runs the restore flow on the tenant `target` names; resolves with the exit code. */
export async function serverRestore(
  config: ServerConfig,
  target: RestoreTarget,
  io: ServerRestoreIO,
): Promise<number> {
  // The accounts are the external platform's: no names here to look up. Refused before anything is
  // opened, as `server user` is.
  if ("user" in target && config.identity !== undefined) {
    io.err(TEXTS.server.restoreUserExternal);
    return 5;
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
    if (!(await takeServerLock(db))) {
      io.err(TEXTS.server.restoreServerRunning);
      return 7;
    }
    try {
      return await restoreHeld(db, config, target, io);
    } finally {
      await releaseServerLock(db);
    }
  } finally {
    await db.close();
  }
}

async function restoreHeld(
  db: ControlDatabase,
  config: ServerConfig,
  target: RestoreTarget,
  io: ServerRestoreIO,
): Promise<number> {
  let control: ServerControlPlane;
  let tenant: TenantId;
  if ("user" in target) {
    const opened = await openAccounts(db, io);
    if (typeof opened === "number") return opened;
    control = opened.control;
    const account = (await listLocalUsers(opened.accounts)).find((u) => u.name === target.user);
    if (account === undefined) {
      io.err(TEXTS.server.restoreNoAccount(target.user));
      return 4;
    }
    // Not registered, or registered and not made: an add that stopped, finished by another add.
    const entry = await control.tenantOf(account.user);
    if (entry?.state !== "active") {
      io.err(TEXTS.server.restoreAccountTenantNotMade(target.user));
      return 5;
    }
    tenant = entry.id;
  } else {
    try {
      control = await openControlPlane(db);
    } catch (e) {
      if (!isCode(e, "control_not_initialized", "control_format_mismatch")) throw e;
      io.err(TEXTS.server.restoreControlNotReady);
      return 5;
    }
    tenant = target.tenant as TenantId;
  }
  const backend = io.backend ?? cellBackend(config, logLine(io), io.formatUpgrade);
  try {
    const r = await restoreTenantFromBackup({
      control,
      backend,
      tenant,
      now: (io.now ?? (() => new Date().toISOString()))(),
    });
    if ("user" in target) io.out(TEXTS.server.restoringAccount(target.user, tenant));
    io.out(TEXTS.server.restored(tenant, r));
    return 0;
  } catch (e) {
    if (e instanceof ServerRestoreError) {
      io.err(TEXTS.server.restoreTenantRefused(e.code));
      return e.code === "unknown_tenant" ? 4 : 5;
    }
    if (e instanceof RestoreError) {
      io.err(TEXTS.server.restoreFlowRefused(e.code));
      return 5;
    }
    throw e;
  }
}

function isCode(e: unknown, ...codes: string[]): boolean {
  const code = (e as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && codes.includes(code);
}
