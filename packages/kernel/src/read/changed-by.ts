// Who last changed a row (04-contract-types §4.1 `Row.changed_by`): the writer of the operation
// in the row's `ver`, given when it is not the caller. One statement for a page, whatever its size.

import { actorsNow } from "../pending/index.ts";
import type { ReadTx } from "../store/ports.ts";
import type { Actor } from "./types.ts";

/** By operation number, its writer, for the operations whose writer is not `caller`. */
export async function changersOf(
  tx: ReadTx,
  ops: readonly number[],
  caller: string,
): Promise<Map<number, Actor>> {
  const out = new Map<number, Actor>();
  const unique = [...new Set(ops)];
  if (unique.length === 0) return out;
  // The operation's head event, whose sequence number is the operation's: the one who made the
  // operation. Its other events may be another actor's (`system` refreshing derived values).
  const r = await tx.query<{ op: unknown; actor: string }>(
    "SELECT seq AS op, actor FROM events WHERE seq = ANY($1)",
    [unique] as never,
  );
  const others = r.rows.filter((x) => x.actor !== caller);
  const who = await actorsNow(
    tx,
    others.map((x) => x.actor),
  );
  for (const x of others) out.set(Number(x.op), who.get(x.actor) as Actor);
  return out;
}
