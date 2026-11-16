// `query` of a derived table (docs/zh-CN/spec/04-contract.md §10 `query`, §4, §15; 04-contract-types
// §4.1, §4.3; 06-derived.md «行身份»): the rows of its physical table, read through the layout and
// decoding of rules (derivedLayout, decodeDerivedRow), filtered, ordered by the group key and paged.
//
// - A row is identified by its group key (`key`, `{}` for a whole aggregate); inside, by its
//   `partition_id`, which the read records as its target. Its `ver` is the operation of the
//   derived write that last set it; it cannot be written with, so the read registers no row
//   version for the fallback, only `sv`.
// - Derived tables have no business time: `valid_at` / `valid_during` are `derived_table`;
//   `clip` / `coalesce` are `not_state_table`, as on any table but a state table. `at` is taken
//   and has no effect: it is the evaluation time of rules depending on today, which this version
//   computes at read time only, and which no derived table of this version has. `include_revoked`
//   gives nothing more: a derived row is never revoked.
// - Each row carries `input_marks` (04-contract §7): of the base rows in its partition (the rule's
//   members: evaluate's members query, of the same checked rule and key decoding), those with an
//   open item's flag on a field the rule depends on, counted once per row and kind; a flag on the
//   row's existence counts too. Given when all are 0 as well, so that "none" is never "not
//   computed". The base table's flags are read first; only the flagged rows' members are asked
//   for, so the cost follows the flagged rows, not the table's size.
// - A later page reads the derived table as it is: a derived table has no state as of a record
//   time. When a derived write changed the table after the first page, the page is
//   `handle_expired` (`derived_changed`) and the caller reads again from the first page; when
//   none did, the table is what the first page read.

import {
  type CompiledBaseField,
  type CompiledBaseTable,
  type CompiledDerivedTable,
  canonicalize,
  type Instant,
  type JsonValue,
  type TableId,
} from "@fluxvita/saveslot-contract-core";
import type { ReadEntry, ReadRow } from "../audit/index.ts";
import { get, has, instantText, type Obj, parseDateTime } from "../request/index.ts";
import {
  decodeDerivedRow,
  derivedRowsQuery,
  evaluateRule,
  type RuleEvaluation,
  RuleEvaluationError,
} from "../rules/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { digest, limitOf, pageAfter, positionOf } from "./page.ts";
import {
  bool,
  CONTROL,
  type Condition,
  condition,
  fieldNamed,
  MAX_TASK_CHARS,
  QUERY_KEYS,
} from "./params.ts";
import type { QueryInput, QueryOutput } from "./query-io.ts";
import { cmpKeys, type KeySpec, keyType, keyValue } from "./rows.ts";
import { conditionSql, logPosition, Params, readTableFlags, restoreCount } from "./select.ts";
import type { NamedTable } from "./slots.ts";
import {
  type InputMarks,
  invalid,
  notImplemented,
  ReadError,
  type ReadWarning,
  type Row,
  type Values,
} from "./types.ts";

/**
 * The derived table as a timeless base table, for the parameter checks shared with base tables
 * (field names, conditions, order). A passed-through `enum` or `ref` has no values or target of its
 * own: its literals are read as text.
 */
function asBase(t: CompiledDerivedTable): CompiledBaseTable {
  const fields = t.fields.map((f) =>
    f.type === "enum" || f.type === "ref"
      ? { id: f.id, name: f.name, type: "text" as const, description: f.description }
      : f,
  ) as unknown as CompiledBaseField[];
  return {
    id: t.id,
    name: t.name,
    kind: "base",
    description: t.description,
    physical: t.physical,
    time: { type: "none" },
    fields,
  } as CompiledBaseTable;
}

/**
 * Whether a later operation than `op` wrote the derived table: its `write.derived` events, on the
 * index of their target table (`target_row` is null on them; `seq > op` narrows the range, every
 * event of a later operation being past it). One row read when it did, none when not.
 *
 * `op > op` is the test, not `seq > op`: a position holds an operation number, and the derived
 * writes of that very operation (the first page's) have larger `seq`s than it. Comparing `seq`
 * alone would take them for a change after the first page.
 */
async function changedSince(tx: ReadTx, table: string, op: number): Promise<boolean> {
  const r = await tx.query(
    `SELECT 1 FROM events
     WHERE target_table = $1 AND target_row IS NULL AND seq > $2 AND op > $2
       AND type = 'write.derived'
     LIMIT 1`,
    [table, op],
  );
  return r.rows.length > 0;
}

export async function queryDerived(
  tx: ReadTx,
  input: QueryInput,
  params: Obj,
  named: NamedTable,
): Promise<QueryOutput> {
  const t = named.table as CompiledDerivedTable;
  const base = asBase(t);
  const qualified = `${named.slot.name}.${t.name}`;
  for (const k of Object.keys(params)) if (!QUERY_KEYS.has(k)) throw invalid("malformed", k);
  const warnings: ReadWarning[] = [];

  let task = input.task;
  if (has(params, "task")) {
    const v = get(params, "task");
    if (
      typeof v !== "string" ||
      v === "" ||
      !v.isWellFormed() ||
      [...v].length > MAX_TASK_CHARS ||
      CONTROL.test(v)
    )
      throw invalid("malformed", "task");
    task = v;
  }
  if (has(params, "detail")) {
    const d = get(params, "detail");
    if (d === "detailed") throw notImplemented("detail", "detail: detailed");
    if (d !== "concise") throw invalid("malformed", "detail");
  }
  // The evaluation time: checked, of no effect on this version's derived tables (above).
  let at = input.now;
  if (has(params, "at")) {
    const v = get(params, "at");
    const p = typeof v === "string" ? parseDateTime(v, "UTC", false) : undefined;
    if (p === undefined || !p.ok || p.assumed) throw invalid("malformed", "at");
    at = instantText(p.epochMs) as Instant;
  }
  for (const k of ["valid_at", "valid_during"])
    if (has(params, k)) throw invalid("derived_table", k);
  for (const k of ["clip", "coalesce"]) if (has(params, k)) throw invalid("not_state_table", k);
  bool(params, "include_revoked", false);

  // Fields.
  let fields = base.fields;
  if (has(params, "fields")) {
    const v = get(params, "fields");
    if (!Array.isArray(v) || v.length === 0) throw invalid("malformed", "fields");
    const chosen = new Set<string>();
    v.forEach((x, i) => {
      const f = fieldNamed(base, x, `fields/${i}`);
      if (chosen.has(f.id)) throw invalid("malformed", `fields/${i}`);
      chosen.add(f.id);
    });
    fields = base.fields.filter((f) => chosen.has(f.id));
  }
  // Conditions.
  const where: Condition[] = [];
  if (has(params, "where")) {
    const v = get(params, "where");
    if (!Array.isArray(v)) throw invalid("malformed", "where");
    const ctx = { zone: named.slot.timezone, g: undefined, during: false, warnings };
    v.forEach((c, i) => {
      where.push(condition(base, c, `where/${i}`, ctx));
    });
  }
  // Order: the order asked for, then the group key ascending, then the partition.
  const order: { field: CompiledBaseField; dir: "asc" | "desc" }[] = [];
  if (has(params, "order")) {
    const v = get(params, "order");
    if (!Array.isArray(v)) throw invalid("malformed", "order");
    v.forEach((o, i) => {
      const p = `order/${i}`;
      if (o === null || typeof o !== "object" || Array.isArray(o)) throw invalid("malformed", p);
      for (const k of Object.keys(o as object))
        if (k !== "field" && k !== "dir") throw invalid("malformed", `${p}/${k}`);
      if (!has(o as Obj, "field")) throw invalid("missing", `${p}/field`);
      const field = fieldNamed(base, get(o as Obj, "field"), `${p}/field`);
      const dir = has(o as Obj, "dir") ? get(o as Obj, "dir") : "asc";
      if (dir !== "asc" && dir !== "desc") throw invalid("malformed", `${p}/dir`);
      if (order.some((x) => x.field.id === field.id)) throw invalid("malformed", `${p}/field`);
      order.push({ field, dir });
    });
  }
  const keyFields =
    t.rule.scope.kind === "tenant"
      ? []
      : t.rule.scope.key.map((id) => base.fields.find((f) => f.id === id) as CompiledBaseField);
  const specs: KeySpec[] = [
    ...order.map((o) => ({ type: keyType(o.field), dir: o.dir })),
    ...keyFields.map((f) => ({ type: keyType(f), dir: "asc" as const })),
    { type: "text", dir: "asc" },
  ];
  const limit = limitOf(params);

  const restore = await restoreCount(tx);
  const latest = await logPosition(tx);
  const identity = digest({
    table: t.id,
    fields: fields.map((f) => f.id),
    where: where.map((c) => ({
      column: typeof c.column === "string" ? c.column : c.column.id,
      op: c.op,
      ...("value" in c ? { value: literalId(c.value) } : {}),
      ...("values" in c ? { values: c.values.map(literalId) } : {}),
      ...("isNull" in c ? { isNull: c.isNull } : {}),
    })),
    order: order.map((o) => ({ field: o.field.id, dir: o.dir })),
  } as JsonValue);
  const position = positionOf(params, { identity, specs, restoreCount: restore, latest });
  if (position !== undefined && (await changedSince(tx, t.id, position.seq))) {
    throw new ReadError("handle_expired", "the derived table changed since the first page", {
      reason: "derived_changed",
      param: "position",
    });
  }

  // The rows.
  const e = evaluateRule(named.slot.compiled, t.id);
  const q = derivedRowsQuery(t);
  const p = new Params();
  const conds = where.map((c) => conditionSql(c, p));
  const res = await tx.query<Record<string, unknown>>(
    `${q.sql}${conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : ""}`,
    p.list,
  );
  const items = res.rows.map((r) => {
    const d = decodeDerivedRow(t, r);
    const values: Record<string, Values[string]> = Object.create(null);
    for (const f of fields) values[f.name] = d.values[f.id] ?? null;
    const key: Record<string, Values[string]> = Object.create(null);
    for (const f of keyFields) key[f.name] = d.values[f.id] ?? null;
    const row: Row = { table: qualified, key, ver: `v${d.ver}.${restore}`, values };
    const keys = [
      ...order.map((o) => keyValue(d.values[o.field.id])),
      ...keyFields.map((f) => keyValue(d.values[f.id])),
      d.partition,
    ];
    const keyText = canonicalize(keyFields.map((f) => d.values[f.id] ?? null) as JsonValue);
    return { item: { row, partition: d.partition, ver: d.ver, key: keyText }, keys };
  });
  items.sort((a, b) => cmpKeys(specs, a.keys, b.keys));
  const seq = position?.seq ?? latest;
  const { page, next } = pageAfter(items, {
    specs,
    identity,
    position,
    seq,
    at: position?.at ?? at,
    restoreCount: restore,
    limit,
  });

  const marks = await inputMarks(
    tx,
    e,
    t,
    page.map((x) => x.key),
  );
  const result = {
    table: qualified,
    slot: named.slot.name,
    sv: named.slot.sv,
    total: items.length,
    ...(next !== undefined ? { next_position: next } : {}),
    rows: page.map((x): Row => ({ ...x.row, input_marks: marks.get(x.key) as InputMarks })),
    ...(warnings.length > 0 ? { warnings } : {}),
  };

  const tableId = t.id as TableId;
  const readRows: ReadRow[] = page.map((x) => ({
    table: tableId,
    target: x.partition,
    ver: { op: x.ver as never, restoreCount: restore },
  }));
  const entry: ReadEntry = {
    read: input.read,
    actor: input.actor,
    task,
    at: input.now,
    pos: seq as never,
    operation: "query",
    slot: named.slot.slot,
    sv: named.slot.sv,
    table: tableId,
    shape: canonicalize({
      table: t.id,
      fields: fields.map((f) => f.id as string).sort(),
      where: where.map((c) => ({
        field: typeof c.column === "string" ? c.column : c.column.id,
        op: c.op,
        value: "?",
      })),
      order: order.map((o) => ({ field: o.field.id, dir: o.dir })),
      page: has(params, "limit") || has(params, "position"),
      time: "none",
    } as JsonValue),
    rows: readRows,
    coarse: [],
    // A derived row's ver cannot be written with: only the slot version counts as read.
    lastRead: [{ kind: "sv", target: named.slot.slot, op: named.slot.sv, restoreCount: 0 }],
  };
  return { result, entry };
}

/** A literal as it identifies a query (numbers exactly). */
function literalId(l: unknown): unknown {
  const o = l as { kind?: unknown; value?: { num: bigint; den: bigint } };
  return o.kind === "number" && o.value !== undefined
    ? { n: String(o.value.num), d: String(o.value.den) }
    : l;
}

/**
 * The input marks of the partitions with these keys (JCS of the group key): the rule's members
 * falling in them, their open items' flags on the fields the rule depends on in the base table
 * (or on the row's existence), each kind counted once per row; the items by ID, at most 10.
 */
export async function inputMarks(
  tx: ReadTx,
  e: Pick<RuleEvaluation, "base" | "membersAmong" | "decodeMember">,
  t: CompiledDerivedTable,
  keys: readonly string[],
): Promise<Map<string, InputMarks>> {
  const out = new Map<string, InputMarks>();
  if (keys.length === 0) return out;
  const zero = (): InputMarks => ({
    disputed: 0,
    awaiting: 0,
    flagged: 0,
    premise_changed: 0,
    items: [] as never,
  });
  // The base rows with flags first (usually few): with none, every row's marks are 0 and the
  // members are not asked for; with some, only those rows' groups. The cost follows the flagged
  // rows, not the table's size.
  const depends = new Set(t.rule.depends_on.filter((d) => d.table === e.base).map((d) => d.field));
  const flags = await readTableFlags(tx, e.base);
  for (const [row, fs] of flags) {
    const kept = fs.filter((f) =>
      f.fields.some((x) => x === "existence" || depends.has(x as never)),
    );
    if (kept.length === 0) flags.delete(row);
    else flags.set(row, kept);
  }
  if (flags.size === 0) {
    for (const k of keys) out.set(k, zero());
    return out;
  }
  const wanted = new Set(keys);
  const rowsOf = new Map<string, string[]>();
  const q = e.membersAmong([...flags.keys()]);
  for (const r of (await tx.query<Record<string, unknown>>(q.sql, q.params as never)).rows) {
    let m: { readonly key: readonly unknown[]; readonly row: string };
    try {
      m = e.decodeMember(r);
    } catch (x) {
      // A key out of what its type represents: its group has no derived row (the rule's own
      // evaluation never decodes it), so it is on no page.
      if (x instanceof RuleEvaluationError) continue;
      throw x;
    }
    const k = canonicalize(m.key as unknown as JsonValue);
    // Members of groups not on this page, or that HAVING drops, are not asked for.
    if (!wanted.has(k)) continue;
    const xs = rowsOf.get(k);
    if (xs === undefined) rowsOf.set(k, [m.row]);
    else xs.push(m.row);
  }
  for (const k of keys) {
    const counts = { disputed: 0, awaiting: 0, flagged: 0 };
    const items = new Set<string>();
    for (const row of rowsOf.get(k) ?? []) {
      const seen = new Set<string>();
      for (const f of flags.get(row) ?? []) {
        if (!f.fields.some((x) => x === "existence" || depends.has(x as never))) continue;
        items.add(f.item);
        if (seen.has(f.flag)) continue;
        seen.add(f.flag);
        counts[f.flag]++;
      }
    }
    out.set(k, {
      ...counts,
      premise_changed: 0,
      items: [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 10) as never,
    });
  }
  return out;
}
