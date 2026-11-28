// The premises a row's timeline shows (docs/zh-CN/spec/04-contract.md §10 `history` «timeline»;
// 04-contract-types §4.5 `TimelineEntry.premises`): each write that declared premises on the row
// gives them, in the receipt's shape (§5.1 `OpResult.premises`), the state being the one now; a
// restatement or a clearing, which has no base write, is an entry of its own (a clearing's premises
// empty). Read from the heads that name the row as an op's target, up to the timeline's position.

import type {
  CompiledBaseTable,
  EntityId,
  PremiseReason,
  RowId,
  Seq,
} from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import { readableContentOf } from "../store/readable-content.ts";
import type { VisibleSlot } from "./slots.ts";
import type { TimelinePremise } from "./types.ts";

/** An op of a request whose target is the row, and what it declared. */
export interface DeclaringOp {
  readonly op: number;
  readonly index: number;
  readonly at: string;
  readonly actor: string;
  /** The premises declared, in request order; a clearing's: none. */
  readonly premises: readonly TimelinePremise[];
}

/**
 * The ops up to operation `upTo` whose target is row `row` and that declared premises or cleared
 * them, by `<op>/<op index>`.
 */
export async function declaringOps(
  tx: ReadTx,
  row: string,
  upTo: number,
  slot: VisibleSlot,
): Promise<Map<string, DeclaringOp>> {
  const out = new Map<string, DeclaringOp>();
  const heads = await tx.query<{
    op: unknown;
    at: string;
    actor: string;
    path: string;
    body: string | null;
  }>(
    `SELECT e.op, e.at, e.actor, c.path, c.body FROM content c JOIN events e ON e.seq = c.seq
     WHERE e.type = 'write.head' AND e.op <= $2 AND c.path LIKE 'ops/%/target'
       AND c.body LIKE $1`,
    [`%"${row}"%`, upTo],
  );
  const mine: { op: number; index: number; at: string; actor: string }[] = [];
  for (const h of heads.rows) {
    if (h.body === null) continue;
    const t = JSON.parse(h.body) as { row?: string; entity?: string };
    // The exact check; `LIKE` above is a prefilter (its `_` matches any character). A target block
    // holds no caller text (table ID, row or entity, intent, flags, ver), so with today's ID formats
    // the prefilter finds no other row: dropping this line is an equivalent mutation.
    if (t.row !== row && t.entity !== row) continue;
    const index = Number(/^ops\/(\d+)\/target$/.exec(h.path)?.[1]);
    mine.push({ op: Number(h.op), index, at: h.at, actor: h.actor });
  }
  if (mine.length === 0) return out;
  const blocks = await tx.query<{ seq: unknown; path: string; body: string | null }>(
    `SELECT seq, path, body FROM ${readableContentOf(
      "$1",
      "x.path ~ '^ops/[0-9]+/premises/[0-9]+$' OR x.path ~ '^ops/[0-9]+/premises_cleared$'",
    )} c`,
    [[...new Set(mine.map((m) => m.op))]] as never,
  );
  const states = await tx.query<{
    op: unknown;
    i: unknown;
    j: unknown;
    state: "current" | "changed";
    reason: string | null;
    since: unknown;
  }>(
    `SELECT op, op_index AS i, decl_index AS j, state, reason, since FROM premise_decls
     WHERE op = ANY($1)`,
    [[...new Set(mine.map((m) => m.op))]] as never,
  );
  const now = new Map(states.rows.map((x) => [`${x.op}/${x.i}/${x.j}`, x]));
  // In force: an edge left for some item, not voided by a later clearing entry on it (as the marks
  // read them, delta/premise-marks.ts). One superseded on its target or cleared has none: `ended`,
  // its state stopped when it ended and marks nothing now.
  const live = await tx.query<{ op: unknown; i: unknown; j: unknown }>(
    `SELECT e.decl_op AS op, e.decl_op_index AS i, e.decl_index AS j FROM premise_edges e
     WHERE e.target <> '*' AND e.decl_op = ANY($1)
       AND NOT EXISTS (
         SELECT 1 FROM premise_edges c WHERE c.target = '*' AND c.item_event = e.item_event
           AND c.field_id = e.field_id AND c.k = e.k
           AND (c.decl_op, c.decl_op_index) > (e.decl_op, e.decl_op_index))
     GROUP BY e.decl_op, e.decl_op_index, e.decl_index`,
    [[...new Set(mine.map((m) => m.op))]] as never,
  );
  const inForce = new Set(live.rows.map((x) => `${x.op}/${x.i}/${x.j}`));
  // Tables a schema switch dropped from the slot, as the last version having each defined it: not
  // tables out of range, when the caller's range takes them in (the whole slot, or the table by its
  // ID); named as they were (04-contract-types §3 `premise_changed`, the same rule).
  const dropped = await tx.query<{ table_id: string; structure: string }>(
    `SELECT DISTINCT ON (table_id) table_id, structure FROM catalog
     WHERE slot_id = $1 AND NOT (table_id = ANY($2)) ORDER BY table_id, sv DESC`,
    [slot.slot, slot.compiled.tables.map((t) => t.id)] as never,
  );
  const former = new Map(
    dropped.rows
      .filter((x) => slot.rangeTables === undefined || slot.rangeTables.has(x.table_id))
      .map((x) => [x.table_id, JSON.parse(x.structure) as CompiledBaseTable] as const),
  );
  const tableOf = (id: string) =>
    (slot.compiled.tables.find((t) => t.id === id && t.kind === "base") as
      | CompiledBaseTable
      | undefined) ?? former.get(id);
  for (const m of mine) {
    const prefix = `ops/${m.index}/`;
    const of = blocks.rows.filter((b) => Number(b.seq) === m.op && b.path.startsWith(prefix));
    const cleared = of.some((b) => b.path.endsWith("/premises_cleared") && b.body === "true");
    const decls = of
      .map((b) => ({ j: /\/premises\/(\d+)$/.exec(b.path)?.[1], body: b.body }))
      .filter((x): x is { j: string; body: string } => x.j !== undefined && x.body !== null)
      .sort((a, b) => Number(a.j) - Number(b.j));
    if (decls.length === 0 && !cleared) continue;
    const premises = decls.map((x): TimelinePremise => {
      const p = JSON.parse(x.body) as {
        table: string;
        row?: RowId;
        entity?: EntityId;
        fields?: string[];
        ver: { op: number; restore_count: number };
      };
      const t = tableOf(p.table);
      const name = (f: string) => t?.fields.find((y) => y.id === f)?.name ?? f;
      const key = `${m.op}/${m.index}/${x.j}`;
      const ended = !inForce.has(key);
      const s = ended ? undefined : now.get(key);
      const since =
        s?.since !== null && s?.since !== undefined ? { since: Number(s.since) as Seq } : {};
      if (!slot.tables.some((v) => v.id === p.table) && !former.has(p.table))
        return ended
          ? { hidden: true, state: "ended" }
          : { hidden: true, state: s?.state ?? "current", ...since };
      const what = {
        target: {
          table: `${slot.name}.${t?.name ?? p.table}`,
          ...(p.row !== undefined ? { row: p.row } : {}),
          ...(p.entity !== undefined ? { entity: p.entity } : {}),
        },
        ...(p.fields !== undefined ? { fields: p.fields.map(name) } : {}),
        ver: `v${p.ver.op}.${p.ver.restore_count}`,
      };
      if (ended) return { ...what, state: "ended" };
      return {
        ...what,
        state: s?.state ?? "current",
        ...(s?.reason !== null && s?.reason !== undefined
          ? { reason: s.reason as PremiseReason }
          : {}),
        ...since,
      };
    });
    out.set(`${m.op}/${m.index}`, { ...m, premises });
  }
  return out;
}
