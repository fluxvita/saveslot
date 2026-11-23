// Import into an empty tenant, server mode (docs/zh-CN/spec/02-architecture.md §8 «格式版本、导出、导入
// 与恢复» steps ①–⑥ and «重入», §5 «租户目录»; 04-contract.md §17 `import`).
//
// The whole import holds the tenant with the pool's `exclusive`, refusing (`importing`): from its
// first step, the tenant's other requests get `unavailable` (`importing`) and a second import
// `rate_limited` (`busy`), not a queue. Inside:
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
// A failure before ④ drops the staging database and forgets it, and the tenant stays as it was. One
// at or after ④ leaves the marker: the pool's next opening finishes the import (swapped in) or rolls
// it back (not), and a staging database with no marker is dropped there too (`stagingDiscarder`).
// The database the swap replaced is that too: a crash after ⑤, or a drop that failed, leaves it
// recorded, and the pool's next opening drops it.
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
 * The pool's `discardStaging`: drops the tenant's staging database (nothing when it is gone) and
 * forgets it in the directory. A database the directory names as the tenant's is never dropped.
 */
export function stagingDiscarder(o: {
  readonly control: ServerControl;
  readonly discardDatabase: DiscardDatabase;
}): (tenant: TenantId, staging: string) => Promise<void> {
  return async (tenant, staging) => {
    const entry = await o.control.tenant(tenant);
    if (entry === undefined) return;
    const ref = postgresRef(entry.ref);
    await o.discardDatabase({
      cell: ref.cell,
      tenantDatabase: databaseOf(tenant),
      current: ref.database,
      database: staging,
    });
    if (entry.staging === staging) await o.control.setStaging(tenant, null);
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
   * database after a failure); the import stands, or fails with its own error.
   */
  readonly onDiscardFailure?: (tenant: TenantId, database: string, error: unknown) => void;
}): Promise<ServerImportResult> {
  const held = await o.pool.exclusive(o.tenant, () => importHeld(o), { refuse: "importing" });
  // After the answer, outside the exclusive (see the top of this file).
  return { ...held.result, dropped: dropQuietly(o, held.replaced) };
}

/**
 * A drop that only cleans up: the database dropped and forgotten (`stagingDiscarder`); a failure
 * is told to `onDiscardFailure` and never thrown, nor is a report that fails.
 */
async function dropQuietly(
  o: Parameters<typeof importServerTenant>[0],
  database: string,
): Promise<void> {
  try {
    await stagingDiscarder(o)(o.tenant, database);
  } catch (e) {
    try {
      o.onDiscardFailure?.(o.tenant, database, e);
    } catch {
      // A report that fails is not the import's failure.
    }
  }
}

async function importHeld(
  o: Parameters<typeof importServerTenant>[0],
): Promise<{ readonly result: Omit<ServerImportResult, "dropped">; readonly replaced: string }> {
  const entry = await o.control.tenant(o.tenant);
  if (entry === undefined || entry.state !== "active") {
    throw new OpsError("internal", "importServerTenant: the tenant is not an active one");
  }
  const ref = postgresRef(entry.ref);
  const discard = stagingDiscarder(o);
  /** A drop that only cleans up: its failure is told, never thrown in place of what happened. */
  const tidy = (database: string) => dropQuietly(o, database);

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
      if (left !== undefined) await tidy(left);
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
      await tidy(staging);
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
        await tidy(staging);
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
