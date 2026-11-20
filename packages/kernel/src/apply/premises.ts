// What apply keeps of write premises (docs/zh-CN/spec/09-event-format.md §5.7 前提块, §5.10
// `premise.changed`; 02-architecture §8 `premise_decls`, `premise_edges`): the declarations and their
// state, and for each 出处项 the declaration in force on it for each premise target. apply compares
// no values: whether a premise changed is decided once, online, and recorded in `premise.changed`.
//
// The cover (§5.7 «覆盖»): a declaration covers its op's own items, every item of the op's
// `write.base` on the target row (registered when that event is applied), and the items its op lists
// in `premise_covers`. For one item and one premise target the latest declaration covering it is in
// force: latest by (operation, op index), so an edge is written over only by a later one, whatever
// order the edges arrive in. A clearing (`premises_cleared`) writes an entry on the target `*` for
// each item it covers, ordered the same way; a declaration from before it on that item is void
// however the edge for its target reads (that comparison is the read's, P2 with the marks). Edges
// are only added and written over, never deleted.
//
// Not here, with deletion (P3): the indices a deletion's restatement numbers anew (covered with the
// item they split from), a range taken from content a deletion lists (the whole time line from then),
// and `repointed`.

import type { JsonValue, Seq } from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import {
  ApplyError,
  type Change,
  type PremiseDeclRow,
  type PremiseEdgeRow,
  type PremiseStateChange,
} from "./model.ts";

type Obj = Readonly<Record<string, JsonValue>>;

/** A declaration of the op a `write.base` belongs to, as `premise_decls` has it. */
export interface OpPremise {
  readonly decl_index: number;
  readonly target_row: string;
}

/**
 * An event `premise_covers` names, as the log has it: its operation, type, target row, the op of
 * its request it belongs to (a `write.base`'s `target.op_index`) and the paths of its blocks.
 */
export interface CoveredEvent {
  readonly op: Seq;
  readonly type: string;
  readonly row: string | null;
  readonly opIndex: number | null;
  readonly items: ReadonlySet<string>;
}

const PREMISE = /^ops\/(\d+)\/premises\/(\d+)$/;
const COVERS = /^ops\/(\d+)\/premise_covers$/;

/** An item reference of `premise_covers` as an edge's item: field ID or `existence`, and k. */
const itemOf = (r: Obj): { item_event: Seq; field_id: string; k: number } =>
  "existence" in r
    ? { item_event: r["event"] as Seq, field_id: "existence", k: r["existence"] as number }
    : { item_event: r["event"] as Seq, field_id: r["field"] as string, k: r["k"] as number };

/**
 * `write.head` (§5.7): each declaration into `premise_decls`; the items `premise_covers` lists,
 * covered by each declaration of the op, or by a clearing entry.
 */
export function planHeadPremises(
  seq: Seq,
  actor: string,
  present: Obj,
  covered: ReadonlyMap<Seq, CoveredEvent>,
): Change[] {
  const decls: PremiseDeclRow[] = [];
  const byOp = new Map<string, { j: number; target: string }[]>();
  for (const [path, v] of Object.entries(present)) {
    const m = PREMISE.exec(path);
    if (m === null) continue;
    const [i, j] = [Number(m[1]), Number(m[2])];
    const b = v as Obj;
    const op = present[`ops/${i}/target`] as Obj | undefined;
    if (op === undefined) throw new ApplyError("inconsistent", seq, `${path}: no ops/${i}/target`);
    const target = (b["row"] ?? b["entity"]) as string;
    const ver = b["ver"] as Obj;
    const valid = present[`ops/${i}/premise_valid/${j}`] as Obj | undefined;
    decls.push({
      op: seq,
      op_index: i,
      decl_index: j,
      dep_table: op["table"] as string,
      dep_row: (op["row"] ?? op["entity"]) as string,
      target_table: b["table"] as string,
      target_row: target,
      fields: b["fields"] === undefined ? null : canonicalize(b["fields"] as never),
      range_kind: b["range"] as string,
      // The business time, without the deps that say where it came from (§5.7).
      valid:
        valid === undefined
          ? null
          : canonicalize(
              ("at" in valid ? { at: valid["at"] } : { during: valid["during"] }) as never,
            ),
      seen_op: ver["op"] as Seq,
      seen_restore_count: ver["restore_count"] as number,
      state: b["state"] as "current" | "changed",
      reason: (b["reason"] as string | undefined) ?? null,
      since: (b["since"] as Seq | undefined) ?? null,
      declarer: actor,
    });
    const list = byOp.get(String(i)) ?? [];
    list.push({ j, target });
    byOp.set(String(i), list);
  }
  const edges: PremiseEdgeRow[] = [];
  for (const [path, v] of Object.entries(present)) {
    const m = COVERS.exec(path);
    if (m === null) continue;
    const i = Number(m[1]);
    const clears = present[`ops/${i}/premises_cleared`] === true;
    const target = present[`ops/${i}/target`] as Obj | undefined;
    const row = (target?.["row"] ?? target?.["entity"]) as string | undefined;
    for (const r of v as readonly Obj[]) {
      const item = itemOf(r);
      // The item is there, on this op's target row, and not after this op: of an earlier
      // operation, or of an op before it in this request (§5.7 «覆盖»: what the row had at the
      // version seen and still has). apply compares no values, but writes no edge to an item the
      // op cannot cover.
      const e = covered.get(item.item_event);
      const where = `${path}: item ${item.item_event}/${item.field_id}/${item.k}`;
      const at =
        item.field_id === "existence" ? `existence/${item.k}` : `fields/${item.field_id}/${item.k}`;
      if (e === undefined || e.type !== "write.base" || !e.items.has(at))
        throw new ApplyError("inconsistent", seq, `${where} is not an item in the log`);
      if (e.row !== row)
        throw new ApplyError("inconsistent", seq, `${where} is not on the op's target row`);
      if (e.op > seq || (e.op === seq && (e.opIndex === null || e.opIndex >= i)))
        throw new ApplyError("inconsistent", seq, `${where} is not before the op`);
      if (clears)
        edges.push({ ...item, target: "*", decl_op: seq, decl_op_index: i, decl_index: null });
      else
        for (const d of byOp.get(String(i)) ?? [])
          edges.push({
            ...item,
            target: d.target,
            decl_op: seq,
            decl_op_index: i,
            decl_index: d.j,
          });
    }
  }
  return [
    ...(decls.length > 0 ? [{ kind: "premise_decls" as const, rows: decls }] : []),
    ...(edges.length > 0 ? [{ kind: "premise_edges" as const, rows: edges }] : []),
  ];
}

/**
 * `write.base` (§5.12 the premise row): every item of the event, whatever became of it, is covered
 * by each declaration of its op. `decls` are the op's (`target.op_index`), read from `premise_decls`.
 */
export function planBasePremises(
  seq: Seq,
  op: Seq,
  present: Obj,
  decls: readonly OpPremise[],
): Change[] {
  if (decls.length === 0) return [];
  const i = (present["target"] as Obj)["op_index"] as number;
  const edges: PremiseEdgeRow[] = [];
  for (const path of Object.keys(present)) {
    const f = /^fields\/(f\d+)\/(\d+)$/.exec(path);
    const e = /^existence\/(\d+)$/.exec(path);
    const item =
      f !== null
        ? { field_id: f[1] as string, k: Number(f[2]) }
        : e !== null
          ? { field_id: "existence", k: Number(e[1]) }
          : undefined;
    if (item === undefined) continue;
    for (const d of decls)
      edges.push({
        item_event: seq,
        ...item,
        target: d.target_row,
        decl_op: op,
        decl_op_index: i,
        decl_index: d.decl_index,
      });
  }
  return edges.length > 0 ? [{ kind: "premise_edges", rows: edges }] : [];
}

/** `premise.changed` (§5.10): each declaration's state, reason and `since` as recorded. */
export function planPremiseChanged(seq: Seq, op: Seq, present: Obj): Change[] {
  const rows: PremiseStateChange[] = [];
  for (const [path, v] of Object.entries(present)) {
    if (!/^targets\/\d+$/.test(path)) continue;
    const t = v as Obj;
    if (t["repointed"] !== undefined)
      throw new ApplyError("not_implemented", seq, `${path}: repointed comes with deletion`);
    for (const d of (t["changed"] ?? []) as readonly Obj[])
      rows.push({
        op: d["op"] as Seq,
        op_index: d["i"] as number,
        decl_index: d["j"] as number,
        state: "changed",
        reason: d["reason"] as string,
        since: op,
      });
    for (const d of (t["matched"] ?? []) as readonly Obj[])
      rows.push({
        op: d["op"] as Seq,
        op_index: d["i"] as number,
        decl_index: d["j"] as number,
        state: "current",
        reason: null,
        since: null,
      });
  }
  return [{ kind: "premise_state", rows }];
}
