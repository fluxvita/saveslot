// Import into an empty tenant, the steps after the staging storage (docs/zh-CN/spec/02-architecture.md
// §8 «格式版本、导出、导入与恢复» steps ④–⑥ and «重入»; 04-contract.md §17 `import`):
//
//   before ④, what would make ⑥ refuse is refused while nothing has changed: an anchor whose high
//      water is above the staging log's end (it would leave the log behind it);
//   ④ `beginImport`: the anchor's "import in progress" marker, then the empty tenant checked again
//      (the log holds the genesis event only; if not, the marker is cleared and the import refused);
//   ⑤ the staging storage swapped in for the target's (the host's `swap`: a directory renamed
//      locally, the storage pointer of the tenant directory updated in server mode);
//   ⑥ `endImport`: in one durable write, the deletion entries the log still has pending, the high
//      water mark (the log's end) and the restore count (the import event's), the marker cleared.
//
// The anchor store and the tenant storage share no transaction: the marker makes the steps re-enter.
// `openTenant` sees the marker first; with the import's event in the target's log (a crash between
// ⑤ and ⑥) the host calls `finishImport`, without it (a crash before ⑤) `abortImportOnOpen`, which
// discards the staging storage and then clears the marker. Either can run again after a crash in
// its middle. A staging storage left by a crash before ④ has no marker; the host clears it when it
// opens the tenant.
//
// Deletion entries: until apply knows the deletion events, an import refuses any file holding one
// (`replay_failed`), so an imported log has no deletion and its registry is empty. `finishImport`
// checks that rather than assume it: a deletion event in the log is an internal error, the marker
// left in place. With the deletion line's apply, the entries come from the deletions the log still
// has pending.

import type { Seq, TenantId } from "@fluxvita/saveslot-contract-core";
import { ImportRejected, readTail } from "../log/index.ts";
import type { AnchorStore, ImportId } from "../store/anchor.ts";
import { AnchorStoreError } from "../store/anchor.ts";
import type { ReadTx, TenantStore } from "../store/ports.ts";
import { restorePoint } from "../store/restore-point.ts";
import { OpsError } from "./errors.ts";
import { ImportLineTooLarge } from "./import.ts";
import { ImportEventError } from "./import-event.ts";

/**
 * Another import holds the tenant (the anchor's marker is set): `unavailable` (`importing`), as
 * any request to the tenant while it imports (04-contract §17); it may be retried.
 */
export class ImportInProgress extends Error {
  readonly code = "unavailable";
  readonly reason = "importing";
  constructor() {
    super("an import is in progress for the tenant");
    this.name = "ImportInProgress";
  }
}

/**
 * Whether the log holds an import's event as its latest restore or import event: the fact
 * `openTenant` takes with an import in progress (`importEventInLog`). The target's log held the
 * genesis event only before the import, and the marker lets no other import in meanwhile, so an
 * import event there is this import's.
 */
export async function importEventInLog(tx: ReadTx): Promise<boolean> {
  const latest = await restorePoint(tx);
  if (latest.seq === null) return false;
  const r = await tx.query<{ type: string }>("SELECT type FROM events WHERE seq = $1", [
    latest.seq,
  ]);
  return r.rows[0]?.type === "tenant.imported";
}

export interface FinishImportResult {
  /** False when no import was in progress: an earlier call finished it. */
  readonly finished: boolean;
  /** The anchor's high water mark and restore count after the call. */
  readonly highWater: Seq;
  readonly restoreCount: number;
}

/**
 * Step ⑥: rebuilds the anchor from the log of `store` (the target's, swapped in) and clears the
 * marker. Nothing when no import is in progress. Refuses (internal), writing nothing, when the log
 * does not end in an import (its latest restore or import event is not `tenant.imported`), holds a
 * deletion event, or ends below the anchor's high water mark.
 */
export async function finishImport(o: {
  readonly store: TenantStore;
  readonly anchor: AnchorStore;
  readonly tenant: TenantId;
  readonly importId: ImportId;
}): Promise<FinishImportResult> {
  const a = await o.anchor.read(o.tenant);
  if (a.importInProgress === undefined) {
    return { finished: false, highWater: a.highWater, restoreCount: a.restoreCount };
  }
  if (a.importInProgress !== o.importId) {
    throw new OpsError("internal", "finishImport: another import is in progress");
  }
  const log = await o.store.read(async (tx) => {
    const tail = await readTail(tx);
    const latest = await restorePoint(tx);
    const imported = await importEventInLog(tx);
    const deletions = await tx.query<{ n: unknown }>(
      "SELECT count(*) AS n FROM events WHERE type LIKE 'deletion.%'",
    );
    return { tail, latest, imported, deletions: Number(deletions.rows[0]?.n ?? 0) };
  });
  if (log.tail === undefined || !log.imported) {
    throw new OpsError("internal", "finishImport: the log does not hold the import's event");
  }
  if (log.deletions > 0) {
    throw new OpsError(
      "internal",
      "finishImport: the imported log holds deletion events; their registry is not built yet",
    );
  }
  // The high water never passes the log's end (§8); `endImport` keeps the larger of the two, so
  // a stored mark above the end would leave the log behind it.
  if (a.highWater > log.tail.seq) {
    throw new OpsError("internal", "finishImport: the anchor's high water is above the log's end");
  }
  const highWater = log.tail.seq;
  const restoreCount = log.latest.restoreCount;
  await o.anchor.endImport(o.tenant, o.importId, { deletions: [], highWater, restoreCount });
  return { finished: true, highWater, restoreCount };
}

/**
 * The re-entry with no import event in the target's log (a crash before ⑤): the staging storage is
 * discarded first (`discardStaging`, the host's; nothing when it is gone), then the marker cleared.
 * The tenant stays empty and takes an import again. Running it again after a crash between the two
 * does the same.
 */
export async function abortImportOnOpen(o: {
  readonly anchor: AnchorStore;
  readonly tenant: TenantId;
  readonly importId: ImportId;
  readonly discardStaging: () => Promise<void>;
}): Promise<void> {
  await o.discardStaging();
  await o.anchor.abortImport(o.tenant, o.importId);
}

/**
 * Steps ④–⑥, after the host replayed the file into the staging storage and appended the import's
 * event there. Before ④, `internal` with nothing changed when the staging log does not end in what
 * step ③ appended: its latest `tenant.imported` at `importSeq`, following the file's last event
 * `importedUpto`, and after it only the tombstones ③ adds for placeholders (`deletion.executed`,
 * trigger `import`, reason `import_placeholder`; 09-event-format §5.2); or when the anchor's high
 * water is above the log's end. An export of an imported tenant ends in a `tenant.imported` of its
 * own, so the type of the latest one does not tell that ③ ran: a host that skipped it would make a
 * copy of the source tenant, its node ID and restore count. ④ sets the marker (the
 * anchor must be empty) and then checks that the target's log holds the genesis event only; if
 * either is not so, `invalid_argument` (`tenant_not_empty`), the marker cleared, nothing changed;
 * another import's marker there is {@link ImportInProgress}.
 * `swap` (⑤) puts the staging storage in the target's place and returns the storage now serving
 * as the target's. A failure after ④ leaves the marker: `openTenant` then finishes the import or
 * rolls it back by whether the swap happened.
 */
export async function runImport(o: {
  /** The target tenant's storage, open: checked to hold the genesis event only. */
  readonly target: TenantStore;
  readonly anchor: AnchorStore;
  readonly tenant: TenantId;
  readonly importId: ImportId;
  /** The staging storage, open: its log is checked before ④; `swap` closes it as it needs. */
  readonly staging: TenantStore;
  /** The `seq` of the import's event in the staging log, as step ③ returned it. */
  readonly importSeq: Seq;
  /** The file's last event, as step ③ returned it: the import event's `imported_upto`. */
  readonly importedUpto: Seq;
  readonly swap: () => Promise<TenantStore>;
}): Promise<FinishImportResult> {
  const notEmpty = () =>
    new OpsError("invalid_argument", "the tenant is not empty", { reason: "tenant_not_empty" });
  const staged = await o.staging.read(async (tx) => {
    const tail = await readTail(tx);
    const r = await tx.query<{ seq: unknown; header: string }>(
      "SELECT seq, header FROM events WHERE type = 'tenant.imported' ORDER BY seq DESC LIMIT 1",
    );
    const row = r.rows[0];
    // What follows the import's event: the tombstones of placeholders only.
    const after = await tx.query<{ type: string; header: string; target: string | null }>(
      `SELECT e.type, e.header, c.body AS target FROM events e
       LEFT JOIN content c ON c.seq = e.seq AND c.path = 'target'
       WHERE e.seq > $1 ORDER BY e.seq`,
      [o.importSeq],
    );
    return {
      end: tail?.seq ?? 0,
      seq: row === undefined ? undefined : Number(row.seq),
      importedUpto: row === undefined ? undefined : JSON.parse(row.header).imported_upto,
      onlyTombstonesAfter: after.rows.every(
        (e) =>
          e.type === "deletion.executed" &&
          JSON.parse(e.header).trigger === "import" &&
          e.target !== null &&
          JSON.parse(e.target).reason === "import_placeholder",
      ),
    };
  });
  if (
    staged.seq !== o.importSeq ||
    staged.importedUpto !== o.importedUpto ||
    !staged.onlyTombstonesAfter
  ) {
    throw new OpsError(
      "internal",
      "runImport: the staging log does not end in what step ③ appended",
    );
  }
  const before = await o.anchor.read(o.tenant);
  // `finishImport` refuses this after the swap, and every reopen would refuse it again: the
  // tenant neither empty nor imported (§8). Refused here, the tenant stays as it was.
  if (before.highWater > staged.end) {
    throw new OpsError(
      "internal",
      "runImport: the anchor's high water is above the staging log's end",
    );
  }
  try {
    await o.anchor.beginImport(o.tenant, o.importId);
  } catch (e) {
    if (e instanceof AnchorStoreError && e.code === "import_refused") {
      if ((await o.anchor.read(o.tenant)).importInProgress !== undefined) {
        throw new ImportInProgress();
      }
      throw notEmpty();
    }
    throw e;
  }
  // ④'s second half: with the marker set, the log holds the genesis event only. A write committed
  // before the marker is seen here rather than lost by the swap.
  const tail = await o.target.read((tx) => readTail(tx));
  if (tail === undefined || tail.seq !== 1) {
    await o.anchor.abortImport(o.tenant, o.importId);
    if (tail === undefined) {
      throw new OpsError("internal", "runImport: the target's storage holds no genesis event");
    }
    throw notEmpty();
  }
  const swapped = await o.swap();
  return finishImport({
    store: swapped,
    anchor: o.anchor,
    tenant: o.tenant,
    importId: o.importId,
  });
}

/** An import's failure as the contract gives it (04-contract-types §9), or undefined if none. */
export type ImportContractError =
  | {
      readonly code: "import_rejected";
      readonly reason: ImportRejected["reason"];
      readonly seq?: Seq;
      readonly path?: string;
    }
  | { readonly code: "too_large"; readonly reason: "import_line"; readonly limit_bytes: number }
  | { readonly code: "unavailable"; readonly reason: "importing" }
  | { readonly code: "internal" };

/**
 * The contract's error for a failure of the import's own steps: a file refused
 * (`import_rejected` with its reason and position), a manifest whose restore count does not match
 * its log (`import_rejected` `incomplete`: the manifest and the content do not match), a
 * line over the limit (`too_large` `import_line`, 09-event-format §8), another import in progress
 * (`unavailable` `importing`). Undefined for any other error, which the caller maps as it maps the rest (`OpsError` such as
 * `tenant_not_empty`, a storage failure).
 */
export function importContractError(e: unknown): ImportContractError | undefined {
  if (e instanceof ImportRejected) {
    return {
      code: "import_rejected",
      reason: e.reason,
      ...(e.seq !== undefined ? { seq: e.seq } : {}),
      ...(e.path !== undefined ? { path: e.path } : {}),
    };
  }
  if (e instanceof ImportLineTooLarge) {
    return { code: "too_large", reason: "import_line", limit_bytes: e.limitBytes };
  }
  if (e instanceof ImportInProgress) return { code: "unavailable", reason: "importing" };
  if (e instanceof ImportEventError) return { code: "import_rejected", reason: "incomplete" };
  return undefined;
}
