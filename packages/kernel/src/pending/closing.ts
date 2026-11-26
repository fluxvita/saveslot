// How an item closed (04-contract-types §4.8 `ItemResolution`, the item's `superseded`): from its
// latest item.resolved or item.superseded event. The item's details and resolve's item_closed
// refusal give the same shape from here; each names the principal its own way.

import type { SupersededReason } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import { READABLE_CONTENT } from "../store/readable-content.ts";
import type { Blocks } from "./detail.ts";

/** A decision of this version, as `item.resolved` records it (09 §5.8; the request's `decision`). */
export type ClosingDecision =
  | "keep_effective"
  | "take_candidate"
  | "take_previous"
  | "confirm"
  | "reject";

/**
 * How a decision closed an item (04-contract-types §4.8 `ItemResolution`, its branch by decision),
 * with the actor written by the caller's naming.
 */
export interface DecisionResolution<A> {
  readonly decision: ClosingDecision;
  /** take_candidate: the candidate taken, by its number in the item (09 §5.8 `k`). */
  readonly candidate?: number;
  readonly seq: number;
  readonly at: string;
  readonly actor: A;
  /** The decision's note, from its `api_call` source; gone with that source. */
  readonly note?: string;
}

/** How an item closed: its resolution or what superseded it. */
export async function closingOf(tx: ReadTx, id: string) {
  const r = await tx.query<{
    type: string;
    seq: unknown;
    op: unknown;
    at: string;
    actor: string;
    body: string;
  }>(
    `SELECT e.type, e.seq, e.op, h.at, h.actor, c.body FROM events e
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
  const note = x?.type === "item.resolved" ? await noteOf(tx, Number(x.seq)) : undefined;
  return {
    principals: x?.type === "item.resolved" ? [x.actor] : [],
    out: <A>(actor: (principal: string) => A) =>
      x === undefined || target === undefined
        ? {}
        : x.type === "item.resolved"
          ? {
              resolution: {
                decision: target["decision"] as ClosingDecision,
                // take_candidate: the candidate taken, by its number in the item (09 §5.8 `k`).
                ...(typeof target["candidate"] === "number"
                  ? { candidate: target["candidate"] }
                  : {}),
                seq: Number(x.op),
                at: x.at,
                actor: actor(x.actor),
                ...(note !== undefined ? { note } : {}),
              } satisfies DecisionResolution<A>,
            }
          : {
              superseded: {
                reason: target["reason"] as SupersededReason,
                ...(by !== undefined ? { by } : {}),
                at: x.at,
              },
            },
  };
}

/**
 * The note a decision was given (04-contract-types §5 `ResolveParams.note`): kept in the request's
 * `api_call` source among the decision's operation sources (09 §4.3, §5.4 `request`), and gone
 * with it when that source is deleted. None when the decision had no note.
 */
async function noteOf(tx: ReadTx, resolved: number): Promise<string | undefined> {
  const r = await tx.query<{ body: string }>(
    `SELECT q.body FROM content o
     JOIN content t ON t.path = 'target' AND t.body IS NOT NULL
       AND t.seq IN (SELECT jsonb_array_elements_text(o.body::jsonb)::bigint)
       AND (t.body::jsonb ->> 'kind') = 'api_call'
     JOIN ${READABLE_CONTENT} q ON q.seq = t.seq AND q.path = 'request' AND q.body IS NOT NULL
     WHERE o.seq = $1 AND o.path = 'op_sources' AND o.body IS NOT NULL`,
    [resolved],
  );
  const note = (JSON.parse(r.rows[0]?.body ?? "{}") as { note?: unknown }).note;
  return typeof note === "string" ? note : undefined;
}
