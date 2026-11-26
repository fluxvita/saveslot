// `query` of a derived table (docs/zh-CN/spec/04-contract.md §10 `query`, §4, §15; 04-contract-types
// §4.1, §4.3; 01-objects «行身份»): the rows of its physical table, read through the layout and
// decoding of rules (derivedLayout, decodeDerivedRow), filtered, ordered by the group key and paged.
//
// - A row is identified by its group key (`key`, `{}` for a whole aggregate); inside, by its
//   `partition_id`, which the read records as its target. Its `ver` is the operation of the
//   derived write that last set it; it cannot be written with, so the read registers no row
//   version for the fallback, only `sv`.
// - Derived tables have no business time: `valid_at` / `valid_during` are `derived_table`;
//   `clip` / `coalesce` are `not_state_table`, as on any table but a state table. `include_revoked`
//   gives nothing more: a derived row is never revoked.
// - A table computed when read (computedAtRead; 06 «时间依赖») is not read from its physical table,
//   which stays empty: its rule is evaluated at `at` (the entry's instant when not given; "today" is
//   its day in the slot's zone), and its rows carry `marks.computed_at_read` and no `ver`. The
//   conditions are applied to the rows as decoded, typed as the physical table would hold them, so
//   that they compare the same values a stored row would. Rows are ordered by the group key, which
//   identifies them (there is no partition). `at` has no effect on any other derived table.
// - Each row carries `input_marks` (04-contract §7): of the base rows in its partition (the rule's
//   members: evaluate's members query, of the same checked rule and key decoding), those with an
//   open item's flag on a field the rule depends on, counted once per row and kind; a flag on the
//   row's existence counts too. Given when all are 0 as well, so that "none" is never "not
//   computed". The base table's flags are read first; only the flagged rows' members are asked
//   for, so the cost follows the flagged rows, not the table's size.
// - A later page reads the derived table as it is: a derived table has no state as of a record
//   time. When a derived write changed the table after the first page, the page is
//   `handle_expired` (`derived_changed`) and the caller reads again from the first page; when
//   none did, the table is what the first page read. A table computed when read has no derived
//   writes: the test is whether a base table its rule reads has a version recorded after the first
//   page's position; when none has, the page is computed again at the first page's `at`, which the
//   position keeps (04-contract §15).

import {
  type CompiledBaseField,
  type CompiledBaseTable,
  type CompiledDerivedTable,
  canonicalize,
  type FieldValue,
  type Instant,
  type JsonValue,
  type TableId,
} from "@fluxvita/saveslot-contract-core";
import type { ReadEntry, ReadRow } from "../audit/index.ts";
import { get, has, instantText, type Obj, parseDateTime } from "../request/index.ts";
import {
  computedAtRead,
  type DerivedRow,
  decodeDerivedRow,
  derivedRowsQuery,
  evaluateRule,
  evaluating,
  type RuleEvaluation,
  RuleEvaluationError,
} from "../rules/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { mergedSegments } from "../store/segments.ts";
import { dateInZone, valueOut } from "../time/index.ts";
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
import { cmpKeys, type KeySpec, keyType, keyValue, spansMeet } from "./rows.ts";
import {
  changedPremiseCovers,
  conditionSql,
  INSTANT_TEXT,
  logPosition,
  Params,
  physical,
  readTableFlags,
  restoreCount,
} from "./select.ts";

import type { NamedTable } from "./slots.ts";
import {
  detailedNotInThisVersion,
  type InputMarks,
  invalid,
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

/**
 * Whether a base table among `tables` has a version recorded after operation `op` (a cell opened
 * or closed by a later operation, as `changes` reads them): what a table computed when read was
 * computed from no longer holds at `op`.
 */
async function basesChangedSince(
  tx: ReadTx,
  tables: readonly CompiledBaseTable[],
  op: number,
): Promise<boolean> {
  for (const b of tables) {
    const r = await tx.query(
      `SELECT 1 FROM ${physical(b).versions} WHERE rec_from > $1 OR rec_to > $1 LIMIT 1`,
      [op],
    );
    if (r.rows.length > 0) return true;
  }
  return false;
}

/** The SQL type a derived field's value is held in (as apply builds the physical table). */
const HELD: Readonly<Record<CompiledDerivedTable["fields"][number]["type"], string>> = {
  text: "text",
  enum: "text",
  ref: "text",
  integer: "bigint",
  decimal: "numeric",
  quantity: "numeric",
  boolean: "boolean",
  date: "date",
  zoned_datetime: "timestamptz",
};

/**
 * Which of these computed rows meet the conditions: the rows passed to the database as the
 * physical table would hold them (one column `f_<field>` per field, of its type), and the same
 * condition SQL as a stored derived table is read with. The indices of those that do.
 */
async function meeting(
  tx: ReadTx,
  t: CompiledDerivedTable,
  rows: readonly DerivedRow[],
  where: readonly Condition[],
): Promise<Set<number>> {
  if (where.length === 0 || rows.length === 0) return new Set(rows.map((_, i) => i));
  const cell = (v: FieldValue) =>
    v !== null && typeof v === "object" && "value" in v ? v.value : v;
  const json = rows.map((r, i) => {
    const o: Record<string, unknown> = { i };
    for (const f of t.fields) o[`f_${f.id}`] = cell(r.values[f.id] ?? null);
    return o;
  });
  const p = new Params();
  const data = p.add(JSON.stringify(json), "::jsonb");
  const cols = [`"i" integer`, ...t.fields.map((f) => `"f_${f.id}" ${HELD[f.type]}`)];
  const conds = where.map((c) => conditionSql(c, p));
  const r = await tx.query<{ i: number }>(
    `SELECT "i" FROM jsonb_to_recordset(${data}) AS x(${cols.join(", ")}) WHERE ${conds.join(" AND ")}`,
    p.list,
  );
  return new Set(r.rows.map((x) => Number(x.i)));
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
    // A derived row has no sources of its own to give, whether computed when read or stored: a
    // detail of half its parts would mislead (not in this version either way).
    if (d === "detailed") throw detailedNotInThisVersion();
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
  const atRead = computedAtRead(t);
  const bases = named.slot.compiled.tables.filter(
    (b): b is CompiledBaseTable =>
      b.kind === "base" && t.rule.depends_on.some((d) => d.table === b.id),
  );
  if (
    position !== undefined &&
    (atRead
      ? await basesChangedSince(tx, bases, position.seq)
      : await changedSince(tx, t.id, position.seq))
  ) {
    throw new ReadError("handle_expired", "the derived table changed since the first page", {
      reason: "derived_changed",
      param: "position",
    });
  }

  // The rows: computed at the evaluation time (a later page: the first page's), or stored.
  const evaluatedAt = position?.at ?? at;
  const e = evaluateRule(
    named.slot.compiled,
    t.id,
    atRead
      ? { now: evaluatedAt, today: dateInZone(Date.parse(evaluatedAt), named.slot.timezone) }
      : undefined,
  );
  const item = (
    values: DerivedRow["values"],
    partition: string | undefined,
    ver: number | undefined,
  ) => {
    const out: Record<string, Values[string]> = Object.create(null);
    for (const f of fields) out[f.name] = valueOut(values[f.id] ?? null);
    const key: Record<string, Values[string]> = Object.create(null);
    for (const f of keyFields) key[f.name] = valueOut(values[f.id] ?? null);
    const keyText = canonicalize(keyFields.map((f) => values[f.id] ?? null) as JsonValue);
    const row: Row =
      ver === undefined
        ? { table: qualified, key, values: out, marks: { computed_at_read: true } }
        : { table: qualified, key, ver: `v${ver}.${restore}`, values: out };
    const keys = [
      ...order.map((o) => keyValue(values[o.field.id])),
      ...keyFields.map((f) => keyValue(values[f.id])),
      partition ?? keyText,
    ];
    return { item: { row, partition, ver, key: keyText }, keys };
  };
  let items: ReturnType<typeof item>[];
  if (atRead) {
    const computed = await evaluating(async () => {
      const out: DerivedRow[] = [];
      const r = await tx.query<Record<string, unknown>>(e.all.sql, e.all.params as never);
      for (const x of r.rows) {
        const d = e.decode(x);
        if (d !== undefined) out.push(d);
      }
      return out;
    });
    const kept = await meeting(tx, t, computed, where);
    items = computed.filter((_, i) => kept.has(i)).map((d) => item(d.values, undefined, undefined));
  } else {
    const q = derivedRowsQuery(t);
    const p = new Params();
    const conds = where.map((c) => conditionSql(c, p));
    const res = await tx.query<Record<string, unknown>>(
      `${q.sql}${conds.length > 0 ? ` WHERE ${conds.join(" AND ")}` : ""}`,
      p.list,
    );
    items = res.rows.map((r) => {
      const d = decodeDerivedRow(t, r);
      return item(d.values, d.partition, d.ver);
    });
  }
  items.sort((a, b) => cmpKeys(specs, a.keys, b.keys));
  const seq = position?.seq ?? latest;
  const { page, next } = pageAfter(items, {
    specs,
    identity,
    position,
    seq,
    at: evaluatedAt,
    restoreCount: restore,
    limit,
  });

  const read = bases.find((b) => b.id === e.base);
  const marks = await inputMarks(
    tx,
    e,
    t,
    page.map((x) => x.key),
    atRead && read !== undefined && read.time.type === "state"
      ? {
          table: read,
          point:
            read.time.granularity === "date"
              ? dateInZone(Date.parse(evaluatedAt), named.slot.timezone)
              : evaluatedAt,
        }
      : undefined,
    read,
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
  // A table computed when read is recorded at table level, under its own name (02-integrity
  // «纠错影响查询»); never under the base tables it reads.
  const readRows: ReadRow[] = atRead
    ? []
    : page.map((x) => ({
        table: tableId,
        target: x.partition as string,
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
    coarse: atRead ? [tableId] : [],
    ...(atRead ? { ruleVersion: t.rule.version, evaluatedAt: evaluatedAt as Instant } : {}),
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
 * The merged segment (../store/segments.ts) of each of these entities that holds `point` (a date,
 * or an instant, by the table's granularity), its ends as flag spans write them.
 */
async function segmentsAt(
  tx: ReadTx,
  t: CompiledBaseTable,
  entities: readonly string[],
  point: string,
): Promise<Map<string, { from: string; to: string | null }>> {
  const byDate = t.time.type === "state" && t.time.granularity === "date";
  const cast = byDate ? "date" : "timestamptz";
  const text = (c: string) => (byDate ? `${c}::text` : `to_char(${c}, ${INSTANT_TEXT})`);
  const r = await tx.query<{ entity_id: string; f: string; t: string | null }>(
    `SELECT "entity_id", ${text('"valid_from"')} AS f, ${text('"valid_to"')} AS t
     FROM (${mergedSegments(t)}) AS "m"
     WHERE "entity_id" = ANY($1) AND "valid_from" <= CAST($2 AS ${cast})
       AND ("valid_to" IS NULL OR "valid_to" > CAST($2 AS ${cast}))`,
    [[...entities], point] as never,
  );
  return new Map(r.rows.map((x) => [x.entity_id, { from: x.f, to: x.t }]));
}

/**
 * The input marks of the partitions with these keys (JCS of the group key): the rule's members
 * falling in them, their open items' flags on the fields the rule depends on in the base table
 * (or on the row's existence), each kind counted once per row; the items by ID, at most 10.
 * `premise_changed`: the members whose value of a field the rule depends on rests on a changed
 * premise (as a read of the base table marks them, `changedPremiseCovers`), once per row.
 */
export async function inputMarks(
  tx: ReadTx,
  e: Pick<RuleEvaluation, "base" | "membersAmong" | "decodeMember">,
  t: CompiledDerivedTable,
  keys: readonly string[],
  stateAt?: { readonly table: CompiledBaseTable; readonly point: string },
  base?: CompiledBaseTable,
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
  // Changed premises: those covering a field the rule depends on (a premise covers no existence).
  const premises = new Map<string, { from: string | null; to: string | null }[]>();
  if (base !== undefined) {
    for (const [row, cs] of await changedPremiseCovers(tx, base)) {
      const kept = cs.filter((c) => depends.has(c.field as never));
      if (kept.length > 0) premises.set(row, kept);
    }
  }
  // A rule reading a state table with no time condition reads each entity's segment holding the
  // evaluation point: a flag or premise counts only when its spans meet that segment, as a read of
  // the base table at that point marks it (04-contract §7).
  if (stateAt !== undefined && (flags.size > 0 || premises.size > 0)) {
    const segments = await segmentsAt(
      tx,
      stateAt.table,
      [...new Set([...flags.keys(), ...premises.keys()])],
      stateAt.point,
    );
    for (const [row, fs] of flags) {
      const seg = segments.get(row);
      const kept = seg === undefined ? [] : fs.filter((f) => spansMeet(f.spans, seg.from, seg.to));
      if (kept.length === 0) flags.delete(row);
      else flags.set(row, kept);
    }
    for (const [row, cs] of premises) {
      const seg = segments.get(row);
      if (seg === undefined || !cs.some((c) => spansMeet([c], seg.from, seg.to)))
        premises.delete(row);
    }
  }
  if (flags.size === 0 && premises.size === 0) {
    for (const k of keys) out.set(k, zero());
    return out;
  }
  const wanted = new Set(keys);
  const rowsOf = new Map<string, string[]>();
  const q = e.membersAmong([...new Set([...flags.keys(), ...premises.keys()])]);
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
    // Once per row, however many changed premises it rests on.
    const premiseRows = new Set((rowsOf.get(k) ?? []).filter((row) => premises.has(row)));
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
      premise_changed: premiseRows.size,
      items: [...items].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).slice(0, 10) as never,
    });
  }
  return out;
}
