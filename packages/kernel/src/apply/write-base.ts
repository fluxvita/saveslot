// apply of `write.base` (docs/zh-CN/spec/09-event-format.md §5.7, the `apply` table; §5.12):
// the source table, the "reverted" registrations, the first creation, then the row or entity
// settled from all its items: the business table's current version, the version table's cells,
// the row count.
//
// The plan is pure. The recording side reads what it needs (`WriteBaseInput`): the table's
// compiled definition, the row's items already in the source table with their content (read from
// their blocks, not from the version table: an item covered within its own operation never had a
// cell, a later revert can expose it, and a deletion clears blocks), the row's open version cells
// and its row count.
//
// Only the items a write puts into effect (applied, corroborated) enter the source table and the
// settling; candidates and awaiting items change neither the business nor the version table. A
// revert registers only when its write takes effect (not while awaiting confirmation).

import {
  type CompiledBaseTable,
  canonicalize,
  type FieldId,
  type FieldValue,
  type JsonValue,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import type { SqlValue } from "../store/ports.ts";
import { type Interval, type IntervalSet, interval, WHOLE } from "../time/index.ts";
import { ApplyError, type Change } from "./model.ts";
import {
  type Cell,
  type ItemKey,
  type Registration,
  registrations,
  type SettleContent,
  type SettleItem,
  type SettleTable,
  settle,
} from "./settle.ts";

type Obj = Readonly<Record<string, JsonValue>>;

/** An open cell of the row's version table (`rec_to` empty), as stored. */
export interface OpenCell {
  readonly field: string;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly src: ItemKey | null;
  /** The cell says the entity has no value there (a state table's field cell). */
  readonly no_value: boolean;
  readonly rec_from: Seq;
}

/** What the plan of a `write.base` reads, read by the caller. */
export interface WriteBaseInput {
  readonly table: CompiledBaseTable;
  /** The row's items in the source table, with their content, in log order. */
  readonly items: readonly SettleItem[];
  readonly openCells: readonly OpenCell[];
  /** The row's logical rows counted now (not revoked; a state table's segments). */
  readonly count: number;
  /** The slot's current schema version, the one `table` is of. */
  readonly sv: number;
  /** The table the row or entity was created in (`row_origins`), if it was. */
  readonly rowTable: string | null;
}

/** What settle needs of a compiled base table. */
export function settleTable(t: CompiledBaseTable): SettleTable {
  return {
    kind: t.time.type === "state" ? "state" : t.time.type === "event" ? "event" : "timeless",
    fields: t.fields.map((f) => f.id),
    required: t.fields.filter((f) => f.required === true).map((f) => f.id),
  };
}

const spanOf = (v: JsonValue): IntervalSet => {
  const s = v as Obj;
  const x = (s["valid"] ?? s["seen_valid"]) as Obj | undefined;
  if (x === undefined) return [WHOLE];
  // A missing end is open, the start too (09 §5.7: a write-back taking back a whole revoke).
  return interval((x["from"] as never) ?? null, (x["to"] as never) ?? null);
};

/** Stops apply: the event does not fit the state it is applied to. */
const inconsistent = (seq: Seq, message: string) => new ApplyError("inconsistent", seq, message);

/**
 * The items this event puts into effect, from its blocks. Checks what is cheap to check here
 * (each stops apply as inconsistent): a field the table does not have; on a state table, an item
 * without its interval block; on an event or timeless table, an interval block or an interval
 * revoke.
 */
function itemsOf(seq: Seq, present: Obj, shape: SettleTable): SettleItem[] {
  const isState = shape.kind === "state";
  const items: SettleItem[] = [];
  const fields = new Set<string>(shape.fields);
  for (const path of Object.keys(present).sort()) {
    const sp = /^span\/(f\d+|existence)\/(\d+)$/.exec(path);
    if (sp !== null && !isState) throw inconsistent(seq, `${path} on a table without time`);
    const f = /^fields\/(f\d+)\/(\d+)$/.exec(path);
    const e = /^existence\/(\d+)$/.exec(path);
    if (f === null && e === null) continue;
    if (f !== null && !fields.has(f[1] as string)) {
      throw inconsistent(seq, `${path}: the table has no field ${f[1]}`);
    }
    const b = present[path] as Obj;
    if (e !== null && b["scope"] === "interval" && !isState) {
      throw inconsistent(seq, `${path}: an interval revoke on a table without time`);
    }
    const status = b["status"] as string;
    if (status !== "applied" && status !== "corroborated") continue;
    const span = (target: string, k: string): IntervalSet => {
      if (!isState) return [WHOLE];
      const v = present[`span/${target}/${k}`];
      if (v === undefined) throw inconsistent(seq, `${path} has no span/${target}/${k}`);
      return spanOf(v);
    };
    if (status === "corroborated" && isState) {
      // Its explicit endpoints (`corroboration_ends`, 02-architecture §8) come from the head
      // event's interval; no write produces a corroboration in this phase.
      throw new ApplyError(
        "not_implemented",
        seq,
        `${path}: corroborations on a state table are not applied yet`,
      );
    }
    if (f !== null) {
      const content: SettleContent =
        "value" in b
          ? { kind: "value", value: b["value"] as FieldValue }
          : "no_value" in b
            ? { kind: "no_value" }
            : { kind: "uncovered" };
      items.push({
        event: seq,
        target: f[1] as FieldId,
        k: Number(f[2]),
        status,
        valid: span(f[1] as string, f[2] as string),
        content,
        reverted: [],
      });
    } else if (e !== null) {
      items.push({
        event: seq,
        target: "existence",
        k: Number(e[1]),
        status: "applied",
        valid: b["scope"] === "interval" ? span("existence", e[1] as string) : [WHOLE],
        content: b["restored"] === true ? { kind: "restore" } : { kind: "revoke" },
        reverted: [],
      });
    }
  }
  return items;
}

const sameKey = (a: ItemKey, b: ItemKey) =>
  a.event === b.event && a.target === b.target && a.k === b.k;

const ends = (v: IntervalSet): { from: string | null; to: string | null } => {
  const x = v[0] ?? WHOLE;
  return { from: x.from, to: x.to };
};

const regsJson = (rs: readonly Registration[]) =>
  canonicalize(
    rs.map((r) => ({
      op: r.op,
      valid: r.valid.map((x) => ({ from: x.from, to: x.to })),
    })) as JsonValue,
  );

/** The source table rows of a new item: one per source; one without a source otherwise. */
function sourceRows(seq: Seq, rowId: string, x: SettleItem, present: Obj): SqlValue[][] {
  const status = x.status;
  const { from, to } = ends(x.valid);
  const common = (
    n: number,
    kind: string,
    src: SqlValue,
    carried: SqlValue[],
    sv: SqlValue,
  ): SqlValue[] => [
    seq,
    rowId,
    x.target,
    x.k,
    n,
    kind,
    src,
    ...carried,
    sv,
    status,
    from,
    to,
    status === "corroborated",
    "[]",
  ];
  const sources = (x.target === "existence" ? undefined : present[`sources/${x.target}/${x.k}`]) as
    | Obj[]
    | undefined;
  if (sources === undefined) {
    // An item with no value has no value source; the operation's sources stand for it.
    const ops = (present["op_sources"] as Seq[] | undefined) ?? [];
    if (ops.length === 0) return [common(0, "operation", null, [null, null, null], null)];
    return ops.map((s, n) => common(n, "operation", s, [null, null, null], null));
  }
  return sources.map((s, n) => {
    if (s["kind"] === "schema_const")
      return common(n, "schema_const", null, [null, null, null], s["sv"] as number);
    const c = s["carried"] as Obj | undefined;
    if (c !== undefined)
      return common(
        n,
        "value",
        null,
        [c["event"] as Seq, c["field"] as string, c["k"] as number],
        null,
      );
    return common(n, "value", s["source"] as Seq, [null, null, null], null);
  });
}

const BASE_SOURCE_COLUMNS = [
  "event_seq",
  "row_id",
  "field_id",
  "k",
  "n",
  "source_kind",
  "source_seq",
  "carried_event",
  "carried_field",
  "carried_k",
  "schema_const_sv",
  "status",
  "valid_from",
  "valid_to",
  "corroborated",
  "reverted",
];

/** A field value as the columns of its field take it (02-architecture §8 业务表). */
function columnValues(t: CompiledBaseTable, f: FieldId, v: FieldValue): SqlValue[] {
  const def = t.fields.find((x) => x.id === f);
  const zoned = def?.type === "zoned_datetime";
  if (v === null) return zoned ? [null, null] : [null];
  if (typeof v === "object" && "instant" in v) return [v.instant, v.zone];
  if (typeof v === "object" && "value" in v) return [v.value];
  return [v as string | boolean];
}

function fieldColumns(t: CompiledBaseTable): string[] {
  return t.fields.flatMap((f) =>
    f.type === "zoned_datetime" ? [`f_${f.id}`, `f_${f.id}__zone`] : [`f_${f.id}`],
  );
}

/** A cell's identity: what it covers, who gave it, and whether it says the entity has no value. */
const cellKey = (
  field: string,
  from: string | null,
  to: string | null,
  src: ItemKey | null,
  noValue: boolean,
) =>
  JSON.stringify([field, from, to, src === null ? null : [src.event, src.target, src.k], noValue]);

export function planWriteBase(seq: Seq, op: Seq, present: Obj, input: WriteBaseInput): Change[] {
  const target = present["target"] as Obj;
  const t = input.table;
  const shape = settleTable(t);
  const isState = shape.kind === "state";
  // The target must be this table's row or entity (cheap checks; each stops apply).
  if (target["sv"] !== input.sv) {
    throw inconsistent(
      seq,
      `target.sv ${String(target["sv"])} is not the current version ${input.sv}`,
    );
  }
  if (
    isState ? "row" in target || !("entity" in target) : "entity" in target || !("row" in target)
  ) {
    throw inconsistent(seq, `a ${shape.kind} table's target is ${isState ? "an entity" : "a row"}`);
  }
  const rowId = (target["row"] ?? target["entity"]) as string;
  if (input.rowTable !== null && input.rowTable !== t.id) {
    throw inconsistent(seq, `${rowId} is a row of ${input.rowTable}, not of ${t.id}`);
  }
  const mine = itemsOf(seq, present, shape);
  const changes: Change[] = [];

  // The registrations of a revert in effect (09 §5.7 `revert`): only read from its blocks.
  let items = [...input.items];
  const revert = present["revert"] as Obj | undefined;
  // Only a revert in effect registers: one awaiting confirmation has its write-backs awaiting,
  // none of them in effect, so the union of the write-backs is empty and nothing is registered.
  if (revert !== undefined) {
    const entries = revert["items"] as {
      event: Seq;
      field?: string;
      existence?: true;
      later?: true;
    }[];
    const regs = registrations(
      items,
      entries.map((e) => ({
        event: e.event,
        target: e.field ?? "existence",
        ...(e.later ? { later: true as const } : {}),
      })),
      mine,
    );
    items = items.map((x) => {
      const r = regs.find((y) => sameKey(y.item, x));
      return r === undefined ? x : { ...x, reverted: [...x.reverted, { op, valid: r.valid }] };
    });
    for (const r of regs) {
      const x = items.find((y) => sameKey(y, r.item)) as SettleItem;
      changes.push({
        kind: "base_sources_reverted",
        row_id: rowId,
        event: x.event,
        field: x.target,
        k: x.k,
        reverted: regsJson(x.reverted),
      });
    }
  }

  // The source table: this event's items in effect.
  if (mine.length > 0) {
    changes.push({
      kind: "rows_insert",
      table: "base_sources",
      columns: BASE_SOURCE_COLUMNS,
      rows: mine.flatMap((x) => sourceRows(seq, rowId, x, present)),
    });
  }
  // The first creation (09 §5.7 `target.created`): the latest one given wins.
  if (target["created"] === true) {
    changes.push({ kind: "row_origin", row_id: rowId, table_id: t.id, seq });
  }

  // The row settled from all its items.
  const settled = settle(shape, [...items, ...mine]);
  const physical = t.physical.table;
  const key = isState ? "entity_id" : "row_id";
  const cols = fieldColumns(t);
  changes.push({
    kind: "rows_replace",
    table: physical,
    key,
    id: rowId,
    columns: isState
      ? ["entity_id", "valid_from", "valid_to", ...cols]
      : ["row_id", "revoked", ...cols],
    rows: settled.rows.map((r) => [
      rowId,
      ...(isState ? [r.valid?.from ?? null, r.valid?.to ?? null] : [r.revoked]),
      ...shape.fields.flatMap((f) => columnValues(t, f, r.values[f] ?? null)),
    ]),
  });

  // Version cells (02-architecture §8 版本表): an open cell no longer current is closed at this
  // operation, or dropped when this operation opened it (a later op of one operation overwrites);
  // a current cell not open yet is opened at this operation.
  const now = new Map(
    settled.cells.map((c) => [
      cellKey(c.field, c.valid?.from ?? null, c.valid?.to ?? null, c.by, c.noValue === true),
      c,
    ]),
  );
  const open = new Map(
    input.openCells.map((c) => [cellKey(c.field, c.valid_from, c.valid_to, c.src, c.no_value), c]),
  );
  const close = [...open].filter(([k]) => !now.has(k)).map(([, c]) => c);
  const added = [...now].filter(([k]) => !open.has(k)).map(([, c]) => c);
  const intent = target["intent"] as string;
  changes.push({
    kind: "cells",
    table: `${physical}__ver`,
    row_id: rowId,
    state: isState,
    op,
    close: close.map((c) => ({ field: c.field, valid_from: c.valid_from, rec_from: c.rec_from })),
    columns: [
      "row_id",
      "field_id",
      ...(isState ? ["valid_from", "valid_to"] : []),
      "rec_from",
      "intent",
      "src_event",
      "src_field",
      "src_k",
      "revoked",
      "no_value",
      ...cols,
    ],
    rows: added.map((c: Cell) => [
      rowId,
      c.field,
      ...(isState ? [c.valid?.from ?? null, c.valid?.to ?? null] : []),
      op,
      intent,
      c.by?.event ?? null,
      c.by?.target ?? null,
      c.by?.k ?? null,
      c.revoked === true ? true : null,
      c.noValue === true ? true : null,
      ...shape.fields.flatMap((f) =>
        f === c.field ? columnValues(t, f, c.value) : columnValues(t, f, null),
      ),
    ]),
  });

  const count = isState ? settled.rows.length : settled.rows.filter((r) => !r.revoked).length;
  if (count !== input.count)
    changes.push({ kind: "counts_add", table_id: t.id, delta: count - input.count });
  return changes;
}

/** The interval columns of a stored item, read back. */
export const storedValid = (from: string | null, to: string | null): IntervalSet =>
  from === null && to === null ? [WHOLE] : [{ from, to } as Interval];
