// The rows a query selects, from the business table of the current version (02-architecture §8:
// `t_<table>_v<n>`; 03-data-model/05-time.md «查询»), and what each needs beside its values: its
// `ver` and the operation that revoked it, from the version table; whether it was ever corrected;
// the flags of open pending items on it.
//
// Every value from the caller goes in as a parameter. Table and column names are built only from
// the kernel's own IDs (`t…`, `f…`), checked by their shape before use.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  FieldValue,
  ItemId,
} from "@fluxvita/saveslot-contract-core";
import { anyPremise, type PremisesOn, premisesOn } from "../delta/index.ts";
import { actorsNow } from "../pending/index.ts";
import { decodeColumns as decode } from "../request/index.ts";
import { column, INSTANT_TEXT, physical, selectOf } from "../store/layout.ts";
import type { ReadTx } from "../store/ports.ts";
import { containsPoint, pointWithin } from "../time/index.ts";
import type { Condition, Literal, QueryPlan } from "./params.ts";
import { type Actor, ReadError } from "./types.ts";

/** A selected row: a row of an event or timeless table, or a segment of a state table's entity. */
export interface SelectedRow {
  /** Row or entity ID. */
  readonly id: string;
  readonly validFrom?: string;
  readonly validTo?: string | null;
  readonly revoked: boolean;
  /** Every field's value, by field ID. */
  readonly values: Readonly<Record<string, FieldValue>>;
}

export interface RowFacts {
  /** The latest operation that changed the row or entity (not a schema switch). */
  readonly ver: ReadonlyMap<string, number>;
  /** The operation whose revoke is in effect (event and timeless tables). */
  readonly revokedBy: ReadonlyMap<string, number>;
  /** Event and timeless rows ever corrected. */
  readonly corrected: ReadonlySet<string>;
  /** State entities: where a field's value in effect comes from a correction. */
  readonly correctSpans: ReadonlyMap<
    string,
    readonly { field: string; from: string; to: string | null }[]
  >;
  readonly flags: ReadonlyMap<string, readonly Flag[]>;
  /** The changed premises the rows' values rest on (`premiseFacts`); absent: none asked for. */
  readonly premises?: PremiseFacts;
}

/** The changed premises of rows, and their declarers by ID as named now. */
export interface PremiseFacts extends PremisesOn {
  readonly actors: ReadonlyMap<string, Actor>;
}

/**
 * The changed premises the values of rows `ids` rest on (02-integrity «标记出现在哪一行»), on the
 * cells in effect at operation `at` (a later page's position) or now; the declarations' state is
 * always the one now.
 */
export async function premiseFacts(
  tx: ReadTx,
  t: CompiledBaseTable,
  ids: readonly string[],
  at?: number,
): Promise<PremiseFacts> {
  const p = await premisesOn(tx, t, ids, {
    decode,
    changed: true,
    ...(at !== undefined ? { at } : {}),
  });
  const actors = await actorsNow(
    tx,
    [...p.decls.values()].map((d) => d.declarer),
  );
  return { ...p, actors };
}

/**
 * The rows of table `t` (among `ids`; none given: all its rows not revoked, as a read of the whole
 * table reads them) whose values now rest on a changed premise, with what each changed declaration
 * covers there (02-integrity «标记出现在哪一行»): the same reading as a row's marks
 * (`premiseFacts`), for the counts of derived rows and of `sql` (04-contract §7). The candidates
 * are the rows the changed declarations were made on (`premise_decls.dep_row`): a declaration
 * covers only items of its own row (its write's, and the row's own in effect at the version it
 * saw; a taken candidate and a write-back stay on the row). A fixed number of statements, whatever
 * the number of rows; one when the tenant has no declaration at all.
 */
export async function changedPremiseCovers(
  tx: ReadTx,
  t: CompiledBaseTable,
  ids?: readonly string[],
): Promise<PremisesOn["covers"]> {
  // No declaration in the tenant (the usual case): one statement that stops at the first edge.
  if (ids?.length === 0 || !(await anyPremise(tx))) return new Map();
  // `state = 'changed'` only narrows the candidates (premisesOn keeps changed ones only): dropping
  // it is an equivalent mutation. Not `SELECT DISTINCT`: the sql tests take those for the
  // statements recording what a caller's statement read.
  const r = await tx.query<{ dep_row: string }>(
    `SELECT dep_row FROM premise_decls WHERE dep_table = $1 AND state = 'changed'
       ${ids !== undefined ? "AND dep_row = ANY($2)" : ""} GROUP BY dep_row`,
    (ids !== undefined ? [t.id, [...ids]] : [t.id]) as never,
  );
  let rows = r.rows.map((x) => x.dep_row);
  if (ids === undefined && rows.length > 0) {
    // A revoked row is not read: a state table has no segment of it, the others mark it.
    const { business } = physical(t);
    const live = await tx.query<{ id: string }>(
      t.time.type === "state"
        ? `SELECT entity_id AS id FROM ${business} WHERE entity_id = ANY($1) GROUP BY entity_id`
        : `SELECT row_id AS id FROM ${business} WHERE row_id = ANY($1) AND NOT revoked`,
      [rows] as never,
    );
    rows = live.rows.map((x) => x.id);
  }
  if (rows.length === 0) return new Map();
  return (await premisesOn(tx, t, rows, { decode, changed: true, checked: true })).covers;
}

/** A business time span `[from, to)`; `to` null: it runs on. */
/** A flag's span: `from` null where the item's first span is open at the start (09 §5.8). */
export interface Span {
  readonly from: string | null;
  readonly to: string | null;
}

export interface Flag {
  readonly flag: "disputed" | "awaiting" | "flagged";
  readonly item: ItemId;
  readonly itemType: string | null;
  /** The conflict unit: field IDs, `["existence"]` for the row or segment existing. */
  readonly fields: readonly string[];
  /** State tables: the spans the flag covers. Event and timeless tables: undefined. */
  readonly spans: readonly Span[] | undefined;
}

// A field's columns decoded (../request `decodeColumns`): the same for reads and receipts.
// The physical layout lives with the store (../store/layout.ts); reads use it from here too.
export { column, decode, INSTANT_TEXT, physical, selectOf };

export class Params {
  readonly list: (string | number | boolean | null)[] = [];
  add(v: string | number | boolean | null, cast = ""): string {
    this.list.push(v);
    return `$${this.list.length}${cast}`;
  }
}

/** The SQL type a point of the table's business time is cast to. */
const pointCast = (plan: QueryPlan): string =>
  plan.table.time.type === "state"
    ? plan.table.time.granularity === "date"
      ? "::date"
      : "::timestamptz"
    : "";

/** A comparison of a column with a literal; numbers exactly: `column × den op num`. */
function compareSql(col: string, type: string, op: string, lit: Literal, p: Params): string {
  const sqlOp = op === "!=" ? "IS DISTINCT FROM" : op;
  switch (lit.kind) {
    case "number":
      return `(${col} * ${p.add(lit.value.den.toString(), "::numeric")} ${sqlOp} ${p.add(
        lit.value.num.toString(),
        "::numeric",
      )})`;
    case "boolean":
      return `(${col} ${sqlOp} ${p.add(lit.value, "::boolean")})`;
    case "instant":
      return `(${col} ${sqlOp} ${p.add(lit.value, "::timestamptz")})`;
    default: {
      const cast = type === "date" ? "::date" : ' COLLATE "C"';
      return `(${col} ${sqlOp} ${p.add(lit.value)}${cast})`;
    }
  }
}

/** A condition on a field (those on valid_from / valid_to apply after merging: ./rows.ts). */
export function conditionSql(c: Condition, p: Params): string {
  if (typeof c.column === "string") throw new ReadError("internal", "an interval condition in SQL");
  const col = column(c.column);
  const type = c.column.type;
  switch (c.op) {
    case "is_null":
      return `(${col} IS ${c.isNull ? "" : "NOT "}NULL)`;
    case "in":
      return `(${c.values.map((v) => compareSql(col, type, "=", v, p)).join(" OR ")})`;
    case "contains":
      return `(strpos(${col}, ${p.add((c.value as { value: string }).value)}) > 0)`;
    default:
      return compareSql(col, type, c.op, c.value, p);
  }
}

/** The rows the plan selects, every field's value with each. */
export async function selectRows(tx: ReadTx, plan: QueryPlan): Promise<SelectedRow[]> {
  const t = plan.table;
  const { business } = physical(t);
  const p = new Params();
  const where: string[] = [];
  const state = plan.kind === "state";
  const cast = pointCast(plan);
  if (state) {
    // Over an interval every segment is selected: merging comes before the interval (./rows.ts).
    if (plan.time.kind !== "during")
      where.push(containsPoint("valid_from", "valid_to", p.add(plan.time.point, cast)));
  } else {
    if (!plan.includeRevoked) where.push("NOT revoked");
    if (plan.kind === "event" && plan.time.kind === "during" && t.time.type === "event") {
      const timeId = t.time.field;
      const f = t.fields.find((x) => x.id === timeId) as CompiledBaseField;
      const c = f.type === "date" ? "::date" : "::timestamptz";
      where.push(
        pointWithin(
          column(f),
          p.add(plan.time.from, c),
          plan.time.to === null ? null : p.add(plan.time.to, c),
        ),
      );
    }
  }
  // Conditions on the fields here; those on valid_from / valid_to apply after merging (./rows.ts).
  for (const c of plan.where) if (typeof c.column !== "string") where.push(conditionSql(c, p));
  const cols = [
    state ? "entity_id AS id" : "row_id AS id",
    ...(state
      ? t.time.type === "state" && t.time.granularity === "date"
        ? ["valid_from::text AS vf", "valid_to::text AS vt"]
        : [`to_char(valid_from, ${INSTANT_TEXT}) AS vf`, `to_char(valid_to, ${INSTANT_TEXT}) AS vt`]
      : ["revoked"]),
    ...t.fields.flatMap((f) => selectOf(f).map((s, i) => `${s} AS c_${f.id}_${i}`)),
  ];
  const r = await tx.query<Record<string, unknown>>(
    `SELECT ${cols.join(", ")} FROM ${business}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}`,
    p.list,
  );
  return r.rows.map((x) => {
    const values: Record<string, FieldValue> = Object.create(null);
    for (const f of t.fields) {
      const n = selectOf(f).length;
      values[f.id] = decode(
        f,
        Array.from({ length: n }, (_, i) => x[`c_${f.id}_${i}`]),
      );
    }
    return {
      id: String(x["id"]),
      ...(state
        ? { validFrom: String(x["vf"]), validTo: x["vt"] === null ? null : String(x["vt"]) }
        : {}),
      revoked: x["revoked"] === true,
      values,
    };
  });
}

/** `ver`, the revoke in effect, `corrected` and the open items' flags of the given rows. */
export async function rowFacts(
  tx: ReadTx,
  t: CompiledBaseTable,
  ids: readonly string[],
): Promise<RowFacts> {
  const { versions } = physical(t);
  const unique = [...new Set(ids)];
  const ver = new Map<string, number>();
  const revokedBy = new Map<string, number>();
  const corrected = new Set<string>();
  const flags = new Map<string, Flag[]>();
  if (unique.length === 0) return { ver, revokedBy, corrected, correctSpans: new Map(), flags };
  const vr = await tx.query<{ id: string; v: unknown; c: boolean }>(
    `SELECT row_id AS id, max(rec_from) AS v, bool_or(intent = 'correct') AS c FROM ${versions}
     WHERE row_id = ANY($1) AND intent <> 'schema_switch' GROUP BY row_id`,
    [unique] as never,
  );
  for (const x of vr.rows) {
    ver.set(x.id, Number(x.v));
    if (x.c === true) corrected.add(x.id);
  }
  if (t.time.type !== "state") {
    const rv = await tx.query<{ id: string; v: unknown }>(
      // The revoke's own operation (its contribution's), not when the cell was last cut.
      `SELECT v.row_id AS id, max((SELECT e.op FROM events e WHERE e.seq = v.src_event)) AS v
       FROM ${versions} v
       WHERE v.row_id = ANY($1) AND v.field_id = 'existence' AND v.revoked AND v.rec_to IS NULL
       GROUP BY v.row_id`,
      [unique] as never,
    );
    for (const x of rv.rows) revokedBy.set(x.id, Number(x.v));
  }
  for (const [row, list] of await readFlagsOf(tx, t.id, unique)) flags.set(row, [...list]);
  const correctSpans = await correctSpansOf(tx, t, unique);
  return { ver, revokedBy, corrected, correctSpans, flags };
}

/**
 * State entities: the business time where a field's value in effect (now, or after operation `s`)
 * comes from a correction: cells whose value a `correct` write gave (their `src_event`). Not the
 * cell's own intent: a cell is closed and opened again whenever another write cuts it, and then
 * holds that write's intent, its value still the correction's.
 */
export async function correctSpansOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  ids: readonly string[],
  s?: number,
): Promise<Map<string, { field: string; from: string; to: string | null }[]>> {
  const out = new Map<string, { field: string; from: string; to: string | null }[]>();
  if (t.time.type !== "state" || ids.length === 0) return out;
  const { versions } = physical(t);
  const interval =
    t.time.granularity === "date"
      ? "valid_from::text AS vf, valid_to::text AS vt"
      : `to_char(valid_from, ${INSTANT_TEXT}) AS vf, to_char(valid_to, ${INSTANT_TEXT}) AS vt`;
  const r = await tx.query<{ row_id: string; field_id: string; vf: string; vt: string | null }>(
    `SELECT v.row_id, v.field_id, ${interval} FROM ${versions} v
     WHERE v.row_id = ANY($1) AND v.field_id <> 'existence' AND ${
       s === undefined
         ? "v.rec_to IS NULL"
         : "v.rec_from <= $2 AND (v.rec_to IS NULL OR v.rec_to > $2)"
     } AND EXISTS (
       SELECT 1 FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
       WHERE e.seq = v.src_event AND e.type = 'write.base' AND c.body IS NOT NULL
         AND (c.body::jsonb ->> 'intent') = 'correct')`,
    (s === undefined ? [ids] : [ids, s]) as never,
  );
  for (const x of r.rows)
    out.set(x.row_id, [...(out.get(x.row_id) ?? []), { field: x.field_id, from: x.vf, to: x.vt }]);
  return out;
}

/**
 * The open items' flags on the given rows (02-architecture §8 `flags`). The one place that knows
 * how the table stores a flag's business time: kept here so that a change of that storage changes
 * only this function.
 */
async function readFlags(
  tx: ReadTx,
  table: string,
  ids: readonly string[] | null,
): Promise<{ row: string; flag: Flag }[]> {
  const r = await tx.query<{
    row_id: string;
    flag: string;
    item_id: string;
    fields: string | null;
    spans: string | null;
    type: string | null;
  }>(
    `SELECT f.row_id, f.flag, f.item_id, f.fields, f.spans, p.type
     FROM flags f LEFT JOIN pending_items p ON p.id = f.item_id
     WHERE f.table_id = $1${ids === null ? "" : " AND f.row_id = ANY($2)"} ORDER BY f.item_id`,
    (ids === null ? [table] : [table, ids]) as never,
  );
  return r.rows.map((x) => ({
    row: x.row_id,
    flag: {
      flag: x.flag as Flag["flag"],
      item: x.item_id as ItemId,
      itemType: x.type,
      fields: x.fields === null ? ["existence"] : (JSON.parse(x.fields) as string[]),
      // The item's spans, JCS (state tables); none on event and timeless tables. The first one
      // may be open at the start (`{to}`); the whole time is no spans at all.
      spans:
        x.spans === null
          ? undefined
          : (JSON.parse(x.spans) as { from?: string; to?: string }[]).map((y) => ({
              from: y.from ?? null,
              to: y.to ?? null,
            })),
    },
  }));
}

/** The flags on every row of `table`, by row (open items' flags only are kept in `flags`). */
export async function readTableFlags(tx: ReadTx, table: string): Promise<Map<string, Flag[]>> {
  const out = new Map<string, Flag[]>();
  for (const f of await readFlags(tx, table, null)) {
    const xs = out.get(f.row);
    if (xs === undefined) out.set(f.row, [f.flag]);
    else xs.push(f.flag);
  }
  return out;
}

/** The open items' flags on the given rows, by row. */
export async function readFlagsOf(
  tx: ReadTx,
  table: string,
  ids: readonly string[],
): Promise<Map<string, Flag[]>> {
  const out = new Map<string, Flag[]>();
  if (ids.length === 0) return out;
  for (const f of await readFlags(tx, table, ids))
    out.set(f.row, [...(out.get(f.row) ?? []), f.flag]);
  return out;
}

/** The current restore count: taken where every path takes it (store/restore-point.ts). */
export { restoreCount } from "../store/restore-point.ts";

/** The log position: the latest operation number (0 for an empty log). */
export async function logPosition(tx: ReadTx): Promise<number> {
  const r = await tx.query<{ op: unknown }>("SELECT max(op) AS op FROM events");
  return Number(r.rows[0]?.op ?? 0);
}
