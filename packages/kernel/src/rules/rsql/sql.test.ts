// The front end of the `sql` operation (./sql.ts; 11-restricted-sql.md «处理步骤» 1–6, context S),
// offline: the whitelist for S, names, types and units, limits, parameters, time, printing. Every
// case the spec names is a fixed test here (./sql-cases.fixture.ts, ./sql-positive.fixture.ts); the
// properties over spellings and random statements are in ./sql.prop.test.ts.

import { SQL_REASONS } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it, vi } from "vitest";
import { ExprTyper } from "./analyze.ts";
import { convertQuery } from "./convert.ts";
import { compileDerivedRule } from "./derived.ts";
import type { Expr, Query } from "./ir.ts";
import { loadRsql, rsqlParser } from "./load.ts";
import { derivedSchema, rule } from "./rules.fixture.ts";
import {
  baseTables,
  check,
  health,
  healthSchema,
  ledger,
  outcome,
  refusal,
} from "./sql.fixture.ts";
import { readSql, type SqlSlot } from "./sql.ts";
import {
  FUNCTION_EXPR,
  inRuns,
  NAME_STMT,
  NODE_EXPR,
  NODE_STMT,
  NOT_SELECT,
  REFUSED,
  SYNTAX,
  SYSTEM_TIME,
  TIME_CLAUSE,
  TYPE_EXPR,
} from "./sql-cases.fixture.ts";
import { variations } from "./sql-mutate.fixture.ts";
import { POSITIVE } from "./sql-positive.fixture.ts";
import { printQuery } from "./sql-print.ts";
import {
  AGGREGATES,
  FUNCTIONS,
  NODES,
  NONDETERMINISTIC_FUNCTIONS,
  OPERATORS,
  WINDOW_FUNCTIONS,
} from "./whitelist.ts";

await loadRsql();

const both = [health(), ledger()];
const stmt = (c: { where: string; sql: string }) => (c.where === "expr" ? inRuns(c.sql) : c.sql);

/** An IR without places, as a string: two trees are the same query when these are equal. */
const shape = (q: unknown): string =>
  JSON.stringify(q, (k, v: unknown) =>
    k === "loc"
      ? undefined
      : v !== null && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
        : v,
  );

function columns(sql: string, params: unknown[] = [], slots = [health()]): string {
  const r = check(sql, params, slots);
  if (!r.ok) throw new Error(`${sql}\n→ ${JSON.stringify(r.error)}`);
  return r.analysis.columns
    .map((c) => `${c.name}:${c.type}${c.unit !== undefined ? `:${c.unit}` : ""}`)
    .join(",");
}

describe("queries the spec and the guide give, and one of each form S has", () => {
  it.each(POSITIVE.map((p) => [p.name, p] as const))("%s", (_name, p) => {
    const r = check(p.sql, [...(p.params ?? [])], p.ledger === true ? both : [health()]);
    if (!r.ok) throw new Error(`${p.sql}\n→ ${JSON.stringify(r.error)}`);
    expect(r.paramCount).toBe(p.params?.length ?? 0);
    if (p.columns !== undefined) {
      expect(
        r.analysis.columns
          .map((c) => `${c.name}:${c.type}${c.unit !== undefined ? `:${c.unit}` : ""}`)
          .join(","),
      ).toBe(p.columns);
    }
  });

  it("have the documented ones from the documents' own sources", () => {
    // The spec's examples are in the list, as the spec writes them.
    expect(POSITIVE.filter((p) => p.source !== undefined).length).toBeGreaterThanOrEqual(12);
  });
});

describe("whole-statement refusals: `not_select`", () => {
  it.each(NOT_SELECT.map((c) => [c.sql === "" ? "(empty)" : c.sql, c] as const))("%s", (_n, c) => {
    expect(outcome(check(c.sql))).toBe("sql_rejected/not_select");
  });

  it("gives no line for a statement with no place, and the node's kind for one with", () => {
    expect(refusal("DELETE FROM runs")).toMatchObject({ reason: "not_select", node: "DeleteStmt" });
    expect(refusal("SELECT 1; SELECT 2")).toMatchObject({ reason: "not_select" });
  });
});

describe("refusals inside a SELECT: `node`", () => {
  it.each(NODE_STMT.map((c) => [c.sql, c] as const))("%s", (_n, c) => {
    expect(outcome(check(c.sql))).toBe("sql_rejected/node");
  });
  it.each(NODE_EXPR.map((c) => [c.sql, c] as const))("%s", (_n, c) => {
    expect(outcome(check(inRuns(c.sql)))).toBe("sql_rejected/node");
  });
});

describe("functions, operators and casts: `function`, by 11 «确定性» 1–4 and the tables", () => {
  it.each(FUNCTION_EXPR.map((c) => [c.sql, c] as const))("%s", (_n, c) => {
    expect(outcome(check(inRuns(c.sql)))).toBe("sql_rejected/function");
  });

  it("refuses each name of the list of functions refused for not being determined", () => {
    for (const f of NONDETERMINISTIC_FUNCTIONS) {
      expect({ f, got: outcome(check(inRuns(`${f}()`))) }).toEqual({
        f,
        got: "sql_rejected/function",
      });
    }
  });

  it("says the function's name", () => {
    expect(refusal(inRuns("lower(feeling)"))).toMatchObject({ reason: "function", node: "lower" });
    expect(refusal(inRuns("now()"))).toMatchObject({ reason: "function", node: "now" });
    expect(refusal(inRuns("feeling ILIKE 'a'"))).toMatchObject({ reason: "function", node: "~~*" });
  });
});

describe("types and units: `type`", () => {
  it.each(TYPE_EXPR.map((c) => [c.sql, c] as const))("%s", (_n, c) => {
    expect(outcome(check(inRuns(c.sql)))).toBe("sql_rejected/type");
  });
});

describe("names that do not resolve: `unknown_name`", () => {
  it.each(NAME_STMT.map((c) => [c.sql, c] as const))("%s", (_n, c) => {
    expect(outcome(check(c.sql))).toBe("sql_rejected/unknown_name");
  });

  it("says the name as the caller wrote it, and no physical name", () => {
    expect(refusal("SELECT * FROM Pg_Class")).toMatchObject({ node: "pg_class" });
    const all = JSON.stringify(refusal("SELECT * FROM nosuch"));
    for (const t of healthSchema().tables) expect(all).not.toContain(t.physical.table);
  });

  it("never lets a physical name or an internal one reach the caller", () => {
    const physical = healthSchema().tables.map((t) => t.physical.table);
    for (const c of REFUSED) {
      if (physical.some((p) => c.sql.includes(p))) continue;
      const r = check(stmt(c));
      expect({ sql: c.sql, leaks: physical.filter((p) => JSON.stringify(r).includes(p)) }).toEqual({
        sql: c.sql,
        leaks: [],
      });
    }
  });
});

describe("record time and valid time", () => {
  it.each(SYSTEM_TIME.map((c) => [c.sql, c] as const))("%s", (_n, c) => {
    expect(refusal(c.sql)).toMatchObject({
      code: "sql_rejected",
      reason: "system_time",
      use: "history",
    });
  });

  it("is refused only as a clause, not where `for system_time` names something else", () => {
    // `substring(t FOR system_time)` is a column here.
    expect(outcome(check("SELECT substring(feeling FROM 1 FOR laps) FROM runs"))).toBe(
      "sql_rejected/function",
    );
    expect(outcome(check("SELECT 'FOR SYSTEM_TIME AS OF x' FROM runs"))).toBe("ok");
    expect(outcome(check("SELECT 1 FROM runs /* FOR SYSTEM_TIME AS OF x */"))).toBe("ok");
  });

  it.each(TIME_CLAUSE.map((c) => [c.sql, c] as const))("%s", (_n, c) => {
    expect(outcome(check(c.sql))).toBe(c.want);
  });

  it("keeps the line numbers of the caller's text where a clause was cut out", () => {
    const sql =
      "SELECT amount\nFROM budgets FOR VALID_TIME\n  AS OF saveslot_today()\nWHERE lower(category) = 'a'";
    expect(refusal(sql)).toMatchObject({ reason: "function", line: 4, node: "lower" });
    const multi =
      "SELECT 'éé', amount\nFROM budgets FOR VALID_TIME AS OF '2026-01-01' AS b\nWHERE b.nosuch = 1";
    expect(refusal(multi)).toMatchObject({ reason: "unknown_name", line: 3 });
  });

  it("takes each clause to its table, by slot name and alias too", () => {
    const r = check(
      "SELECT 1 FROM health.budgets FOR VALID_TIME AS OF '2026-01-01' b, budgets FOR VALID_TIME FROM $1 TO $2 c",
      ["2026-01-01", "2026-02-01"],
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect([...r.analysis.tables.values()].map((t) => t.table)).toEqual(["t3", "t3"]);
  });

  it("reads a state table now when no clause says when (11 «时间»), an event table not", () => {
    const now = (sql: string, params: unknown[] = []) => {
      const r = check(sql, params);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return r.analysis.usesNow;
    };
    expect(now("SELECT amount FROM budgets")).toBe(true);
    expect(now("SELECT amount FROM budgets FOR VALID_TIME AS OF '2026-01-01'")).toBe(false);
    expect(now("SELECT amount FROM budgets FOR VALID_TIME AS OF saveslot_today()")).toBe(true);
    expect(now("SELECT laps FROM runs")).toBe(false);
    expect(now("SELECT saveslot_now()")).toBe(true);
    expect(now("SELECT laps FROM runs WHERE date = saveslot_today()")).toBe(true);
    expect(now("SELECT laps FROM runs WHERE date = $1", ["2026-01-01"])).toBe(false);
  });

  it("takes saveslot_today() only when the slots read agree on a time zone", () => {
    const mixed = "SELECT saveslot_today(), r.laps FROM health.runs r, ledger.expenses e";
    expect(refusal(mixed, [], both)).toMatchObject({
      code: "sql_rejected",
      reason: "function",
      node: "saveslot_today",
    });
    expect(outcome(check("SELECT saveslot_today() FROM health.runs r", [], both))).toBe("ok");
    expect(outcome(check("SELECT saveslot_today()", [], both))).toBe("ok");
    expect(
      outcome(
        check(
          "SELECT r.laps FROM health.runs r, ledger.expenses e WHERE r.date = $1",
          ["2026-01-01"],
          both,
        ),
      ),
    ).toBe("ok");
    expect(outcome(check(mixed, [], [health(), ledger({ timezone: "Asia/Shanghai" })]))).toBe("ok");
    // Also where it is the operand of a time clause.
    expect(
      outcome(
        check(
          "SELECT 1 FROM health.budgets FOR VALID_TIME AS OF saveslot_today(), ledger.accounts",
          [],
          both,
        ),
      ),
    ).toBe("function".length > 0 ? "sql_rejected/function" : "");
  });

  it("takes saveslot_date only on a zoned_datetime field of a base table", () => {
    expect(outcome(check(inRuns("saveslot_date(laps)")))).toBe("sql_rejected/function");
    expect(outcome(check(inRuns("saveslot_date(started + 1)")))).toBe("sql_rejected/function");
    expect(
      outcome(check("SELECT saveslot_date(t.s) FROM (SELECT started AS s FROM runs) AS t")),
    ).toBe("sql_rejected/function");
    expect(outcome(check("SELECT saveslot_date(s.started) FROM runs s"))).toBe("ok");
  });
});

describe("syntax", () => {
  it.each(SYNTAX.map((c) => [c.sql, c] as const))("%s", (_n, c) => {
    expect(outcome(check(c.sql))).toBe("sql_rejected/syntax");
  });

  it("gives the line of a syntax error in the caller's text", () => {
    expect(refusal("SELECT 1\nFROM runs\nWHERE ,")).toMatchObject({ reason: "syntax", line: 3 });
    expect(
      refusal("SELECT amount\nFROM budgets FOR VALID_TIME AS OF saveslot_today()\nWHERE ,"),
    ).toMatchObject({
      reason: "syntax",
      line: 3,
    });
  });

  it("refuses text that is not well-formed Unicode, before it is read", () => {
    expect(outcome(check("SELECT '\uD800'"))).toBe("sql_rejected/syntax");
    expect(outcome(check("SELECT 'a\uDC00b'"))).toBe("sql_rejected/syntax");
    expect(outcome(check("SELECT '\u{1F600}'"))).toBe("ok");
  });

  it("refuses a NUL in the text as a syntax error, with its line, wherever it is", () => {
    for (const sql of [
      "SELECT 'a\u0000b'",
      "SELECT 1\u0000",
      "\u0000",
      "SELECT 1\nFROM runs\u0000 WHERE true",
      'SELECT "a\u0000" FROM runs',
      "SELECT 1 /* \u0000 */",
    ]) {
      expect({ sql, got: outcome(check(sql)) }).toEqual({ sql, got: "sql_rejected/syntax" });
    }
    expect(refusal("SELECT 1\nFROM runs\nWHERE '\u0000'")).toMatchObject({
      reason: "syntax",
      line: 3,
    });
  });

  it("does not pass on the parser's own words for something that is not a syntax error", () => {
    // Too deeply nested for the parser: a limit, in fixed words.
    const deep = `SELECT ${"(".repeat(20000)}1${")".repeat(20000)}`;
    const e = refusal(deep);
    expect(e).toMatchObject({ code: "sql_rejected" });
    expect(["limit"]).toContain(e.code === "sql_rejected" ? e.reason : "");
  });
});

describe("limits (11 «代价»), at the limit and one over", () => {
  const rep = (s: string, n: number, sep = ", ") => Array.from({ length: n }, () => s).join(sep);
  const r = (sql: string, params: unknown[] = []) => outcome(check(sql, params));
  const OK = "ok";
  const LIMIT = "sql_rejected/limit";

  it("text: 16 KB in bytes", () => {
    const text = (bytes: number) => `SELECT 1 /*${"x".repeat(bytes - 13)}*/`;
    expect([r(text(16384)), r(text(16385))]).toEqual([OK, LIMIT]);
    // Bytes, not characters: two-byte letters.
    const wide = (chars: number, odd: string) => `SELECT 1 /*${"é".repeat(chars)}${odd}*/`;
    expect(new TextEncoder().encode(wide(8185, "x")).length).toBe(16384);
    expect([r(wide(8185, "x")), r(wide(8186, ""))]).toEqual([OK, LIMIT]);
    expect(new TextEncoder().encode(wide(8186, "")).length).toBe(16385);
  });

  it("syntax tree nodes: 2,000", () => {
    const q = (k: number, more = "") => `SELECT ${rep("1", k)} FROM runs WHERE NULL IS NULL${more}`;
    expect([r(q(998)), r(q(998, " LIMIT 1"))]).toEqual([OK, LIMIT]);
  });

  it("expression depth: 32", () => {
    const chain = (pluses: number) => `SELECT ${rep("1", pluses + 1, " + ")}`;
    expect([r(chain(31)), r(chain(32))]).toEqual([OK, LIMIT]);
    // Nested the other way round, and through subqueries.
    const parens = (n: number) => `SELECT ${"(1 + ".repeat(n)}1${")".repeat(n)}`;
    expect([r(parens(30)), r(parens(32))]).toEqual([OK, LIMIT]);
  });

  it("subquery nesting: 4", () => {
    const sub = (d: number) => `SELECT ${"(SELECT ".repeat(d)}1${")".repeat(d)}`;
    expect([r(sub(4)), r(sub(5))]).toEqual([OK, LIMIT]);
    const from = (d: number) => `${"SELECT * FROM (".repeat(d)}SELECT 1 AS x${") AS t".repeat(d)}`;
    expect([r(from(4)), r(from(5))]).toEqual([OK, LIMIT]);
    const exists = (d: number) =>
      `SELECT 1 WHERE ${"EXISTS (SELECT 1 WHERE ".repeat(d)}true${")".repeat(d)}`;
    expect([r(exists(4)), r(exists(5))]).toEqual([OK, LIMIT]);
    const inSub = (d: number) =>
      `SELECT 1 WHERE ${"1 IN (SELECT 1 WHERE ".repeat(d)}true${")".repeat(d)}`;
    expect([r(inSub(4)), r(inSub(5))]).toEqual([OK, LIMIT]);
    // A CTE is a level: each one nested in the next.
    const cte = (d: number) => `${"WITH c AS (".repeat(d)}SELECT 1${") SELECT * FROM c".repeat(d)}`;
    expect([r(cte(4)), r(cte(5))]).toEqual([OK, LIMIT]);
    // Mixed kinds count together.
    expect(
      r(
        "SELECT (SELECT * FROM (WITH c AS (SELECT 1 WHERE EXISTS (SELECT 1)) SELECT 1 FROM c) AS t)",
      ),
    ).toBe(OK);
    expect(
      r(
        "SELECT (SELECT * FROM (WITH c AS (SELECT 1 WHERE EXISTS (SELECT 1 WHERE 1 IN (SELECT 1))) SELECT 1 FROM c) AS t)",
      ),
    ).toBe(LIMIT);
  });

  it("table references: 8, those of CTEs too", () => {
    const tables = (n: number) =>
      `SELECT 1 FROM ${Array.from({ length: n }, (_, i) => `shoes t${i}`).join(", ")}`;
    expect([r(tables(8)), r(tables(9))]).toEqual([OK, LIMIT]);
    const viaCte = (n: number) =>
      `WITH c AS (SELECT 1 AS x) SELECT 1 FROM ${Array.from({ length: n }, (_, i) => `c t${i}`).join(", ")}`;
    expect([r(viaCte(7)), r(viaCte(8)), r(viaCte(9))]).toEqual([OK, OK, LIMIT]);
    // Anywhere in the statement, subqueries and joins included.
    const joined = (n: number) =>
      `SELECT 1 FROM ${Array.from({ length: n }, (_, i) => `shoes t${i}`).join(" CROSS JOIN ")}`;
    expect([r(joined(8)), r(joined(9))]).toEqual([OK, LIMIT]);
    const spread = (n: number) =>
      `SELECT (SELECT 1 FROM shoes a) FROM shoes b WHERE EXISTS (SELECT 1 FROM ${Array.from({ length: n }, (_, i) => `shoes t${i}`).join(", ")})`;
    expect([r(spread(6)), r(spread(7))]).toEqual([OK, LIMIT]);
  });

  it("table references: a derived table computed when read counts the references of its rule too", () => {
    // `today_km` reads `runs` and depends on today: computed when read, its rule put in its place.
    const base = derivedSchema(
      rule("SELECT sum(distance) AS km FROM runs WHERE date <= saveslot_today()", ["km"], "now"),
    ).tables;
    const first = base.find((t) => t.id === "t9");
    if (first?.kind !== "derived") throw new Error("no derived table");
    expect(first.rule.time_dependency).toBe("now");
    // Another one over that one: its reference adds two.
    const over = {
      ...first,
      id: "t10",
      name: "outer_km",
      rule: { ...first.rule, sql: first.rule.sql.replace(/\bt1\b/g, "t9"), depends_on: [] },
    };
    const slot = health({ tables: [...base, over] as never });
    const refs = (n: number, name = "weekly") =>
      `SELECT 1 FROM ${Array.from({ length: n }, (_, i) => `${name} t${i}`).join(", ")}`;
    const at = (sql: string) => outcome(check(sql, [], [slot]));
    // Each reference is one, and one more for the table its rule reads: 4 are 8, 5 are 10.
    expect([at(refs(4)), at(refs(5))]).toEqual([OK, LIMIT]);
    // With the written ones added: three of them and five other tables are 6 + 5 = 11.
    expect(at(`${refs(2)}, shoes a, shoes b, shoes c, shoes d`)).toBe(OK);
    expect(at(`${refs(2)}, shoes a, shoes b, shoes c, shoes d, shoes e`)).toBe(LIMIT);
    // Where the rule reads another computed-when-read table, that one is counted too.
    expect([at(refs(2, "outer_km")), at(refs(3, "outer_km"))]).toEqual([OK, LIMIT]);
    // One that is kept (not computed when read) is a single reference.
    const kept = (n: number) => outcome(check(refs(n), [], [health()]));
    expect([kept(8), kept(9)]).toEqual([OK, LIMIT]);
  });

  it("the count assumes a derived rule reads one table, and the rest is refused as not implemented", () => {
    // The references a read-time derived table adds are counted as one table, the shape of a derived
    // rule today. Where a rule reads several tables (a JOIN, a second table in FROM, a subquery, a
    // WITH), compiling it stops here: when that opens, the count must be made over every table the
    // rule reads, and this case changes with it.
    for (const sql of [
      "SELECT sum(r.distance) AS km FROM runs r JOIN shoes s ON s.row_id = r.shoe WHERE r.date <= saveslot_today()",
      "SELECT sum(distance) AS km FROM runs, shoes WHERE date <= saveslot_today()",
      "WITH c AS (SELECT distance FROM runs) SELECT sum(distance) AS km FROM c",
      "SELECT sum(distance) AS km FROM (SELECT distance FROM runs) q",
    ]) {
      const r = compileDerivedRule(rule(sql, ["km"], "now"));
      expect({ sql, code: r.ok ? "ok" : r.error.code }).toEqual({ sql, code: "not_implemented" });
    }
  });

  it("CTEs: 8", () => {
    const ctes = (n: number) =>
      `WITH ${Array.from({ length: n }, (_, i) => `c${i} AS (SELECT 1)`).join(", ")} SELECT 1`;
    expect([r(ctes(8)), r(ctes(9))]).toEqual([OK, LIMIT]);
  });

  it("set operation branches: 8", () => {
    const union = (n: number) => rep("SELECT 1", n, " UNION ALL ");
    expect([r(union(8)), r(union(9))]).toEqual([OK, LIMIT]);
    const mixed = (n: number) => `SELECT 1 UNION (${rep("SELECT 1", n - 1, " INTERSECT ")})`;
    expect([r(mixed(8)), r(mixed(9))]).toEqual([OK, LIMIT]);
  });

  it("IN list: 1,000", () => {
    const inList = (n: number) =>
      `SELECT 1 FROM runs WHERE laps IN (${Array.from({ length: n }, (_, i) => i).join(", ")})`;
    expect([r(inList(1000)), r(inList(1001))]).toEqual([OK, LIMIT]);
  });

  it("CASE branches: 256", () => {
    const cases = (n: number) =>
      `SELECT CASE ${Array.from({ length: n }, (_, i) => `WHEN laps = ${i} THEN ${i}`).join(" ")} END FROM runs`;
    expect([r(cases(256)), r(cases(257))]).toEqual([OK, LIMIT]);
  });

  it("parameters: 100", () => {
    const params = (n: number) =>
      [
        `SELECT 1 FROM runs WHERE laps IN (${Array.from({ length: n }, (_, i) => `$${i + 1}`).join(", ")})`,
        Array.from({ length: n }, () => 1),
      ] as const;
    expect([r(...params(100)), r(...params(101))]).toEqual([OK, LIMIT]);
    // The limit is the statement's, before the count of `params` is compared.
    expect(r(params(101)[0], [])).toBe(LIMIT);
  });

  it("window definitions: 4, named and in OVER", () => {
    const over = (n: number) =>
      `SELECT ${Array.from({ length: n }, (_, i) => `count(*) OVER (ORDER BY laps + ${i})`).join(", ")} FROM runs`;
    expect([r(over(4)), r(over(5))]).toEqual([OK, LIMIT]);
    const named = (n: number) =>
      `SELECT count(*) OVER a FROM runs WINDOW ${Array.from({ length: n }, (_, i) => `${"abcdefgh"[i]} AS ()`).join(", ")}`;
    expect([r(named(4)), r(named(5))]).toEqual([OK, LIMIT]);
    expect(
      r("SELECT count(*) OVER (ORDER BY laps) FROM runs WINDOW a AS (), b AS (), c AS (), d AS ()"),
    ).toBe(LIMIT);
    // Using a name is not defining one.
    expect(
      r(
        "SELECT count(*) OVER a, count(*) OVER a, count(*) OVER a, count(*) OVER a, count(*) OVER a, count(*) OVER a FROM runs WINDOW a AS ()",
      ),
    ).toBe(OK);
  });

  it("applies in subqueries and in set operation branches as much as at the top", () => {
    expect(r(`SELECT * FROM (SELECT ${rep("1", 999)} FROM runs WHERE NULL IS NULL) AS t`)).toBe(
      LIMIT,
    );
    expect(
      r(
        `WITH c AS (SELECT 1 FROM runs WHERE laps IN (${Array.from({ length: 1001 }, (_, i) => i).join(", ")})) SELECT 1`,
      ),
    ).toBe(LIMIT);
  });
});

describe("parameters (11 «名字» 参数)", () => {
  const bad = (sql: string, params: unknown[] = []) => refusal(sql, params);

  it("are numbered from $1 without gaps and are as many as `params` has: else `malformed` at `params`", () => {
    expect(bad("SELECT 1", [1])).toMatchObject({
      code: "invalid_argument",
      reason: "malformed",
      param: "params",
    });
    expect(bad("SELECT 1 FROM runs WHERE laps = $1", [])).toMatchObject({
      reason: "malformed",
      param: "params",
    });
    expect(bad("SELECT 1 FROM runs WHERE laps = $1", [1, 2])).toMatchObject({
      reason: "malformed",
    });
    expect(bad("SELECT 1 FROM runs WHERE laps = $2", [1, 2])).toMatchObject({
      reason: "malformed",
    });
    expect(bad("SELECT 1 FROM runs WHERE laps = $1 AND laps = $3", [1, 2, 3])).toMatchObject({
      reason: "malformed",
    });
    expect(outcome(check("SELECT 1 FROM runs WHERE laps = $2 AND laps = $1", [1, 2]))).toBe("ok");
    expect(outcome(check("SELECT 1 FROM runs WHERE laps = $1 AND laps = $1", [1]))).toBe("ok");
  });

  it("count parameters of a time clause, and of subqueries, too", () => {
    expect(outcome(check("SELECT amount FROM budgets FOR VALID_TIME AS OF $1", []))).toBe(
      "invalid_argument/malformed",
    );
    expect(
      outcome(
        check(
          "SELECT amount FROM budgets FOR VALID_TIME AS OF $2 WHERE (SELECT 1 WHERE $1 = 'a') = 1",
          ["a", "2026-01-01"],
        ),
      ),
    ).toBe("ok");
  });

  it("have the type their use gives them, and the unit of the side they are compared with", () => {
    const types = (sql: string, params: unknown[]) => {
      const r = check(sql, params);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return [...r.analysis.params]
        .map(([n, p]) => `$${n}:${p.t}${p.unit !== undefined ? `:${p.unit.code}` : ""}`)
        .join(",");
    };
    expect(
      types("SELECT 1 FROM expenses WHERE date >= $1 AND amount > $2 AND note = $3", [
        "2026-01-01",
        "5",
        "x",
      ]),
    ).toBe("$1:date,$2:numeric:CNY,$3:text");
    expect(
      types("SELECT 1 FROM runs WHERE laps = $1 AND race = $2 AND started > $3", [
        1,
        true,
        "2026-01-01T00:00:00Z",
      ]),
    ).toBe("$1:bigint,$2:boolean,$3:timestamptz");
    expect(types("SELECT amount FROM budgets FOR VALID_TIME AS OF $1", ["2026-01-01"])).toBe(
      "$1:date",
    );
    expect(
      types("SELECT guest FROM rooms FOR VALID_TIME FROM $1 TO $2", [
        "2026-01-01T00:00:00Z",
        "2026-01-02T00:00:00Z",
      ]),
    ).toBe("$1:timestamptz,$2:timestamptz");
    expect(types("SELECT laps FROM runs LIMIT $1 OFFSET $2", [1, 2])).toBe("$1:bigint,$2:bigint");
    expect(types("SELECT distance + $1, distance * $2 FROM runs", ["1", "2"])).toBe(
      "$1:numeric:km,$2:numeric",
    );
    expect(types("SELECT 1 FROM runs WHERE laps = $1 AND pace > $1", [1])).toBe("$1:numeric");
    expect(types("SELECT $1::date", ["2026-01-01"])).toBe("$1:date");
    expect(types("SELECT 1 FROM runs WHERE feeling LIKE 'a%' AND $1 || 'x' = feeling", ["a"])).toBe(
      "$1:text",
    );
  });

  it("that no place types are `type`", () => {
    for (const sql of [
      "SELECT $1",
      "SELECT $1, $2 FROM runs",
      "SELECT $1 IS NULL",
      "SELECT count($1)",
      "SELECT 1 WHERE $1 = $2",
      "SELECT 1 FROM runs ORDER BY $1",
      "SELECT sum($1)",
      "SELECT NULLIF($1, $2)",
      "SELECT COALESCE($1, $2)",
      "SELECT (SELECT $1)",
      "SELECT * FROM (SELECT $1) AS t",
    ]) {
      const n = (sql.match(/\$\d/g) ?? []).map((m) => Number(m.slice(1)));
      const params = Array.from({ length: Math.max(...n) }, () => 1);
      expect({ sql, got: outcome(check(sql, params)) }).toEqual({ sql, got: "sql_rejected/type" });
    }
  });

  it("`$1 + $2` has no number to give them: `function`", () => {
    expect(outcome(check("SELECT $1 + $2", [1, 2]))).toBe("sql_rejected/function");
  });

  it("that two places type differently are `type`", () => {
    expect(outcome(check("SELECT 1 FROM runs WHERE laps = $1 AND feeling = $1", [1]))).toBe(
      "sql_rejected/type",
    );
    expect(outcome(check("SELECT 1 FROM runs WHERE date = $1 AND race = $1", [1]))).toBe(
      "sql_rejected/type",
    );
    expect(outcome(check("SELECT 1 FROM runs WHERE distance > $1 AND uphill > $1", ["1"]))).toBe(
      "sql_rejected/type",
    );
  });

  it("are not places for a number of digits or a 32-bit integer, and cast only to date", () => {
    expect(outcome(check(inRuns("substr(feeling, $1)"), [1]))).toBe("sql_rejected/function");
    expect(outcome(check(inRuns("$1::numeric"), [1]))).toBe("sql_rejected/function");
    expect(outcome(check("SELECT 1 FROM runs LIMIT $1 + 1", [1]))).toBe("sql_rejected/node");
    expect(outcome(check("SELECT 1 FROM runs LIMIT laps"))).toBe("sql_rejected/node");
  });

  it("take LIMIT and OFFSET as constants or $n only, non-negative integers", () => {
    for (const bad of ["1.5", "'a'", "true", "-1"]) {
      expect({ bad, got: outcome(check(`SELECT 1 FROM runs LIMIT ${bad}`)) }).toEqual({
        bad,
        got: "sql_rejected/type",
      });
    }
    expect(outcome(check("SELECT 1 FROM runs OFFSET 0"))).toBe("ok");
    expect(outcome(check("SELECT 1 FROM runs LIMIT 9223372036854775807"))).toBe("ok");
    expect(outcome(check("SELECT 1 FROM runs LIMIT 9223372036854775808"))).toBe(
      "sql_rejected/type",
    );
  });
});

describe("what a query with several tables resolves to", () => {
  it("one slot, no qualifier: the table it has; several: `ambiguous_table` with the candidates", () => {
    expect(refusal("SELECT * FROM expenses", [], both)).toMatchObject({
      code: "invalid_argument",
      reason: "ambiguous_table",
      param: "sql",
      candidates: ["health.expenses", "ledger.expenses"],
    });
    expect(outcome(check("SELECT amount FROM health.expenses", [], both))).toBe("ok");
    expect(outcome(check("SELECT amount FROM LEDGER.Expenses", [], both))).toBe("ok");
    expect(outcome(check("SELECT owner FROM accounts", [], both))).toBe("ok");
    // Ambiguous wherever it is written: a subquery, a CTE, a join, a time clause's neighbour.
    for (const sql of [
      "SELECT (SELECT max(amount) FROM expenses)",
      "WITH c AS (SELECT * FROM expenses) SELECT 1",
      "SELECT 1 FROM runs r JOIN expenses e ON e.date = r.date",
      "SELECT 1 WHERE EXISTS (SELECT 1 FROM expenses)",
    ]) {
      expect({ sql, got: outcome(check(sql, [], both)) }).toEqual({
        sql,
        got: "invalid_argument/ambiguous_table",
      });
    }
    // The error says where, in the caller's text.
    expect(refusal("SELECT 1\nFROM runs r\nJOIN expenses e ON true", [], both)).toMatchObject({
      line: 3,
    });
  });

  it("a CTE of the name hides a table, a qualified name does not", () => {
    expect(
      outcome(check("WITH expenses AS (SELECT 1 AS x) SELECT x FROM expenses", [], both)),
    ).toBe("ok");
    expect(
      outcome(
        check("WITH expenses AS (SELECT 1 AS x) SELECT amount FROM health.expenses", [], both),
      ),
    ).toBe("ok");
  });

  it("several slots in one query, each at its own version", () => {
    const r = check(
      "SELECT r.laps, l.amount FROM health.runs r JOIN ledger.expenses l ON l.date = r.date",
      [],
      both,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect([...r.analysis.slots]).toEqual([
      ["sl_health", { name: "health", sv: 3 }],
      ["sl_ledger", { name: "ledger", sv: 7 }],
    ]);
    const one = check("SELECT laps FROM runs", [], both);
    if (!one.ok) throw new Error(JSON.stringify(one.error));
    expect([...one.analysis.slots.keys()]).toEqual(["sl_health"]);
  });

  it("names are case-insensitive for ASCII, and quoting changes nothing", () => {
    for (const sql of [
      'SELECT "AvgHR" FROM (SELECT 1 AS avghr) AS t',
      'SELECT avghr FROM (SELECT 1 AS "AvgHR") AS t',
      "SELECT AVGHR FROM (SELECT 1 AS AvgHr) AS t",
    ]) {
      expect({ sql, got: outcome(check(sql)) }).toEqual({ sql, got: "ok" });
      // The database compares quoted names exactly: the executed text is one spelling for all.
      const r = check(sql);
      if (!r.ok) throw new Error(sql);
      expect({ sql, text: printQuery(r.analysis.query) }).toEqual({
        sql,
        text: 'SELECT "t1"."avghr" AS "avghr" FROM (SELECT 1 AS "avghr") AS "t1"',
      });
    }
    // The same for every name the caller chooses, and the references to it.
    for (const [sql, text] of [
      [
        'WITH "Principals" AS (SELECT 1 AS "Id") SELECT id FROM principals',
        'WITH "c1" AS (SELECT 1 AS "id") SELECT "t2"."id" AS "id" FROM "c1" AS "t2"',
      ],
      [
        'SELECT s.concat FROM (SELECT 1 AS "Concat") s',
        'SELECT "t1"."concat" AS "concat" FROM (SELECT 1 AS "concat") AS "t1"',
      ],
      [
        'SELECT laps FROM runs AS "R" WHERE r.laps > 0',
        'SELECT "t1"."laps" AS "laps" FROM "health"."runs" AS "t1" WHERE ("t1"."laps" > 0)',
      ],
      [
        'SELECT count(*) OVER "W" FROM runs WINDOW "W" AS ()',
        'SELECT count(*) OVER "w" AS "count" FROM "health"."runs" AS "t1" WINDOW "w" AS ()',
      ],
      [
        'SELECT a FROM (SELECT 1) AS t ("A")',
        'SELECT "t1"."a" AS "a" FROM (SELECT 1 AS "a") AS "t1"',
      ],
    ] as const) {
      const r = check(sql);
      if (!r.ok) throw new Error(`${sql}\n→ ${JSON.stringify(r.error)}`);
      expect({ sql, text: printQuery(r.analysis.query) }).toEqual({ sql, text });
    }
    // Not for other letters.
    expect(outcome(check('SELECT "É" FROM (SELECT 1 AS "é") AS t'))).toBe(
      "sql_rejected/unknown_name",
    );
  });

  it("a name that is a keyword is quoted, `user` unquoted is the current user and is refused", () => {
    expect(outcome(check('SELECT "user" FROM (SELECT 1 AS "user") AS t'))).toBe("ok");
    expect(outcome(check('SELECT user FROM (SELECT 1 AS "user") AS t'))).toBe("sql_rejected/node");
    // A table the user called pg_class is theirs.
    const pgClass = {
      ...health(),
      tables: [{ ...baseTables[4], id: "t5", name: "pg_class" }],
    } as never;
    expect(outcome(check("SELECT model FROM pg_class", [], [pgClass]))).toBe("ok");
    expect(outcome(check("SELECT model FROM pg_catalog.pg_class", [], [pgClass]))).toBe(
      "sql_rejected/unknown_name",
    );
  });

  it("a column named in several tables of the FROM, unqualified, is `unknown_name`", () => {
    const e = refusal("SELECT date FROM runs r, expenses e");
    expect(e).toMatchObject({ reason: "unknown_name", node: "date" });
    expect(e.message).toContain("table name");
    expect(outcome(check("SELECT r.date, e.date FROM runs r, expenses e"))).toBe("ok");
    expect(outcome(check("SELECT date FROM runs r JOIN expenses e USING (date)"))).toBe("ok");
    // After USING, the pair is one column; a third table with it makes it ambiguous again.
    expect(outcome(check("SELECT date FROM runs r JOIN expenses e USING (date), budgets b"))).toBe(
      "ok",
    );
    expect(
      outcome(
        check("SELECT date FROM runs r JOIN expenses e USING (date), (SELECT date FROM runs) AS z"),
      ),
    ).toBe("sql_rejected/unknown_name");
  });

  it("a correlated name reaches the outer query, the inner one first", () => {
    expect(
      outcome(
        check("SELECT (SELECT max(e.amount) FROM expenses e WHERE e.date = r.date) FROM runs r"),
      ),
    ).toBe("ok");
    expect(outcome(check("SELECT (SELECT date FROM expenses e LIMIT 1) FROM runs r"))).toBe("ok");
    // A FROM subquery does not see its neighbours (no LATERAL).
    expect(outcome(check("SELECT 1 FROM runs r, (SELECT r.date) AS s"))).toBe(
      "sql_rejected/unknown_name",
    );
  });
});

describe("old names (11 «名字»: the last 10 schema versions)", () => {
  const renamed = (over = {}) =>
    health({
      formerNames: {
        tables: [
          { name: "jogs", table: "t1" },
          { name: "accounts", table: "t5" },
        ],
        fields: [
          { table: "t1", name: "km", field: "f2" },
          { table: "t1", name: "laps", field: "f6" },
          { table: "t1", name: "old_date", field: "f1" },
        ],
      },
      ...over,
    });

  it("resolve, with a `renamed` warning each", () => {
    const r = check("SELECT j.km, old_date FROM jogs j", [], [renamed()]);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.analysis.warnings).toEqual([
      { code: "renamed", from: "jogs", to: "runs" },
      { code: "renamed", table: "j", from: "km", to: "distance" },
      { code: "renamed", from: "old_date", to: "date" },
    ]);
    expect(r.analysis.columns.map((c) => `${c.name}:${c.type}`)).toEqual([
      "km:quantity",
      "old_date:date",
    ]);
    expect([...r.analysis.tables.values()][0]).toMatchObject({ table: "t1" });
  });

  it("warn once for a name used twice", () => {
    const r = check("SELECT km, km + 1 FROM jogs", [], [renamed()]);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.analysis.warnings.filter((w) => w.from === "km")).toHaveLength(1);
  });

  it("lose to a current name", () => {
    // `laps` is a field of runs now (it is also an old name of it): no warning.
    const r = check("SELECT laps FROM runs", [], [renamed()]);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.analysis.warnings).toEqual([]);
    // `accounts` is a table of another slot now.
    const w = check("SELECT owner FROM accounts", [], [renamed(), ledger()]);
    if (!w.ok) throw new Error(JSON.stringify(w.error));
    expect(w.analysis.warnings).toEqual([]);
  });

  it("are not the old name of a table that is not visible", () => {
    const hidden = renamed({ tables: healthSchema().tables.filter((t) => t.id !== "t1") });
    expect(refusal("SELECT 1 FROM jogs", [], [hidden])).toMatchObject({ reason: "unknown_name" });
  });

  it("do not make a table ambiguous with itself, and are ambiguous across slots", () => {
    expect(outcome(check("SELECT km FROM jogs", [], [renamed(), ledger()]))).toBe("ok");
    const twice = ledger({ formerNames: { tables: [{ name: "jogs", table: "t1" }] } });
    expect(refusal("SELECT 1 FROM jogs", [], [renamed(), twice])).toMatchObject({
      reason: "ambiguous_table",
      candidates: ["health.runs", "ledger.expenses"],
    });
  });

  it("are not given when the slot says none", () => {
    expect(outcome(check("SELECT km FROM runs"))).toBe("sql_rejected/unknown_name");
    expect(outcome(check("SELECT 1 FROM jogs"))).toBe("sql_rejected/unknown_name");
  });
});

describe("a table that does not exist and one that is not visible give the same answer", () => {
  const full = healthSchema().tables;
  const without = (...ids: string[]) => full.filter((t) => !ids.includes(t.id));
  /** What visibleSlots() gives: the visible tables, and (here) the whole schema beside them. */
  const world = (visible: typeof full, hidden: boolean) =>
    health({ tables: visible, ...(hidden ? { compiled: { tables: full } } : {}) } as never);

  it("for each table, derived or not, by every way of naming it", () => {
    const names = [
      "runs",
      "health.runs",
      "RUNS",
      '"Runs"',
      "shoes",
      "expenses",
      "budgets",
      "rooms",
      "weekly",
      "health.weekly",
    ];
    for (const [hide, ...gone] of [["t1", "t9"], ["t5"], ["t3"], ["t9"]] as const) {
      void hide;
      const ids = [hide, ...gone] as string[];
      for (const n of names) {
        for (const sql of [
          `SELECT * FROM ${n}`,
          `SELECT 1 FROM ${n} AS x WHERE x.row_id IS NULL`,
          `SELECT (SELECT 1 FROM ${n})`,
        ]) {
          const hiddenOne = check(sql, [], [world(without(...ids), true)]);
          const absentOne = check(sql, [], [world(without(...ids), false)]);
          expect(hiddenOne).toEqual(absentOne);
          // And the same words as for a name that was never there, the name apart.
          if (
            !hiddenOne.ok &&
            hiddenOne.error.code === "sql_rejected" &&
            hiddenOne.error.message.startsWith("unknown table")
          ) {
            const never = check(sql.replace(n, "never_was"), [], [world(without(...ids), false)]);
            if (!never.ok && never.error.code === "sql_rejected") {
              const folded = n.replaceAll('"', "").toLowerCase();
              const clean = (e: typeof hiddenOne.error) =>
                JSON.stringify(e)
                  .replace(new RegExp(folded.replaceAll(".", "\\."), "gi"), "N")
                  .replace(new RegExp(folded.split(".").pop() as string, "gi"), "N")
                  .replaceAll("never_was", "N");
              expect(clean(hiddenOne.error)).toBe(clean(never.error));
            }
          }
        }
      }
    }
  });

  it("with every table of the slot invisible, or the slot itself not there", () => {
    expect(refusal("SELECT * FROM runs", [], [world([], true)])).toEqual(
      refusal("SELECT * FROM runs", [], [world([], false)]),
    );
    expect(refusal("SELECT * FROM runs", [], [])).toEqual(
      refusal("SELECT * FROM runs", [], [world([], true)]),
    );
    expect(refusal("SELECT * FROM health.runs", [], [ledger()])).toMatchObject({
      reason: "unknown_name",
    });
    expect(refusal("SELECT * FROM runs", [], [])).toMatchObject({ reason: "unknown_name" });
  });

  it("a derived table is visible only if every table it depends on is", () => {
    const names = (visible: typeof full) => {
      const r = check("SELECT week, km FROM weekly", [], [health({ tables: visible })]);
      return outcome(r);
    };
    expect(names(full)).toBe("ok");
    expect(names(without("t1"))).toBe("sql_rejected/unknown_name");
    expect(names(without("t5", "t2", "t3", "t4"))).toBe("ok");
    // Its dependencies are what its rule says (runs.date and runs.distance), not the table's fields.
    expect(healthSchema().tables.find((t) => t.id === "t9")).toMatchObject({
      rule: {
        depends_on: [
          { table: "t1", field: "f1" },
          { table: "t1", field: "f2" },
        ],
      },
    });
  });

  it("a derived table over a derived table needs both", () => {
    const base = healthSchema().tables.find((t) => t.id === "t9");
    if (base?.kind !== "derived") throw new Error("no derived table");
    const over = {
      ...base,
      id: "t10",
      name: "monthly",
      rule: { ...base.rule, depends_on: [{ table: "t9", field: "f1" }] },
    };
    const tables = [...full, over] as typeof full;
    expect(outcome(check("SELECT * FROM monthly", [], [health({ tables })]))).toBe("ok");
    expect(
      outcome(
        check(
          "SELECT * FROM monthly",
          [],
          [health({ tables: tables.filter((t) => t.id !== "t9") })],
        ),
      ),
    ).toBe("sql_rejected/unknown_name");
    expect(
      outcome(
        check(
          "SELECT * FROM monthly",
          [],
          [health({ tables: tables.filter((t) => t.id !== "t1") })],
        ),
      ),
    ).toBe("sql_rejected/unknown_name");
  });
});

describe("system columns (11 «名字» 系统列)", () => {
  it("row_id on event and timeless tables, entity_id, valid_from and valid_to on state tables, none on derived", () => {
    expect(columns("SELECT row_id FROM runs")).toBe("row_id:text");
    expect(columns("SELECT row_id FROM shoes")).toBe("row_id:text");
    expect(columns("SELECT entity_id, valid_from, valid_to FROM budgets")).toBe(
      "entity_id:text,valid_from:date,valid_to:date",
    );
    expect(columns("SELECT entity_id, valid_from, valid_to FROM rooms")).toBe(
      "entity_id:text,valid_from:unknown,valid_to:unknown",
    );
    for (const sql of [
      "SELECT entity_id FROM runs",
      "SELECT valid_from FROM shoes",
      "SELECT valid_to FROM expenses",
      "SELECT row_id FROM budgets",
      "SELECT row_id FROM rooms",
      "SELECT row_id FROM weekly",
      "SELECT entity_id FROM weekly",
      "SELECT valid_from FROM weekly",
    ]) {
      expect({ sql, got: outcome(check(sql)) }).toEqual({ sql, got: "sql_rejected/unknown_name" });
    }
  });

  it("are not in `*`, and not on what a subquery or a CTE gives", () => {
    expect(columns("SELECT * FROM runs").split(",")).not.toContain("row_id:text");
    expect(columns("SELECT * FROM budgets")).toBe("category:text,amount:quantity:CNY");
    expect(outcome(check("SELECT row_id FROM (SELECT * FROM runs) AS t"))).toBe(
      "sql_rejected/unknown_name",
    );
    expect(outcome(check("SELECT t.row_id FROM (SELECT row_id FROM runs) AS t"))).toBe("ok");
    expect(outcome(check("WITH c AS (SELECT * FROM shoes) SELECT row_id FROM c"))).toBe(
      "sql_rejected/unknown_name",
    );
  });

  it("are columns of the table they belong to when qualified", () => {
    expect(
      outcome(check("SELECT r.row_id, s.row_id FROM runs r JOIN shoes s ON s.row_id = r.shoe")),
    ).toBe("ok");
    expect(outcome(check("SELECT row_id FROM runs r JOIN shoes s ON s.row_id = r.shoe"))).toBe(
      "sql_rejected/unknown_name",
    );
    // A ref compares with a row ID.
    expect(outcome(check("SELECT 1 FROM runs r WHERE r.shoe = 'r_1'"))).toBe("ok");
    expect(outcome(check("SELECT 1 FROM runs r WHERE r.shoe = r.laps"))).toBe("sql_rejected/type");
  });
});

describe("`*` and `t.*`", () => {
  it("are expanded to the fields, in their order, qualified", () => {
    const r = check("SELECT * FROM shoes s JOIN runs r ON s.row_id = r.shoe");
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const [t] = [r.analysis.query.body];
    expect(t?.k).toBe("select");
    expect(printQuery(r.analysis.query)).toBe(
      'SELECT "t1"."model" AS "model", "t2"."date" AS "date", "t2"."distance" AS "distance", "t2"."duration" AS "duration", "t2"."feeling" AS "feeling", "t2"."route" AS "route", "t2"."laps" AS "laps", "t2"."pace" AS "pace", "t2"."started" AS "started", "t2"."shoe" AS "shoe", "t2"."race" AS "race", "t2"."uphill" AS "uphill" FROM ("health"."shoes" AS "t1" INNER JOIN "health"."runs" AS "t2" ON ("t1"."row_id" = "t2"."shoe"))',
    );
  });

  it("stand for the visible fields of a derived table too, and the output of a subquery", () => {
    expect(columns("SELECT * FROM weekly")).toBe("week:date,km:quantity:km");
    expect(columns("SELECT t.* FROM (SELECT date AS d, laps FROM runs) AS t")).toBe(
      "d:date,laps:integer",
    );
    expect(columns("SELECT * FROM (SELECT date AS d, laps FROM runs) AS t (a, b)")).toBe(
      "a:date,b:integer",
    );
  });

  it("are expanded inside subqueries and CTEs", () => {
    const r = check(
      "WITH c AS (SELECT * FROM shoes) SELECT (SELECT count(*) FROM (SELECT * FROM shoes) AS q), c.* FROM c",
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(printQuery(r.analysis.query).match(/\*/g)).toHaveLength(1);
    expect(printQuery(r.analysis.query)).toContain(
      'WITH "c2" AS (SELECT "t1"."model" AS "model" FROM "health"."shoes" AS "t1")',
    );
  });

  it("are refused where only an expression goes, and with no FROM", () => {
    for (const sql of [
      "SELECT count(*), * FROM runs WHERE *",
      "SELECT * + 1 FROM runs",
      "SELECT (*) FROM runs",
      "SELECT abs(*) FROM runs",
      "SELECT runs.* + 1 FROM runs",
      "SELECT 1 FROM runs ORDER BY *",
    ]) {
      expect({ sql, got: outcome(check(sql)).split("/")[0] }).toEqual({ sql, got: "sql_rejected" });
    }
    expect(outcome(check("SELECT *"))).toBe("sql_rejected/node");
    expect(outcome(check("SELECT nosuch.* FROM runs"))).toBe("sql_rejected/unknown_name");
    expect(outcome(check("SELECT shoes.* FROM runs"))).toBe("sql_rejected/unknown_name");
  });

  it("names the columns by the first part's names, and takes the name of a table by its alias", () => {
    expect(outcome(check("SELECT runs.* FROM runs AS r"))).toBe("sql_rejected/unknown_name");
    expect(outcome(check("SELECT r.* FROM runs AS r"))).toBe("ok");
  });
});

describe("the result columns (11 «类型»)", () => {
  it("are typed by FieldType, `unknown` for timestamptz and NULL, with the unit of a quantity", () => {
    expect(
      columns(
        "SELECT date, distance, feeling, route, laps, pace, started, shoe, race, uphill FROM runs",
      ),
    ).toBe(
      "date:date,distance:quantity:km,feeling:text,route:enum,laps:integer,pace:decimal,started:unknown,shoe:ref,race:boolean,uphill:quantity:mi",
    );
    expect(columns("SELECT NULL")).toBe("?column?:unknown");
    expect(columns("SELECT saveslot_now(), min(started) FROM runs")).toBe(
      "saveslot_now:unknown,min:unknown",
    );
  });

  it("follow the checks of units (11 «单位»)", () => {
    expect(
      columns(
        "SELECT distance + distance AS a, distance * 2 AS b, distance / duration AS c, distance / distance AS d FROM runs",
      ),
    ).toBe("a:quantity:km,b:quantity:km,c:decimal,d:quantity:1");
    expect(
      columns("SELECT sum(distance) AS e, avg(distance) AS f, count(distance) AS g FROM runs"),
    ).toBe("e:quantity:km,f:quantity:km,g:integer");
    expect(columns("SELECT COALESCE(sum(amount), 0) AS a FROM expenses")).toBe("a:quantity:CNY");
    expect(
      columns(
        "SELECT CASE WHEN true THEN 0 ELSE amount END AS b, GREATEST(amount, 0) AS c FROM expenses",
      ),
    ).toBe("b:quantity:CNY,c:quantity:CNY");
    // Literals and parameters take the unit of the other side; numbers without one do not mix with it.
    expect(outcome(check("SELECT 1 FROM expenses WHERE amount > 5"))).toBe("ok");
    expect(outcome(check("SELECT amount + laps FROM expenses e, runs r"))).toBe(
      "sql_rejected/type",
    );
    expect(outcome(check("SELECT amount + pace FROM expenses e, runs r"))).toBe(
      "sql_rejected/type",
    );
    expect(outcome(check("SELECT distance + uphill FROM runs"))).toBe("sql_rejected/type");
    expect(outcome(check("SELECT distance FROM runs UNION SELECT uphill FROM runs"))).toBe(
      "sql_rejected/type",
    );
    expect(
      outcome(check("SELECT distance FROM runs WHERE distance IN (SELECT uphill FROM runs)")),
    ).toBe("sql_rejected/type");
    expect(outcome(check("SELECT sum(distance + uphill) FROM runs"))).toBe("sql_rejected/type");
  });

  it("are named by AS, by the column, by the function; `?column?` for the rest", () => {
    expect(
      columns(
        "SELECT laps AS l, r.date, abs(laps), laps + 1, CASE WHEN true THEN 1 END, COALESCE(laps, 1), EXTRACT(year FROM date), (SELECT 1), EXISTS (SELECT 1), laps::numeric, count(*) FROM runs r GROUP BY 1, 2, 3, 4, 7, 9",
      ),
    ).toBe(
      "l:integer,date:date,abs:integer,?column?:integer,case:integer,coalesce:integer,extract:decimal,?column?:integer,exists:boolean,laps:decimal,count:integer",
    );
  });

  it("do not give a timestamp, which is only a step on the way", () => {
    expect(refusal("SELECT date::timestamp FROM runs")).toMatchObject({ reason: "type" });
    expect(outcome(check("SELECT date_trunc('day', date::timestamp)::date FROM runs"))).toBe("ok");
    expect(outcome(check("SELECT t FROM (SELECT date::timestamp AS t FROM runs) AS q"))).toBe(
      "sql_rejected/type",
    );
    expect(
      outcome(
        check(
          "SELECT date_trunc('day', t)::date FROM (SELECT date::timestamp AS t FROM runs) AS q",
        ),
      ),
    ).toBe("ok");
  });

  it("through a subquery, a CTE, a set operation and a join keep their type and unit", () => {
    expect(columns("SELECT t.d, t.k FROM (SELECT date AS d, distance AS k FROM runs) AS t")).toBe(
      "d:date,k:quantity:km",
    );
    expect(columns("WITH c AS (SELECT distance AS k FROM runs) SELECT sum(k) FROM c")).toBe(
      "sum:quantity:km",
    );
    expect(columns("SELECT distance FROM runs UNION ALL SELECT distance FROM runs")).toBe(
      "distance:quantity:km",
    );
    expect(columns("SELECT 1 AS a UNION SELECT laps FROM runs")).toBe("a:integer");
    expect(columns("SELECT 1 AS a UNION SELECT pace FROM runs")).toBe("a:decimal");
    expect(columns("SELECT 'a' AS a UNION SELECT feeling FROM runs")).toBe("a:text");
    expect(columns("SELECT route FROM runs UNION SELECT route FROM runs")).toBe("route:enum");
    expect(outcome(check("SELECT 1 UNION SELECT 'a'"))).toBe("sql_rejected/type");
    expect(outcome(check("SELECT 1, 2 UNION SELECT 1"))).toBe("sql_rejected/type");
    expect(outcome(check("SELECT date FROM runs UNION SELECT started FROM runs"))).toBe(
      "sql_rejected/function",
    );
  });

  it("through window functions", () => {
    expect(
      columns(
        "SELECT lag(distance) OVER w AS a, lead(distance, 1, 0) OVER w AS b, sum(distance) OVER w AS c, rank() OVER w AS d, first_value(feeling) OVER w AS e, row_number() OVER w AS f, max(date) OVER w AS g FROM runs WINDOW w AS (ORDER BY date)",
      ),
    ).toBe("a:quantity:km,b:quantity:km,c:quantity:km,d:integer,e:text,f:integer,g:date");
    expect(outcome(check("SELECT lag(distance, 1, 'x') OVER (ORDER BY date) FROM runs"))).toBe(
      "sql_rejected/type",
    );
    expect(outcome(check("SELECT lag(distance, laps) OVER (ORDER BY date) FROM runs"))).toBe(
      "sql_rejected/function",
    );
    expect(outcome(check("SELECT lag(NULL) OVER (ORDER BY date) FROM runs"))).toBe(
      "sql_rejected/function",
    );
  });
});

describe("statements that PostgreSQL would refuse at run time are refused here", () => {
  it.each([
    ["a column outside GROUP BY", "SELECT laps, count(*) FROM runs", "node"],
    [
      "a column outside GROUP BY, with a key",
      "SELECT route, laps FROM runs GROUP BY route",
      "node",
    ],
    [
      "a column in HAVING outside GROUP BY",
      "SELECT route FROM runs GROUP BY route HAVING laps > 1",
      "node",
    ],
    ["an aggregate in WHERE", "SELECT 1 FROM runs WHERE count(*) > 1", "node"],
    ["an aggregate in GROUP BY", "SELECT 1 FROM runs GROUP BY count(*)", "node"],
    [
      "an aggregate in a join condition",
      "SELECT 1 FROM runs a JOIN shoes b ON count(*) > 1",
      "node",
    ],
    ["a nested aggregate", "SELECT sum(count(*)) FROM runs", "node"],
    ["a window function in WHERE", "SELECT 1 FROM runs WHERE rank() OVER () > 1", "node"],
    ["a window function in GROUP BY", "SELECT 1 FROM runs GROUP BY rank() OVER ()", "node"],
    ["a window function in HAVING", "SELECT 1 FROM runs HAVING rank() OVER () > 1", "node"],
    ["an undefined window", "SELECT rank() OVER w FROM runs", "unknown_name"],
    ["a window defined twice", "SELECT rank() OVER w FROM runs WINDOW w AS (), w AS ()", "node"],
    [
      "a window that extends one and partitions",
      "SELECT rank() OVER (w PARTITION BY laps) FROM runs WINDOW w AS ()",
      "node",
    ],
    [
      "a window that extends one with a frame",
      "SELECT rank() OVER (w) FROM runs WINDOW w AS (ORDER BY date ROWS 1 PRECEDING)",
      "node",
    ],
    [
      "a window that extends one and orders again",
      "SELECT rank() OVER (w ORDER BY laps) FROM runs WINDOW w AS (ORDER BY date)",
      "node",
    ],
    [
      "a frame that starts after it ends (the grammar's own check)",
      "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN 1 FOLLOWING AND 1 PRECEDING) FROM runs",
      "syntax",
    ],
    [
      "a frame starting after the current row and ending on it (the grammar's own check)",
      "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN 1 FOLLOWING AND CURRENT ROW) FROM runs",
      "syntax",
    ],
    [
      "GROUPS without ORDER BY",
      "SELECT sum(laps) OVER (GROUPS BETWEEN 1 PRECEDING AND CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "RANGE with an offset and two keys",
      "SELECT sum(laps) OVER (ORDER BY date, laps RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "RANGE with an offset and no key",
      "SELECT sum(laps) OVER (RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "RANGE over a date with a number",
      "SELECT sum(laps) OVER (ORDER BY date RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM runs",
      "type",
    ],
    [
      "RANGE over a number with an interval",
      "SELECT sum(laps) OVER (ORDER BY laps RANGE BETWEEN INTERVAL '1 day' PRECEDING AND CURRENT ROW) FROM runs",
      "type",
    ],
    [
      "RANGE over text with an offset",
      "SELECT sum(laps) OVER (ORDER BY feeling RANGE BETWEEN 1 PRECEDING AND CURRENT ROW) FROM runs",
      "type",
    ],
    [
      "an interval in a ROWS frame",
      "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN INTERVAL '1 day' PRECEDING AND CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "an interval in another unit",
      "SELECT sum(laps) OVER (ORDER BY date RANGE BETWEEN INTERVAL '1 month' PRECEDING AND CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "a frame offset that is not a constant",
      "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN laps PRECEDING AND CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "a negative frame offset",
      "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN -1 PRECEDING AND CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "a fractional ROWS offset",
      "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN 1.5 PRECEDING AND CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "a parameter as a frame offset",
      "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN $1 PRECEDING AND CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "DISTINCT ON not matching ORDER BY",
      "SELECT DISTINCT ON (route) route FROM runs ORDER BY date",
      "node",
    ],
    [
      "DISTINCT ON an output that is not first",
      "SELECT DISTINCT ON (laps) route, laps FROM runs ORDER BY route, laps",
      "node",
    ],
    [
      "DISTINCT ORDER BY something not selected",
      "SELECT DISTINCT route FROM runs ORDER BY laps",
      "node",
    ],
    ["ORDER BY a number out of range", "SELECT laps FROM runs ORDER BY 2", "node"],
    ["ORDER BY zero", "SELECT laps FROM runs ORDER BY 0", "node"],
    ["GROUP BY a number out of range", "SELECT laps FROM runs GROUP BY 2", "node"],
    [
      "ORDER BY an expression after a set operation",
      "SELECT laps FROM runs UNION SELECT laps FROM runs ORDER BY laps + 1",
      "node",
    ],
    [
      "ORDER BY a name that two columns have",
      "SELECT laps AS a, pace AS a FROM runs ORDER BY a",
      "unknown_name",
    ],
    ["a scalar subquery of two columns", "SELECT (SELECT laps, pace FROM runs) FROM runs", "type"],
    [
      "IN of a subquery of two columns",
      "SELECT 1 FROM runs WHERE laps IN (SELECT laps, pace FROM runs)",
      "type",
    ],
    [
      "IN of a subquery of another type",
      "SELECT 1 FROM runs WHERE laps IN (SELECT feeling FROM runs)",
      "type",
    ],
    ["a WHERE that is not a boolean", "SELECT 1 FROM runs WHERE laps", "type"],
    ["a HAVING that is not a boolean", "SELECT 1 FROM runs HAVING laps", "type"],
    ["an ON that is not a boolean", "SELECT 1 FROM runs a JOIN shoes b ON a.laps", "type"],
    [
      "USING columns of other types",
      "SELECT 1 FROM runs a JOIN expenses b USING (date, category)",
      "unknown_name",
    ],
    [
      "USING a column of another type",
      "SELECT 1 FROM (SELECT 1 AS x) a JOIN (SELECT 'a' AS x) b USING (x)",
      "type",
    ],
    ["a column alias list longer than the columns", "SELECT 1 FROM (SELECT 1) AS t (a, b)", "node"],
    ["the same alias twice", "SELECT 1 FROM runs a, shoes a", "unknown_name"],
    [
      "a CTE referring to a later one",
      "WITH a AS (SELECT * FROM b), b AS (SELECT 1) SELECT 1",
      "unknown_name",
    ],
    ["a CTE referring to itself", "WITH a AS (SELECT * FROM a) SELECT 1", "unknown_name"],
    ["a CTE column list longer than the query's", "WITH c (a, b) AS (SELECT 1) SELECT 1", "node"],
    [
      "a CTE used outside its query",
      "SELECT (WITH c AS (SELECT 1) SELECT 1) + (SELECT x FROM c)",
      "unknown_name",
    ],
  ])("%s", (_n, sql, reason) => {
    expect(outcome(check(sql))).toBe(`sql_rejected/${reason}`);
  });

  it("but takes what PostgreSQL takes", () => {
    for (const sql of [
      "SELECT route, count(*) FROM runs GROUP BY route HAVING count(*) > 1 ORDER BY route",
      "SELECT 1 + count(*) FROM runs",
      "SELECT route, laps FROM runs GROUP BY route, laps",
      "SELECT route AS r FROM runs GROUP BY 1 ORDER BY r",
      "SELECT laps + 1 FROM runs GROUP BY laps + 1",
      "SELECT laps + 1 FROM runs GROUP BY laps",
      "SELECT count(*) FROM runs HAVING true",
      "SELECT sum(laps) OVER (PARTITION BY route) FROM runs",
      "SELECT route, rank() OVER (ORDER BY count(*)) FROM runs GROUP BY route",
      "SELECT (SELECT count(*) FROM expenses e WHERE e.date = r.date) FROM runs r GROUP BY r.date",
      "SELECT DISTINCT ON (route, laps) route, laps FROM runs ORDER BY laps, route",
      "SELECT DISTINCT route, laps FROM runs ORDER BY laps, route",
      "SELECT DISTINCT route FROM runs ORDER BY 1",
      "SELECT DISTINCT route AS r FROM runs ORDER BY r",
      "SELECT laps FROM runs ORDER BY laps + 1",
      "SELECT 1 AS a, 2 AS a ORDER BY 1",
    ]) {
      expect({ sql, got: outcome(check(sql)) }).toEqual({ sql, got: "ok" });
    }
  });
});

describe("whitelist entry by entry: every entry of S is reached by an accepted query", () => {
  const texts = POSITIVE.map((p) => p.sql).join("\n");

  /** The nodes of a statement's parse tree, by the names of the whitelist. */
  function nodes(tree: unknown, seen = new Set<string>()): Set<string> {
    const walk = (v: unknown, key?: string): void => {
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (v === null || typeof v !== "object") return;
      for (const [k, x] of Object.entries(v)) {
        if (/^[A-Z]/.test(k) && x !== null && typeof x === "object") seen.add(k);
        if (k === "alias") seen.add("Alias");
        if (k === "stmts") seen.add("RawStmt");
        if (k === "withClause") seen.add("WithClause");
        if (k === "over") seen.add("WindowDef");
        if (k === "ival") seen.add("Integer");
        if (k === "fval") seen.add("Float");
        if (k === "sval") seen.add("String");
        if (k === "boolval") seen.add("Boolean");
        if (k === "typeName") seen.add("TypeName");
        walk(x, k);
      }
      void key;
    };
    walk(tree);
    return seen;
  }

  it("nodes: all 32, in some statement of the positive list", () => {
    const seen = new Set<string>();
    for (const p of POSITIVE) {
      const r = readSql(p.sql);
      if (!r.ok) throw new Error(p.sql);
      // The printed statement (time clauses are read by the scanner, not the parser).
      if (p.sql.includes("VALID_TIME") || p.sql.toLowerCase().includes("valid_time")) continue;
      nodes(rsqlParser().parse(printQuery(r.query)), seen);
    }
    const missing = NODES.filter((n) => n.contexts.includes("S") && !seen.has(n.name)).map(
      (n) => n.name,
    );
    expect(missing).toEqual([]);
  });

  it("functions, with their synonyms", () => {
    const missing = FUNCTIONS.flatMap((f) => [f.name, ...(f.aliases ?? [])]).filter(
      (n) => !new RegExp(`\\b${n}\\s*\\(`, "i").test(texts),
    );
    expect(missing).toEqual([]);
  });

  it("aggregates, and the window functions", () => {
    expect(
      AGGREGATES.map((a) => a.name).filter((n) => !new RegExp(`\\b${n}\\s*\\(`, "i").test(texts)),
    ).toEqual([]);
    expect(
      WINDOW_FUNCTIONS.filter((w) => w.contexts.includes("S"))
        .map((w) => w.name)
        .filter(
          (n) =>
            !new RegExp(`\\b${n}\\s*\\([^)]*\\)\\s*OVER`, "i").test(texts) &&
            !new RegExp(`\\b${n}\\s*\\([^)]*\\)\\s*OVER`, "i").test(texts.replace(/\s+/g, " ")),
        ),
    ).toEqual([]);
  });

  it("operators, by the symbol in the tree", () => {
    const ops = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (v === null || typeof v !== "object") return;
      const e = v as { k?: string; op?: string; not?: boolean };
      if (e.k === "op" && e.op !== undefined) ops.add(e.op);
      if (e.k === "like") ops.add(e.not === true ? "!~~" : "~~");
      Object.values(v).forEach(walk);
    };
    for (const p of POSITIVE) {
      const r = readSql(p.sql);
      if (r.ok) walk(r.query);
    }
    expect(OPERATORS.map((o) => o.name).filter((o) => !ops.has(o))).toEqual([]);
  });

  it("casts: those S has are accepted, the others refused", () => {
    for (const e of [
      "laps::numeric",
      "pace::bigint",
      "pace::numeric(10, 2)",
      "date::timestamp",
      "date::timestamp::date",
      "DATE '2026-01-01'",
      "CAST(laps AS numeric)",
    ]) {
      expect({ e, got: outcome(check(`SELECT ${e} FROM runs`)) }).toEqual({
        e,
        got: e === "date::timestamp" ? "sql_rejected/type" : "ok",
      });
    }
  });
});

describe("what is printed carries the caller's text only through the tree", () => {
  it("prints each query so that the parser reads it back as the same tree", () => {
    for (const p of POSITIVE) {
      const a = readSql(p.sql);
      if (!a.ok) throw new Error(p.sql);
      const text = printQuery(a.query);
      const b = readSql(text);
      if (!b.ok) throw new Error(`${p.sql}\n→ ${text}\n→ ${JSON.stringify(b.error)}`);
      expect({ sql: p.sql, text, tree: shape(b.query) }).toEqual({
        sql: p.sql,
        text,
        tree: shape(a.query),
      });
      // And the analysed query, its stars expanded, is a query of its own.
      const r = check(p.sql, [...(p.params ?? [])], p.ledger === true ? both : [health()]);
      if (!r.ok) throw new Error(p.sql);
      const expanded = printQuery(r.analysis.query);
      const c = readSql(expanded);
      if (!c.ok) throw new Error(`${p.sql}\n→ ${expanded}\n→ ${JSON.stringify(c.error)}`);
      expect(shape(c.query)).toBe(shape(r.analysis.query));
      const again = check(expanded, [...(p.params ?? [])], p.ledger === true ? both : [health()]);
      if (!again.ok) throw new Error(`${expanded}\n→ ${JSON.stringify(again.error)}`);
      expect(again.analysis.columns.map((x) => `${x.type}:${x.unit ?? ""}`)).toEqual(
        r.analysis.columns.map((x) => `${x.type}:${x.unit ?? ""}`),
      );
      // The tree the parser makes of what was printed, when the text is one it can read.
      if (!/valid_time/i.test(expanded)) expect(() => rsqlParser().parse(expanded)).not.toThrow();
    }
  });

  it("leaves out the comments and the spelling, and quotes every name", () => {
    const a = readSql(
      "SELECT /* secret */ Laps -- more\n FROM RUNS  AS  r WHERE feeling = 'it''s ; -- /* */ \\ '",
    );
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    const text = printQuery(a.query);
    expect(text).toBe(
      `SELECT "laps" FROM "runs" AS "r" WHERE ("feeling" = 'it''s ; -- /* */ \\ ')`,
    );
    expect(text).not.toContain("secret");
  });

  it("holds a name with quotes and a statement break as the name it is", () => {
    const evil = 'x"; DROP TABLE runs; --';
    const a = readSql(
      `SELECT laps AS "${evil.replaceAll('"', '""')}" FROM runs AS "${evil.replaceAll('"', '""')}"`,
    );
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    const text = printQuery(a.query);
    const b = readSql(text);
    if (!b.ok) throw new Error(JSON.stringify(b.error));
    expect(shape(b.query)).toBe(shape(a.query));
    // One statement, a SELECT, and the break is inside the name.
    const parsed = rsqlParser().parse(text) as { stmts: unknown[] };
    expect(parsed.stmts).toHaveLength(1);
    // Caller-chosen names are folded to lower case, in the definition and in every reference.
    expect(JSON.stringify(a.query)).toContain("drop table runs; --");
    expect(JSON.stringify(parsed)).toContain("SelectStmt");
    expect(JSON.stringify(parsed)).not.toContain("DropStmt");
  });

  it("holds a string with quotes, backslashes and break markers as the string it is", () => {
    for (const s of [
      "'; DROP TABLE runs; --",
      "\\'; DROP",
      "a\nb",
      "*/ SELECT 1 /*",
      "\u0000x".slice(1),
      "\u{1F600} é",
      "$$ x $$",
      "E'\\x41'",
    ]) {
      const a = readSql(`SELECT 1 FROM runs WHERE feeling = '${s.replaceAll("'", "''")}'`);
      if (!a.ok) throw new Error(`${s}\n${JSON.stringify(a.error)}`);
      const b = readSql(printQuery(a.query));
      if (!b.ok) throw new Error(`${s}\n${JSON.stringify(b.error)}`);
      expect(shape(b.query)).toBe(shape(a.query));
    }
  });

  it("does not print a tree that holds what the parser could not have given", () => {
    const col = (parts: string[]): Expr => ({ k: "col", parts, loc: 0 });
    const q = (e: Expr): Query => ({
      with: [],
      body: {
        k: "select",
        distinct: false,
        targets: [{ expr: e, loc: 0 }],
        from: [],
        groupBy: [],
        windows: [],
        loc: 0,
      },
      orderBy: [],
      loc: 0,
    });
    for (const e of [
      { k: "int", text: "1; DROP TABLE x", loc: 0 },
      { k: "num", text: "1e5", loc: 0 },
      { k: "func", name: "lower(", args: [], loc: 0 },
      { k: "func", name: "A", args: [], loc: 0 },
      { k: "op", op: "||/", args: [col(["a"]), col(["b"])], loc: 0 },
      { k: "op", op: "; --", args: [col(["a"]), col(["b"])], loc: 0 },
      { k: "extract", field: "year; DROP", arg: col(["a"]), loc: 0 },
      { k: "agg", name: "sum)", star: true, distinct: false, loc: 0 },
      { k: "param", n: 0, loc: 0 },
      { k: "param", n: 1.5, loc: 0 },
      col([""]),
      col(["a\0b"]),
      { k: "str", value: "a\0b", loc: 0 },
    ] as Expr[]) {
      expect(() => printQuery(q(e))).toThrow();
    }
    // A name with a quote in it is a name.
    expect(printQuery(q(col(['a"b'])))).toBe('SELECT "a""b"');
  });

  it("has no way in for the caller's text but the names, strings and numbers of the tree", () => {
    // Every printed string is a quoted name, a quoted string, a checked number or a fixed word:
    // taking those out leaves only words of the printer's own.
    const a = readSql(
      "SELECT abs(laps) + 1.5 AS \"A b\", 'x' || feeling FROM health.runs AS r WHERE laps IN (1, 2) ORDER BY 1 DESC NULLS LAST LIMIT 3 OFFSET $1",
    );
    if (!a.ok) throw new Error(JSON.stringify(a.error));
    const text = printQuery(a.query);
    const rest = text
      .replace(/"(?:[^"]|"")*"/g, "N")
      .replace(/'(?:[^']|'')*'/g, "S")
      .replace(/\$\d+|-?\d+(?:\.\d+)?/g, "9");
    expect(rest).toBe(
      "SELECT (abs(N) + 9) AS N, (S || N) FROM N.N AS N WHERE (N IN (9, 9)) ORDER BY 9 DESC NULLS LAST LIMIT 9 OFFSET 9",
    );
  });
});

describe("the whole refused list at once, and the same for every spelling and place", () => {
  it("gives each case its outcome as written", () => {
    const wrong = REFUSED.flatMap((c) => {
      const got = outcome(check(stmt(c), [...(c.params ?? [])]));
      return got === c.want ? [] : [{ sql: stmt(c), want: c.want, got }];
    });
    expect(wrong).toEqual([]);
  });

  it("gives each variation of each case the same outcome", () => {
    const wrong: unknown[] = [];
    let total = 0;
    for (const c of REFUSED) {
      for (const v of variations(c)) {
        total++;
        const got = outcome(check(v.sql, [...(c.params ?? [])]));
        if (got !== c.want) wrong.push({ variation: v.name, sql: v.sql, want: c.want, got });
      }
    }
    expect(wrong).toEqual([]);
    expect(total).toBeGreaterThan(5000);
  });

  it("covers each reason the spec lists for `sql_rejected` except `runtime`, which is not found before the query runs", () => {
    const reasons = new Set(REFUSED.map((c) => c.want.split("/")[1]));
    for (const r of SQL_REASONS) {
      // `limit` is the section above's, at the limit and one over.
      if (r === "runtime" || r === "limit") continue;
      expect({ r, seen: reasons.has(r) }).toEqual({ r, seen: true });
    }
    expect(reasons.has("ambiguous_table")).toBe(false);
  });

  it("gives a reason from the contract's list, a line and a message for every refusal", () => {
    for (const c of REFUSED) {
      const r = check(stmt(c), [...(c.params ?? [])]);
      if (r.ok) continue;
      expect(r.error.message.length).toBeGreaterThan(0);
      if (r.error.code === "sql_rejected") expect(SQL_REASONS).toContain(r.error.reason);
      const line = "line" in r.error ? r.error.line : undefined;
      if (line !== undefined) expect(Number.isInteger(line) && line >= 1).toBe(true);
      expect(r.error.message).not.toMatch(/not compiled yet/);
    }
  });
});

describe("the cost of analysis grows with the size of the text", () => {
  /** How many times an expression is typed while a statement is analysed. */
  function inferences(sql: string): number {
    const spy = vi.spyOn(ExprTyper.prototype, "ty");
    try {
      const r = check(sql);
      if (!r.ok) throw new Error(`${sql}\n→ ${JSON.stringify(r.error)}`);
      return spy.mock.calls.length;
    } finally {
      spy.mockRestore();
    }
  }

  // One level of nesting for each form that types its operands, around `x`.
  const LEVELS: [string, (x: string) => string][] = [
    ["IS DISTINCT FROM", (x) => `(${x} IS DISTINCT FROM TRUE)`],
    ["IS NOT DISTINCT FROM", (x) => `(${x} IS NOT DISTINCT FROM TRUE)`],
    ["the right side of IS DISTINCT FROM", (x) => `(TRUE IS DISTINCT FROM ${x})`],
    ["simple CASE, the argument", (x) => `(CASE ${x} WHEN TRUE THEN TRUE END)`],
    ["simple CASE, a WHEN", (x) => `(CASE TRUE WHEN ${x} THEN TRUE ELSE FALSE END)`],
    ["searched CASE", (x) => `(CASE WHEN ${x} THEN TRUE ELSE FALSE END)`],
    ["NULLIF", (x) => `NULLIF(${x}, TRUE)`],
    ["COALESCE", (x) => `COALESCE(${x}, TRUE)`],
    ["AND", (x) => `(${x} AND TRUE)`],
    ["NOT", (x) => `(NOT ${x})`],
    ["IS TRUE", (x) => `(${x} IS TRUE)`],
    ["IS NULL", (x) => `(${x} IS NULL)`],
    ["comparison", (x) => `(${x} = TRUE)`],
    ["IN", (x) => `(${x} IN (TRUE, FALSE))`],
    ["BETWEEN", (x) => `(${x} BETWEEN FALSE AND TRUE)`],
    ["BETWEEN, the bound", (x) => `(TRUE BETWEEN ${x} AND TRUE)`],
    ["scalar subquery", (x) => `(SELECT ${x})`],
  ];

  it.each(LEVELS)(
    "%s: typing each level once, the count grows by the same amount per level",
    (form, level) => {
      const nest = (n: number) => {
        let x = "race";
        for (let i = 0; i < n; i++) x = level(x);
        return `SELECT ${x} FROM runs`;
      };
      // Up to the nesting limits (32 deep, 4 subqueries).
      const ns = form === "scalar subquery" ? [1, 2, 3] : [6, 12, 18, 24];
      const counts = ns.map((n) => inferences(nest(n)));
      const perLevel = counts
        .slice(1)
        .map((c, i) => (c - (counts[i] as number)) / ((ns[i + 1] as number) - (ns[i] as number)));
      // The same number of inferences for each added level, and few: not a matter of timing.
      expect(new Set(perLevel).size, `${form}: ${counts} at ${ns}`).toBe(1);
      expect(perLevel[0] as number).toBeLessThanOrEqual(4);
    },
  );
});

describe("a node the whitelist knows, spelled with more than it admits, is refused (refusal is the default)", () => {
  // For each class of node: statements whose only fault is a key or form of that node that the
  // whitelist does not list. Each is refused as `node`, except where another rule answers first.
  const EXTRA: readonly [node: string, sql: string, reason: string][] = [
    ["TypeName", "SELECT laps::numeric[] FROM runs", "node"],
    ["TypeName", "SELECT CAST(laps AS numeric[]) FROM runs", "node"],
    ["TypeName", "SELECT laps::numeric ARRAY FROM runs", "node"],
    ["TypeName", "SELECT laps::numeric(10, 2)[] FROM runs", "node"],
    ["TypeName", "SELECT date::timestamp(3) FROM runs", "node"],
    ["TypeName", "SELECT pace::numeric(10, 2, 3) FROM runs", "node"],
    ["TypeName", "SELECT laps::setof numeric FROM runs", "node"],
    ["TypeName", "SELECT $1::numeric[]", "node"],
    ["TypeName", "SELECT CASE WHEN true THEN 1 END::numeric[] FROM runs", "node"],
    ["FuncCall", "SELECT sum(laps ORDER BY laps) FROM runs", "node"],
    ["FuncCall", "SELECT sum(DISTINCT laps) FROM runs", "node"],
    ["FuncCall", "SELECT sum(VARIADIC ARRAY[1]) FROM runs", "node"],
    ["FuncCall", "SELECT max(*) FROM runs", "node"],
    ["FuncCall", "SELECT count(*) WITHIN GROUP (ORDER BY laps) FROM runs", "node"],
    ["FuncCall", "SELECT substr(feeling, length => 1) FROM runs", "node"],
    ["FuncCall", 'SELECT "COUNT"(*) FROM runs', "node"],
    ["FuncCall", "SELECT pg_catalog.count(*) FROM runs", "function"],
    [
      "WindowDef",
      "SELECT count(*) OVER (ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE CURRENT ROW) FROM runs",
      "node",
    ],
    [
      "WindowDef",
      "SELECT count(*) OVER (ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE TIES) FROM runs",
      "node",
    ],
    [
      "WindowDef",
      "SELECT count(*) OVER (ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW EXCLUDE GROUP) FROM runs",
      "node",
    ],
    ["SortBy", "SELECT laps FROM runs ORDER BY laps USING <", "node"],
    ["SortBy", "SELECT laps FROM runs ORDER BY laps USING >", "node"],
    ["SortBy", "SELECT DISTINCT ON (laps) laps FROM runs ORDER BY laps USING <", "node"],
    ["SortBy", 'SELECT laps FROM runs ORDER BY laps COLLATE "C"', "node"],
    ["RangeVar", "SELECT laps FROM ONLY runs", "node"],
    ["RangeVar", "SELECT laps FROM runs TABLESAMPLE SYSTEM (10)", "node"],
    ["RangeVar", "SELECT * FROM runs a TABLESAMPLE BERNOULLI (5) REPEATABLE (1)", "node"],
    ["RangeVar", "SELECT laps FROM health.public.runs", "node"],
    ["JoinExpr", "SELECT laps FROM (runs a JOIN shoes b ON true) AS j", "node"],
    ["JoinExpr", "SELECT laps FROM runs a NATURAL JOIN shoes b", "node"],
    ["JoinExpr", "SELECT 1 FROM runs a JOIN shoes b USING (date) AS u", "node"],
    ["RangeSubselect", "SELECT * FROM runs a, LATERAL (SELECT a.laps) b", "node"],
    ["RangeSubselect", "SELECT * FROM runs a CROSS JOIN LATERAL (SELECT 1) b", "node"],
    ["CommonTableExpr", "WITH c AS MATERIALIZED (SELECT 1) SELECT * FROM c", "node"],
    ["CommonTableExpr", "WITH c AS NOT MATERIALIZED (SELECT 1) SELECT * FROM c", "node"],
    [
      "CommonTableExpr",
      "WITH c AS (SELECT 1) SEARCH DEPTH FIRST BY x SET y SELECT * FROM c",
      "node",
    ],
    ["CommonTableExpr", "WITH c AS (SELECT 1 AS x) CYCLE x SET m USING p SELECT * FROM c", "node"],
    ["WithClause", "WITH RECURSIVE c AS (SELECT 1) SELECT * FROM c", "node"],
    ["SelectStmt", "SELECT laps INTO t FROM runs", "node"],
    ["SelectStmt", "SELECT laps FROM runs FOR UPDATE", "node"],
    ["SelectStmt", "SELECT * FROM (VALUES (1)) v", "node"],
    ["SelectStmt", "SELECT laps FROM runs ORDER BY laps FETCH FIRST 5 ROWS WITH TIES", "node"],
    ["SelectStmt", "SELECT laps FROM runs GROUP BY ROLLUP (laps)", "node"],
    ["SelectStmt", "SELECT laps FROM runs GROUP BY DISTINCT laps", "node"],
    ["SelectStmt", "SELECT laps FROM runs GROUP BY GROUPING SETS ((laps))", "node"],
    ["ResTarget", "SELECT laps[1] FROM runs", "node"],
    ["ResTarget", "SELECT (laps).x FROM runs", "node"],
    ["ColumnRef", "SELECT a.b.c.d FROM runs", "node"],
    ["NullTest", "SELECT ROW(1,2) IS NULL FROM runs", "node"],
    ["SubLink", "SELECT laps = ANY (SELECT laps FROM runs) FROM runs", "node"],
    ["SubLink", "SELECT laps > ALL (SELECT laps FROM runs) FROM runs", "node"],
    ["SubLink", "SELECT ARRAY(SELECT laps FROM runs) FROM runs", "node"],
    ["A_Expr", "SELECT laps = ANY (ARRAY[1,2]) FROM runs", "node"],
    ["A_Expr", "SELECT feeling SIMILAR TO 'a' FROM runs", "function"],
    ["A_Expr", "SELECT (1, 2) OVERLAPS (3, 4) FROM runs", "function"],
    ["Alias", "SELECT * FROM runs a JOIN shoes b USING (date) AS u", "node"],
  ];

  it.each(EXTRA.map((c) => [`${c[0]}: ${c[1]}`, c] as const))("%s", (_n, [, sql, reason]) => {
    expect(outcome(check(sql))).toBe(`sql_rejected/${reason}`);
  });

  it("covers the node classes the whitelist has for S, as far as they take extra keys", () => {
    const classes = new Set(EXTRA.map((c) => c[0]));
    for (const n of [
      "TypeName",
      "FuncCall",
      "WindowDef",
      "SortBy",
      "RangeVar",
      "JoinExpr",
      "RangeSubselect",
      "CommonTableExpr",
      "WithClause",
      "SelectStmt",
      "ResTarget",
      "ColumnRef",
      "NullTest",
      "SubLink",
      "A_Expr",
      "Alias",
    ]) {
      expect({ n, covered: classes.has(n) }).toEqual({ n, covered: true });
      expect(NODES.some((x) => x.name === n && x.contexts.includes("S"))).toBe(true);
    }
  });
});

describe("an unknown key on any node of any accepted statement's parse tree is refused", () => {
  // The queries of the positive list are parsed; then, one at a time, every object of the tree gets
  // a key the parser does not give. The walker refuses what it does not know whichever node it is on,
  // not only on the node classes of the table above (a later libpg_query may add keys to any).
  it("refuses each injection, and and reaches the main kinds of node", () => {
    let total = 0;
    const accepted: string[] = [];
    const kinds = new Set<string>();
    for (const p of POSITIVE) {
      if (/valid_time/i.test(p.sql)) continue;
      const tree = rsqlParser().parse(p.sql) as unknown;
      const paths: (string | number)[][] = [];
      const walk = (v: unknown, path: (string | number)[]): void => {
        if (Array.isArray(v)) {
          v.forEach((x, i) => {
            walk(x, [...path, i]);
          });
          return;
        }
        if (v === null || typeof v !== "object") return;
        paths.push(path);
        for (const [k, x] of Object.entries(v)) walk(x, [...path, k]);
      };
      walk(tree, []);
      for (const path of paths) {
        const copy = JSON.parse(JSON.stringify(tree)) as Record<string, unknown>;
        let o: Record<string, unknown> = copy;
        for (const k of path) o = o[k as string] as Record<string, unknown>;
        o["zz_extra"] = 1;
        total++;
        kinds.add(
          String(path.findLast((k) => typeof k === "string" && /^[A-Z]/.test(k)) ?? "tree"),
        );
        try {
          convertQuery(copy);
          accepted.push(`${path.join(".")} in ${p.sql}`);
        } catch {
          // refused
        }
      }
    }
    expect(accepted).toEqual([]);
    expect(total).toBeGreaterThan(3000);
    // The nodes that were given the key cover the main kinds.
    for (const k of [
      "SelectStmt",
      "FuncCall",
      "WindowDef",
      "SubLink",
      "JoinExpr",
      "CommonTableExpr",
      "A_Expr",
      "CaseExpr",
      "TypeCast",
    ]) {
      expect({ k, seen: kinds.has(k) }).toEqual({ k, seen: true });
    }
  });
});

describe("`*` over a table with two columns of one name (11 «语句形状»)", () => {
  it("is refused as `node`, with `*` as the node, and a line", () => {
    for (const sql of [
      "SELECT * FROM (SELECT 1, 2) AS t",
      "SELECT * FROM (SELECT 1 AS a, 2 AS a) AS t",
      "SELECT t.* FROM (SELECT 1 AS a, 2 AS a) AS t",
      "SELECT t.* FROM (SELECT 1 AS a, 2 AS a) AS t, (SELECT 3 AS b) AS u",
      "WITH c AS (SELECT 1 AS a, 2 AS a) SELECT * FROM c",
      "SELECT * FROM (SELECT 1, 2) AS t (x, x)",
    ]) {
      expect({ sql, got: refusal(sql) }).toMatchObject({
        got: { code: "sql_rejected", reason: "node", node: "*", line: 1 },
      });
    }
  });

  it("is not refused where the same names are in different tables, or only one is taken", () => {
    for (const sql of [
      "SELECT * FROM (SELECT 1 AS a) AS x, (SELECT 2 AS a) AS y",
      "SELECT x.* FROM (SELECT 1 AS a) AS x, (SELECT 2 AS a) AS y",
      "SELECT x.a, y.a FROM (SELECT 1 AS a) AS x, (SELECT 2 AS a) AS y",
    ]) {
      expect({ sql, got: outcome(check(sql)) }).toEqual({ sql, got: "ok" });
    }
  });

  it("reads a repeated name written out as an ambiguous name, `unknown_name`, not `node`", () => {
    for (const sql of [
      "SELECT a FROM (SELECT 1 AS a, 2 AS a) AS t",
      "SELECT t.a FROM (SELECT 1 AS a, 2 AS a) AS t",
      "SELECT 1 FROM (SELECT 1 AS a, 2 AS a) AS t WHERE a = 1",
    ]) {
      expect({ sql, got: refusal(sql) }).toMatchObject({
        got: { code: "sql_rejected", reason: "unknown_name" },
      });
    }
  });
});

describe("what is printed leaves the database nothing to resolve (11 «处理步骤» 7–8)", () => {
  /** What the parser reads in the printed text of an accepted query. */
  function structure(text: string) {
    const refs: string[][] = [];
    const targetsWithoutName: string[] = [];
    const aliases: string[] = [];
    const fromItems = { total: 0, aliased: 0 };
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const x of v) walk(x);
        return;
      }
      if (v === null || typeof v !== "object") return;
      const o = v as Record<string, unknown>;
      const col = o["ColumnRef"] as { fields?: { String?: { sval?: string } }[] } | undefined;
      if (col !== undefined) refs.push((col.fields ?? []).map((f) => f.String?.sval ?? "*"));
      const target = o["ResTarget"] as { name?: string; val?: unknown } | undefined;
      if (target !== undefined && target.name === undefined) targetsWithoutName.push(text);
      for (const kind of ["RangeVar", "RangeSubselect"]) {
        const f = o[kind] as { alias?: { aliasname?: string } } | undefined;
        if (f !== undefined) {
          fromItems.total++;
          const name = f.alias?.aliasname;
          if (name !== undefined) {
            fromItems.aliased++;
            aliases.push(name);
          }
        }
      }
      const cte = o["CommonTableExpr"] as { ctename?: string } | undefined;
      if (cte?.ctename !== undefined) aliases.push(cte.ctename);
      for (const x of Object.values(o)) walk(x);
    };
    walk(rsqlParser().parse(text));
    return { refs, targetsWithoutName, aliases, fromItems };
  }

  it.each(POSITIVE.map((p) => [p.name, p] as const))(
    "%s: every column is a generated alias and a column, every output has AS, every alias is the only one",
    (_name, p) => {
      const r = check(p.sql, [...(p.params ?? [])], p.ledger === true ? both : [health()]);
      if (!r.ok) throw new Error(`${p.sql}\n→ ${JSON.stringify(r.error)}`);
      const text = printQuery(r.analysis.query);
      // Time clauses are read by the library's scanner, not its parser: take them out for the parse.
      const parsable = text.replace(/ FOR VALID_TIME (AS OF|FROM) [^"]*?(?= AS "t\d+")/g, "");
      const st = structure(parsable);
      // Each column: `"t<n>"."name"`, the alias of a FROM item of this query.
      for (const ref of st.refs) {
        expect({ text, ref }).toEqual({
          text,
          ref: [expect.stringMatching(/^t\d+$/), expect.any(String)],
        });
        expect(ref.length).toBe(2);
        expect(st.aliases).toContain(ref[0]);
      }
      expect(st.targetsWithoutName).toEqual([]);
      // Every FROM item has a generated alias, and no alias is used twice in the query.
      expect(st.fromItems.aliased).toBe(st.fromItems.total);
      const tables = st.aliases.filter((a) => /^t\d+$/.test(a));
      expect(new Set(st.aliases).size).toBe(st.aliases.length);
      expect(tables.length).toBe(st.fromItems.total);
      // The caller's own spelling of an alias or a name does not come through: only generated ones.
      for (const a of st.aliases) expect(a).toMatch(/^[tc]\d+$/);
    },
  );

  it("a column a USING merges is the equality's column on the side it comes from", () => {
    const text = (sql: string) => {
      const r = check(sql);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return printQuery(r.analysis.query);
    };
    expect(text("SELECT x FROM (SELECT 1 AS x) a JOIN (SELECT 2 AS x) b USING (x)")).toContain(
      'ON ("t1"."x" = "t2"."x")',
    );
    expect(text("SELECT x FROM (SELECT 1 AS x) a LEFT JOIN (SELECT 2 AS x) b USING (x)")).toContain(
      'SELECT "t1"."x" AS "x"',
    );
    expect(
      text("SELECT x FROM (SELECT 1 AS x) a RIGHT JOIN (SELECT 2 AS x) b USING (x)"),
    ).toContain('SELECT "t2"."x" AS "x"');
    expect(text("SELECT x FROM (SELECT 1 AS x) a FULL JOIN (SELECT 2 AS x) b USING (x)")).toContain(
      'SELECT COALESCE("t1"."x", "t2"."x") AS "x"',
    );
  });

  it("ORDER BY and GROUP BY by an output name are written by position", () => {
    const text = (sql: string) => {
      const r = check(sql);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      return printQuery(r.analysis.query);
    };
    expect(text("SELECT laps AS n, count(*) AS c FROM runs GROUP BY n ORDER BY c DESC")).toMatch(
      /GROUP BY 1 ORDER BY 2 DESC$/,
    );
    expect(text("SELECT 1 AS a UNION SELECT 2 ORDER BY a")).toMatch(/ORDER BY 1$/);
  });
});

describe("names in subqueries and CTEs: what the printed text will be resolved against (11 «名字»)", () => {
  const refused = (sql: string, slots?: readonly SqlSlot[]) => outcome(check(sql, [], slots));

  it("a qualified name looks in the innermost scope that has the qualifier, and never outwards", () => {
    for (const sql of [
      // The inner `s` has no `to_json`; the outer one has.
      "SELECT (SELECT s.to_json FROM (SELECT 1 AS x) s) AS v FROM (SELECT 1 AS to_json) s",
      "WITH s AS (SELECT 1 AS x) SELECT (SELECT s.to_json FROM s) AS v FROM (SELECT 1 AS to_json) s",
      "SELECT (SELECT r.to_json FROM runs r) AS v FROM (SELECT 'a' AS to_json) r",
      "SELECT (SELECT r.laps FROM shoes r) AS v FROM runs r",
      "SELECT (SELECT health.runs.nosuch FROM runs) FROM runs",
    ]) {
      expect({ sql, got: refused(sql) }).toEqual({ sql, got: "sql_rejected/unknown_name" });
    }
  });

  it("goes outwards for a name with no qualifier, and for a qualifier the inner scopes do not have", () => {
    for (const sql of [
      "SELECT (SELECT laps FROM shoes) FROM runs",
      "SELECT (SELECT r.laps FROM shoes s) FROM runs r",
      "SELECT (SELECT s.model FROM shoes s WHERE s.row_id = r.shoe) FROM runs r",
    ]) {
      expect({ sql, got: refused(sql) }).toEqual({ sql, got: "ok" });
    }
  });

  it("two CTEs of one WITH with one name, once folded, are refused; one in another WITH is not", () => {
    expect(refused('WITH "A" AS (SELECT 1 AS x), a AS (SELECT 2 AS x) SELECT x FROM a')).toBe(
      "sql_rejected/unknown_name",
    );
    expect(refused("WITH a AS (SELECT 1 AS x), A AS (SELECT 2 AS x) SELECT 1")).toBe(
      "sql_rejected/unknown_name",
    );
    expect(
      refused("WITH a AS (SELECT 1 AS x) SELECT (WITH A AS (SELECT 2 AS x) SELECT x FROM a)"),
    ).toBe("ok");
  });

  it("an output column without AS that is not a plain column cannot be named by an outer query", () => {
    for (const sql of [
      "SELECT s.count FROM (SELECT count(*) FROM runs) s",
      "SELECT count FROM (SELECT count(*) FROM runs) s",
      "SELECT s.abs FROM (SELECT abs(laps) FROM runs) s",
      "SELECT s.case FROM (SELECT CASE WHEN true THEN 1 END) s",
      "SELECT x FROM (SELECT (SELECT 1 AS x)) s",
      "SELECT s.numeric FROM (SELECT CAST((SELECT 1 AS x) AS numeric(10, 2))) s",
      "WITH c AS (SELECT count(*) FROM runs) SELECT count FROM c",
      "SELECT s.exists FROM (SELECT EXISTS (SELECT 1)) s",
    ]) {
      expect({ sql, got: refused(sql) }).toEqual({ sql, got: "sql_rejected/unknown_name" });
    }
  });

  it("a name not found in a scope that has such a column is refused, not looked for outside it", () => {
    // PostgreSQL would bind it to the unnamed column of the inner item; the analyser cannot, and must
    // not read it as the outer table's column instead.
    for (const sql of [
      "SELECT (SELECT laps FROM (SELECT (SELECT 'm' AS laps)) s) AS v FROM runs",
      "SELECT (SELECT laps FROM (SELECT count(*) FROM runs) s) FROM runs",
      "WITH c AS (SELECT count(*) FROM runs) SELECT (SELECT laps FROM c) FROM runs",
    ]) {
      expect({ sql, got: refusal(sql) }).toMatchObject({
        got: {
          code: "sql_rejected",
          reason: "unknown_name",
          node: "laps",
          suggestion: "give each output column of the subquery or CTE an AS name",
        },
      });
    }
  });

  it("where the inner items are all named, a name not found there still correlates outwards", () => {
    for (const sql of [
      "SELECT (SELECT laps FROM (SELECT 1 AS n) s) AS v FROM runs",
      "SELECT (SELECT n + laps FROM (SELECT 1 AS n) s) AS v FROM runs",
      "SELECT (SELECT s.n FROM (SELECT 1 AS n) s WHERE laps > 0) AS v FROM runs",
      "WITH c AS (SELECT 1 AS n) SELECT (SELECT laps FROM c) FROM runs",
      "SELECT (SELECT laps FROM (SELECT laps FROM shoes, runs) s) FROM runs",
    ]) {
      expect({ sql, got: outcome(check(sql)) }).toEqual({ sql, got: "ok" });
    }
  });

  it("but one with AS, or a plain column, or one a column alias list names, can", () => {
    for (const sql of [
      "SELECT s.n FROM (SELECT count(*) AS n FROM runs) s",
      "SELECT s.laps FROM (SELECT laps FROM runs) s",
      "SELECT s.laps FROM (SELECT r.laps FROM runs r) s",
      "SELECT s.n FROM (SELECT count(*) FROM runs) AS s (n)",
      "WITH c (n) AS (SELECT count(*) FROM runs) SELECT n FROM c",
      "SELECT s.n FROM (SELECT 1 AS n UNION SELECT 2) s",
    ]) {
      expect({ sql, got: refused(sql) }).toEqual({ sql, got: "ok" });
    }
  });

  it("a star still takes the column that has no name, and the result names it as the database would", () => {
    expect(columns("SELECT * FROM (SELECT count(*) FROM runs) s")).toBe("count:integer");
    expect(columns("SELECT * FROM (SELECT (SELECT 1 AS x)) s")).toBe("?column?:integer");
    expect(columns("SELECT s.* FROM (SELECT abs(laps), laps FROM runs) s")).toBe(
      "abs:integer,laps:integer",
    );
  });

  it("the columns of the result keep the caller's names, whatever the printed names are", () => {
    const r = check('SELECT laps AS "N", count(*) OVER () FROM runs');
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.analysis.columns.map((c) => c.name)).toEqual(["n", "count"]);
    // (names the caller wrote are folded, as everywhere: 11 «名字».)
  });
});
