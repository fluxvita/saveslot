// The detection of premises (docs/zh-CN/spec/03-data-model/02-integrity-and-records.md «写入的前提»
// «检测»; 09-event-format §5.10 `premise.changed`): once an operation's base and item events are
// applied, the targets it changed are read from the version table before and after it, and each
// declaration in force on them changes state by the criterion:
//
// - one that is current is marked when this operation made the declared fields (and business
//   time) differ from what they were just before it: `since` is this operation, the reason this
//   operation's on that target. History is not read: a current declaration's range held the value
//   seen up to this operation.
// - one that is changed is taken back to current when the value now on its range is the value at
//   the version it saw again.
//
// The result is at most one `premise.changed`, a block a target, put into the same operation after
// its base and item events and before its derived writes. Repointing, and a range made the whole
// time line by a deletion, are deletion's (P3).

import type {
  BizPoint,
  CompiledBaseTable,
  OpNumber,
  Seq,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { type PremiseScope, premiseDelta, stateAt } from "../delta/index.ts";
import type { NewEvent } from "../log/index.ts";
import { decodeColumns } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { restoreAt, restoreHistory, seenOfVer } from "../store/restore-point.ts";
import { reasonOf } from "./premises.ts";

/** A declaration as `premise_decls` has it. */
interface StoredDecl {
  readonly op: number;
  readonly op_index: number;
  readonly decl_index: number;
  readonly fields: string | null;
  readonly range_kind: string;
  readonly valid: string | null;
  readonly seen_op: number;
  readonly seen_restore_count: number;
  readonly state: "current" | "changed";
}

/**
 * The declarations in force on `target`: some item covered by them, not by a later declaration
 * on the same target (edges are written over) nor cleared after them.
 */
async function inForce(tx: ReadTx, target: string): Promise<StoredDecl[]> {
  const r = await tx.query<Record<string, unknown>>(
    `SELECT d.op, d.op_index, d.decl_index, d.fields, d.range_kind, d.valid, d.seen_op,
       d.seen_restore_count, d.state
     FROM premise_decls d
     WHERE d.target_row = $1 AND EXISTS (
       SELECT 1 FROM premise_edges e
       WHERE e.target = $1 AND e.decl_op = d.op AND e.decl_op_index = d.op_index
         AND e.decl_index = d.decl_index
         AND NOT EXISTS (
           SELECT 1 FROM premise_edges c WHERE c.target = '*' AND c.item_event = e.item_event
             AND c.field_id = e.field_id AND c.k = e.k
             AND (c.decl_op, c.decl_op_index) > (e.decl_op, e.decl_op_index)))
     ORDER BY d.op, d.op_index, d.decl_index`,
    [target],
  );
  return r.rows.map((x) => ({
    op: Number(x["op"]),
    op_index: Number(x["op_index"]),
    decl_index: Number(x["decl_index"]),
    fields: (x["fields"] as string | null) ?? null,
    range_kind: x["range_kind"] as string,
    valid: (x["valid"] as string | null) ?? null,
    seen_op: Number(x["seen_op"]),
    seen_restore_count: Number(x["seen_restore_count"]),
    state: x["state"] as "current" | "changed",
  }));
}

/** The scope a stored declaration declared: its fields and, on a state table, its business time. */
async function scopeOf(tx: ReadTx, d: StoredDecl, t: CompiledBaseTable): Promise<PremiseScope> {
  const fields = d.fields !== null ? { fields: JSON.parse(d.fields) as never } : {};
  if (t.time.type !== "state") return fields;
  if (d.valid !== null) {
    const v = JSON.parse(d.valid) as
      | { at: BizPoint }
      | { during: { from: BizPoint; to?: BizPoint } };
    if ("at" in v) return { ...fields, range: { at: v.at } };
    return { ...fields, range: { from: v.during.from, to: v.during.to ?? null } };
  }
  // From now on: from the declaring operation's entry time (its head's `ctx`), at the table's
  // granularity: on a date table the slot's day (`today`), not the instant, whose UTC date is the
  // day before in a zone east of UTC late in the UTC day: the stretch of that day would count.
  const c = await tx.query<{ body: string | null }>(
    "SELECT body FROM content WHERE seq = $1 AND path = 'ctx'",
    [d.op],
  );
  const ctx = JSON.parse(c.rows[0]?.body ?? "{}") as { now?: string; today?: string };
  const from = ((t.time.granularity === "date" ? ctx.today : ctx.now) ?? "") as BizPoint;
  return { ...fields, range: { from, to: null } };
}

/** Tests only: fail as the detection's events are put into the operation. */
let failForTests = false;
export function failPremiseDetectionForTests(on: boolean): void {
  failForTests = on;
}

/**
 * The `premise.changed` of operation `op`, its base and item events applied; none when no
 * declaration changes state. `tableOf` gives the slot's base tables.
 */
export async function detectPremises(
  tx: ReadTx,
  op: OpNumber,
  tableOf: (id: TableId) => CompiledBaseTable | undefined,
): Promise<NewEvent | undefined> {
  // The targets the operation changed, with the first base event changing each (09 §5.10
  // `by_event`): one with an item that took effect; one whose items all became candidates or wait
  // for confirmation changed nothing.
  const bases = await tx.query<{ seq: unknown; target_table: string; target_row: string }>(
    `SELECT e.seq, e.target_table, e.target_row FROM events e
     WHERE e.op = $1 AND e.type = 'write.base'
       AND EXISTS (SELECT 1 FROM base_sources b WHERE b.event_seq = e.seq AND b.status = 'applied')
     ORDER BY e.seq`,
    [op],
  );
  const firsts = new Map<string, { table: TableId; seq: Seq }>();
  for (const b of bases.rows)
    if (!firsts.has(b.target_row))
      firsts.set(b.target_row, { table: b.target_table as TableId, seq: Number(b.seq) as Seq });
  const blocks: Record<string, unknown>[] = [];
  let slot: string | undefined;
  // Where a declaration's seen version reads, as of its declaration (04-contract §15).
  const restores = await restoreHistory(tx);
  const seenAt = (d: StoredDecl) =>
    seenOfVer({ op: d.seen_op, restoreCount: d.seen_restore_count }, restoreAt(restores, d.op))
      ?.seen ?? d.seen_op;
  for (const [id, { table, seq }] of firsts) {
    const t = tableOf(table);
    if (t === undefined) continue;
    // A declaration of this operation on a row it creates (`same_request`: its seen version is
    // this operation, 08 «as 与临时名») sees the request's end: what the request did to its target,
    // creating it included, is no change of it. One on a row read before (explicit, fallback) sees
    // that version, and a later op of the request changing it is a change, as before.
    const decls = (await inForce(tx, id)).filter((d) => !(d.op === op && d.seen_op === op));
    if (decls.length === 0) continue;
    const read = (v: number) => stateAt(tx, t, id, v, { decode: decodeColumns });
    const before = await read(op - 1);
    const after = await read(op);
    const changed: { op: number; i: number; j: number; reason: string }[] = [];
    const matched: { op: number; i: number; j: number }[] = [];
    for (const d of decls) {
      const scope = await scopeOf(tx, d, t);
      const ref = { op: d.op, i: d.op_index, j: d.decl_index };
      if (d.state === "current") {
        // Against the state just before this operation, not the version seen: a current
        // declaration's range holds the value seen up to here, so the two give the same answer;
        // this one reads no history.
        if (premiseDelta(before, after, scope).length > 0)
          changed.push({ ...ref, reason: await reasonOf(tx, t, id, op, before, after, scope) });
      } else if (premiseDelta(await read(seenAt(d)), after, scope).length === 0) {
        matched.push(ref);
      }
    }
    if (changed.length === 0 && matched.length === 0) continue;
    blocks.push({
      table,
      ...(t.time.type === "state" ? { entity: id } : { row: id }),
      by_event: seq,
      ...(changed.length > 0 ? { changed } : {}),
      ...(matched.length > 0 ? { matched } : {}),
    });
    slot ??= (await tx.query<{ slot: string }>("SELECT slot FROM events WHERE seq = $1", [seq]))
      .rows[0]?.slot;
  }
  if (blocks.length === 0) return undefined;
  if (failForTests) throw new Error("premise detection failed (tests)");
  return {
    type: "premise.changed",
    slot: slot as never,
    blocks: Object.fromEntries(blocks.map((b, k) => [`targets/${k}`, b])) as never,
  };
}
