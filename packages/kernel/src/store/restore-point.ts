// The current restore count and the latest restore or import (03-data-model/03-deletion.md
// «恢复次数»; 09-event-format §5.2 `tenant.restored`, `tenant.imported`): the one way to take them.
// The current restore count is the latest restore or import event's, 0 when there is none; the
// restore point that event gives is `restored_to` for a restore, `imported_upto` for an import.
// The read path, the write path, a receipt's count in `resolve` and whether a writer's receipt
// still stands all take them from here. It is in `store`, beside the format that defines the
// `events` table, because `store` is the module all of them may depend on (02-architecture §11).

import type { Seq } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "./ports.ts";

export interface RestorePoint {
  /** The restore count: the latest restore or import event's; 0 when there is none. */
  readonly restoreCount: number;
  /** That event's `seq`; null when there is none. */
  readonly seq: Seq | null;
  /** The restore point it gives: `restored_to` or `imported_upto`; null when there is none. */
  readonly point: Seq | null;
}

const NONE: RestorePoint = { restoreCount: 0, seq: null, point: null };

/** The latest restore or import event, of the whole log or of the events before `before`. */
export async function restorePoint(
  tx: ReadTx,
  o: { readonly before?: Seq } = {},
): Promise<RestorePoint> {
  const r = await tx.query<{ seq: unknown; header: string }>(
    `SELECT seq, header FROM events WHERE type IN ('tenant.restored', 'tenant.imported')
       ${o.before === undefined ? "" : "AND seq < $1"}
     ORDER BY seq DESC LIMIT 1`,
    o.before === undefined ? [] : [o.before],
  );
  const row = r.rows[0];
  if (row === undefined) return NONE;
  const h = JSON.parse(row.header) as {
    restore_count?: number;
    restored_to?: number;
    imported_upto?: number;
  };
  return {
    restoreCount: h.restore_count ?? 0,
    seq: Number(row.seq),
    point: h.restored_to ?? h.imported_upto ?? null,
  };
}

/** The current restore count (01-objects «版本标记»). */
export async function restoreCount(tx: ReadTx): Promise<number> {
  return (await restorePoint(tx)).restoreCount;
}

/** Every restore and import in the log, oldest first (the restore points `seenOfVer` reads at). */
export async function restoreHistory(tx: ReadTx): Promise<readonly RestorePoint[]> {
  const r = await tx.query<{ seq: unknown; header: string }>(
    `SELECT seq, header FROM events WHERE type IN ('tenant.restored', 'tenant.imported')
     ORDER BY seq`,
  );
  return r.rows.map((row) => {
    const h = JSON.parse(row.header) as {
      restore_count?: number;
      restored_to?: number;
      imported_upto?: number;
    };
    return {
      restoreCount: h.restore_count ?? 0,
      seq: Number(row.seq) as Seq,
      point: (h.restored_to ?? h.imported_upto ?? null) as Seq | null,
    };
  });
}

/** Of `history` (oldest first), the restore or import in force at `seq`: the latest before it. */
export function restoreAt(history: readonly RestorePoint[], seq: number): RestorePoint {
  let at = NONE;
  for (const h of history) {
    if (h.seq !== null && h.seq < seq) at = h;
    else break;
  }
  return at;
}

/**
 * Where a `ver` (an operation and the restore count it was given under) is taken to have read, as
 * of the restore count and point `at` in force (04-contract §15 «恢复备份或导入之后»; 03-deletion
 * «恢复次数»). Of the current count: its own operation. One less and not past the restore point:
 * its own operation too (the two timelines are the same up to the point), `own`. Otherwise — one
 * less and past the point, or older still — the restore point is what it read; `own` false: its
 * operation is not one of this timeline's to check. A count newer than the current one: undefined,
 * no version of this timeline. The first judgement (the pipeline and a premise's `ver`) and the
 * log's (`decodeRecords`, taking `at` as of the event) both take it from here, so a replay sees
 * what the write saw whatever restores come after.
 */
export function seenOfVer(
  ver: { readonly op: number; readonly restoreCount: number },
  at: Pick<RestorePoint, "restoreCount" | "point">,
): { readonly seen: number; readonly own: boolean } | undefined {
  if (ver.restoreCount > at.restoreCount) return undefined;
  if (ver.restoreCount === at.restoreCount) return { seen: ver.op, own: true };
  if (at.point === null) return undefined;
  if (ver.restoreCount === at.restoreCount - 1 && ver.op <= at.point)
    return { seen: ver.op, own: true };
  return { seen: at.point, own: false };
}
