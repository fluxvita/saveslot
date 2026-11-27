// The rows a query selects as of an operation number S, from the version table (02-architecture
// §8: `t_<table>_v<n>__ver`, every cell with the record interval it held), for the pages after the
// first: a page is fixed to its first page's operation (04-contract §15), so writes made meanwhile
// neither drop nor repeat rows.
//
// The state as of S is rebuilt from the cells in effect then (`rec_from ≤ S < rec_to`), the way
// apply builds the business table from its cells: a state entity has a value on a piece of business
// time where a field cell there is not marked no_value (apply writes every field's cell where it has
// one, a cleared or never written field included, 05-time «无值区间»), pieces with the same values running together; an event or timeless row exists when it
// has cells, revoked when a revoke is in effect. The business time and the conditions are then
// evaluated here, operator by operator as ./select.ts writes them in SQL for the first page:
// - `=`, `<`, `<=`, `>`, `>=`, `in`, `contains`: an empty value matches none; `!=` matches it;
// - numbers exactly (`value × den op num` in SQL; rationals here), text by exact code points (the
//   "C" collation), dates and instants by their fixed-width text, booleans false before true;
// - an open interval end compares as later than any point (`COALESCE(valid_to, 'infinity')`).
// The first page and a page read as of the same S must agree: query.prop.test checks it.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  FieldValue,
} from "@fluxvita/saveslot-contract-core";
import { segmentsOf as segmentsFrom } from "../delta/index.ts";
import { compare, rationalOf } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { cellWithheld, withholdingIn } from "../store/readable-content.ts";
import type { Condition, Literal, QueryPlan } from "./params.ts";
import {
  correctSpansOf,
  decode,
  INSTANT_TEXT,
  physical,
  type RowFacts,
  readFlagsOf,
  type SelectedRow,
  selectOf,
} from "./select.ts";

/** A cell of one row or entity: field, business interval, record start, revoke, values. */
export type RowCell = {
  field_id: string;
  vf: string | null;
  vt: string | null;
  rec_from: unknown;
  revoked: boolean | null;
  /** A field cell saying the entity has no value there (`__ver.no_value`). */
  no_value: boolean | null;
  /**
   * Its value came from a contribution no longer readable (`cellWithheld`): the value is not read
   * (its columns are emptied here), the cell still counts as a value there.
   */
  withheld?: boolean | null;
} & Record<string, unknown>;

/** A cell read as `cellWithheld` says: a withheld one's value columns emptied. */
export function readableCell<C extends RowCell>(c: C): C {
  if (c.withheld !== true) return c;
  const out: Record<string, unknown> = { ...c };
  for (const k of Object.keys(out)) if (k.startsWith("c_")) out[k] = null;
  return out as C;
}

/** The source key of a withheld cell: it never runs together with a value read. */
const WITHHELD = "\u0000withheld";

type Cell = RowCell & { row_id: string };

/** Every cell of the table in effect after operation `s`; of the rows `ids` only, when given. */
async function cellsAsOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  s: number,
  ids?: readonly string[],
): Promise<Cell[]> {
  const { versions } = physical(t);
  const state = t.time.type === "state";
  const interval = state
    ? t.time.granularity === "date"
      ? "valid_from::text AS vf, valid_to::text AS vt"
      : `to_char(valid_from, ${INSTANT_TEXT}) AS vf, to_char(valid_to, ${INSTANT_TEXT}) AS vt`
    : "NULL AS vf, NULL AS vt";
  const cols = t.fields.flatMap((f) => selectOf(f).map((x, i) => `${x} AS c_${f.id}_${i}`));
  const r = await tx.query<Cell>(
    `SELECT row_id, field_id, ${interval}, rec_from, revoked, no_value, ${cellWithheld("v", await withholdingIn(tx))} AS withheld,
       ${cols.join(", ")} FROM ${versions} v
     WHERE rec_from <= $1 AND (rec_to IS NULL OR rec_to > $1)${ids !== undefined ? " AND row_id = ANY($2)" : ""}`,
    (ids !== undefined ? [s, [...ids]] : [s]) as never,
  );
  return r.rows.map(readableCell);
}

/**
 * The rows (entities on state tables) of table `t` changed after operation `x`: those with a cell
 * opened or closed since (`rec_from > x` or `rec_to > x`). Every other row has the same cells now
 * as then, so the business table holds it as it was after `x`. Undefined when more than `max`.
 * A write that closes a cell opens one in the same operation, so `rec_to > x` adds no row today:
 * only a deletion closes cells without opening others, and after one a later page is the whole
 * read (`switchedOrDeletedSince`). It is kept so that C stays right without that.
 */
export async function changedSince(
  tx: ReadTx,
  t: CompiledBaseTable,
  x: number,
  max: number,
): Promise<string[] | undefined> {
  const { versions } = physical(t);
  const r = await tx.query<{ row_id: string }>(
    `SELECT row_id FROM ${versions} WHERE rec_from > $1 OR rec_to > $1 GROUP BY row_id LIMIT $2`,
    [x, max + 1],
  );
  return r.rows.length > max ? undefined : r.rows.map((y) => y.row_id);
}

/**
 * Whether, after operation `x`, a schema switch or any step of a deletion (confirmed, cancelled,
 * carried out; 09-event-format §4) happened, in any slot: what a reader can read may then differ
 * from what the cells after `x` alone say. A confirmed deletion already hides the blocks it lists
 * from every reader, a cancelled one gives them back. Wider than the slot read, on purpose: one
 * statement, no slot to resolve; a later page it sends to the whole read is the same page.
 *
 * Not here: a restore or an import. Either changes the restore count, and a position from before
 * it is refused when decoded (`handle_expired`, `restored`), before any page is read. Nor the
 * other events (items, a changed premise, a migration started or failed, a slot removed, a policy
 * set): none of them changes a business table without opening or closing a cell of it in the same
 * operation, which C then holds, and the marks, facts and premises of a page are read the same way
 * on both paths. A change that lets one of them change a business table otherwise has to add it
 * here.
 */
export async function switchedOrDeletedSince(tx: ReadTx, x: number): Promise<boolean> {
  const r = await tx.query<{ one: unknown }>(
    `SELECT 1 AS one FROM events WHERE op > $1
       AND type IN ('schema.switched', 'deletion.confirmed', 'deletion.cancelled',
                    'deletion.executed') LIMIT 1`,
    [x],
  );
  return r.rows.length > 0;
}

const cellValue = (f: CompiledBaseField, c: RowCell): FieldValue =>
  decode(
    f,
    selectOf(f).map((_, i) => c[`c_${f.id}_${i}`]),
  );

/**
 * A state entity's segments from its cells: where it has a value, equal pieces run together.
 * `withheld`: the fields whose value there a withheld cell gave (not given, the segment marked); a
 * withheld piece runs together only with another withheld one.
 */
export function segmentsOf(
  t: CompiledBaseTable,
  cells: readonly RowCell[],
): {
  from: string;
  to: string | null;
  values: Record<string, FieldValue>;
  withheld: readonly string[];
}[] {
  // The sources `delta` can carry per segment are not read here: every source is empty but a
  // withheld cell's.
  return segmentsFrom(t, cells, {
    decode,
    sourceOf: (_, c) => ((c as RowCell).withheld === true ? WITHHELD : ""),
  }).map((s) => {
    const withheld = t.fields.filter((f) => s.source[f.id] === WITHHELD).map((f) => f.id);
    const values = { ...(s.values as Record<string, FieldValue>) };
    for (const f of withheld) delete values[f];
    return { from: s.from, to: s.to, values, withheld };
  });
}

// --- conditions, evaluated here -------------------------------------------------------------------

/** A column's value as compared: null when empty. */
type Cmp = string | boolean | { readonly num: bigint; readonly den: bigint } | null;

function columnValue(c: Condition["column"], r: SelectedRow): { v: Cmp; open?: true } {
  if (c === "valid_from") return { v: r.validFrom ?? null };
  if (c === "valid_to")
    return r.validTo === null || r.validTo === undefined
      ? { v: null, open: true }
      : { v: r.validTo };
  const x = r.values[c.id];
  if (x === null || x === undefined) return { v: null };
  if (typeof x === "boolean") return { v: x };
  if (typeof x === "string")
    return { v: c.type === "integer" || c.type === "decimal" ? rationalOf(x) : x };
  if ("instant" in x) return { v: x.instant };
  return { v: rationalOf(x.value) };
}

function order(a: Cmp, b: Literal): number {
  if (b.kind === "number") return compare(a as { num: bigint; den: bigint }, b.value);
  if (b.kind === "boolean") return a === b.value ? 0 : a === false ? -1 : 1;
  // Code point order: for the fixed-width ASCII of dates and instants, string order is the same.
  return cmpCodePoints(a as string, b.value);
}

function cmpCodePoints(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = ((x[i] as string).codePointAt(0) ?? 0) - ((y[i] as string).codePointAt(0) ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

function compareOp(op: string, col: { v: Cmp; open?: true }, lit: Literal): boolean {
  if (col.open === true) {
    // `COALESCE(valid_to, 'infinity')`: later than any point.
    return op === "!=" || op === ">" || op === ">=";
  }
  if (col.v === null) return op === "!=";
  const c = order(col.v, lit);
  switch (op) {
    case "=":
      return c === 0;
    case "!=":
      return c !== 0;
    case "<":
      return c < 0;
    case "<=":
      return c <= 0;
    case ">":
      return c > 0;
    default:
      return c >= 0;
  }
}

/** Whether a row meets a condition, as ./select.ts's SQL decides it. */
export function meetsCondition(c: Condition, r: SelectedRow): boolean {
  const col = columnValue(c.column, r);
  switch (c.op) {
    case "is_null":
      return (col.v === null) === c.isNull;
    case "in":
      return c.values.some((v) => compareOp("=", col, v));
    case "contains":
      return typeof col.v === "string" && col.v.includes((c.value as { value: string }).value);
    default:
      return compareOp(c.op, col, c.value);
  }
}

const within = (p: string, from: string, to: string | null) => from <= p && (to === null || p < to);

/**
 * The rows the plan selects as of operation `s`, as `selectRows` would have then; among the rows
 * (entities) `ids` only, when given.
 */
export async function selectRowsAsOf(
  tx: ReadTx,
  plan: QueryPlan,
  s: number,
  ids?: readonly string[],
): Promise<SelectedRow[]> {
  const t = plan.table;
  const byRow = new Map<string, Cell[]>();
  if (ids !== undefined && ids.length === 0) return [];
  for (const c of await cellsAsOf(tx, t, s, ids))
    byRow.set(c.row_id, [...(byRow.get(c.row_id) ?? []), c]);
  const rows: SelectedRow[] = [];
  for (const [id, cells] of byRow) {
    if (plan.kind === "state") {
      for (const seg of segmentsOf(t, cells)) {
        const time = plan.time;
        // Over an interval every segment: merging comes before the interval (./rows.ts).
        const keep = time.kind === "during" || within(time.point, seg.from, seg.to);
        if (keep)
          rows.push({
            id,
            validFrom: seg.from,
            validTo: seg.to,
            revoked: false,
            values: seg.values,
            ...(seg.withheld.length > 0 ? { withheld: seg.withheld } : {}),
          });
      }
      continue;
    }
    const values: Record<string, FieldValue> = Object.create(null);
    const withheld: string[] = [];
    for (const f of t.fields) {
      const c = cells.find((x) => x.field_id === f.id);
      if (c?.withheld === true) withheld.push(f.id);
      else values[f.id] = c === undefined ? null : cellValue(f, c);
    }
    const revoked = cells.some((c) => c.field_id === "existence" && c.revoked === true);
    if (revoked && !plan.includeRevoked) continue;
    if (plan.kind === "event" && plan.time.kind === "during" && t.time.type === "event") {
      const tf = t.time.field;
      const v = values[tf];
      const point =
        typeof v === "string"
          ? v
          : typeof v === "object" && v !== null && "instant" in v
            ? v.instant
            : null;
      if (point === null || !within(point, plan.time.from, plan.time.to)) continue;
    }
    rows.push({ id, revoked, values, ...(withheld.length > 0 ? { withheld } : {}) });
  }
  // Conditions on the fields here; those on valid_from / valid_to apply after merging (./rows.ts).
  const onFields = plan.where.filter((c) => typeof c.column !== "string");
  return rows.filter((r) => onFields.every((c) => meetsCondition(c, r)));
}

/** `ver`, the revoke in effect, `corrected` as of operation `s`; the open items' flags of now. */
export async function rowFactsAsOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  ids: readonly string[],
  s: number,
): Promise<RowFacts> {
  const { versions } = physical(t);
  const unique = [...new Set(ids)];
  const ver = new Map<string, number>();
  const revokedBy = new Map<string, number>();
  const corrected = new Set<string>();
  if (unique.length > 0) {
    const vr = await tx.query<{ id: string; v: unknown; c: boolean }>(
      `SELECT row_id AS id, max(rec_from) AS v, bool_or(intent = 'correct') AS c FROM ${versions}
       WHERE row_id = ANY($1) AND rec_from <= $2 AND intent <> 'schema_switch' GROUP BY row_id`,
      [unique, s] as never,
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
         WHERE v.row_id = ANY($1) AND v.field_id = 'existence' AND v.revoked
           AND v.rec_from <= $2 AND (v.rec_to IS NULL OR v.rec_to > $2)
         GROUP BY v.row_id`,
        [unique, s] as never,
      );
      for (const x of rv.rows) revokedBy.set(x.id, Number(x.v));
    }
  }
  return {
    ver,
    revokedBy,
    corrected,
    correctSpans: await correctSpansOf(tx, t, unique, s),
    flags: await readFlagsOf(tx, t.id, unique),
  };
}
