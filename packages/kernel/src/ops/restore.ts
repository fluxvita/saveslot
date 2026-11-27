// The restore flow (docs/zh-CN/spec/02-architecture.md §8 «恢复备份、快照、冷租户归档之后必须走恢复
// 流程»; 03-data-model/03-deletion.md «恢复流程里以登记为准，补日志», «恢复后 `seq` 不复用»): after a
// backup, a snapshot or an archive is put back, and before the tenant serves,
//
//   1. the anchor's "restore in progress" marker is set and the restore count raised (`beginRestore`);
//   2. `tenant.restored` is appended (a new node ID, the count, the restore point, the high water
//      mark; its `seq` follows the larger of the log's end and the high water mark: no `seq` is
//      reused);
//   3. the deletions the registry holds and the restored log lacks are made up (`backfill`);
//   4. the marker is cleared and the high water mark advanced to the log's end (`endRestore`).
//
// The anchor store and the tenant storage share no transaction, so the flow re-enters on the
// marker: any step done is found done (step 2 by the marker's restore ID in a `tenant.restored`
// header) and not done again. Step 3 is the deletion flow's; until it exists, a registry with
// entries is refused (`deletion_backfill_not_implemented`) before anything is changed, never
// restored over: a restore that skipped it would let a deleted thing come back.

import type { Instant, NodeId, Seq, TenantId } from "@fluxvita/saveslot-contract-core";
import { applyEvents, eventsOf } from "../apply/index.ts";
import { appendOperation, forgetRestores, readTail } from "../log/index.ts";
import type { Anchor, AnchorStore, RestoreId } from "../store/anchor.ts";
import type { TenantStore } from "../store/ports.ts";
import { OpsError } from "./errors.ts";
import { newNodeId, randomCrockford } from "./ids.ts";

export type RestoreErrorCode =
  /** The registry has entries and nothing was given to make up their deletions. */
  | "deletion_backfill_not_implemented"
  /** An import is in progress: it re-enters first (`openTenant` step 1). */
  | "import_in_progress"
  /** The storage has no log: there is nothing to restore into. */
  | "log_empty";

export class RestoreError extends Error {
  readonly code: RestoreErrorCode;
  constructor(code: RestoreErrorCode, message: string) {
    super(message);
    this.name = "RestoreError";
    this.code = code;
  }
}

export const newRestoreId = (): RestoreId => `rs_${randomCrockford(16)}`;

export interface RestoreInput {
  readonly store: TenantStore;
  readonly anchor: AnchorStore;
  readonly tenant: TenantId;
  readonly now: Instant;
  /**
   * Step 3: makes up, from the registry, the deletions the restored log lacks and runs the ones
   * due. Called after `tenant.restored` is in the log, with the anchor as `beginRestore` left it.
   * Absent: the registry must be empty. **Called again on every re-entry** until the marker is
   * cleared (a crash after it and before step 4 calls it a second time): it must be idempotent.
   */
  readonly backfill?: (a: Anchor) => Promise<void>;
  /** For tests: the IDs a new restore takes. */
  readonly ids?: { readonly restore?: RestoreId; readonly node?: NodeId };
}

export interface RestoreResult {
  readonly restore: RestoreId;
  /** The restore count after this restore. */
  readonly restoreCount: number;
  /** The `seq` of `tenant.restored`. */
  readonly restoredSeq: Seq;
  /** The log's end when the flow finished: where the high water mark now is. */
  readonly logEnd: Seq;
  /** The marker was already set: this call took up a restore an earlier one began. */
  readonly resumed: boolean;
  /** `tenant.restored` was already in the log: this call did not append it. */
  readonly eventWasThere: boolean;
}

/** The `tenant.restored` event for `restore`, if the log has one. */
async function restoredEventOf(
  store: TenantStore,
  restore: RestoreId,
): Promise<{ readonly seq: Seq; readonly restoreCount: number } | undefined> {
  return store.read(async (tx) => {
    const r = await tx.query<{ seq: unknown; header: string }>(
      "SELECT seq, header FROM events WHERE type = 'tenant.restored' ORDER BY seq DESC",
    );
    for (const row of r.rows) {
      const h = JSON.parse(row.header) as { restore_id?: string; restore_count?: number };
      if (h.restore_id === restore) {
        return { seq: Number(row.seq), restoreCount: h.restore_count ?? 0 };
      }
    }
    return undefined;
  });
}

/** Runs the flow, or takes up the one the marker says was begun. */
export async function restoreTenant(o: RestoreInput): Promise<RestoreResult> {
  const before = await o.anchor.read(o.tenant);
  if (before.importInProgress !== undefined) {
    throw new RestoreError("import_in_progress", "an import is in progress; it re-enters first");
  }
  if (before.deletions.length > 0 && o.backfill === undefined) {
    throw new RestoreError(
      "deletion_backfill_not_implemented",
      "the deletion registry has entries and making up their deletions is not implemented yet",
    );
  }
  if ((await o.store.read((tx) => readTail(tx))) === undefined) {
    throw new RestoreError("log_empty", "the storage has no log to restore into");
  }

  const resumed = before.restoreInProgress !== undefined;
  const restore = before.restoreInProgress ?? o.ids?.restore ?? newRestoreId();
  // A restore that is done (its event in the log, no marker): asked again by its ID, it is
  // answered as it is, and the anchor is not touched (`beginRestore` would raise the count again).
  if (!resumed) {
    const done = await restoredEventOf(o.store, restore);
    if (done !== undefined) {
      const end = await o.store.read((tx) => readTail(tx));
      return {
        restore,
        restoreCount: done.restoreCount,
        restoredSeq: done.seq,
        logEnd: end?.seq ?? done.seq,
        resumed: false,
        eventWasThere: true,
      };
    }
  }
  // Step 1. A marker already set is left as it is: `beginRestore` returns the anchor unchanged
  // then, so the restore count is raised once for a restore however often it is taken up.
  const a = await o.anchor.beginRestore(o.tenant, restore);

  // Step 2.
  let event = await restoredEventOf(o.store, restore);
  const eventWasThere = event !== undefined;
  if (event === undefined) {
    event = await o.store.write(async (tx) => {
      const tail = await readTail(tx);
      if (tail === undefined) throw new OpsError("internal", "the log lost its events");
      const op = await appendOperation(tx, {
        actor: "system",
        now: o.now,
        events: [
          {
            type: "tenant.restored",
            trigger: "restore",
            node_id: o.ids?.node ?? newNodeId(),
            restore_id: restore as `rs_${string}`,
            restore_count: a.restoreCount,
            restored_to: tail.seq,
            high_water: a.highWater,
            blocks: {},
          },
        ],
      });
      await applyEvents(tx, eventsOf(op));
      return { seq: op.op, restoreCount: a.restoreCount };
    });
    // The restore count changed under this store: what effects noted of it is read again.
    forgetRestores(o.store);
  }

  // Step 3.
  if (o.backfill !== undefined) await o.backfill(a);

  // Step 4: the high water mark goes to the log's end, where the flow left it.
  const end = await o.store.read((tx) => readTail(tx));
  const logEnd = end?.seq ?? event.seq;
  await o.anchor.endRestore(o.tenant, restore, logEnd);
  return {
    restore,
    restoreCount: event.restoreCount,
    restoredSeq: event.seq,
    logEnd,
    resumed,
    eventWasThere,
  };
}
