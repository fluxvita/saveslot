// How an item closed (04-contract-types §4.8 `ItemResolution`, the item's `superseded`): from its
// latest item.resolved or item.superseded event. The item's details and resolve's item_closed
// refusal give the same shape from here; each names the principal its own way.

import type { ReadTx } from "../store/ports.ts";
import type { Blocks } from "./detail.ts";

/** How an item closed: its resolution or what superseded it. */
export async function closingOf(tx: ReadTx, id: string) {
  const r = await tx.query<{ type: string; op: unknown; at: string; actor: string; body: string }>(
    `SELECT e.type, e.op, h.at, h.actor, c.body FROM events e
     JOIN events h ON h.seq = e.op
     JOIN content c ON c.seq = e.seq AND c.path = 'target' AND c.body IS NOT NULL
     WHERE e.type IN ('item.resolved', 'item.superseded') AND (c.body::jsonb ->> 'item') = $1
     ORDER BY e.seq DESC LIMIT 1`,
    [id],
  );
  const x = r.rows[0];
  const target = x === undefined ? undefined : (JSON.parse(x.body) as Blocks);
  let by: number | undefined;
  if (x?.type === "item.superseded" && typeof target?.["by_event"] === "number") {
    const b = await tx.query<{ op: unknown }>("SELECT op FROM events WHERE seq = $1", [
      target["by_event"],
    ]);
    by = b.rows[0] === undefined ? undefined : Number(b.rows[0].op);
  }
  return {
    principals: x?.type === "item.resolved" ? [x.actor] : [],
    out: <A>(actor: (principal: string) => A) =>
      x === undefined || target === undefined
        ? {}
        : x.type === "item.resolved"
          ? {
              resolution: {
                decision: target["decision"],
                // take_candidate: the candidate taken, by its number in the item (09 §5.8 `k`).
                ...(typeof target["candidate"] === "number"
                  ? { candidate: target["candidate"] }
                  : {}),
                seq: Number(x.op),
                at: x.at,
                actor: actor(x.actor),
              },
            }
          : {
              superseded: {
                reason: target["reason"],
                ...(by !== undefined ? { by } : {}),
                at: x.at,
              },
            },
  };
}
