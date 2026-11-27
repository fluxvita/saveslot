// The whitelist in code (./whitelist.ts) against the tables of 03-data-model/11-restricted-sql.md
// «白名单» and «类型转换», item by item and context by context (11 «怎么测»: the whitelist is data,
// the spec's tables agree with it, checked mechanically); and against the compiler, entry by
// entry: what the data admits for derived rules compiles, what it does not is refused.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { compileDerivedRule, type DerivedRuleResult } from "./derived.ts";
import { loadRsql } from "./load.ts";
import { rule } from "./rules.fixture.ts";
import {
  AGGREGATES,
  CASTS,
  type Context,
  FUNCTIONS,
  NODES,
  OPERATORS,
  WINDOW_FUNCTIONS,
} from "./whitelist.ts";

const SPEC = readFileSync(
  join(import.meta.dirname, "../../../../../docs/zh-CN/spec/03-data-model/11-restricted-sql.md"),
  "utf8",
);

/** The rows of the first table after `marker`, split into cells. */
function table(marker: string): string[][] {
  const at = SPEC.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} in the spec`);
  const lines = SPEC.slice(at).split("\n");
  const start = lines.findIndex((l) => l.startsWith("|"));
  const rows: string[][] = [];
  for (const l of lines.slice(start + 2)) {
    if (!l.startsWith("|")) break;
    rows.push(
      l
        .slice(1, -1)
        .split(/(?<!\\)\|/)
        .map((c) => c.trim()),
    );
  }
  return rows;
}

/** Backticked items of a cell. */
const ticks = (cell: string) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1] as string);
/** The leading name of a backticked item: `count(*)` → count, `EXTRACT(…)` → extract. */
const nameOf = (s: string) => (/^[A-Za-z_]+/.exec(s)?.[0] ?? s).toLowerCase();
/** Contexts named by letters (`S D M`), or by columns of `收` / `不收` (accepted / not). */
const letters = (cell: string): Context[] =>
  (["S", "D", "M"] as const).filter((c) =>
    new RegExp(`\\b${c}\\b`).test(cell.split("（")[0] ?? ""),
  );
const accepts = (cell: string) => cell.startsWith("收");

const sorted = (xs: Iterable<string>) => [...xs].sort();
const byName = (
  list: readonly { name: string; aliases?: readonly string[]; contexts: readonly Context[] }[],
) =>
  new Map(
    list.flatMap((e) =>
      [e.name, ...(e.aliases ?? [])].map((n) => [n, [...e.contexts].sort()] as const),
    ),
  );

describe("the whitelist in code is the spec's", () => {
  it("nodes: 32 kinds, with their contexts", () => {
    const spec = new Map(
      table("#### 语法树节点").flatMap((r) =>
        ticks(r[0] ?? "").map((n) => [n, letters(r[2] ?? "").sort()] as const),
      ),
    );
    expect(spec.size).toBe(32);
    expect(byName(NODES)).toEqual(spec);
  });

  it("functions: every name and synonym, with their contexts", () => {
    const spec = new Map<string, Context[]>();
    for (const r of table("#### 函数")) {
      for (const n of ticks(r[0] ?? "")) {
        // `trim(…)` is SQL syntax for btrim / ltrim / rtrim, not a function of its own.
        if (nameOf(n) === "trim") continue;
        spec.set(nameOf(n), letters(r[3] ?? "").sort());
      }
    }
    // The three saveslot functions' contexts are in the «时间» table.
    for (const r of table("| 函数 | 结果 | 含义 |")) {
      const ctx: Context[] = [];
      if (accepts(r[3] ?? "")) ctx.push("S");
      if (accepts(r[4] ?? "")) ctx.push("D");
      if (accepts(r[5] ?? "")) ctx.push("M");
      spec.set(nameOf(ticks(r[0] ?? "")[0] ?? ""), ctx.sort());
    }
    expect(byName(FUNCTIONS)).toEqual(spec);
    expect(FUNCTIONS.length).toBe(24);
  });

  it("aggregates, with their contexts", () => {
    const spec = new Map(
      table("#### 聚合函数").flatMap((r) =>
        ticks(r[0] ?? "").map((n) => [nameOf(n), letters(r[2] ?? "").sort()] as const),
      ),
    );
    expect(byName(AGGREGATES)).toEqual(spec);
  });

  it("window functions, with their contexts; the five aggregates also as windows", () => {
    const rows = table("#### 窗口函数");
    const spec = new Map<string, Context[]>();
    for (const r of rows) {
      const ctx = [
        ...(accepts(r[1] ?? "") ? ["S" as const] : []),
        ...(accepts(r[2] ?? "") ? ["D" as const] : []),
      ];
      // The first row reads "count … max 加 `OVER (…)`": OVER is the clause, not a function.
      for (const n of ticks(r[0] ?? "").map(nameOf)) if (n !== "over") spec.set(n, ctx.sort());
    }
    for (const a of ["count", "sum", "avg", "min", "max"]) {
      expect(spec.get(a)).toEqual(["D", "S"]);
      spec.delete(a);
    }
    expect(byName(WINDOW_FUNCTIONS)).toEqual(spec);
  });

  it("operators: every symbol in code is in the spec's table, and the other way", () => {
    const cells = table("#### 运算符").map((r) => r[0] ?? "");
    const spec = new Set<string>();
    for (const c of cells) {
      for (const t of ticks(c.replaceAll("\\|", "|"))) {
        if (/^[^A-Za-z]+$/.test(t)) spec.add(t === "!=" ? "<>" : t);
        if (t === "LIKE") spec.add("~~");
        if (t === "NOT LIKE") spec.add("!~~");
      }
    }
    expect(sorted(OPERATORS.map((o) => o.name))).toEqual(sorted(spec));
    for (const o of OPERATORS) expect(o.contexts).toEqual(["S", "D", "M"]);
  });

  it("type casts: each accepted row, with its contexts", () => {
    const spec = new Set<string>();
    for (const r of table("| 转换 | `sql` |")) {
      const [from, ...to] = ticks(r[0] ?? "");
      const ctx = ["S", "D", "M"].filter((_, i) => accepts(r[i + 1] ?? ""));
      if (ctx.length === 0 || from === undefined) continue;
      for (const t of to) spec.add(`${from}→${nameOf(t)}:${ctx.join("")}`);
    }
    const code = new Set(
      CASTS.filter((c) => c.from !== "unknown").map(
        (c) => `${c.from}→${c.to}:${c.contexts.join("")}`,
      ),
    );
    expect(sorted(code)).toEqual(sorted(spec));
    // The one cast not in that table: the typed literal DATE '…' (11 «类型 · 字面量»).
    expect(CASTS.filter((c) => c.from === "unknown")).toEqual([
      { from: "unknown", to: "date", contexts: ["S", "D", "M"] },
    ]);
  });
});

// --- the data against the compiler ---------------------------------------------------------------

beforeAll(() => loadRsql());

/** `code/sql_reason`, the error code, or "compiled". */
function outcome(r: DerivedRuleResult): string {
  if (r.ok) return "compiled";
  if (r.error.code !== "validation_failed") return r.error.code;
  const [d] = r.error.details;
  return `${d.code}${d.sql_reason !== undefined ? `/${d.sql_reason}` : ""}`;
}
const inCount = (e: string) =>
  outcome(compileDerivedRule(rule(`SELECT count(${e}) AS x FROM runs WHERE laps > 0`, ["x"])));
const asOutput = (e: string) =>
  outcome(compileDerivedRule(rule(`SELECT ${e} AS x FROM runs WHERE laps > 0`, ["x"])));

/** A call of each function, written so that it compiles when the function is admitted. */
const FUNCTION_SAMPLES: ReadonlyMap<string, string> = new Map([
  ["abs", "abs(laps)"],
  ["round", "round(pace, 1)"],
  ["trunc", "trunc(pace)"],
  ["floor", "floor(pace)"],
  ["ceil", "ceil(pace)"],
  ["ceiling", "ceiling(pace)"],
  ["sign", "sign(pace)"],
  ["mod", "mod(laps, 3)"],
  ["date_trunc", "date_trunc('month', date::timestamp)::date"],
  ["extract", "EXTRACT(year FROM date)"],
  ["make_date", "make_date(2026, 1, 1)"],
  ["length", "length(feeling)"],
  ["char_length", "char_length(feeling)"],
  ["substr", "substr(feeling, 1, 2)"],
  ["substring", "substring(feeling, 1, 2)"],
  ["left", "left(feeling, 2)"],
  ["right", "right(feeling, 2)"],
  ["strpos", "strpos(feeling, 'a')"],
  ["position", "position('a' IN feeling)"],
  ["starts_with", "starts_with(feeling, 'a')"],
  ["btrim", "btrim(feeling)"],
  ["ltrim", "ltrim(feeling)"],
  ["rtrim", "rtrim(feeling)"],
  ["replace", "replace(feeling, 'a', 'b')"],
  ["split_part", "split_part(feeling, ',', 2)"],
  ["saveslot_now", "started < saveslot_now()"],
  ["saveslot_today", "date < saveslot_today()"],
  ["saveslot_date", "saveslot_date(started)"],
]);

/** Functions of PostgreSQL that are not in the data (the same kind of thing, refused). */
const NOT_IN_DATA = [
  "lower",
  "upper",
  "concat",
  "md5",
  "sqrt",
  "power",
  "exp",
  "ln",
  "log",
  "greatest_common_divisor",
  "gcd",
  "lcm",
  "div",
  "width_bucket",
  "ascii",
  "chr",
  "repeat",
  "reverse",
  "lpad",
  "rpad",
  "overlay",
  "translate",
  "age",
  "date_part",
  "make_interval",
  "to_date",
  "to_number",
  "numnonnulls",
  "num_nulls",
  "array_length",
  "quote_literal",
  "format",
];

describe("the data decides what derived rules admit", () => {
  it("every function and synonym in the data has a sample", () => {
    const names = FUNCTIONS.flatMap((f) => [f.name, ...(f.aliases ?? [])]);
    expect([...FUNCTION_SAMPLES.keys()].sort()).toEqual(names.sort());
  });

  it.each(
    FUNCTIONS.flatMap((f) =>
      [f.name, ...(f.aliases ?? [])].map((n) => [n, f.contexts.includes("D")] as const),
    ),
  )("function %s: compiles iff the data marks it for derived rules (%s)", (name, d) => {
    const e = FUNCTION_SAMPLES.get(name) as string;
    const usesNow = name === "saveslot_now" || name === "saveslot_today";
    const r = compileDerivedRule(
      rule(`SELECT count(${e}) AS x FROM runs WHERE laps > 0`, ["x"], usesNow ? "now" : "none"),
    );
    expect(outcome(r)).toBe(d ? "compiled" : "rule_sql_rejected/function");
  });

  it.each(NOT_IN_DATA)("function %s, not in the data: refused", (name) => {
    expect(FUNCTION_SAMPLES.has(name)).toBe(false);
    expect(inCount(`${name}(feeling)`)).toMatch(
      /^(rule_sql_rejected|nondeterministic_function)\/function$/,
    );
  });

  const AGGREGATE_SAMPLES: ReadonlyMap<string, string> = new Map([
    ["count", "count(laps)"],
    ["sum", "sum(laps)"],
    ["avg", "avg(pace)"],
    ["min", "min(feeling)"],
    ["max", "max(date)"],
    ["bool_and", "bool_and(race)"],
    ["bool_or", "bool_or(race)"],
  ]);

  it.each(AGGREGATES.map((a) => [a.name, a.contexts.includes("D")] as const))(
    "aggregate %s: compiles iff marked for derived rules (%s)",
    (name, d) => {
      expect(asOutput(AGGREGATE_SAMPLES.get(name) as string)).toBe(
        d ? "compiled" : "rule_sql_rejected/function",
      );
    },
  );

  it.each([
    "string_agg(feeling, ',')",
    "array_agg(laps)",
    "stddev(pace)",
    "variance(pace)",
    "every(race)",
    "bit_and(laps)",
  ])("aggregate not in the data: %s refused", (e) => {
    expect(asOutput(e)).toBe("rule_sql_rejected/function");
  });

  const OPERATOR_SAMPLES: ReadonlyMap<string, string> = new Map([
    ["=", "laps = 1"],
    ["<>", "laps <> 1"],
    ["<", "laps < 1"],
    ["<=", "laps <= 1"],
    [">", "laps > 1"],
    [">=", "laps >= 1"],
    ["+", "laps + 1"],
    ["-", "laps - 1"],
    ["*", "laps * 2"],
    ["/", "pace / 2"],
    ["%", "laps % 2"],
    ["||", "feeling || 'x'"],
    ["~~", "feeling LIKE 'a%'"],
    ["!~~", "feeling NOT LIKE 'a%'"],
  ]);

  it.each(OPERATORS.map((o) => [o.name, o.contexts.includes("D")] as const))(
    "operator %s: compiles iff marked for derived rules (%s)",
    (name, d) => {
      expect(inCount(OPERATOR_SAMPLES.get(name) as string)).toBe(
        d ? "compiled" : "rule_sql_rejected/function",
      );
    },
  );

  it.each([
    "laps ^ 2",
    "laps & 1",
    "laps | 1",
    "laps # 1",
    "laps << 1",
    "feeling ~ 'a'",
    "feeling ~~* 'a'",
    "feeling ~~ 'a'",
    "|/ pace",
    "@ laps",
    "~ laps",
  ])("operator not in the data (or not in this form): %s refused", (e) => {
    expect(inCount(e)).toBe("rule_sql_rejected/function");
  });

  const CAST_SAMPLES: ReadonlyMap<string, string> = new Map([
    ["bigint→numeric", "laps::numeric"],
    ["numeric→bigint", "pace::bigint"],
    ["numeric→numeric", "pace::numeric(10, 2)"],
    ["date→timestamp", "date::timestamp"],
    ["timestamp→date", "date::timestamp::date"],
    ["unknown→date", "DATE '2026-01-01'"],
    ["text→numeric", "feeling::numeric"],
    ["text→bigint", "feeling::bigint"],
    ["text→boolean", "feeling::boolean"],
  ]);

  it.each(CASTS.map((c) => [`${c.from}→${c.to}`, c.contexts.includes("D")] as const))(
    "cast %s: compiles iff marked for derived rules (%s)",
    (key, d) => {
      const e = CAST_SAMPLES.get(key) as string;
      // A timestamp is no value of a derived rule's output; count it through a cast back.
      const x = key === "date→timestamp" ? `${e}::date` : e;
      expect(inCount(x)).toBe(d ? "compiled" : "rule_sql_rejected/function");
    },
  );

  it.each([
    "laps::text",
    "laps::int4",
    "laps::float8",
    "date::timestamptz",
    "laps::boolean",
    "race::bigint",
    "date::numeric",
  ])("cast not in the data: %s refused", (e) => {
    expect(inCount(e)).toMatch(/^(rule_sql_rejected|nondeterministic_function)\/function$/);
  });

  /** Each node marked for derived rules, in a rule using it; some stop as not compiled yet. */
  const NODE_SAMPLES: ReadonlyMap<string, readonly [string, string]> = new Map([
    ["RawStmt", ["SELECT count(laps) AS x FROM runs", "compiled"]],
    ["SelectStmt", ["SELECT count(laps) AS x FROM runs", "compiled"]],
    ["ResTarget", ["SELECT count(laps) AS x FROM runs", "compiled"]],
    ["ColumnRef", ["SELECT count(laps) AS x FROM runs", "compiled"]],
    ["A_Const", ["SELECT count(laps) AS x FROM runs WHERE laps > 1", "compiled"]],
    ["TypeCast", ["SELECT count(laps::numeric) AS x FROM runs", "compiled"]],
    ["TypeName", ["SELECT count(laps::numeric) AS x FROM runs", "compiled"]],
    ["A_Expr", ["SELECT count(laps + 1) AS x FROM runs", "compiled"]],
    ["BoolExpr", ["SELECT count(race AND race) AS x FROM runs", "compiled"]],
    ["NullTest", ["SELECT count(laps IS NULL) AS x FROM runs", "compiled"]],
    ["BooleanTest", ["SELECT count(race IS TRUE) AS x FROM runs", "compiled"]],
    [
      "CaseExpr",
      ["SELECT count(CASE WHEN race THEN 1 END) AS x FROM runs WHERE laps > 0", "compiled"],
    ],
    [
      "CaseWhen",
      ["SELECT count(CASE WHEN race THEN 1 END) AS x FROM runs WHERE laps > 0", "compiled"],
    ],
    ["CoalesceExpr", ["SELECT count(COALESCE(laps, 1)) AS x FROM runs", "compiled"]],
    ["MinMaxExpr", ["SELECT count(GREATEST(laps, 1)) AS x FROM runs", "compiled"]],
    ["FuncCall", ["SELECT count(abs(laps)) AS x FROM runs", "compiled"]],
    ["SubLink", ["SELECT count(laps) AS x FROM runs WHERE EXISTS (SELECT 1)", "not_implemented"]],
    ["RangeVar", ["SELECT count(laps) AS x FROM runs", "compiled"]],
    ["Alias", ["SELECT count(r.laps) AS x FROM runs r", "compiled"]],
    ["JoinExpr", ["SELECT count(laps) AS x FROM runs JOIN shoes ON true", "not_implemented"]],
    ["RangeSubselect", ["SELECT count(laps) AS x FROM (SELECT 1) s", "not_implemented"]],
    ["WithClause", ["WITH s AS (SELECT 1) SELECT count(laps) AS x FROM runs", "not_implemented"]],
    [
      "CommonTableExpr",
      ["WITH s AS (SELECT 1) SELECT count(laps) AS x FROM runs", "not_implemented"],
    ],
    ["SortBy", ["SELECT rank() OVER (ORDER BY laps) AS x FROM runs", "not_implemented"]],
    ["WindowDef", ["SELECT rank() OVER (ORDER BY laps) AS x FROM runs", "not_implemented"]],
    ["String", ["SELECT count(feeling = 'a') AS x FROM runs", "compiled"]],
    ["Integer", ["SELECT count(laps) AS x FROM runs WHERE laps > 1", "compiled"]],
    ["Float", ["SELECT count(laps) AS x FROM runs WHERE pace > 1.5", "compiled"]],
    ["Boolean", ["SELECT count(laps) AS x FROM runs WHERE race = TRUE", "compiled"]],
    ["List", ["SELECT count(laps) AS x FROM runs WHERE laps IN (1, 2)", "compiled"]],
    ["A_Star", ["SELECT * FROM runs", "rule_sql_rejected/node"]],
    ["ParamRef", ["SELECT count(laps) AS x FROM runs WHERE laps > $1", "rule_sql_rejected/node"]],
  ]);

  it("every node in the data has a sample", () => {
    expect([...NODE_SAMPLES.keys()].sort()).toEqual(NODES.map((n) => n.name).sort());
  });

  it.each(NODES.map((n) => [n.name, n.contexts.includes("D")] as const))(
    "node %s: admitted iff marked for derived rules (%s)",
    (name, d) => {
      const [sql, expected] = NODE_SAMPLES.get(name) as readonly [string, string];
      const got = outcome(compileDerivedRule(rule(sql, ["x"])));
      expect(got).toBe(expected);
      expect(d).toBe(expected !== "rule_sql_rejected/node");
    },
  );

  it.each([
    ["A_Indirection", "SELECT count((laps)[1]) AS x FROM runs"],
    ["A_ArrayExpr", "SELECT count(ARRAY[laps]) AS x FROM runs"],
    ["RowExpr", "SELECT count(ROW(laps, 1)) AS x FROM runs"],
    ["CollateClause", 'SELECT count(feeling COLLATE "C") AS x FROM runs'],
    ["RangeTableSample", "SELECT count(laps) AS x FROM runs TABLESAMPLE SYSTEM (10)"],
    ["XmlExpr", "SELECT count(xmlelement(name a)) AS x FROM runs"],
    ["GroupingFunc", "SELECT count(GROUPING(laps)) AS x FROM runs GROUP BY laps"],
  ])("node not in the data: %s refused", (_, sql) => {
    expect(outcome(compileDerivedRule(rule(sql, ["x"])))).toBe("rule_sql_rejected/node");
  });
});
