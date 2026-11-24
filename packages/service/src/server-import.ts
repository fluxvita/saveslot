// Import into an empty tenant, server mode (docs/zh-CN/spec/02-architecture.md §8 «格式版本、导出、导入
// 与恢复» steps ①–⑥ and «重入», §5 «租户目录»; 04-contract.md §17 `import`).
//
// The import holds the tenant with the pool's `exclusive`, refusing (`importing`), from its first
// step through ⑥: meanwhile the tenant's other requests get `unavailable` (`importing`) and a second
// import `rate_limited` (`busy`), not a queue. The drops that only clean up (the database it
// replaced; a failed import's staging database) come after the answer, outside the exclusive
// (below). Inside:
//
//   ①–③ a staging database named after the tenant and the import ID (recorded in the tenant
//       directory as the tenant's staging database), the file replayed into it, the import's event
//       appended;
//   ④–⑥ the kernel's `runImport`: the staging log checked to end in ③'s event, the empty tenant
//       checked, the anchor's marker, the swap (one transaction of the directory: the staging
//       database becomes the tenant's, the one it replaced is recorded as its staging database),
//       the anchor rebuilt.
//
// The import answers once ⑥ is done and the exclusive released; the database it replaced (the
// genesis event only) is dropped and forgotten after that, outside the exclusive, as far as it
// goes (`dropped`). That is safe: the directory records it as the tenant's staging database and it
// is never the one the directory names, so the only drop it can meet is an opening's drop of the
// same record, and both drops tolerate the other (`IF EXISTS`; the record forgotten only while it
// still names it). Nothing waits for it: a drop still running when the service stops may fail; it
// is told to `onDiscardFailure`, the record stays, and the next opening drops the database.
//
// A failure that leaves the tenant as it was (a file refused, a tenant not empty, ④ refusing the
// marker) answers first too: the exclusive is released and the error thrown, and the staging
// database it leaves is dropped and forgotten after that, outside the exclusive, as the replaced
// one is (`onFailureDrops`). The directory records it until its drop has finished. A new import
// meanwhile meets that record and drops it before recording its own (both drops `IF EXISTS`, the
// record forgotten only while it still names it), and waits for that drop to end first, so a drop
// that fails cannot leave it unrecorded. An opening meanwhile, with the server's pool, leaves it to
// that drop and does not wait (`stagingDiscarder`'s `inFlight`). A failure from ④ on leaves the
// marker: the pool's next opening finishes the import (swapped in) or rolls it back (not), and a
// staging database with no marker is dropped there too (`stagingDiscarder`). The database the swap
// replaced is that too: a crash after ⑤, or a drop that failed, leaves it recorded, and the pool's
// next opening drops it.
//
// Dropping is the daemon's (`discardDatabase`, from the PostgreSQL backend): this package does not
// depend on a backend (§11). Its guard refuses any database but the tenant's staging databases and
// the one an import replaced, and the one the directory names now.

import type { ImportResult } from "@fluxvita/saveslot-contract";
import {
  type appendImportEvent,
  importIntoStaging,
  newImportId,
  OpsError,
  readTail,
  runImport,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import type { ServerControl, TenantId, UserId } from "./control-plane.ts";
import { appendImportEventCounted } from "./import-result.ts";
import { databaseOf } from "./server-tenant.ts";
import { type TenantPool, takeUpImport } from "./tenant-pool.ts";

/**
 * Drops a database of the tenant's cell, the daemon's (the PostgreSQL backend's `discardDatabase`).
 * Refuses unless `database` is one of the tenant's staging databases or the one an import replaced
 * (`tenantDatabase`), and not `current`, the one the directory names.
 */
export type DiscardDatabase = (o: {
  readonly cell: string;
  readonly tenantDatabase: string;
  readonly current: string;
  readonly database: string;
}) => Promise<void>;

/** An import's staging database: the tenant's database name, `_`, the import ID in lower case. */
export const stagingDatabaseOf = (tenant: TenantId, importId: string): string =>
  `${databaseOf(tenant)}_${importId.toLowerCase()}`;

const postgresRef = (ref: TenantRef) => {
  if (ref.kind !== "postgres") {
    throw new OpsError("internal", "a server tenant's storage is a PostgreSQL database");
  }
  return ref;
};

/**
 * The drops of a staging database under way, by control plane, then by tenant and database. A
 * server has one control plane, and one process runs on a control database (02-architecture §7),
 * so for a server these are all the drops there are. A control plane closed and opened again (a
 * server started again in the same process) starts with none.
 */
const dropsInFlight = new WeakMap<ServerControl, Map<string, Promise<void>>>();

/**
 * The pool's `discardStaging`: drops the tenant's staging database (nothing when it is gone) and
 * forgets it in the directory. A database the directory names as the tenant's is never dropped.
 *
 * A drop of the same database may already be under way (an import's, after its answer), and
 * `inFlight` says what to do then. "wait": wait for it to end, then drop and forget as usual
 * (nothing left to drop then), so that what needs the database gone, an import about to record its
 * own, gets it gone even when that drop failed. "leave": leave the database to that drop and
 * return at once, for an opening, which serves whether the record is there or not and should not
 * wait for a `DROP DATABASE`; a drop that fails leaves the record for the next opening.
 */
export function stagingDiscarder(o: {
  readonly control: ServerControl;
  readonly discardDatabase: DiscardDatabase;
  readonly inFlight: "wait" | "leave";
}): (tenant: TenantId, staging: string) => Promise<void> {
  let drops = dropsInFlight.get(o.control);
  if (drops === undefined) {
    drops = new Map();
    dropsInFlight.set(o.control, drops);
  }
  const inFlight = drops;
  return async (tenant, staging) => {
    const key = `${tenant}\u0000${staging}`;
    const running = inFlight.get(key);
    if (running !== undefined) {
      if (o.inFlight === "leave") return;
      await running.catch(() => {});
    }
    const drop = (async () => {
      const entry = await o.control.tenant(tenant);
      if (entry === undefined) return;
      const ref = postgresRef(entry.ref);
      await o.discardDatabase({
        cell: ref.cell,
        tenantDatabase: databaseOf(tenant),
        current: ref.database,
        database: staging,
      });
      await o.control.forgetStaging(tenant, staging);
    })();
    inFlight.set(key, drop);
    try {
      await drop;
    } finally {
      if (inFlight.get(key) === drop) inFlight.delete(key);
    }
  };
}

export interface ServerImportResult {
  /**
   * The drop of the database the import replaced, run after the answer; it never rejects (a
   * failure is told to `onDiscardFailure`). For tests and a host that wants to wait for it.
   */
  readonly dropped: Promise<void>;
  /** The import's result as the contract gives it (04-contract-types `ImportResult`). */
  readonly contract: ImportResult;
  readonly importId: string;
  /** The last imported event's `seq`. */
  readonly importedUpto: number;
  readonly events: number;
  /** The anchor after the import: the log's end, and the import event's restore count. */
  readonly highWater: number;
  readonly restoreCount: number;
}

/**
 * Imports the export file in `body` into `tenant`, which must be empty. Errors: the kernel's
 * (`ImportRejected`, `ImportEventError`: `importContractError` maps them; `OpsError`
 * `tenant_not_empty`), the pool's (`TenantPoolError` `busy`), the storage's.
 */
export async function importServerTenant(o: {
  readonly control: ServerControl;
  readonly backend: StorageBackend;
  readonly pool: TenantPool;
  readonly discardDatabase: DiscardDatabase;
  readonly tenant: TenantId;
  readonly user: UserId;
  /** The file's bytes, as a request body gives them. */
  readonly body: AsyncIterable<Uint8Array>;
  readonly now: Parameters<typeof appendImportEvent>[1]["now"];
  /**
   * Told when a drop that only cleans up failed (the database the import replaced, or a staging
   * database after a failure); the import stands, or fails with its own error. By default, one
   * line on standard error.
   */
  readonly onDiscardFailure?: (tenant: TenantId, database: string, error: unknown) => void;
  /**
   * Given, when the import fails, the drops it leaves to run after its answer (as `dropped` is on
   * success); the promise never rejects. For tests and a host that wants to wait for them.
   */
  readonly onFailureDrops?: (dropped: Promise<void>) => void;
}): Promise<ServerImportResult> {
  // The databases to drop after the answer, outside the exclusive (see the top of this file).
  const after: string[] = [];
  let held: Awaited<ReturnType<typeof importHeld>>;
  try {
    held = await o.pool.exclusive(o.tenant, () => importHeld(o, after), { refuse: "importing" });
  } catch (e) {
    const dropped = dropAllQuietly(o, after);
    try {
      o.onFailureDrops?.(dropped);
    } catch {
      // A host's callback that throws is not the import's failure: its own error is.
    }
    throw e;
  }
  return { ...held.result, dropped: dropAllQuietly(o, [...after, held.replaced]) };
}

/** The drops left for after the answer, one after another; never rejects. */
async function dropAllQuietly(
  o: Parameters<typeof importServerTenant>[0],
  databases: readonly string[],
): Promise<void> {
  for (const database of databases) await dropQuietly(o, database);
}

const codeOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : e instanceof Error ? e.name : "error";
};

/** `onDiscardFailure` by default: one line on standard error, the error's code only. */
const reportDiscardToStderr = (tenant: TenantId, database: string, error: unknown): void => {
  console.error(`saveslot server import: ${database} of ${tenant} not dropped: ${codeOf(error)}`);
};

/**
 * A drop that only cleans up: the database dropped and forgotten (`stagingDiscarder`); a failure
 * is told to `onDiscardFailure` and never thrown, nor is a report that fails.
 */
async function dropQuietly(
  o: Parameters<typeof importServerTenant>[0],
  database: string,
): Promise<void> {
  try {
    // A drop of it already under way is joined, then this one drops what is left: `dropped` and
    // `onFailureDrops` resolve only once the database is gone, and a failure is told here.
    await stagingDiscarder({ ...o, inFlight: "wait" })(o.tenant, database);
  } catch (e) {
    try {
      (o.onDiscardFailure ?? reportDiscardToStderr)(o.tenant, database, e);
    } catch {
      // A report that fails is not the import's failure.
    }
  }
}

async function importHeld(
  o: Parameters<typeof importServerTenant>[0],
  after: string[],
): Promise<{ readonly result: Omit<ServerImportResult, "dropped">; readonly replaced: string }> {
  const entry = await o.control.tenant(o.tenant);
  if (entry === undefined || entry.state !== "active") {
    throw new OpsError("internal", "importServerTenant: the tenant is not an active one");
  }
  const ref = postgresRef(entry.ref);
  // What must be gone before the import goes on: a drop of it under way is waited for first.
  const discard = stagingDiscarder({ ...o, inFlight: "wait" });
  /**
   * A drop that only cleans up: left for after the answer, outside the exclusive; its failure is
   * told, never thrown in place of what happened.
   */
  const tidy = (database: string) => {
    after.push(database);
  };

  const notEmpty = () =>
    new OpsError("invalid_argument", "the tenant is not empty", { reason: "tenant_not_empty" });
  const importId = newImportId();
  const staging = stagingDatabaseOf(o.tenant, importId);
  const opened: TenantStore[] = [];
  const open = async (r: TenantRef, create: boolean) => {
    const s = await o.backend.open(r, create ? { create: true } : {});
    opened.push(s);
    return s;
  };
  try {
    const target = await open(ref, false);
    const tail = await target.read((tx) => readTail(tx));
    // An earlier import a failure or a crash left from ④ on: taken up as an opening takes it up
    // (§8 «重入»), since an exclusive opens nothing. Retrying is safe: rolled back, the tenant is
    // empty and this import goes on; finished, the tenant is the imported one.
    const { taken } = await takeUpImport({
      store: target,
      anchors: o.control.anchors,
      tenant: o.tenant,
      logEnd: tail?.seq ?? 0,
      discardStaging: async () => {
        if (entry.staging !== undefined) await discard(o.tenant, entry.staging);
      },
    });
    // Checked first, so that a tenant not empty costs no replay; `runImport` checks it again.
    const a = await o.control.anchors.read(o.tenant);
    const anchorEmpty =
      a.deletions.length === 0 &&
      a.restoreCount === 0 &&
      a.restoreInProgress === undefined &&
      a.importInProgress === undefined;
    const left = taken === "aborted" ? undefined : (await o.control.tenant(o.tenant))?.staging;
    if (tail?.seq !== 1 || !anchorEmpty) {
      // A database the directory still names as staging (the one a swap replaced) is tidied up.
      if (left !== undefined) tidy(left);
      throw notEmpty();
    }
    // A staging database a crash before ④ left, no marker with it: dropped before another is
    // recorded in its place, or the import goes no further.
    if (left !== undefined) await discard(o.tenant, left);

    // ①–③ into the staging database; a failure drops it.
    await o.control.setStaging(o.tenant, staging);
    let store: TenantStore;
    let staged: Awaited<ReturnType<typeof importIntoStaging>>;
    let ev: Awaited<ReturnType<typeof appendImportEvent>>;
    let counted: Omit<ImportResult, "restore_count">;
    try {
      store = await open({ ...ref, database: staging }, true);
      staged = await importIntoStaging({ staging: store, body: o.body });
      ({ ev, result: counted } = await appendImportEventCounted(store, {
        tenant: o.tenant,
        user: o.user,
        staged,
        now: o.now,
      }));
    } catch (e) {
      await closeAll(opened);
      tidy(staging);
      throw e;
    }

    // ④–⑥. Before ④ a failure drops the staging database; from ④ on the marker stays for the
    // re-entry.
    let finished: Awaited<ReturnType<typeof runImport>>;
    try {
      finished = await runImport({
        target,
        anchor: o.control.anchors,
        tenant: o.tenant,
        importId,
        // The staging storage stays open: the swap renames nothing, the database becomes the target's.
        staging: store,
        importSeq: ev.seq,
        importedUpto: ev.importedUpto,
        swap: async () => {
          await o.control.swapInStaging(o.tenant);
          return store;
        },
      });
    } catch (e) {
      // The staging database is dropped only when the failure left the tenant as it was: the
      // marker not this import's (before ④, or cleared by ④'s own refusal) and no swap. With the
      // marker there it is the re-entry's; swapped in (`endImport` committed but its answer lost),
      // it is the tenant's database. Whatever goes wrong here, the error is the import's own.
      const left = await Promise.all([o.control.anchors.read(o.tenant), o.control.tenant(o.tenant)])
        .then(
          ([now, entryNow]) =>
            now.importInProgress !== importId &&
            entryNow !== undefined &&
            postgresRef(entryNow.ref).database !== staging,
        )
        .catch(() => false);
      if (left) {
        await closeAll(opened);
        tidy(staging);
      }
      throw e;
    }

    // The database the import replaced, the directory's staging database now: dropped after the
    // answer, outside the exclusive (importServerTenant).
    await closeAll(opened);
    return {
      result: {
        contract: { ...counted, restore_count: finished.restoreCount },
        importId,
        importedUpto: staged.importedUpto,
        events: staged.events,
        highWater: finished.highWater,
        restoreCount: finished.restoreCount,
      },
      replaced: ref.database,
    };
  } finally {
    await closeAll(opened);
  }
}

/** Closes the stores opened here, once each; a close that fails is not thrown. */
async function closeAll(opened: TenantStore[]): Promise<void> {
  const stores = opened.splice(0);
  await Promise.all(stores.map((s) => s.close().catch(() => {})));
}
