// `saveslot server restore` (docs/zh-CN/spec/06-cli.md §4.1 «服务器自部署的运维命令»; 02-architecture
// §8 «恢复备份、快照、冷租户归档之后必须走恢复流程»): after the deployer has put one tenant's database
// back from a backup, runs the restore flow on it before it serves again. The tenant is named by its
// ID (`--tenant`).
//
// Only while no server runs on the control database: the command tries the server-running lock and,
// held by a server, does nothing. It holds the lock until it ends, so a server started meanwhile
// does not start.
//
// Exit codes (06 §6.2): 2 for a usage error; 4 for a tenant the control database does not have; 5 for a configuration or a control database refused, or a tenant the flow cannot run
// on; 7 when the control database cannot be reached or a server is running on it.

import { parseArgs } from "node:util";
import {
  openControlPlane,
  RestoreError,
  restoreTenantFromBackup,
  type ServerControlPlane,
  ServerRestoreError,
  type TenantId,
} from "@fluxvita/saveslot-service";
import {
  type ControlDatabase,
  openControlDatabase,
  PostgresBackend,
} from "@fluxvita/saveslot-store-postgres";
import type { ServerCommandIO } from "./server-command-io.ts";
import type { ServerConfig } from "./server-config.ts";
import { releaseServerLock, takeServerLock } from "./server-lock.ts";
import { TEXTS } from "./texts.ts";

export interface ServerRestoreIO extends ServerCommandIO {
  /** Opens the tenants' databases (a test gives its own backend). */
  readonly backend?: Parameters<typeof restoreTenantFromBackup>[0]["backend"];
  /** The clock, in `toISOString` form. */
  readonly now?: () => string;
}

/** The tenant asked for, from `restore`'s arguments; a number is the exit code of a usage error. */
export function restoreTarget(
  rest: readonly string[],
  io: Pick<ServerCommandIO, "err">,
): { readonly tenant: string } | number {
  let values: { tenant?: string[] | undefined };
  try {
    ({ values } = parseArgs({
      args: [...rest],
      // Collected, so that one given twice is refused rather than the last one taken (06 §6.2).
      options: { tenant: { type: "string", multiple: true } },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    io.err(TEXTS.usage((e as Error).message));
    return 2;
  }
  const tenant = values.tenant?.length === 1 ? values.tenant[0] : undefined;
  if (tenant === undefined || tenant === "") {
    io.err(TEXTS.usage(TEXTS.server.restoreTakesTenant));
    return 2;
  }
  return { tenant };
}

/** Runs the restore flow on the tenant `target` names; resolves with the exit code. */
export async function serverRestore(
  config: ServerConfig,
  target: { readonly tenant: string },
  io: ServerRestoreIO,
): Promise<number> {
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
  target: { readonly tenant: string },
  io: ServerRestoreIO,
): Promise<number> {
  let control: ServerControlPlane;
  try {
    control = await openControlPlane(db);
  } catch (e) {
    if (!isCode(e, "control_not_initialized", "control_format_mismatch")) throw e;
    io.err(TEXTS.server.restoreControlNotReady);
    return 5;
  }
  const tenant = target.tenant as TenantId;
  const backend = io.backend ?? new PostgresBackend({ cells: { [config.cellName]: config.cell } });
  try {
    const r = await restoreTenantFromBackup({
      control,
      backend,
      tenant,
      now: (io.now ?? (() => new Date().toISOString()))(),
    });
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
