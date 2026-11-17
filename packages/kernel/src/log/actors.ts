// Who a principal was at a position of the log (04-contract-types §1.6 `Actor`; 09-event-format
// §5.2, §5.3): its kind, the name its last registration or rename up to there gave it, and its
// state there. A write's receipt names principals as of its own operation, both when the write
// first answers and when an idempotent replay rebuilds the receipt (03-data-model/04-write-and-read
// «幂等重放的回执»), so this reads the log only and never the `principals` table, which holds the
// state now.

import type { ReadTx } from "../store/ports.ts";

/** 04-contract-types §1.6 `Actor`. */
export interface ActorAsOf {
  readonly kind: "connection" | "user" | "system";
  readonly id: string;
  readonly name: string;
  readonly state?: "revoked" | "disabled";
}

/** The events that register a principal, name it, or change its state. */
const TYPES = [
  "tenant.genesis",
  "tenant.imported",
  "principal.registered",
  "principal.renamed",
  "principal.revoked",
];

interface Known {
  kind: ActorAsOf["kind"];
  name: string | null;
  state: "active" | "revoked" | "disabled";
}

/**
 * The principals `ids` as of log position `pos`: from the events with `seq` ≤ `pos` only. A
 * principal with no name there (a user principal; a connection whose name block is gone) is named
 * by its ID, and one the log does not register by then is a user, or `system` (as the reads name
 * them).
 */
export async function actorsAsOf(
  tx: ReadTx,
  ids: readonly string[],
  pos: number,
): Promise<Map<string, ActorAsOf>> {
  const out = new Map<string, ActorAsOf>();
  const wanted = new Set(ids);
  if (wanted.size === 0) return out;
  const r = await tx.query<{
    seq: unknown;
    type: string;
    path: string | null;
    body: string | null;
  }>(
    `SELECT e.seq, e.type, c.path, c.body
       FROM events e
       LEFT JOIN content c ON c.seq = e.seq AND c.path IN ('principal', 'name', 'user')
      WHERE e.type = ANY($1) AND e.seq <= $2
      ORDER BY e.seq, c.path`,
    [TYPES, pos] as never,
  );
  // An event's blocks by path, in log order.
  const events: { type: string; blocks: Map<string, Record<string, unknown>> }[] = [];
  let last: unknown;
  for (const x of r.rows) {
    if (x.seq !== last) {
      events.push({ type: x.type, blocks: new Map() });
      last = x.seq;
    }
    if (x.path !== null && x.body !== null) {
      (events.at(-1) as (typeof events)[number]).blocks.set(x.path, JSON.parse(x.body));
    }
  }

  const known = new Map<string, Known>();
  const of = (b: Map<string, Record<string, unknown>>, path: string) =>
    b.get(path)?.["principal"] as string | undefined;
  for (const e of events) {
    switch (e.type) {
      case "tenant.genesis": {
        const user = of(e.blocks, "user");
        if (user !== undefined) known.set(user, { kind: "user", name: null, state: "active" });
        known.set("system", { kind: "system", name: null, state: "active" });
        break;
      }
      // §5.2: every principal registered before it is disabled, `system` and its own user aside.
      case "tenant.imported": {
        for (const p of known.values()) if (p.kind !== "system") p.state = "disabled";
        const user = of(e.blocks, "user");
        if (user !== undefined) known.set(user, { kind: "user", name: null, state: "active" });
        break;
      }
      case "principal.registered": {
        const id = of(e.blocks, "principal");
        const name = e.blocks.get("name")?.["name"];
        if (id !== undefined) {
          known.set(id, {
            kind: "connection",
            name: typeof name === "string" ? name : null,
            state: "active",
          });
        }
        break;
      }
      case "principal.renamed": {
        const p = known.get(of(e.blocks, "principal") ?? "");
        const name = e.blocks.get("name")?.["name"];
        if (p !== undefined && p.kind === "connection")
          p.name = typeof name === "string" ? name : null;
        break;
      }
      case "principal.revoked": {
        const p = known.get(of(e.blocks, "principal") ?? "");
        if (p !== undefined && p.kind === "connection") p.state = "revoked";
        break;
      }
    }
  }

  for (const id of wanted) {
    const p = known.get(id);
    out.set(
      id,
      p === undefined
        ? { kind: id === "system" ? "system" : "user", id, name: id }
        : {
            kind: p.kind,
            id,
            name: p.name ?? id,
            ...(p.state !== "active" ? { state: p.state } : {}),
          },
    );
  }
  return out;
}
