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
