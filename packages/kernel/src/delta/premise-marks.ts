// The premises a row's or entity's values rest on (docs/zh-CN/spec/03-data-model/02-integrity-and-
// records.md «写入的前提» «标记出现在哪一行»): read when needed, never stored.
//
// 1. The 出处项 of each field cell in effect (`sourceItemsAt`: the contribution that gave the value,
//    carried references followed to their ends, and the corroborations of the same value still in
//    force). Cells without a value (`no_value`) and existence have none.
// 2. The declarations covering those items: the edge of each item for each premise target
//    (`premise_edges`, the latest declaration covering it), not voided by a later clearing entry on
//    the item.
// 3. Each with what it covers here: the field and, on a state table, the cell's business time, so
//    that a segment shows only what lies on it.
//
// The declarations' state is the one now: it is not kept by time.

import type { CompiledBaseTable, FieldId, TableId } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import { cellsOfRows, type Decode, sourceItemsOfRows } from "./sources.ts";

/** A declaration as `premise_decls` has it, by its key `<op>/<op index>/<index>`. */
export interface DeclaredPremise {
  readonly op: number;
  readonly opIndex: number;
  readonly index: number;
  readonly targetTable: TableId;
  /** The target row or entity. */
  readonly target: string;
  /** The declared fields; null: the whole row. */
  readonly fields: readonly FieldId[] | null;
  readonly seen: { readonly op: number; readonly restoreCount: number };
  readonly state: "current" | "changed";
  readonly reason: string | null;
  readonly since: number | null;
  /** The principal that declared it. */
  readonly declarer: string;
}

/** Something of a row a declaration covers: a field's value, on a stretch on a state table. */
export interface PremiseCover {
  readonly decl: string;
  readonly field: FieldId;
  /** The cell's business time (null on a row of an event or timeless table). */
  readonly from: string | null;
  readonly to: string | null;
}

export interface PremisesOn {
  /** By row or entity ID. */
  readonly covers: ReadonlyMap<string, readonly PremiseCover[]>;
  /** By declaration key. */
  readonly decls: ReadonlyMap<string, DeclaredPremise>;
}

/** The key of a declaration. */
export const declKey = (op: unknown, opIndex: unknown, index: unknown): string =>
  `${op}/${opIndex}/${index}`;

/**
 * The declarations in force on the values of rows `ids` at version position `at` (none: now), and
 * what each covers there. `changed`: only those whose state is changed (the marks); otherwise all
 * of them. A fixed number of statements, whatever the number of rows: whether there is any
 * declaration at all; then, for the page together, the cells, the sources and the declarations on
 * their items. No row is passed over before its 出处项 are known: an item reached only through a
 * carried reference (a taken candidate, a confirmed proposal) is not among the row's own items in
 * the sources table, only what a write-back carries.
 */
export async function premisesOn(
  tx: ReadTx,
  t: CompiledBaseTable,
  ids: readonly string[],
  o: { readonly decode: Decode; readonly at?: number; readonly changed?: boolean },
): Promise<PremisesOn> {
  const covers = new Map<string, PremiseCover[]>();
  const decls = new Map<string, DeclaredPremise>();
  const unique = [...new Set(ids)];
  if (unique.length === 0) return { covers, decls };
  const any = await tx.query<{ x: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM premise_edges WHERE target <> '*') AS x",
  );
  if (any.rows[0]?.x !== true) return { covers, decls };
  // Now: every cell not yet closed (no operation number reaches the end of the log).
  const at = o.at ?? Number.MAX_SAFE_INTEGER;
  const cells = await cellsOfRows(tx, t, unique, at);
  const of = await sourceItemsOfRows(tx, t, unique, at, o.decode);
  // By row, by item: the field and business time of each cell whose value the item gives.
  const byRow = new Map<
    string,
    Map<string, { field: FieldId; from: string | null; to: string | null }[]>
  >();
  for (const [id, list] of cells) {
    const byItem = new Map<string, { field: FieldId; from: string | null; to: string | null }[]>();
    for (const c of list) {
      // Step 1 is of the fields' values: existence has no 出处项, nor a stretch without a value
      // (its cell names the write-back that left it so, an item no premise covers as a value).
      if (c.field_id === "existence" || c.no_value === true) continue;
      for (const item of of(id, c.field_id as FieldId, c)) {
        const xs = byItem.get(item) ?? [];
        xs.push({ field: c.field_id as FieldId, from: c.vf, to: c.vt });
        byItem.set(item, xs);
      }
    }
    if (byItem.size > 0) byRow.set(id, byItem);
  }
  const items = [...new Set([...byRow.values()].flatMap((m) => [...m.keys()]))];
  if (items.length === 0) return { covers, decls };
  const r = await tx.query<{
    item: string;
    op: unknown;
    op_index: unknown;
    decl_index: unknown;
    target_table: string;
    target_row: string;
    fields: string | null;
    seen_op: unknown;
    seen_restore_count: unknown;
    state: "current" | "changed";
    reason: string | null;
    since: unknown;
    declarer: string;
  }>(
    `SELECT e.item_event::text || '/' || e.field_id || '/' || e.k::text AS item,
       d.op, d.op_index, d.decl_index, d.target_table, d.target_row, d.fields, d.seen_op,
       d.seen_restore_count, d.state, d.reason, d.since, d.declarer
     FROM premise_edges e
     JOIN premise_decls d
       ON d.op = e.decl_op AND d.op_index = e.decl_op_index AND d.decl_index = e.decl_index
     WHERE e.target <> '*'
       AND e.item_event::text || '/' || e.field_id || '/' || e.k::text = ANY($1)
       ${o.changed === true ? "AND d.state = 'changed'" : ""}
       AND NOT EXISTS (
         SELECT 1 FROM premise_edges c WHERE c.target = '*' AND c.item_event = e.item_event
           AND c.field_id = e.field_id AND c.k = e.k
           AND (c.decl_op, c.decl_op_index) > (e.decl_op, e.decl_op_index))`,
    [items] as never,
  );
  const declsOf = new Map<string, string[]>();
  for (const x of r.rows) {
    const key = declKey(x.op, x.op_index, x.decl_index);
    if (!decls.has(key))
      decls.set(key, {
        op: Number(x.op),
        opIndex: Number(x.op_index),
        index: Number(x.decl_index),
        targetTable: x.target_table as TableId,
        target: x.target_row,
        fields: x.fields === null ? null : (JSON.parse(x.fields) as FieldId[]),
        seen: { op: Number(x.seen_op), restoreCount: Number(x.seen_restore_count) },
        state: x.state,
        reason: x.reason,
        since: x.since === null ? null : Number(x.since),
        declarer: x.declarer,
      });
    declsOf.set(x.item, [...(declsOf.get(x.item) ?? []), key]);
  }
  for (const [id, byItem] of byRow) {
    const mine: PremiseCover[] = [];
    for (const [item, cs] of byItem)
      for (const key of declsOf.get(item) ?? []) for (const c of cs) mine.push({ decl: key, ...c });
    if (mine.length > 0) covers.set(id, mine);
  }
  return { covers, decls };
}
