// The import's event (docs/zh-CN/spec/02-architecture.md §8 «格式版本、导出、导入与恢复» step ③;
// 09-event-format §5.2 `tenant.imported`): appended at the end of the imported log in the staging
// storage, after the last imported event, and applied in the same transaction.
//
// Its actor is the importing user, whom it registers; it carries no `ctx`, `task` or request key.
// A new node ID names the events after it (§2.2); the restore count is the export's plus one, so
// item versions and `ver`s given out before the import are told apart (03-data-model/03-deletion.md
// «恢复次数»); `imported_upto` is the last imported event, the import point. The manifest is outside
// input: its restore count must be a non-negative integer below 2^31 − 1 (the count plus one is
// stored as a 32-bit integer) and equal to the imported log's own current restore count, or the
// manifest does not describe the log it came with and nothing is appended. The import ID is not
// in the event.

import type {
  ExportManifest,
  Instant,
  NodeId,
  Seq,
  TenantId,
  UserId,
} from "@fluxvita/saveslot-contract-core";
import { applyEvents, eventsOf } from "../apply/index.ts";
import { appendOperation, readTail } from "../log/index.ts";
import { STORAGE_FORMAT_VERSION } from "../store/format-v1.ts";
import type { TenantStore } from "../store/ports.ts";
import { restorePoint } from "../store/restore-point.ts";
import { OpsError } from "./errors.ts";
import { newNodeId } from "./ids.ts";

export interface ImportEventInput {
  /** The importing user, registered by the event. */
  readonly user: UserId;
  /** The target tenant: the current tenant ID from the event on. */
  readonly tenant: TenantId;
  /** The first segment's manifest. */
  readonly manifest: ExportManifest;
  readonly now: Instant;
  /** For tests: the node ID the event takes. */
  readonly node?: NodeId;
}

export interface ImportEventResult {
  readonly seq: Seq;
  readonly importedUpto: Seq;
  readonly restoreCount: number;
  readonly node_id: NodeId;
}

/** The largest restore count a manifest may give: the import's, one more, still fits INTEGER. */
export const MAX_MANIFEST_RESTORE_COUNT = 2 ** 31 - 2;

/**
 * Why the import's event was not appended. Codes are stable; the message gives no content.
 * - `manifest_restore_count`: the manifest's restore count is not a non-negative integer up to
 *   {@link MAX_MANIFEST_RESTORE_COUNT}, or not the imported log's own current restore count.
 */
export type ImportEventErrorCode = "manifest_restore_count";

export class ImportEventError extends Error {
  readonly code: ImportEventErrorCode;
  constructor(code: ImportEventErrorCode, message: string) {
    super(message);
    this.name = "ImportEventError";
    this.code = code;
  }
}

/**
 * Appends and applies `tenant.imported` after the last event of the imported log in `staging`.
 * The staging log must end where the manifest says (`upto`, its header hashing to `upto_hash`),
 * whatever its last event is: an export of a tenant that was imported may end in that import's
 * event. Anything else is `internal`, nothing appended: step ③ runs once on a staging storage of
 * its own (§8 «重入»: a crash before ⑤ discards it, after ⑤ only ⑥ runs).
 */
export async function appendImportEvent(
  staging: TenantStore,
  o: ImportEventInput,
): Promise<ImportEventResult> {
  const node_id = o.node ?? newNodeId();
  const given: unknown = o.manifest.restore_count;
  if (
    typeof given !== "number" ||
    !Number.isInteger(given) ||
    given < 0 ||
    given > MAX_MANIFEST_RESTORE_COUNT
  ) {
    throw new ImportEventError(
      "manifest_restore_count",
      "the manifest's restore count is not a non-negative integer in range",
    );
  }
  const restoreCount = given + 1;
  return staging.write(async (tx) => {
    const tail = await readTail(tx);
    if (tail === undefined) {
      throw new OpsError(
        "internal",
        "appendImportEvent: the staging storage holds no imported log",
      );
    }
    if (tail.seq !== o.manifest.upto || tail.hash !== o.manifest.upto_hash) {
      throw new OpsError(
        "internal",
        "appendImportEvent: the staging log does not end at the manifest's upto",
      );
    }
    const latest = await restorePoint(tx);
    if (latest.restoreCount !== given) {
      throw new ImportEventError(
        "manifest_restore_count",
        `the manifest's restore count is not the imported log's own (${latest.restoreCount})`,
      );
    }
    const op = await appendOperation(tx, {
      actor: o.user,
      now: o.now,
      events: [
        {
          type: "tenant.imported",
          node_id,
          restore_count: restoreCount,
          imported_upto: tail.seq,
          blocks: {
            tenant: {
              tenant_id: o.tenant,
              previous_tenant_id: o.manifest.tenant_id,
              storage_format: STORAGE_FORMAT_VERSION,
              event_format: 1,
            },
            user: { principal: o.user, kind: "user" },
            export: {
              exported_at: o.manifest.exported_at,
              pending_deletions: o.manifest.pending_deletions,
            },
          },
        },
      ],
    });
    await applyEvents(tx, eventsOf(op));
    return { seq: op.op, importedUpto: tail.seq, restoreCount, node_id };
  });
}
