// Writing a ref field: the target as the write finds it (03-data-model/04-write-and-read.md
// «引用字段», «写入 ref 字段时»; «判定顺序» step 5, the checks on the current state).
//
// Only what the operation gives and takes effect is checked: every applied item giving a ref field
// a value, written directly or written back by a revert (`undo`, `take_previous`, a confirmed undo),
// so that no write makes a reference to a target already gone: a dangling reference only comes of
// a target revoked or deleted later. A corroboration or a no-op restates a value already there; a
// write-back with no content or of "no value" gives none; a candidate or an awaiting write does not
// take effect now, and is checked when a decision takes it (`take_candidate`, `confirm`).
//
// The target must be visible and exist (`ref_not_found` otherwise, the same answer for both), be a
// row or entity of the table the field names (`ref_wrong_table`, only for a visible target), and be
// there now: an event or timeless row not revoked, a state table's entity with a value over some
// stretch of business time (`ref_not_found` otherwise). "Now" is before this op: the ops before it
// in the request count. A target in a confirmed deletion is not checked in this version: deletion
// comes later.

import type {
  CompiledBaseTable,
  CompiledTable,
  EntityId,
  FieldId,
  RowId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import {
  type Limit,
  type OpRecord,
  type RecordedItem,
  type RowState,
  stateFromRecord,
} from "../judge/index.ts";
import { qualifiedTable, type WriteValidationDetail } from "../request/index.ts";
import type { Tx } from "../store/ports.ts";
import { restoreHistory } from "../store/restore-point.ts";
import { tableShape } from "./plan.ts";
import { rowEvents, rowTable } from "./reads.ts";
import { decodeRecords } from "./record.ts";

/** A row or entity this request has worked on so far: its table and state. */
export interface KnownRow {
  readonly table: TableId;
  readonly state: RowState;
}

export interface RefCheck {
  /** The op's index; none for a decision's write (`resolve`), whose request has no ops. */
  readonly index?: number;
  /** The slot's name and the table written, as the details name them. */
  readonly slot: string;
  readonly table: CompiledBaseTable;
  /** The slot's base tables, by ID. */
  readonly tableOf: (id: TableId) => CompiledBaseTable | undefined;
  /** What the judgement records: the items it gives. */
  readonly items: readonly RecordedItem[];
  /** The rows and entities the request has worked on, before this op. */
  readonly known: (id: string) => KnownRow | undefined;
  /** Whether the caller can see a table. */
  readonly visible: (table: TableId) => boolean;
  /** What this request has read from the store of the targets it has not worked on: read once. */
  readonly stored: StoredTargets;
  /** Before this op. */
  readonly at: Limit;
}

type Problem = "ref_not_found" | "ref_wrong_table";

/** A target as stored: its table (none: no such row or entity) and its state. */
type StoredTarget = { readonly table?: TableId; readonly state?: RowState };
export type StoredTargets = Map<string, Promise<StoredTarget>>;

/** Whether the caller can see a table: the tables in range of the visible slots, as reads take them. */
export const tableInRange =
  (slots: readonly { readonly tables: readonly CompiledTable[] }[]) =>
  (table: TableId): boolean =>
    slots.some((s) => s.tables.some((t) => t.id === table));

/**
 * The items a judgement records: a write's, a taken candidate's, a confirmed write's, and the
 * write-backs of a revert, a return to the merge base, a confirmed undo. A reject, keep_effective
 * record none; a revoke's give no value.
 */
export function givenItems(r: OpRecord): readonly RecordedItem[] {
  return "items" in r ? r.items : [];
}

/** The ref fields whose targets fail, one detail per field (in the table's order of fields). */
export async function refProblems(tx: Tx, c: RefCheck): Promise<WriteValidationDetail[]> {
  const out: WriteValidationDetail[] = [];
  for (const f of c.table.fields) {
    if (f.type !== "ref") continue;
    // Every value the operation gives the field: one in a write, but a revert on a state table
    // can write back a different earlier value on each stretch. Each distinct value is checked;
    // the first that fails gives the field its detail.
    const values = new Set<string>();
    for (const x of c.items) {
      if (x.status !== "applied" || x.target !== (f.id as FieldId)) continue;
      if (x.content.kind === "value" && typeof x.content.value === "string") {
        values.add(x.content.value);
      }
    }
    let problem: Problem | undefined;
    for (const id of values) {
      problem = await targetProblem(tx, c, id, f.ref.table);
      if (problem !== undefined) break;
    }
    if (problem === undefined) continue;
    out.push({
      ...(c.index !== undefined ? { op: c.index } : {}),
      table: qualifiedTable(c.slot, c.table),
      field: f.name,
      code: problem,
    });
  }
  return out;
}

async function targetProblem(
  tx: Tx,
  c: RefCheck,
  id: string,
  named: TableId,
): Promise<Problem | undefined> {
  const known = c.known(id);
  const stored = known === undefined ? await storedTarget(tx, c, id) : undefined;
  const table = known?.table ?? stored?.table;
  // Not visible is answered as not there (04-contract «不存在与不可见报同一个错误»): a target in a
  // table out of range, as one that does not exist.
  if (table === undefined || !c.visible(table)) return "ref_not_found";
  if (table !== named) return "ref_wrong_table";
  const state = known?.state ?? stored?.state;
  if (state === undefined) return "ref_not_found";
  if (state.isState) {
    // An entity with no value over any stretch is not there (05-time «无值区间»).
    return state.pieces().some((p) => state.hasValue(p, c.at)) ? undefined : "ref_not_found";
  }
  return state.revoked(c.at) ? "ref_not_found" : undefined;
}

/** A target as stored, read once per request. */
function storedTarget(tx: Tx, c: RefCheck, id: string): Promise<StoredTarget> {
  let hit = c.stored.get(id);
  if (hit === undefined) {
    hit = readTarget(tx, c, id);
    c.stored.set(id, hit);
  }
  return hit;
}

async function readTarget(tx: Tx, c: RefCheck, id: string): Promise<StoredTarget> {
  const table = (await rowTable(tx, id)) as TableId | undefined;
  if (table === undefined) return {};
  const t = c.tableOf(table);
  // Another slot's table: its state is not needed (the target is in another table than named).
  if (t === undefined) return { table };
  const shape = tableShape(t);
  const isState = shape.kind === "state";
  const ctx = {
    table,
    target: isState ? { entity: id as EntityId } : { row: id as RowId },
    shape,
    granularity: isState && t.time.type === "state" ? t.time.granularity : "date",
    restores: await restoreHistory(tx),
  } as const;
  return {
    table,
    state: stateFromRecord(shape, decodeRecords(ctx, await rowEvents(tx, table, id))),
  };
}
