// Derived rules evaluated on PGlite (03-data-model/11-restricted-sql.md «处理步骤» 7–8, «精度与
// 舍入»; 06-derived.md «规则读的是逻辑表»). The queries evaluateRule gives run over physical tables
// laid out as apply lays them (`t_<table>_v<n>`: row_id, revoked, `f_<field>` columns):
//
// A. Rewriting keeps the meaning, for every generated rule of this version's subset: the query over
//    the physical table (rows revoked or not) gives what the same rule body gives over a table
//    holding only the rows not revoked; and, for rules without quotients, what the bound text as
//    stored gives there, decoded alike (division by zero in % and mod() aside: NULL against an
//    error).
// B. The values are the rule's meaning, for a restricted set of shapes (group keys: none, a date, its
//    week or month, an enum or text field; sums, counts, min / max, avg and one quotient of a sum,
//    with FILTER, WHERE and HAVING): the decoded rows equal the aggregation in exact arithmetic of
//    the same rows, rounded to each field's precision.
//
// The cases that must be covered are fixed below: the two template rules, groups and whole
// aggregates left without rows, NULL keys through the partition query, rounding at exactly half
// (half_up and half_even) and the quotients whose rounding needs the guard places.

import { PGlite } from "@electric-sql/pglite";
import {
  compileDerivedRule,
  computedAtRead,
  type DerivedRow,
  evaluateRule,
  evaluationRefusal,
  loadRsql,
  type RuleEvaluation,
  SESSION_SETTINGS,
} from "@fluxvita/saveslot-kernel";
import {
  derivedSchema,
  fc,
  generatedRule,
  propRuns,
  rule,
  TABLES,
} from "@fluxvita/saveslot-kernel/rsql-testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000 });

type CompiledBaseTable = (typeof TABLES)[number];
type FieldValue = DerivedRow["key"][number];
/** Keys are dates, text or NULL here: their JSON text identifies them. */
const keyText = (key: readonly FieldValue[]) => JSON.stringify(key);

const COLUMN: Readonly<Record<string, string>> = {
  text: 'text COLLATE "C"',
  enum: 'text COLLATE "C"',
  ref: 'text COLLATE "C"',
  integer: "bigint",
  decimal: "numeric",
  quantity: "numeric",
  boolean: "boolean",
  date: "date",
  zoned_datetime: "timestamptz",
};

/** Data-dependent evaluation errors (11 «确定性» 6): division by zero, overflow, a date out of range. */
const DATA_ERRORS = new Set(["22012", "22003", "22008"]);
/** The instant a rule computed when read is evaluated at here, and its day in the slot's zone. */
const AT_READ = { now: "2026-11-20T02:00:00.000Z", today: "2026-11-20" };

const tableOf = (id: string, tables: readonly CompiledBaseTable[] = TABLES) =>
  tables.find((t) => t.id === id) as CompiledBaseTable;

/** The physical business table, as apply lays it out (event and timeless tables). */
function physicalDdl(schema: string, t: CompiledBaseTable): string {
  const cols = t.fields.flatMap((f) => [
    `"f_${f.id}" ${COLUMN[f.type]}`,
    ...(f.type === "zoned_datetime" ? [`"f_${f.id}__zone" text COLLATE "C"`] : []),
  ]);
  return `CREATE TABLE ${schema}."${t.physical.table}" (row_id text COLLATE "C" PRIMARY KEY, revoked boolean NOT NULL DEFAULT FALSE, ${cols.join(", ")})`;
}

/** The logical table: only the rows not revoked, columns named by field ID. */
function logicalDdl(schema: string, t: CompiledBaseTable): string {
  const cols = t.fields.map((f) => `"${f.id}" ${COLUMN[f.type]}`);
  return `CREATE TABLE ${schema}."${t.id}" (row_id text COLLATE "C", ${cols.join(", ")})`;
}

type Cell = string | boolean | null;
interface Row {
  readonly revoked: boolean;
  /** By field ID. */
  readonly cells: Readonly<Record<string, Cell>>;
}

let db: PGlite;

beforeAll(async () => {
  await loadRsql();
  db = await PGlite.create();
  for (const s of SESSION_SETTINGS) await db.exec(s);
  await db.exec(`
    CREATE SCHEMA s_phys; CREATE SCHEMA s_log;
    ${physicalDdl("s_phys", tableOf("t1"))}; ${logicalDdl("s_log", tableOf("t1"))};
  `);
});

afterAll(async () => {
  await db.close();
});

async function inSchema(schema: string, sql: string, params: readonly unknown[] = []) {
  await db.exec(`SET search_path TO ${schema}`);
  return db.query<Record<string, unknown>>(sql, params as unknown[]);
}

/** Replaces the rows of table `t` in s_phys (all) and s_log (those not revoked). */
async function load(t: CompiledBaseTable, rows: readonly Row[]): Promise<void> {
  await db.exec(`TRUNCATE s_phys."${t.physical.table}"; TRUNCATE s_log."${t.id}"`);
  const ids = t.fields.map((f) => f.id);
  for (const [i, r] of rows.entries()) {
    const values = ids.map((id) => r.cells[id] ?? null);
    const ph = values.map((_, j) => `$${j + 3}`).join(", ");
    await db.query(
      `INSERT INTO s_phys."${t.physical.table}" (row_id, revoked, ${ids.map((id) => `"f_${id}"`).join(", ")}) VALUES ($1, $2, ${ph})`,
      [`r${i}`, r.revoked, ...values],
    );
    if (!r.revoked) {
      await db.query(
        `INSERT INTO s_log."${t.id}" (row_id, ${ids.map((id) => `"${id}"`).join(", ")}) VALUES ($1, ${values.map((_, j) => `$${j + 2}`).join(", ")})`,
        [`r${i}`, ...values],
      );
    }
  }
}

type Outcome = { readonly rows: readonly Record<string, unknown>[] } | { readonly error: string };

async function attempt(
  schema: string,
  sql: string,
  params: readonly unknown[] = [],
): Promise<Outcome> {
  try {
    return { rows: (await inSchema(schema, sql, params)).rows };
  } catch (e) {
    const code = String((e as { code?: unknown }).code);
    if (!DATA_ERRORS.has(code)) throw new Error(`${code} ${(e as Error).message}\n${sql}`);
    return { error: code };
  }
}

/** The evaluation's rows decoded, by the JCS of their key. */
function byKey(
  e: RuleEvaluation,
  rows: readonly Record<string, unknown>[],
): Map<string, DerivedRow> {
  const m = new Map<string, DerivedRow>();
  for (const r of rows) {
    const d = e.decode(r);
    if (d === undefined) continue;
    const k = keyText(d.key);
    if (m.has(k)) throw new Error(`two rows with key ${k}`);
    m.set(k, d);
  }
  return m;
}

const sorted = (m: Map<string, DerivedRow>) =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
/** Entries by their text key, in order. */
const byText = <T>(xs: Iterable<readonly [string, T]>) =>
  [...xs].sort(([a], [b]) => (a < b ? -1 : 1));

/** The rule body as printed for evaluation, run over the logical table instead of the CTE. */
const withoutCte = (sql: string) => sql.slice(sql.indexOf(") SELECT ") + 2);

// --- rows of `runs` ----------------------------------------------------------------------------

const DATES = [
  "2025-12-29",
  "2026-01-01",
  "2026-01-04",
  "2026-01-05",
  "2026-10-28",
  "2026-11-01",
  "2026-11-02",
  "2026-11-08",
  "2026-11-30",
  "2026-12-01",
];
const dec = (maxInt: number, scale: number) =>
  fc
    .tuple(fc.integer({ min: -maxInt, max: maxInt }), fc.integer({ min: 0, max: 10 ** scale - 1 }))
    .map(([i, f]) => {
      const s = `${Math.abs(i)}.${String(f).padStart(scale, "0")}`;
      return i < 0 ? `-${s}` : s;
    });
const nullable = <T>(a: fc.Arbitrary<T>) => fc.option(a, { nil: null, freq: 5 });

/** A row of runs (f1 date, f2 distance, f3 duration, f4 feeling, f5 route, f6 laps, f7 pace, f8 started, f9 shoe, f10 race, f11 uphill). */
const runsRow: fc.Arbitrary<Row> = fc
  .record({
    revoked: fc.integer({ min: 0, max: 3 }).map((n) => n === 0),
    f1: fc.constantFrom(...DATES),
    f2: dec(40, 2).map((s) => s.replace(/^-/, "")),
    f3: nullable(dec(90, 1).map((s) => s.replace(/^-/, ""))),
    f4: nullable(fc.constantFrom("", "a", "B", "a b", "说", "😀", ",x")),
    f5: nullable(fc.constantFrom("park", "river")),
    f6: nullable(fc.integer({ min: -3, max: 20 }).map(String)),
    f7: nullable(dec(9, 3)),
    f8: nullable(fc.constantFrom("2026-01-01 06:00:00+00", "2026-11-03 23:30:00+00")),
    f9: nullable(fc.constantFrom("s1", "s2")),
    f10: nullable(fc.boolean()),
    f11: nullable(dec(5, 2)),
  })
  .map(({ revoked, ...cells }) => ({ revoked, cells }));
const runsRows = fc.array(runsRow, { maxLength: 12 });

// --- exact arithmetic for the oracle -----------------------------------------------------------

interface Q {
  readonly n: bigint;
  readonly d: bigint;
}
const gcd = (a: bigint, b: bigint): bigint => {
  let x = a < 0n ? -a : a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};
const q = (n: bigint, d: bigint): Q => {
  if (d < 0n) [n, d] = [-n, -d];
  const g = gcd(n, d) || 1n;
  return { n: n / g, d: d / g };
};
const qOf = (s: string): Q => {
  const [i, f = ""] = s.split(".");
  return q(BigInt(`${i}${f}`.replace(/^(-?)$/, "$10")), 10n ** BigInt(f.length));
};
const add = (a: Q, b: Q) => q(a.n * b.d + b.n * a.d, a.d * b.d);
const div = (a: Q, b: Q) => q(a.n * b.d, a.d * b.n);
const cmp = (a: Q, b: Q) => {
  const l = a.n * b.d;
  const r = b.n * a.d;
  return l < r ? -1 : l > r ? 1 : 0;
};
/** Rounded to `scale` places: half_up away from zero at half, half_even to even; canonical text. */
function roundQ(a: Q, scale: number, mode: "half_up" | "half_even"): string {
  const scaled = a.n * 10n ** BigInt(scale);
  const neg = scaled < 0n;
  const abs = neg ? -scaled : scaled;
  let k = abs / a.d;
  const r2 = (abs % a.d) * 2n;
  if (r2 > a.d || (r2 === a.d && (mode === "half_up" || k % 2n === 1n))) k += 1n;
  if (k === 0n) return "0";
  const digits = k.toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const frac = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac === "" ? "" : `.${frac}`}`;
}
const utf8Less = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b)) < 0;

// --- B: restricted shapes and their meaning ----------------------------------------------------

type Pred = "race" | "laps > 2" | "route = 'park'";
const holds = (p: Pred | undefined, c: Readonly<Record<string, Cell>>): boolean => {
  if (p === undefined) return true;
  if (p === "race") return c["f10"] === true;
  if (p === "laps > 2") return c["f6"] !== null && c["f6"] !== undefined && Number(c["f6"]) > 2;
  return c["f5"] === "park";
};

type Value =
  | { readonly kind: "q"; readonly v: Q }
  | { readonly kind: "s"; readonly v: string }
  | null;

interface Agg {
  readonly sql: string;
  readonly of: (rows: readonly Readonly<Record<string, Cell>>[]) => Value;
}
const nums = (rows: readonly Readonly<Record<string, Cell>>[], f: string) =>
  rows
    .map((r) => r[f])
    .filter((x): x is string => typeof x === "string")
    .map(qOf);
const sumOf =
  (f: string) =>
  (rows: readonly Readonly<Record<string, Cell>>[]): Value => {
    const xs = nums(rows, f);
    return xs.length === 0 ? null : { kind: "q", v: xs.reduce(add) };
  };
const avgOf =
  (f: string) =>
  (rows: readonly Readonly<Record<string, Cell>>[]): Value => {
    const xs = nums(rows, f);
    return xs.length === 0 ? null : { kind: "q", v: div(xs.reduce(add), q(BigInt(xs.length), 1n)) };
  };
const extreme =
  (f: string, max: boolean, text: boolean) =>
  (rows: readonly Readonly<Record<string, Cell>>[]): Value => {
    const xs = rows.map((r) => r[f]).filter((x): x is string => typeof x === "string");
    if (xs.length === 0) return null;
    if (text) {
      const best = xs.reduce((a, b) => (max ? (utf8Less(a, b) ? b : a) : utf8Less(b, a) ? b : a));
      return { kind: "s", v: best };
    }
    const best = xs.map(qOf).reduce((a, b) => (cmp(a, b) * (max ? 1 : -1) >= 0 ? a : b));
    return { kind: "q", v: best };
  };
const countOf =
  (f: string | undefined, distinct = false) =>
  (rows: readonly Readonly<Record<string, Cell>>[]): Value => {
    const xs =
      f === undefined ? rows : rows.map((r) => r[f]).filter((x) => x !== null && x !== undefined);
    const n = distinct ? new Set(xs.map(String)).size : xs.length;
    return { kind: "q", v: q(BigInt(n), 1n) };
  };
const quotient =
  (a: Agg["of"], b: Agg["of"]) =>
  (rows: readonly Readonly<Record<string, Cell>>[]): Value => {
    const x = a(rows);
    const y = b(rows);
    if (x === null || y === null || x.kind !== "q" || y.kind !== "q" || y.v.n === 0n) return null;
    return { kind: "q", v: div(x.v, y.v) };
  };

const AGGS: readonly Agg[] = [
  { sql: "sum(distance)", of: sumOf("f2") },
  { sql: "sum(pace)", of: sumOf("f7") },
  { sql: "sum(laps)", of: sumOf("f6") },
  { sql: "count(*)", of: countOf(undefined) },
  { sql: "count(feeling)", of: countOf("f4") },
  { sql: "count(DISTINCT date)", of: countOf("f1", true) },
  { sql: "count(DISTINCT route)", of: countOf("f5", true) },
  { sql: "min(date)", of: extreme("f1", false, true) },
  { sql: "max(date)", of: extreme("f1", true, true) },
  { sql: "min(distance)", of: extreme("f2", false, false) },
  { sql: "max(pace)", of: extreme("f7", true, false) },
  { sql: "min(laps)", of: extreme("f6", false, false) },
  { sql: "max(feeling)", of: extreme("f4", true, true) },
  { sql: "min(feeling)", of: extreme("f4", false, true) },
  { sql: "avg(distance)", of: avgOf("f2") },
  { sql: "avg(pace)", of: avgOf("f7") },
  { sql: "avg(laps)", of: avgOf("f6") },
  { sql: "avg(duration)", of: avgOf("f3") },
  { sql: "sum(distance) / count(*)", of: quotient(sumOf("f2"), countOf(undefined)) },
  { sql: "sum(pace) / sum(laps)", of: quotient(sumOf("f7"), sumOf("f6")) },
];

type KeyKind =
  | "date"
  | "week"
  | "month"
  | "route"
  | "feeling"
  | "pace"
  | "round_pace"
  | "distance"
  | "distance_plus";
const KEY_KINDS: readonly KeyKind[] = [
  "date",
  "week",
  "month",
  "route",
  "feeling",
  "pace",
  "round_pace",
  "distance",
  "distance_plus",
];
const KEY_SQL: Readonly<Record<KeyKind, string>> = {
  date: "date",
  week: "date_trunc('week', date::timestamp)::date",
  month: "date_trunc('month', date::timestamp)::date",
  route: "route",
  feeling: "feeling",
  // Decimal and quantity keys whose places stay within their scale.
  pace: "pace",
  round_pace: "round(pace, 1)",
  distance: "distance",
  distance_plus: "distance + 1",
};
function keyOf(k: KeyKind, c: Readonly<Record<string, Cell>>): Value {
  const num = (f: string) => (typeof c[f] === "string" ? qOf(c[f] as string) : undefined);
  const text = (f: string): Value =>
    typeof c[f] === "string" ? { kind: "s", v: c[f] as string } : null;
  switch (k) {
    case "route":
      return text("f5");
    case "feeling":
      return text("f4");
    case "pace": {
      const v = num("f7");
      return v === undefined ? null : { kind: "q", v };
    }
    case "round_pace": {
      const v = num("f7");
      return v === undefined ? null : { kind: "q", v: qOf(roundQ(v, 1, "half_up")) };
    }
    case "distance": {
      const v = num("f2");
      return v === undefined ? null : { kind: "q", v };
    }
    case "distance_plus": {
      const v = num("f2");
      return v === undefined ? null : { kind: "q", v: add(v, q(1n, 1n)) };
    }
    default:
      break;
  }
  const d = c["f1"] as string;
  if (k === "date") return { kind: "s", v: d };
  if (k === "month") return { kind: "s", v: `${d.slice(0, 7)}-01` };
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() - ((t.getUTCDay() + 6) % 7));
  return { kind: "s", v: t.toISOString().slice(0, 10) };
}
const valueId = (v: Value) =>
  v === null ? "null" : v.kind === "s" ? `s:${v.v}` : `q:${v.v.n}/${v.v.d}`;

interface Shape {
  readonly key: KeyKind | undefined;
  readonly aggs: readonly { readonly agg: number; readonly filter: Pred | undefined }[];
  readonly where: Pred | undefined;
  readonly having: boolean;
}
const shape: fc.Arbitrary<Shape> = fc
  .record({
    key: fc.option(fc.constantFrom<KeyKind>(...KEY_KINDS), {
      nil: undefined,
      freq: 4,
    }),
    aggs: fc.array(
      fc.record({
        agg: fc.integer({ min: 0, max: AGGS.length - 1 }),
        filter: fc.option(fc.constantFrom<Pred>("race", "laps > 2"), { nil: undefined, freq: 3 }),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    where: fc.option(fc.constantFrom<Pred>("race", "laps > 2", "route = 'park'"), {
      nil: undefined,
      freq: 3,
    }),
    having: fc.boolean(),
  })
  .map((s) => ({
    ...s,
    // FILTER would attach to the divisor's aggregate only: quotients go without.
    aggs: s.aggs.map((a) =>
      (AGGS[a.agg] as Agg).sql.includes("/") ? { ...a, filter: undefined } : a,
    ),
  }));

function ruleSql(s: Shape): { sql: string; fields: string[]; td: "none" | "bucketed" } {
  const outs = [
    ...(s.key !== undefined ? [`${KEY_SQL[s.key]} AS k`] : []),
    ...s.aggs.map(
      (a, i) =>
        `${(AGGS[a.agg] as Agg).sql}${a.filter !== undefined ? ` FILTER (WHERE ${a.filter})` : ""} AS a${i}`,
    ),
  ];
  // A quotient's FILTER would apply to one side only: put it on both by writing it per aggregate.
  const sql = `SELECT ${outs.join(", ")} FROM runs${s.where !== undefined ? ` WHERE ${s.where}` : ""}${s.key !== undefined ? " GROUP BY 1" : ""}${s.having ? " HAVING count(*) > 1" : ""}`;
  const bucket = s.key === "date" || s.key === "week" || s.key === "month";
  return {
    sql,
    fields: [...(s.key !== undefined ? ["k"] : []), ...s.aggs.map((_, i) => `a${i}`)],
    td: bucket ? "bucketed" : "none",
  };
}

/** The rule's rows in exact arithmetic, by the JCS of their key, values as in events. */
function oracle(
  s: Shape,
  e: RuleEvaluation,
  fieldsOf: ReturnType<typeof derivedSchema>,
  rows: readonly Row[],
) {
  const derived = fieldsOf.tables.find((t) => t.id === "t9");
  if (derived === undefined || derived.kind !== "derived") throw new Error("no t9");
  // Row IDs as load gives them (`r<index>`).
  const live = rows
    .map((r, i) => ({ r, id: `r${i}` }))
    .filter(({ r }) => !r.revoked && holds(s.where, r.cells));
  const groups = new Map<
    string,
    { key: Value; rows: Readonly<Record<string, Cell>>[]; ids: string[] }
  >();
  if (s.key === undefined) {
    if (live.length > 0)
      groups.set("", { key: null, rows: live.map((x) => x.r.cells), ids: live.map((x) => x.id) });
  } else {
    for (const { r, id: rowId } of live) {
      const k = keyOf(s.key, r.cells);
      const id = valueId(k);
      const g = groups.get(id) ?? { key: k, rows: [], ids: [] };
      g.rows.push(r.cells);
      g.ids.push(rowId);
      groups.set(id, g);
    }
  }
  const out = new Map<string, DerivedRow>();
  const members = new Map<string, string[]>();
  for (const g of groups.values()) {
    const dropped = s.having && g.rows.length <= 1;
    const values: Record<string, FieldValue> = {};
    const raw: Value[] = [
      ...(s.key !== undefined ? [g.key] : []),
      ...s.aggs.map((a) => (AGGS[a.agg] as Agg).of(g.rows.filter((c) => holds(a.filter, c)))),
    ];
    raw.forEach((v, i) => {
      const f = derived.fields[i];
      if (f === undefined) throw new Error("no field");
      if (v === null) values[f.id] = null;
      else if (v.kind === "s") values[f.id] = v.v as FieldValue;
      else if (f.type === "integer") values[f.id] = roundQ(v.v, 0, "half_up") as FieldValue;
      else if (f.type === "decimal")
        values[f.id] = roundQ(v.v, f.precision.scale, f.precision.rounding) as FieldValue;
      else if (f.type === "quantity")
        values[f.id] = {
          value: roundQ(v.v, f.precision.scale, f.precision.rounding),
          unit: f.unit.code,
        } as FieldValue;
      else values[f.id] = roundQ(v.v, 0, "half_up") as FieldValue;
    });
    const key = s.key === undefined ? [] : [values["f1"] as FieldValue];
    // Every group's members, whether HAVING keeps it or not.
    members.set(keyText(key), [...g.ids].sort());
    if (!dropped) out.set(keyText(key), { values, key });
  }
  void e;
  return Object.assign(out, { members });
}

/** A value with every object's keys in sorted order, as a compiled definition read from the log. */
function sortedKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortedKeys);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.keys(v)
      .sort()
      .map((k) => [k, sortedKeys((v as Record<string, unknown>)[k])]),
  );
}
const fromLog = <T>(schema: T): T => sortedKeys(schema) as T;

/** The members' row IDs by the JCS of their group key, sorted. */
function memberSets(e: RuleEvaluation, rows: readonly Record<string, unknown>[]) {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const m = e.decodeMember(r);
    const k = keyText(m.key);
    const xs = out.get(k);
    if (xs === undefined) out.set(k, [m.row]);
    else xs.push(m.row);
  }
  for (const xs of out.values()) xs.sort();
  return byText(out);
}

/** Every row of the full result is found again, alone and the same, by the partition query. */
async function partitionsAgree(
  e: RuleEvaluation,
  rows: readonly Record<string, unknown>[],
  where: string,
) {
  let n = 0;
  for (const [, d] of byKey(e, rows)) {
    const p = e.partition(d.key);
    const out = await attempt("s_phys", p.sql, p.params);
    if ("error" in out)
      throw new Error(`${where}\npartition ${JSON.stringify(d.key)}: ${out.error}`);
    const found = out.rows.map((r) => e.decode(r)).filter((x) => x !== undefined);
    expect(found, `${where}\npartition ${JSON.stringify(d.key)}`).toEqual([d]);
    n++;
  }
  return n;
}

describe("A: rewriting keeps the meaning (generated rules)", () => {
  it("over the physical table = the body over the logical table = the bound text, decoded", async () => {
    const counts = {
      compiled: 0,
      refused: 0,
      run: 0,
      decimalKeys: 0,
      partitions: 0,
      againstBound: 0,
      divisionByZero: 0,
      dataErrors: 0,
      atRead: 0,
    };
    const runs = tableOf("t1");
    await fc.assert(
      fc.asyncProperty(generatedRule, runsRows, async (g, rows) => {
        const r = compileDerivedRule(rule(g.sql, g.fields, g.timeDependency));
        fc.pre(r.ok);
        counts.compiled++;
        // As the log keeps it: JCS, keys in sorted order.
        const schema = fromLog(derivedSchema(rule(g.sql, g.fields, g.timeDependency)));
        if (evaluationRefusal(schema, "t9") !== undefined) {
          counts.refused++;
          fc.pre(false);
        }
        await load(runs, rows);
        const derived = schema.tables.find((t) => t.id === "t9");
        if (derived === undefined || derived.kind !== "derived") throw new Error("no t9");
        // A rule computed when read is evaluated at a fixed instant, its day passed as a parameter.
        const atRead = computedAtRead(derived);
        const e = evaluateRule(schema, "t9", atRead ? AT_READ : undefined);
        const where = `${g.sql}\n→ ${e.all.sql}`;
        const phys = await attempt("s_phys", e.all.sql, e.all.params);
        const logical = await attempt("s_log", withoutCte(e.all.sql), e.all.params);
        const bag = (o: Outcome) =>
          "error" in o ? o : { rows: o.rows.map((x) => JSON.stringify(x)).sort() };
        expect(bag(phys), where).toEqual(bag(logical));
        counts.run++;
        if (atRead) counts.atRead++;
        if ("error" in phys) {
          counts.dataErrors++;
          return;
        }
        if (
          derived.fields.some(
            (f) =>
              derived.rule.scope.kind === "group" &&
              derived.rule.scope.key.includes(f.id) &&
              (f.type === "decimal" || f.type === "quantity"),
          )
        )
          counts.decimalKeys++;
        counts.partitions += await partitionsAgree(e, phys.rows, where);
        // Every derived row's group has members (HAVING may drop groups that have some).
        const members = await attempt("s_phys", e.members.sql, e.members.params);
        if ("error" in members) throw new Error(`${where}\nmembers: ${members.error}`);
        const memberKeys = new Set(members.rows.map((r) => keyText(e.decodeMember(r).key)));
        for (const k of byKey(e, phys.rows).keys())
          expect(memberKeys.has(k), `${where}\nno members of ${k}`).toBe(true);
        // The bound text as stored, for rules without quotients (whose digits the guard changes) and
        // not computed when read (its text calls saveslot_today(), which the database does not have).
        const bound = derived.rule.sql;
        if (/ \/ |avg\(/.test(bound) || atRead) return;
        const cols = derived.fields.map((f) =>
          f.type === "boolean" ? `"r"."${f.id}"` : `CAST("r"."${f.id}" AS text) AS "${f.id}"`,
        );
        const asStored = await attempt("s_log", `SELECT ${cols.join(", ")} FROM (${bound}) AS "r"`);
        if ("error" in asStored) {
          // Only division by zero in % or mod(), which evaluation turns into NULL.
          expect(asStored.error, where).toBe("22012");
          counts.divisionByZero++;
          return;
        }
        const got = byKey(e, phys.rows);
        // The bound text has no input count: a whole aggregate is compared on its values when it
        // has a row (whether it has one is B's and the fixed cases' to check).
        const whole = derived.rule.scope.kind === "tenant";
        if (whole && got.size === 0) return;
        const want = byKey(
          e,
          asStored.rows.map((x) => (whole ? { ...x, inputs: "1" } : x)),
        );
        expect(sorted(got), where).toEqual(sorted(want));
        counts.againstBound++;
      }),
      { numRuns: propRuns(300) },
    );
    if (process.env["RSQL_FORMS"] !== undefined) console.log(JSON.stringify(counts));
    // Most samples reach the comparison with the bound text; decimal keys (EXTRACT) are run.
    // Rules computed when read are run and their partitions checked, but have no bound text to run.
    expect(counts.againstBound / (counts.run - counts.atRead)).toBeGreaterThanOrEqual(0.4);
    expect(counts.atRead).toBeGreaterThan(0);
    expect(counts.decimalKeys).toBeGreaterThan(0);
    expect(counts.partitions).toBeGreaterThan(0);
  });
});

describe("B: the values are the rule's meaning (restricted shapes)", () => {
  it("decoded rows = exact aggregation of the same rows, rounded to each field's precision", async () => {
    const runs = tableOf("t1");
    let checked = 0;
    await fc.assert(
      fc.asyncProperty(shape, runsRows, async (s, rows) => {
        const { sql, fields, td } = ruleSql(s);
        const r = compileDerivedRule(rule(sql, fields, td));
        // Rules reading no field (count(*) alone) are not compiled yet.
        fc.pre(r.ok || r.error.code !== "not_implemented");
        if (!r.ok) throw new Error(`${sql}: ${JSON.stringify(r.error)}`);
        const schema = derivedSchema(rule(sql, fields, td));
        const e = evaluateRule(schema, "t9");
        await load(runs, rows);
        const out = await attempt("s_phys", e.all.sql);
        if ("error" in out) throw new Error(`${sql}: ${out.error}`);
        const want = oracle(s, e, schema, rows);
        expect(sorted(byKey(e, out.rows)), sql).toEqual(sorted(want));
        // The rule's members: for every group, HAVING or not, its rows after WHERE, by row ID.
        const members = await attempt("s_phys", e.members.sql, e.members.params);
        if ("error" in members) throw new Error(`${sql}: ${members.error}`);
        expect(memberSets(e, members.rows), `${sql}: members`).toEqual(byText(want.members));
        // Among some rows only (every other one, revoked or not): the same sets, kept to them.
        const some = rows.map((_, i) => `r${i}`).filter((_, i) => i % 2 === 0);
        const among = e.membersAmong(some);
        const amongRows = await attempt("s_phys", among.sql, among.params);
        if ("error" in amongRows) throw new Error(`${sql}: ${amongRows.error}`);
        const kept = new Set(some);
        const wantAmong = [...want.members]
          .map(([k, ids]) => [k, ids.filter((id) => kept.has(id))] as const)
          .filter(([, ids]) => ids.length > 0);
        expect(memberSets(e, amongRows.rows), `${sql}: members among`).toEqual(byText(wantAmong));
        await partitionsAgree(e, out.rows, sql);
        checked++;
      }),
      { numRuns: propRuns(200) },
    );
    expect(checked).toBeGreaterThan(0);
  });
});

// --- fixed cases -------------------------------------------------------------------------------

const row = (cells: Record<string, Cell>, revoked = false): Row => ({ revoked, cells });
const run = (date: string, distance: string, more: Record<string, Cell> = {}, revoked = false) =>
  row({ f1: date, f2: distance, ...more }, revoked);

async function rowsOf(e: RuleEvaluation, schema = "s_phys") {
  const out = await attempt(schema, e.all.sql);
  if ("error" in out) throw new Error(out.error);
  return sorted(byKey(e, out.rows)).map(([, d]) => d.values);
}

const WEEKLY =
  "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total_distance, count(*) AS run_count, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM runs GROUP BY 1";
const WEEKLY_FIELDS = [
  "week_start",
  "total_distance",
  "run_count",
  "days_recorded",
  "first_date",
  "last_date",
];

describe("fixed cases", () => {
  it("weekly_mileage on the health fixture (10-evals 3.1), with a revoked run left out", async () => {
    await load(tableOf("t1"), [
      run("2026-10-28", "7"),
      run("2026-11-01", "8", { f3: "50", f4: "很轻松" }),
      run("2026-11-03", "15", { f4: "腿有点酸" }),
      run("2026-11-05", "6"),
      run("2026-11-08", "10"),
      run("2026-11-04", "99", {}, true),
    ]);
    const e = evaluateRule(derivedSchema(rule(WEEKLY, WEEKLY_FIELDS, "bucketed")), "t9");
    expect(await rowsOf(e)).toEqual([
      {
        f1: "2026-10-26",
        f2: { value: "15", unit: "km" },
        f3: "2",
        f4: "2",
        f5: "2026-10-28",
        f6: "2026-11-01",
      },
      {
        f1: "2026-11-02",
        f2: { value: "31", unit: "km" },
        f3: "3",
        f4: "3",
        f5: "2026-11-03",
        f6: "2026-11-08",
      },
    ]);
  });

  it("monthly_total on the ledger fixture (10-evals 3.2)", async () => {
    const expenses = tableOf("t2");
    await db.exec(`${physicalDdl("s_phys", expenses)}; ${logicalDdl("s_log", expenses)}`);
    try {
      await load(expenses, [
        row({ f1: "2026-11-10", f2: "餐饮", f3: "54" }),
        row({ f1: "2026-11-10", f2: "交通", f3: "30" }),
        row({ f1: "2026-11-10", f2: "餐饮", f3: "45" }, true),
      ]);
      const e = evaluateRule(
        derivedSchema(
          rule(
            "SELECT date_trunc('month', date::timestamp)::date AS month, sum(amount) AS total, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM expenses GROUP BY 1",
            ["month", "total", "days_recorded", "first_date", "last_date"],
            "bucketed",
          ),
        ),
        "t9",
      );
      expect(await rowsOf(e)).toEqual([
        {
          f1: "2026-11-01",
          f2: { value: "84", unit: "CNY" },
          f3: "1",
          f4: "2026-11-10",
          f5: "2026-11-10",
        },
      ]);
    } finally {
      await db.exec(
        `DROP TABLE s_phys."${expenses.physical.table}"; DROP TABLE s_log."${expenses.id}"`,
      );
    }
  });

  it("a group whose rows are all revoked has no row; HAVING drops groups", async () => {
    await load(tableOf("t1"), [
      run("2026-11-02", "5"),
      run("2026-11-03", "6"),
      run("2026-10-28", "7", {}, true),
      run("2026-12-01", "1"),
    ]);
    const e = evaluateRule(derivedSchema(rule(WEEKLY, WEEKLY_FIELDS, "bucketed")), "t9");
    expect((await rowsOf(e)).map((v) => v["f1"])).toEqual(["2026-11-02", "2026-11-30"]);
    const h = evaluateRule(
      derivedSchema(
        rule(
          "SELECT date_trunc('week', date::timestamp)::date AS w, count(*) AS n FROM runs GROUP BY 1 HAVING count(*) > 1",
          ["w", "n"],
          "bucketed",
        ),
      ),
      "t9",
    );
    expect(await rowsOf(h)).toEqual([{ f1: "2026-11-02", f2: "2" }]);
  });

  it("a whole aggregate: no row on an empty table or when every row is revoked or filtered out; one row when FILTER matches none", async () => {
    const e = evaluateRule(
      derivedSchema(
        rule(
          "SELECT sum(distance) AS total, count(*) FILTER (WHERE race) AS races FROM runs WHERE laps > 2",
          ["total", "races"],
        ),
      ),
      "t9",
    );
    await load(tableOf("t1"), []);
    expect(await rowsOf(e)).toEqual([]);
    await load(tableOf("t1"), [run("2026-11-02", "5", { f6: "4" }, true)]);
    expect(await rowsOf(e)).toEqual([]);
    await load(tableOf("t1"), [run("2026-11-02", "5", { f6: "1" })]);
    expect(await rowsOf(e)).toEqual([]);
    await load(tableOf("t1"), [run("2026-11-02", "5", { f6: "4", f10: false })]);
    expect(await rowsOf(e)).toEqual([{ f1: { value: "5", unit: "km" }, f2: "0" }]);
  });

  it("a NULL group key: a row of its own, found again by the partition query", async () => {
    await load(tableOf("t1"), [
      run("2026-11-02", "5", { f5: "park" }),
      run("2026-11-03", "6"),
      run("2026-11-04", "7"),
    ]);
    const e = evaluateRule(
      derivedSchema(rule("SELECT route AS r, sum(distance) AS d FROM runs GROUP BY 1", ["r", "d"])),
      "t9",
    );
    expect(await rowsOf(e)).toEqual([
      { f1: "park", f2: { value: "5", unit: "km" } },
      { f1: null, f2: { value: "13", unit: "km" } },
    ]);
    for (const [k, want] of [
      [null, "13"],
      ["park", "5"],
      ["river", undefined],
    ] as const) {
      const p = e.partition([k]);
      const out = await attempt("s_phys", p.sql, p.params);
      if ("error" in out) throw new Error(out.error);
      expect(out.rows.map((r) => e.decode(r)?.values["f2"])).toEqual(
        want === undefined ? [] : [{ value: want, unit: "km" }],
      );
    }
  });

  it("division by zero gives NULL: /, % and mod()", async () => {
    await load(tableOf("t1"), [run("2026-11-02", "5", { f6: "0", f7: "1.5" })]);
    const e = evaluateRule(
      derivedSchema(
        rule(
          "SELECT sum(pace) / sum(laps) AS q, max(laps % laps) AS m, max(mod(laps, laps)) AS n FROM runs",
          ["q", "m", "n"],
        ),
      ),
      "t9",
    );
    expect(await rowsOf(e)).toEqual([{ f1: null, f2: null, f3: null }]);
  });

  it("quotients against values worked by hand: round(a / b, n), in FILTER, in WHERE", async () => {
    // pace 1.5 / laps 3 = 0.5; pace 2.25 / laps 4 = 0.5625; laps 0: the quotient is NULL.
    await load(tableOf("t1"), [
      run("2026-11-02", "10", { f6: "3", f7: "1.5" }),
      run("2026-11-03", "20", { f6: "4", f7: "2.25" }),
      run("2026-11-04", "40", { f6: "0", f7: "9" }),
    ]);
    const one = async (sql: string) => {
      const e = evaluateRule(derivedSchema(rule(sql, ["x"])), "t9");
      return (await rowsOf(e))[0]?.["f1"];
    };
    // (1.5 + 2.25 + 9) / 7 = 12.75 / 7 = 1.82142857…, to 2 places 1.82.
    expect(await one("SELECT round(sum(pace) / sum(laps), 2) AS x FROM runs")).toBe("1.82");
    // Only the 2.25 / 4 row has a quotient above 0.5.
    expect(
      await one("SELECT sum(distance) FILTER (WHERE pace / laps > 0.5) AS x FROM runs"),
    ).toEqual({
      value: "20",
      unit: "km",
    });
    // distance / laps: 3.33…, 5 and NULL; at least 4: one row.
    expect(await one("SELECT count(distance) AS x FROM runs WHERE distance / laps >= 4")).toBe("1");
  });

  it("a string literal with a backslash means the backslash (standard_conforming_strings)", async () => {
    await load(tableOf("t1"), [
      run("2026-11-02", "1", { f4: "a\\" }),
      run("2026-11-02", "1", { f4: "a" }),
      run("2026-11-02", "1", { f4: "a\\\\" }),
    ]);
    const e = evaluateRule(
      derivedSchema(
        rule("SELECT count(feeling) FILTER (WHERE feeling = 'a\\') AS x FROM runs", ["x"]),
      ),
      "t9",
    );
    expect(await rowsOf(e)).toEqual([{ f1: "1" }]);
  });

  it("text keys with quotes and non-ASCII, NULL, and a decimal key: each found again by partition", async () => {
    await load(tableOf("t1"), [
      run("2026-11-02", "1", { f4: "it's", f7: "1.5" }),
      run("2026-11-02", "2", { f4: "说😀", f7: "-0.25" }),
      run("2026-11-02", "3", { f4: null, f7: null }),
      run("2026-11-02", "4", { f4: "'; --", f7: "1.500" }),
    ]);
    for (const [key, n] of [
      ["feeling", 4],
      ["pace", 3],
      ["round(pace, 1)", 3],
    ] as const) {
      const e = evaluateRule(
        derivedSchema(
          rule(`SELECT ${key} AS k, sum(distance) AS d FROM runs GROUP BY 1`, ["k", "d"]),
        ),
        "t9",
      );
      const out = await attempt("s_phys", e.all.sql);
      if ("error" in out) throw new Error(out.error);
      expect(await partitionsAgree(e, out.rows, key)).toBe(n);
    }
  });

  it("avg exactly at half: half_up away from zero, half_even to even", async () => {
    // duration: min, scale 1, half_even; distance: km, scale 2, half_up; avg's scale is 6.
    const e = evaluateRule(
      derivedSchema(rule("SELECT avg(duration) AS d, avg(distance) AS k FROM runs", ["d", "k"])),
      "t9",
    );
    // 64 rows: 0.1 / 64 = 0.0015625 (half: to even, 0.001562); 0.01 / 64 = 0.00015625 (below half).
    await load(
      tableOf("t1"),
      Array.from({ length: 64 }, (_, i) =>
        run("2026-11-02", i === 0 ? "0.01" : "0", { f3: i === 0 ? "0.1" : "0" }),
      ),
    );
    expect(await rowsOf(e)).toEqual([
      { f1: { value: "0.001562", unit: "min" }, f2: { value: "0.000156", unit: "km" } },
    ]);
    // 32 rows: 0.1 / 32 = 0.003125 (exact); 0.01 / 32 = 0.0003125 (half: away from zero, 0.000313).
    await load(
      tableOf("t1"),
      Array.from({ length: 32 }, (_, i) =>
        run("2026-11-02", i === 0 ? "0.01" : "0", { f3: i === 0 ? "0.1" : "0" }),
      ),
    );
    expect(await rowsOf(e)).toEqual([
      { f1: { value: "0.003125", unit: "min" }, f2: { value: "0.000313", unit: "km" } },
    ]);
  });
});

/** readings: values of scale 12, for quotients that need the guard places. */
const READINGS: CompiledBaseTable = {
  id: "t1",
  name: "readings",
  kind: "base",
  description: "values",
  time: { type: "none" },
  physical: { table: "t_t1_v1" },
  fields: [
    {
      id: "f1",
      name: "a",
      type: "decimal",
      description: "a",
      precision: { scale: 12, rounding: "half_up" },
    },
    {
      id: "f2",
      name: "b",
      type: "decimal",
      description: "b",
      precision: { scale: 12, rounding: "half_up" },
    },
  ],
};

describe("quotients need the guard places", () => {
  const schemaOf = (sql: string) =>
    derivedSchema(rule(sql, ["x"], "none", { tables: [READINGS], slot: { name: "lab" } }));

  /** The rows of readings as a SELECT of (row_id, a, b). */
  async function withReadings(rows: string, f: () => Promise<void>) {
    await db.exec(`CREATE SCHEMA s_lab; ${physicalDdl("s_lab", READINGS)}`);
    try {
      await db.exec(
        `INSERT INTO s_lab."t_t1_v1" (row_id, revoked, f_f1, f_f2) SELECT r, false, a, b FROM (${rows}) AS v(r, a, b)`,
      );
      await f();
    } finally {
      await db.exec("DROP SCHEMA s_lab CASCADE");
    }
  }
  const resultOf = async (e: RuleEvaluation) => {
    const rows = await rowsOf(e, "s_lab");
    return rows[0]?.["f1"];
  };
  /** The bound text as stored, without the guard: what the value would be without it. */
  const unguarded = async (schema: ReturnType<typeof schemaOf>, e: RuleEvaluation) => {
    const t9 = schema.tables.find((t) => t.id === "t9");
    if (t9 === undefined || t9.kind !== "derived") throw new Error("no t9");
    const head = e.all.sql.slice(0, e.all.sql.indexOf(") SELECT ") + 1);
    const out = await attempt(
      "s_lab",
      `${head} SELECT CAST("r"."f1" AS text) AS "f1", 1 AS "inputs" FROM (${t9.rule.sql}) AS "r"`,
    );
    if ("error" in out) throw new Error(out.error);
    return e.decode(out.rows[0] as Record<string, unknown>)?.values["f1"];
  };

  it("a quotient just below half is not taken for half (a / b)", async () => {
    // a / b = 0.5000000000005 − 5·10^-25: rounds to 0.5 at 12 places. Unguarded, PostgreSQL gives
    // 16 significant digits, 0.5000000000005000, which then rounds up.
    await withReadings("VALUES ('r1', 1.000000000002, 2.000000000002)", async () => {
      const s = schemaOf("SELECT sum(a) / sum(b) AS x FROM readings");
      const e = evaluateRule(s, "t9");
      expect(await resultOf(e)).toBe("0.5");
      expect(await unguarded(s, e)).toBe("0.500000000001");
    });
  });

  it("an average just below half is not taken for half (avg)", async () => {
    // 32767 rows of 9 and one of 9.000000016383: the sum is 32768 × 9.0000000000005 − 10^-12, the
    // average 9.0000000000005 − 3.05·10^-17: rounds to 9 at 12 places. Unguarded, PostgreSQL gives
    // it to 16 places, 9.0000000000005000, which then rounds up.
    const rows =
      "SELECT 'r' || i, CASE WHEN i = 1 THEN 9.000000016383 ELSE 9 END, 1 FROM generate_series(1, 32768) AS g(i)";
    await withReadings(rows, async () => {
      const s = schemaOf("SELECT avg(a) AS x FROM readings");
      const e = evaluateRule(s, "t9");
      expect(await resultOf(e)).toBe("9");
      expect(await unguarded(s, e)).toBe("9.000000000001");
    });
  });

  it("a large divisor: 30 places would not do, 45 do", async () => {
    // 50000 / (10^17 + 10^-12) = 5·10^-13 − 5·10^-42: rounds to 0 at 12 places. At 30 places it
    // would be 5·10^-13 exactly, and round up.
    await withReadings("VALUES ('r1', 50000, 100000000000000000.000000000001)", async () => {
      const s = schemaOf("SELECT sum(a) / sum(b) AS x FROM readings");
      const e = evaluateRule(s, "t9");
      expect(await resultOf(e)).toBe("0");
      const at30 = await attempt(
        "s_lab",
        `SELECT CAST(CAST(sum(f_f1) AS numeric(1000, 30)) / NULLIF(sum(f_f2), 0) AS text) AS x FROM "t_t1_v1"`,
      );
      if ("error" in at30) throw new Error(at30.error);
      // Exactly half at 12 places, as far as it goes.
      expect(at30.rows[0]?.["x"]).toMatch(/^0\.00000000000050+$/);
    });
  });
});
