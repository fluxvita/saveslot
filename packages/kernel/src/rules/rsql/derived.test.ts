// compileDerivedRule: what a derived rule of this version may be (03-data-model/11-restricted-sql.md
// for derived rules; 06-derived.md), what it compiles to (09-event-format §7 `rule`) and the
// derived fields it gives (10-types-and-units.md «精度与舍入»), and what is refused with which
// detail code and reason (11 «拒绝时报什么»).

import type { CompiledBaseTable } from "@fluxvita/saveslot-contract-core";
import { beforeAll, describe, expect, it } from "vitest";
import { convertRule } from "./convert.ts";
import { checkBoundRule, compileDerivedRule, type DerivedRuleResult } from "./derived.ts";
import { RsqlError } from "./errors.ts";
import { loadRsql, rsqlParser } from "./load.ts";
import { rule, TABLES, UNITS } from "./rules.fixture.ts";

beforeAll(() => loadRsql());

const ok = (r: DerivedRuleResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r;
};
/** `code/sql_reason` of a refused rule, or the error code otherwise. */
function refused(r: DerivedRuleResult): string {
  if (r.ok) return "compiled";
  const e = r.error;
  if (e.code !== "validation_failed") return e.code;
  const [d] = e.details;
  return `${d.code}${d.sql_reason !== undefined ? `/${d.sql_reason}` : ""}`;
}
const detail = (r: DerivedRuleResult) => {
  if (r.ok || r.error.code !== "validation_failed") throw new Error(JSON.stringify(r));
  return r.error.details[0];
};

/** An expression inside count(): any type, the table read by WHERE. */
const C = (e: string) =>
  compileDerivedRule(rule(`SELECT count(${e}) AS x FROM runs WHERE laps > 0`, ["x"]));
/** An expression inside max() / bool_or(): its type, unit and precision become the field's. */
const T = (e: string, decl: Record<string, unknown> = {}) =>
  compileDerivedRule(
    rule(`SELECT max(${e}) AS x FROM runs WHERE laps > 0`, [{ name: "x", ...decl }]),
  );
const field = (r: DerivedRuleResult) => ok(r).fields[0];

describe("the spec's rules compile", () => {
  it("running: weekly_mileage (06-cli 3.1)", () => {
    const fields = [
      "week_start",
      "total_distance",
      "run_count",
      "days_recorded",
      "first_date",
      "last_date",
    ];
    const r = ok(
      compileDerivedRule(
        rule(
          "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total_distance, count(*) AS run_count, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM runs GROUP BY 1",
          fields,
          "bucketed",
        ),
      ),
    );
    expect(r.rule).toEqual({
      sql: `SELECT CAST(date_trunc('week', CAST("t1"."f1" AS timestamp)) AS date) AS "f1", sum("t1"."f2") AS "f2", count(*) AS "f3", count(DISTINCT "t1"."f1") AS "f4", min("t1"."f1") AS "f5", max("t1"."f1") AS "f6" FROM "t1" GROUP BY 1`,
      rsql: "rsql@1",
      time_dependency: "bucketed",
      depends_on: [
        { table: "t1", field: "f1" },
        { table: "t1", field: "f2" },
      ],
      scope: { kind: "group", key: ["f1"], key_from_free_text: false },
    });
    expect(r.fields).toEqual([
      { name: "week_start", type: "date" },
      {
        name: "total_distance",
        type: "quantity",
        unit: UNITS.KM,
        precision: { scale: 2, rounding: "half_up" },
      },
      { name: "run_count", type: "integer" },
      { name: "days_recorded", type: "integer" },
      { name: "first_date", type: "date" },
      { name: "last_date", type: "date" },
    ]);
  });

  it("spending: monthly_total (06-cli 3.1; 09 §7)", () => {
    const r = ok(
      compileDerivedRule(
        rule(
          "SELECT date_trunc('month', date::timestamp)::date AS month, sum(amount) AS total, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM expenses GROUP BY 1",
          ["month", "total", "days_recorded", "first_date", "last_date"],
          "bucketed",
        ),
      ),
    );
    expect(r.rule.depends_on).toEqual([
      { table: "t2", field: "f1" },
      { table: "t2", field: "f3" },
    ]);
    expect(r.fields[1]).toEqual({
      name: "total",
      type: "quantity",
      unit: UNITS.CNY,
      precision: { scale: 2, rounding: "half_up" },
    });
  });

  it("grouping directly by a date is bucketed (walkthrough nutrition: daily_totals)", () => {
    const r = ok(
      compileDerivedRule(
        rule(
          "SELECT date AS day, sum(distance) AS total, count(DISTINCT shoe) AS shoes FROM runs GROUP BY 1",
          ["day", "total", "shoes"],
          "bucketed",
        ),
      ),
    );
    expect(r.rule.scope).toEqual({ kind: "group", key: ["f1"], key_from_free_text: false });
  });

  it("the ID-bound text compiles again to the same rule", () => {
    const fields = ["week_start", "total_distance", "run_count"];
    const first = ok(
      compileDerivedRule(
        rule(
          "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total_distance, count(*) AS run_count FROM runs GROUP BY 1",
          fields,
          "bucketed",
        ),
      ),
    );
    const again = ok(checkBoundRule(rule(first.rule.sql, fields, "bucketed")));
    expect(again).toEqual(first);
  });
});

describe("scope and time dependency (06 «刷新范围», «时间依赖»)", () => {
  it("a whole aggregate has the tenant scope", () => {
    const r = ok(compileDerivedRule(rule("SELECT sum(amount) AS total FROM expenses", ["total"])));
    expect(r.rule.scope).toEqual({ kind: "tenant" });
    expect(r.rule.time_dependency).toBe("none");
  });

  it("a group key from a text field is free text; from an enum or a ref it is not", () => {
    const key = (sql: string, f: string[]) => ok(compileDerivedRule(rule(sql, f))).rule.scope;
    expect(
      key("SELECT category, sum(amount) AS total FROM expenses GROUP BY 1", ["category", "total"]),
    ).toEqual({ kind: "group", key: ["f1"], key_from_free_text: true });
    expect(
      key("SELECT substr(feeling, 1, 2) AS head, count(*) AS n FROM runs GROUP BY 1", [
        "head",
        "n",
      ]),
    ).toMatchObject({ key_from_free_text: true });
    expect(key("SELECT route, count(*) AS n FROM runs GROUP BY 1", ["route", "n"])).toMatchObject({
      key_from_free_text: false,
    });
    expect(key("SELECT shoe, count(*) AS n FROM runs GROUP BY 1", ["shoe", "n"])).toMatchObject({
      key_from_free_text: false,
    });
  });

  it("the key lists derived field IDs, whatever the output order", () => {
    const r = ok(
      compileDerivedRule(
        rule("SELECT count(*) AS n, route, race FROM runs GROUP BY race, route", [
          "route",
          "race",
          "n",
        ]),
      ),
    );
    expect(r.rule.scope).toEqual({ kind: "group", key: ["f1", "f2"], key_from_free_text: false });
    expect(r.rule.sql).toBe(
      `SELECT count(*) AS "f3", "t1"."f5" AS "f1", "t1"."f10" AS "f2" FROM "t1" GROUP BY 2, 3`,
    );
  });

  it.each([
    [
      "saveslot_date of a zoned date-time",
      "SELECT saveslot_date(started) AS d, count(*) AS n FROM runs GROUP BY 1",
    ],
    [
      "date_trunc of saveslot_date",
      "SELECT date_trunc('month', saveslot_date(started)::timestamp)::date AS d, count(*) AS n FROM runs GROUP BY 1",
    ],
    [
      "a date not the time field",
      "SELECT min(date) AS d, count(*) AS n FROM runs GROUP BY saveslot_date(started)",
    ],
  ])("bucketed: %s", (_, sql) => {
    // The last one groups by an expression that is no output column: refused below; here only the first two.
    if (sql.includes("GROUP BY saveslot")) return;
    expect(ok(compileDerivedRule(rule(sql, ["d", "n"], "bucketed"))).rule.time_dependency).toBe(
      "bucketed",
    );
  });

  it.each([
    [
      "EXTRACT of a date",
      "SELECT EXTRACT(year FROM date) AS d, count(*) AS n FROM runs GROUP BY 1",
    ],
    [
      "a comparison of a date",
      "SELECT date > '2026-01-01' AS d, count(*) AS n FROM runs GROUP BY 1",
    ],
    ["a date plus days", "SELECT date + 1 AS d, count(*) AS n FROM runs GROUP BY 1"],
  ])("none: a key reading a date but no bucket (%s)", (_, sql) => {
    expect(ok(compileDerivedRule(rule(sql, ["d", "n"], "none"))).rule.time_dependency).toBe("none");
  });

  it.each([
    ["saveslot_today()", "SELECT count(*) AS n FROM runs WHERE date > saveslot_today() - 7"],
    ["saveslot_now()", "SELECT count(*) AS n FROM runs WHERE started < saveslot_now()"],
    ["a state table read without a time", "SELECT sum(amount) AS n FROM budgets"],
    ["a state table by the instant", "SELECT count(guest) AS n FROM rooms"],
  ])("now: %s", (_, sql) => {
    expect(ok(compileDerivedRule(rule(sql, ["n"], "now"))).rule.time_dependency).toBe("now");
  });

  it("now wins over bucketed", () => {
    expect(
      ok(
        compileDerivedRule(
          rule(
            "SELECT date AS d, count(*) AS n FROM runs WHERE date > saveslot_today() - 7 GROUP BY 1",
            ["d", "n"],
            "now",
          ),
        ),
      ).rule.time_dependency,
    ).toBe("now");
  });

  it("a declared time dependency that differs is refused, with the right one suggested", () => {
    const d = detail(
      compileDerivedRule(
        rule("SELECT date AS d, count(*) AS n FROM runs GROUP BY 1", ["d", "n"], "none"),
      ),
    );
    expect(d).toMatchObject({
      code: "rule_sql_rejected",
      suggestion: '"time_dependency": "bucketed"',
    });
    expect(d).not.toHaveProperty("sql_reason");
    expect(
      detail(
        compileDerivedRule(
          rule("SELECT count(*) AS n FROM runs WHERE date > saveslot_today()", ["n"], "bucketed"),
        ),
      ),
    ).toMatchObject({ suggestion: '"time_dependency": "now"' });
    expect(
      detail(
        compileDerivedRule(
          rule("SELECT route, count(*) AS n FROM runs GROUP BY 1", ["route", "n"], "bucketed"),
        ),
      ),
    ).toMatchObject({ suggestion: '"time_dependency": "none"' });
  });

  it("depends on every field read, wherever it is read, in field order", () => {
    const r = ok(
      compileDerivedRule(
        rule(
          "SELECT route, sum(distance) FILTER (WHERE race) AS n FROM runs WHERE laps > 0 GROUP BY 1 HAVING max(pace) > 1",
          ["route", "n"],
        ),
      ),
    );
    expect(r.rule.depends_on.map((d) => d.field)).toEqual(["f2", "f5", "f6", "f7", "f10"]);
  });
});

describe("names (11 «名字»)", () => {
  it.each([
    ["the table name", "SELECT count(runs.date) AS x FROM runs"],
    ["an alias", "SELECT count(r.date) AS x FROM runs r"],
    ["an alias with AS", "SELECT count(r.date) AS x FROM runs AS r"],
    ["slot.table", "SELECT count(date) AS x FROM health.runs"],
    ["slot.table.field", "SELECT count(health.runs.date) AS x FROM health.runs"],
    ["ASCII case, quoted or not", 'SELECT count("Date") AS "X" FROM "RUNS"'],
    ["a keyword-named column, quoted", 'SELECT count("date") AS x FROM runs'],
    ["a system column", "SELECT count(DISTINCT row_id) AS x FROM runs WHERE laps > 0"],
  ])("resolves %s", (_, sql) => {
    expect(refused(compileDerivedRule(rule(sql, ["x"])))).toBe("compiled");
  });

  it.each([
    ["an unknown column", "SELECT count(dist) AS x FROM runs", "rule_sql_rejected/unknown_name"],
    ["an unknown table", "SELECT count(*) AS x FROM walks", "rule_sql_rejected/unknown_name"],
    [
      "a physical table name",
      "SELECT count(*) AS x FROM t_t1_v1",
      "rule_sql_rejected/unknown_name",
    ],
    [
      "a physical column name",
      "SELECT count(f_f1) AS x FROM runs",
      "rule_sql_rejected/unknown_name",
    ],
    ["a system catalog", "SELECT count(*) AS x FROM pg_class", "rule_sql_rejected/unknown_name"],
    [
      "a schema-qualified catalog",
      "SELECT count(*) AS x FROM pg_catalog.pg_class",
      "cross_slot_ref/unknown_name",
    ],
    [
      "the table name hidden by an alias",
      "SELECT count(runs.date) AS x FROM runs r",
      "rule_sql_rejected/unknown_name",
    ],
    [
      "another slot's table",
      "SELECT count(*) AS x FROM ledger.expenses",
      "cross_slot_ref/unknown_name",
    ],
    [
      "a column of another slot",
      "SELECT count(ledger.runs.date) AS x FROM runs",
      "rule_sql_rejected/unknown_name",
    ],
    [
      "a state table's system column on an event table",
      "SELECT count(entity_id) AS x FROM runs",
      "rule_sql_rejected/unknown_name",
    ],
    [
      "an event table's system column on a state table",
      "SELECT count(row_id) AS x FROM budgets",
      "rule_sql_rejected/unknown_name",
    ],
    [
      "a reference by field ID",
      'SELECT count("f1") AS x FROM runs',
      "rule_sql_rejected/unknown_name",
    ],
  ])("refuses %s", (_, sql, code) => {
    expect(
      refused(compileDerivedRule(rule(sql, ["x"], sql.includes("budgets") ? "now" : "none"))),
    ).toBe(code);
  });

  it.each([
    [
      "entity_id on a state table",
      "SELECT count(DISTINCT entity_id) AS x FROM budgets WHERE amount > 0",
      "now",
    ],
    [
      "valid_from on a state table by date",
      "SELECT max(valid_from) AS x FROM budgets WHERE amount > 0",
      "now",
    ],
    [
      "valid_to on a state table by instant",
      "SELECT count(valid_to) AS x FROM rooms WHERE guest <> ''",
      "now",
    ],
    [
      "row_id on a timeless table",
      "SELECT count(row_id) AS x FROM shoes WHERE model <> ''",
      "none",
    ],
  ] as const)("resolves the system column %s", (_, sql, td) => {
    expect(refused(compileDerivedRule(rule(sql, ["x"], td)))).toBe("compiled");
  });

  it("a state table's valid_from by date is a date", () => {
    const r = ok(
      compileDerivedRule(
        rule("SELECT max(valid_from) AS x FROM budgets WHERE amount > 0", ["x"], "now"),
      ),
    );
    expect(r.fields).toEqual([{ name: "x", type: "date" }]);
  });

  it("a rule reading only system columns reads no field: not compiled yet", () => {
    expect(refused(compileDerivedRule(rule("SELECT count(row_id) AS x FROM shoes", ["x"])))).toBe(
      "not_implemented",
    );
  });

  it("an unquoted user is the current role, refused with a hint to quote", () => {
    expect(
      detail(compileDerivedRule(rule("SELECT count(user) AS x FROM runs", ["x"]))),
    ).toMatchObject({
      code: "nondeterministic_function",
      sql_reason: "node",
      suggestion: expect.stringContaining('"user"'),
    });
  });

  it("names a derived table: not compiled yet", () => {
    expect(refused(compileDerivedRule(rule("SELECT count(*) AS x FROM weekly", ["x"])))).toBe(
      "not_implemented",
    );
  });

  it("names a derived table computed when read: not in this version", () => {
    const r = compileDerivedRule(
      rule("SELECT count(*) AS x FROM weekly", ["x"], "none", {
        computedAtReadTables: ["Weekly"],
      }),
    );
    expect(r.ok ? "compiled" : r.error).toEqual({
      code: "not_in_this_version",
      param: "tables/5/rule/sql",
      message: "a derived rule does not read a derived table computed when read in this version",
    });
  });
});

describe("output columns ↔ declared fields", () => {
  it("match by name without ASCII case, in any order", () => {
    const r = ok(
      compileDerivedRule(rule("SELECT count(*) AS N, ROUTE FROM runs GROUP BY 2", ["route", "n"])),
    );
    expect(r.fields.map((f) => f.name)).toEqual(["route", "n"]);
  });
  it.each([
    ["an expression without AS", "SELECT route, count(*) FROM runs GROUP BY 1", ["route", "count"]],
    ["an output not declared", "SELECT route, count(*) AS n FROM runs GROUP BY 1", ["route"]],
    [
      "a declared field not output",
      "SELECT route, count(*) AS n FROM runs GROUP BY 1",
      ["route", "n", "m"],
    ],
    ["two outputs of one name", "SELECT route, count(*) AS route FROM runs GROUP BY 1", ["route"]],
  ])("refuse %s", (_, sql, f) => {
    expect(refused(compileDerivedRule(rule(sql, f)))).toMatch(/^rule_sql_rejected/);
  });
  it("suggests AS for an expression", () => {
    expect(
      detail(compileDerivedRule(rule("SELECT count(*) FROM runs", ["count"]))).suggestion,
    ).toBe("<expression> AS <field name>");
  });
});

describe("grouping", () => {
  const G = (sql: string, f = ["k", "n"]) => refused(compileDerivedRule(rule(sql, f)));
  it.each([
    ["by ordinal", "SELECT route AS k, count(*) AS n FROM runs GROUP BY 1"],
    [
      "by the expression",
      "SELECT substr(feeling, 1, 1) AS k, count(*) AS n FROM runs GROUP BY substr(feeling, 1, 1)",
    ],
    [
      "by the expression, qualified differently",
      "SELECT r.route AS k, count(*) AS n FROM runs r GROUP BY route",
    ],
    ["by the output name", "SELECT substr(feeling, 1, 1) AS k, count(*) AS n FROM runs GROUP BY k"],
    [
      "with an expression of the key in the output",
      "SELECT laps AS k, count(*) + laps AS n FROM runs GROUP BY 1",
    ],
    [
      "with HAVING",
      "SELECT route AS k, count(*) AS n FROM runs GROUP BY 1 HAVING count(*) > 2 AND route <> 'park'",
    ],
    ["the same key twice", "SELECT route AS k, count(*) AS n FROM runs GROUP BY 1, route"],
  ])("compiles %s", (_, sql) => {
    expect(G(sql)).toBe("compiled");
  });
  it.each([
    [
      "a key that is no output column",
      "SELECT count(*) AS k, sum(laps) AS n FROM runs GROUP BY route",
      "rule_sql_rejected/node",
    ],
    [
      "an output neither grouped nor aggregated",
      "SELECT route AS k, laps AS n FROM runs GROUP BY 1",
      "rule_sql_rejected/node",
    ],
    [
      "HAVING on an ungrouped column",
      "SELECT route AS k, count(*) AS n FROM runs GROUP BY 1 HAVING laps > 1",
      "rule_sql_rejected/node",
    ],
    [
      "an aggregate as the key",
      "SELECT count(*) AS k, route AS n FROM runs GROUP BY 1",
      "rule_sql_rejected/node",
    ],
    [
      "an aggregate in WHERE",
      "SELECT route AS k, count(*) AS n FROM runs WHERE count(*) > 1 GROUP BY 1",
      "rule_sql_rejected/node",
    ],
    [
      "an aggregate in GROUP BY",
      "SELECT route AS k, count(*) AS n FROM runs GROUP BY count(*)",
      "rule_sql_rejected/node",
    ],
    [
      "a nested aggregate",
      "SELECT route AS k, sum(count(*)) AS n FROM runs GROUP BY 1",
      "rule_sql_rejected/node",
    ],
    [
      "an aggregate in FILTER",
      "SELECT route AS k, count(*) FILTER (WHERE count(*) > 1) AS n FROM runs GROUP BY 1",
      "rule_sql_rejected/node",
    ],
    [
      "an ordinal out of range",
      "SELECT route AS k, count(*) AS n FROM runs GROUP BY 3",
      "rule_sql_rejected/node",
    ],
    [
      "an ordinal of 0",
      "SELECT route AS k, count(*) AS n FROM runs GROUP BY 0",
      "rule_sql_rejected/node",
    ],
    [
      "a constant key",
      "SELECT route AS k, count(*) AS n FROM runs GROUP BY 1, 'x'",
      "rule_sql_rejected/node",
    ],
    [
      "GROUPING SETS",
      "SELECT route AS k, count(*) AS n FROM runs GROUP BY GROUPING SETS ((route))",
      "rule_sql_rejected/node",
    ],
    [
      "ROLLUP",
      "SELECT route AS k, count(*) AS n FROM runs GROUP BY ROLLUP (route)",
      "rule_sql_rejected/node",
    ],
    [
      "GROUP BY DISTINCT",
      "SELECT route AS k, count(*) AS n FROM runs GROUP BY DISTINCT route",
      "rule_sql_rejected/node",
    ],
    [
      "an outermost level that is no aggregate",
      "SELECT route AS k, laps AS n FROM runs",
      "not_in_this_version",
    ],
    [
      "a whole aggregate with a bare column",
      "SELECT route AS k, count(*) AS n FROM runs",
      "rule_sql_rejected/node",
    ],
  ])("refuses %s", (_, sql, code) => {
    expect(G(sql)).toBe(code);
  });
});

describe("statement shape (11 «语句形状»)", () => {
  const S = (sql: string) => refused(compileDerivedRule(rule(sql, ["x"])));
  it("takes one trailing semicolon and comments", () => {
    expect(S("SELECT count(date) AS x FROM runs; -- weekly\n")).toBe("compiled");
    expect(S("/* c */ SELECT count(date) /* in */ AS x FROM runs")).toBe("compiled");
  });
  it.each([
    [
      "two statements",
      "SELECT count(date) AS x FROM runs; SELECT 1",
      "rule_sql_rejected/not_select",
    ],
    ["an empty text", "", "rule_sql_rejected/not_select"],
    ["only a semicolon", ";", "rule_sql_rejected/not_select"],
    ["INSERT", "INSERT INTO runs VALUES (1)", "rule_sql_rejected/not_select"],
    ["DELETE", "DELETE FROM runs", "rule_sql_rejected/not_select"],
    ["UPDATE", "UPDATE runs SET laps = 1", "rule_sql_rejected/not_select"],
    ["DDL", "DROP TABLE runs", "rule_sql_rejected/not_select"],
    ["SET", "SET search_path = x", "rule_sql_rejected/not_select"],
    ["COPY", "COPY runs TO STDOUT", "rule_sql_rejected/not_select"],
    ["EXPLAIN", "EXPLAIN SELECT count(date) AS x FROM runs", "rule_sql_rejected/not_select"],
    [
      "a data-modifying WITH",
      "WITH d AS (DELETE FROM runs RETURNING 1) SELECT count(*) AS x FROM d",
      "not_implemented",
    ],
    ["a SELECT without FROM", "SELECT count(1) AS x", "rule_sql_rejected/node"],
    ["a SELECT without output", "SELECT FROM runs", "rule_sql_rejected/node"],
    ["SELECT INTO", "SELECT count(date) AS x INTO y FROM runs", "rule_sql_rejected/node"],
    ["FOR UPDATE", "SELECT count(date) AS x FROM runs FOR UPDATE", "rule_sql_rejected/node"],
    ["VALUES", "VALUES (1)", "rule_sql_rejected/node"],
    ["ORDER BY", "SELECT count(date) AS x FROM runs ORDER BY 1", "nondeterministic_function/node"],
    ["LIMIT", "SELECT count(date) AS x FROM runs LIMIT 1", "nondeterministic_function/node"],
    ["OFFSET", "SELECT count(date) AS x FROM runs OFFSET 1", "nondeterministic_function/node"],
    [
      "FETCH WITH TIES",
      "SELECT count(date) AS x FROM runs ORDER BY 1 FETCH FIRST 1 ROWS WITH TIES",
      "nondeterministic_function/node",
    ],
    ["only a comment", "-- nothing\n", "rule_sql_rejected/not_select"],
    [
      "DISTINCT ON",
      "SELECT DISTINCT ON (route) count(date) AS x FROM runs",
      "nondeterministic_function/node",
    ],
    [
      "WITH RECURSIVE",
      "WITH RECURSIVE r AS (SELECT 1) SELECT count(*) AS x FROM runs",
      "rule_sql_rejected/node",
    ],
    ["ONLY", "SELECT count(date) AS x FROM ONLY runs", "rule_sql_rejected/node"],
    ["a three-part table name", "SELECT count(date) AS x FROM a.b.runs", "rule_sql_rejected/node"],
    [
      "a function in FROM",
      "SELECT count(*) AS x FROM generate_series(1, 10)",
      "rule_sql_rejected/node",
    ],
    [
      "TABLESAMPLE",
      "SELECT count(date) AS x FROM runs TABLESAMPLE SYSTEM (10)",
      "rule_sql_rejected/node",
    ],
    ["LATERAL", "SELECT count(*) AS x FROM runs, LATERAL (SELECT 1) s", "not_implemented"],
    ["SELECT *", "SELECT * FROM runs", "rule_sql_rejected/node"],
    ["t.*", "SELECT runs.* FROM runs", "rule_sql_rejected/node"],
    ["a syntax error", "SELECT count(date AS x FROM runs", "rule_sql_rejected/syntax"],
  ])("refuses %s", (_, sql, code) => {
    expect(S(sql)).toBe(code);
  });

  it.each([
    ["JOIN", "SELECT count(*) AS x FROM runs JOIN shoes ON shoes.row_id = runs.shoe"],
    ["two tables", "SELECT count(*) AS x FROM runs, shoes"],
    ["a subquery in FROM", "SELECT count(*) AS x FROM (SELECT date FROM runs) s"],
    ["a scalar subquery", "SELECT count((SELECT 1)) AS x FROM runs"],
    ["EXISTS", "SELECT count(*) AS x FROM runs WHERE EXISTS (SELECT 1)"],
    ["IN (SELECT …)", "SELECT count(*) AS x FROM runs WHERE laps IN (SELECT 1)"],
    ["WITH", "WITH r AS (SELECT date FROM runs) SELECT count(*) AS x FROM r"],
    ["UNION", "SELECT count(date) AS x FROM runs UNION SELECT count(date) FROM runs"],
    ["a window function", "SELECT sum(count(*)) OVER () AS x FROM runs"],
    ["WINDOW", "SELECT count(date) AS x FROM runs WINDOW w AS ()"],
    ["DISTINCT", "SELECT DISTINCT count(date) AS x FROM runs"],
    ["a column alias list", "SELECT count(d) AS x FROM runs AS r (d)"],
    [
      "FOR VALID_TIME",
      "SELECT sum(amount) AS x FROM budgets FOR VALID_TIME AS OF saveslot_today()",
    ],
    ["a rule reading no field", "SELECT count(*) AS x FROM runs"],
  ])("stops on %s: not compiled yet", (_, sql) => {
    expect(S(sql)).toBe("not_implemented");
  });

  it("FOR SYSTEM_TIME is refused (record time is not in SQL)", () => {
    expect(S("SELECT count(date) AS x FROM runs FOR SYSTEM_TIME AS OF 5")).toBe(
      "rule_sql_rejected/system_time",
    );
    // In a string or a comment it is not a clause.
    expect(
      S("SELECT count(date) AS x FROM runs WHERE feeling <> 'FOR SYSTEM_TIME' -- FOR VALID_TIME\n"),
    ).toBe("compiled");
  });
});

describe("expressions accepted (11 «语法树节点», «运算符», «函数», «聚合函数»)", () => {
  it.each([
    // constants
    "1",
    "0",
    "-7",
    "1.5",
    ".5",
    "1.",
    "9223372036854775807",
    "123456789012345678901234567890",
    "'text'",
    "''",
    "TRUE",
    "FALSE",
    // operators
    "laps = 1",
    "laps <> 1",
    "laps != 1",
    "laps < 1",
    "laps <= 1",
    "laps > 1",
    "laps >= 1",
    "laps + 1",
    "laps - 1",
    "laps * 2",
    "pace / 2",
    "laps / 2.0",
    "laps % 3",
    "-laps",
    "+laps",
    "feeling || 'x'",
    "feeling LIKE 'a%'",
    "feeling NOT LIKE 'a%'",
    "feeling LIKE 'a!%' ESCAPE '!'",
    "date + 1",
    "1 + date",
    "date - 1",
    "date - date",
    "laps IS DISTINCT FROM 1",
    "laps IS NOT DISTINCT FROM 1",
    "NULLIF(laps, 0)",
    "laps IN (1, 2)",
    "laps NOT IN (1)",
    "laps BETWEEN 1 AND 2",
    "laps NOT BETWEEN 1 AND 2",
    "race AND laps > 1",
    "race OR NOT race",
    "laps IS NULL",
    "laps IS NOT NULL",
    "race IS TRUE",
    "race IS NOT TRUE",
    "race IS FALSE",
    "race IS NOT FALSE",
    "race IS UNKNOWN",
    "race IS NOT UNKNOWN",
    "CASE WHEN race THEN 1 ELSE 2 END",
    "CASE route WHEN 'park' THEN 1 END",
    "COALESCE(laps, 0)",
    "GREATEST(laps, 1)",
    "LEAST(pace, 2)",
    "date = '2026-11-10'",
    "date = DATE '2026-11-10'",
    "started > '2026-11-10T08:00:00+08:00'",
    "started > '2026-11-10 08:00:00Z'",
    "distance > 5",
    "distance + 1.5",
    "distance * 2",
    "distance / 2",
    "distance / distance",
    "COALESCE(distance, 0)",
    // casts
    "laps::numeric",
    "laps::numeric(10, 2)",
    "pace::bigint",
    "pace::numeric(5, 1)",
    "date::timestamp::date",
    "date::timestamp::date",
    "CAST(pace AS bigint)::numeric",
    // functions
    "abs(laps)",
    "abs(pace)",
    "round(pace)",
    "round(pace, 1)",
    "trunc(pace)",
    "trunc(pace, 2)",
    "floor(pace)",
    "ceil(pace)",
    "ceiling(pace)",
    "sign(pace)",
    "mod(laps, 2)",
    "mod(pace, 2.5)",
    "date_trunc('day', date::timestamp)::date",
    "date_trunc('week', date::timestamp)::date",
    "date_trunc('month', date::timestamp)::date",
    "date_trunc('quarter', date::timestamp)::date",
    "date_trunc('year', date::timestamp)::date",
    "EXTRACT(year FROM date)",
    "EXTRACT(dow FROM date)",
    "EXTRACT(isoyear FROM saveslot_date(started))",
    "length(feeling)",
    "char_length(feeling)",
    "substr(feeling, 2)",
    "substr(feeling, 2, 3)",
    "substring(feeling FROM 2 FOR 3)",
    "left(feeling, 2)",
    "right(feeling, 2)",
    "strpos(feeling, 'a')",
    "position('a' IN feeling)",
    "starts_with(feeling, 'a')",
    "btrim(feeling)",
    "btrim(feeling, 'x')",
    "ltrim(feeling)",
    "rtrim(feeling, 'x')",
    "trim(feeling)",
    "trim(both 'x' from feeling)",
    "trim(leading from feeling)",
    "replace(feeling, 'a', 'b')",
    "split_part(feeling, ',', 2)",
    "saveslot_date(started)",
  ])("%s", (e) => {
    expect(refused(C(e))).toBe("compiled");
  });

  it.each([
    "count(*)",
    "count(laps)",
    "count(DISTINCT laps)",
    "sum(laps)",
    "sum(pace)",
    "avg(pace)",
    "min(feeling)",
    "max(date)",
    "bool_and(race)",
    "bool_or(race)",
    "sum(laps) FILTER (WHERE race)",
    "count(*) FILTER (WHERE laps > 1)",
  ])("the aggregate %s", (a) => {
    expect(
      refused(compileDerivedRule(rule(`SELECT ${a} AS x FROM runs WHERE laps > 0`, ["x"]))),
    ).toBe("compiled");
  });
});

describe("expressions refused", () => {
  it.each([
    // functions and operators not in the whitelist, or with the wrong signature
    ["lower(feeling)", "rule_sql_rejected/function"],
    ["NULL", "rule_sql_rejected/type"],
    ["upper(feeling)", "rule_sql_rejected/function"],
    ["make_date(2026, 1, 1)", "rule_sql_rejected/function"],
    ["date_part('year', date)", "rule_sql_rejected/function"],
    ["sqrt(pace)", "rule_sql_rejected/function"],
    ["pg_catalog.abs(laps)", "rule_sql_rejected/function"],
    ['"ABS"(laps)', "rule_sql_rejected/function"],
    ["laps OPERATOR(pg_catalog.+) 1", "rule_sql_rejected/function"],
    ["feeling ILIKE 'a'", "rule_sql_rejected/function"],
    ["feeling SIMILAR TO 'a'", "rule_sql_rejected/function"],
    ["feeling ~ 'a'", "rule_sql_rejected/function"],
    ["laps ^ 2", "rule_sql_rejected/function"],
    ["laps / 2", "rule_sql_rejected/function"],
    ["date_trunc('hour', date::timestamp)", "rule_sql_rejected/function"],
    ["date_trunc(route, date::timestamp)", "rule_sql_rejected/function"],
    ["EXTRACT(epoch FROM date)", "rule_sql_rejected/function"],
    ["EXTRACT(year FROM date::timestamp)", "rule_sql_rejected/function"],
    ["length(laps)", "rule_sql_rejected/function"],
    ["abs(feeling)", "rule_sql_rejected/function"],
    ["round(pace, 1.5)", "rule_sql_rejected/function"],
    ["substr(feeling, 'a')", "rule_sql_rejected/function"],
    ["saveslot_date(date)", "rule_sql_rejected/function"],
    ["saveslot_date(started::timestamp)", "rule_sql_rejected/function"],
    ["saveslot_today(1)", "rule_sql_rejected/function"],
    ["feeling || laps", "rule_sql_rejected/function"],
    ["date + 1.5", "rule_sql_rejected/function"],
    ["date * 2", "rule_sql_rejected/function"],
    ["feeling + 1", "rule_sql_rejected/function"],
    ["abs(VARIADIC laps)", "rule_sql_rejected/node"],
    // casts
    ["'5'::numeric", "rule_sql_rejected/function"],
    ["feeling::numeric", "rule_sql_rejected/function"],
    ["race::boolean", "rule_sql_rejected/function"],
    ["laps::integer", "rule_sql_rejected/function"],
    ["laps::float8", "rule_sql_rejected/function"],
    ["laps::bigint", "rule_sql_rejected/function"],
    ["pace::numeric", "rule_sql_rejected/function"],
    ["pace::numeric(5)", "rule_sql_rejected/node"],
    ["laps::bigint[]", "rule_sql_rejected/node"],
    ["'2026-02-30'::date", "rule_sql_rejected/type"],
    ["DATE 'today'", "rule_sql_rejected/type"],
    ["INTERVAL '1 day'", "rule_sql_rejected/function"],
    ["pg_catalog.int8 '1'", "rule_sql_rejected/function"],
    // nodes
    ["ARRAY[1]", "rule_sql_rejected/node"],
    ["ROW(1, 2)", "rule_sql_rejected/node"],
    ["(laps)[1]", "rule_sql_rejected/node"],
    ['feeling COLLATE "C"', "rule_sql_rejected/node"],
    ["B'101'", "rule_sql_rejected/node"],
    ["1e3", "rule_sql_rejected/node"],
    ["$1", "rule_sql_rejected/node"],
    ["laps = ANY('{1}')", "rule_sql_rejected/node"],
    ["laps BETWEEN SYMMETRIC 1 AND 2", "rule_sql_rejected/node"],
    ["ROW(laps) IS NULL", "rule_sql_rejected/node"],
    ["xmlconcat('<a/>')", "rule_sql_rejected/node"],
    // not determined by the data
    ["now()", "nondeterministic_function/function"],
    ["random()", "nondeterministic_function/function"],
    ["clock_timestamp()", "nondeterministic_function/function"],
    ["current_setting('x')", "nondeterministic_function/function"],
    ["to_char(laps, '9')", "nondeterministic_function/function"],
    ["concat(feeling, 'x')", "nondeterministic_function/function"],
    ["CURRENT_DATE", "nondeterministic_function/node"],
    ["CURRENT_TIMESTAMP", "nondeterministic_function/node"],
    ["LOCALTIMESTAMP", "nondeterministic_function/node"],
    ["CURRENT_USER", "nondeterministic_function/node"],
    ["laps::text", "nondeterministic_function/function"],
    ["date::timestamptz", "nondeterministic_function/function"],
    ["started::date", "nondeterministic_function/function"],
    ["date_trunc('week', date)", "nondeterministic_function/function"],
    ["date_trunc('week', started)", "nondeterministic_function/function"],
    ["EXTRACT(year FROM started)", "nondeterministic_function/function"],
    ["date < started", "nondeterministic_function/function"],
    // types
    ["laps = feeling", "rule_sql_rejected/type"],
    ["race = 1", "rule_sql_rejected/type"],
    ["date = '10/11/2026'", "rule_sql_rejected/type"],
    ["started > '2026-11-10T08:00:00'", "rule_sql_rejected/type"],
    ["laps = 'one'", "rule_sql_rejected/type"],
    ["race = 'true'", "rule_sql_rejected/type"],
    ["NOT laps", "rule_sql_rejected/type"],
    ["laps AND race", "rule_sql_rejected/type"],
    ["CASE WHEN laps THEN 1 END", "rule_sql_rejected/type"],
    ["CASE WHEN race THEN 1 ELSE 'x' END", "rule_sql_rejected/type"],
    ["COALESCE(laps, feeling)", "rule_sql_rejected/type"],
    ["GREATEST(race, race)", "rule_sql_rejected/type"],
    ["laps IS TRUE", "rule_sql_rejected/type"],
    ["date::timestamp = date::timestamp", "rule_sql_rejected/type"],
    // units
    ["distance + uphill", "unit_inference_failed/type"],
    ["distance > uphill", "unit_inference_failed/type"],
    ["distance + laps", "unit_inference_failed/type"],
    ["distance > pace", "unit_inference_failed/type"],
    ["COALESCE(distance, laps)", "unit_inference_failed/type"],
    ["CASE WHEN race THEN distance ELSE uphill END", "unit_inference_failed/type"],
    ["mod(distance, uphill)", "unit_inference_failed/type"],
    ["distance * duration + distance", "unit_inference_failed/type"],
  ])("%s → %s", (e, code) => {
    expect(refused(C(e))).toBe(code);
  });

  it("date_trunc on a date suggests the cast", () => {
    expect(detail(C("date_trunc('week', date)")).suggestion).toBe(
      "date_trunc('week', <date>::timestamp)::date",
    );
  });

  it.each([
    ["row_number() OVER ()", "nondeterministic_function/function"],
    ["lag(laps) OVER ()", "nondeterministic_function/function"],
    ["first_value(laps) OVER ()", "nondeterministic_function/function"],
    ["rank() OVER ()", "not_implemented"],
    ["sum(laps) OVER ()", "not_implemented"],
    ["ntile(2) OVER ()", "rule_sql_rejected/function"],
    ["rank()", "rule_sql_rejected/function"],
    ["string_agg(feeling, ',')", "rule_sql_rejected/function"],
    ["array_agg(laps)", "rule_sql_rejected/function"],
    ["stddev(pace)", "rule_sql_rejected/function"],
    ["percentile_cont(0.5) WITHIN GROUP (ORDER BY pace)", "rule_sql_rejected/node"],
    ["sum(laps ORDER BY laps)", "rule_sql_rejected/node"],
    ["sum(DISTINCT laps)", "rule_sql_rejected/node"],
    ["sum(*)", "rule_sql_rejected/node"],
    ["sum(feeling)", "rule_sql_rejected/function"],
    ["avg(date)", "rule_sql_rejected/function"],
    ["min(race)", "rule_sql_rejected/function"],
    ["bool_and(laps)", "rule_sql_rejected/function"],
    ["count(laps, pace)", "rule_sql_rejected/function"],
    ["abs(laps) FILTER (WHERE race)", "rule_sql_rejected/node"],
    ["sum(laps) FILTER (WHERE laps)", "rule_sql_rejected/type"],
  ])("the aggregate %s → %s", (a, code) => {
    expect(
      refused(compileDerivedRule(rule(`SELECT ${a} AS x FROM runs WHERE laps > 0`, ["x"]))),
    ).toBe(code);
  });
});

describe("derived fields: type, unit and precision (10 «精度与舍入»)", () => {
  it.each<[string, unknown]>([
    ["laps", { type: "integer" }],
    ["pace", { type: "decimal", precision: { scale: 3, rounding: "half_up" } }],
    [
      "distance",
      { type: "quantity", unit: UNITS.KM, precision: { scale: 2, rounding: "half_up" } },
    ],
    [
      "duration",
      { type: "quantity", unit: UNITS.MIN, precision: { scale: 1, rounding: "half_even" } },
    ],
    ["feeling", { type: "text" }],
    ["route", { type: "enum" }],
    ["shoe", { type: "ref" }],
    ["date", { type: "date" }],
    ["substr(route, 1)", { type: "text" }],
    ["COALESCE(route, 'x')", { type: "text" }],
    ["pace + 1.25", { type: "decimal", precision: { scale: 3, rounding: "half_up" } }],
    ["pace * 1.25", { type: "decimal", precision: { scale: 5, rounding: "half_up" } }],
    [
      "pace * pace * pace * pace * pace",
      { type: "decimal", precision: { scale: 12, rounding: "half_up" } },
    ],
    ["pace / 3", { type: "decimal", precision: { scale: 6, rounding: "half_up" } }],
    [
      "distance / 2",
      { type: "quantity", unit: UNITS.KM, precision: { scale: 6, rounding: "half_up" } },
    ],
    [
      "distance / distance",
      {
        type: "quantity",
        unit: { code: "1", dimension: "dimensionless", to_base: "1" },
        precision: { scale: 6, rounding: "half_up" },
      },
    ],
    ["round(pace, 1)", { type: "decimal", precision: { scale: 1, rounding: "half_up" } }],
    [
      "round(distance)",
      { type: "quantity", unit: UNITS.KM, precision: { scale: 0, rounding: "half_up" } },
    ],
    ["trunc(pace, 20)", { type: "decimal", precision: { scale: 12, rounding: "half_up" } }],
    ["laps::numeric(9, 4)", { type: "decimal", precision: { scale: 4, rounding: "half_up" } }],
    [
      "CASE WHEN race THEN pace ELSE 1.5 END",
      { type: "decimal", precision: { scale: 3, rounding: "half_up" } },
    ],
    [
      "GREATEST(duration, 2.25)",
      { type: "quantity", unit: UNITS.MIN, precision: { scale: 2, rounding: "half_even" } },
    ],
    ["EXTRACT(year FROM date)", { type: "decimal", precision: { scale: 0, rounding: "half_up" } }],
    ["length(feeling)", { type: "integer" }],
  ])("max(%s)", (e, f) => {
    expect(field(T(e))).toEqual({ name: "x", ...(f as object) });
  });

  it.each<[string, unknown]>([
    ["count(*)", { type: "integer" }],
    ["sum(laps)", { type: "integer" }],
    [
      "sum(duration)",
      { type: "quantity", unit: UNITS.MIN, precision: { scale: 1, rounding: "half_even" } },
    ],
    [
      "avg(duration)",
      { type: "quantity", unit: UNITS.MIN, precision: { scale: 6, rounding: "half_even" } },
    ],
    ["avg(laps)", { type: "decimal", precision: { scale: 6, rounding: "half_up" } }],
    [
      "COALESCE(sum(distance), 0)",
      { type: "quantity", unit: UNITS.KM, precision: { scale: 2, rounding: "half_up" } },
    ],
    ["bool_or(race)", { type: "boolean" }],
    ["sum(duration) + sum(pace)", null],
  ])("%s", (a, f) => {
    const r = compileDerivedRule(rule(`SELECT ${a} AS x FROM runs WHERE laps > 0`, ["x"]));
    if (f === null) expect(refused(r)).toBe("unit_inference_failed/type");
    else expect(field(r)).toEqual({ name: "x", ...(f as object) });
  });

  it("refuses outputs that cannot be a derived column", () => {
    expect(refused(T("started"))).toBe("rule_sql_rejected/type");
    // A timestamp is only an intermediate value (11 «类型»): max() of it is refused first.
    expect(refused(T("date::timestamp"))).toBe("rule_sql_rejected/function");
    // A zoned date-time may still be aggregated where it does not become a column.
    expect(
      refused(
        compileDerivedRule(
          rule(
            "SELECT route AS x, count(*) AS n FROM runs GROUP BY 1 HAVING min(started) > '2026-01-01T00:00:00Z'",
            ["x", "n"],
          ),
        ),
      ),
    ).toBe("compiled");
    expect(
      refused(
        compileDerivedRule(
          rule("SELECT NULL AS x, count(*) AS n FROM runs WHERE laps > 0", ["x", "n"]),
        ),
      ),
    ).toBe("rule_sql_rejected/type");
  });

  describe("declarations", () => {
    it("a product of quantities needs a declaration: decimal, or a unit", () => {
      expect(detail(T("distance * duration"))).toMatchObject({
        code: "unit_inference_failed",
        suggestion: 'declare the field with "type": "decimal"',
      });
      expect(field(T("distance * duration", { type: "decimal" }))).toEqual({
        name: "x",
        type: "decimal",
        precision: { scale: 3, rounding: "half_up" },
      });
      expect(field(T("distance * duration", { unit: UNITS.CNY }))).toEqual({
        name: "x",
        type: "quantity",
        unit: UNITS.CNY,
        precision: { scale: 3, rounding: "half_up" },
      });
      expect(field(T("1 / distance", { type: "decimal" }))).toMatchObject({ type: "decimal" });
    });

    it("a scale not inferred needs a declared one", () => {
      // A NULL operand has no scale (10 «精度与舍入»: an input not inferred).
      expect(detail(T("pace + NULL"))).toMatchObject({
        code: "rule_sql_rejected",
        sql_reason: "type",
        suggestion: 'declare "scale" on the field',
      });
      expect(field(T("pace + NULL", { scale: 4 }))).toEqual({
        name: "x",
        type: "decimal",
        precision: { scale: 4, rounding: "half_up" },
      });
    });

    it("a rounding not inherited may be declared", () => {
      expect(field(T("laps::numeric(9, 2)", { rounding: "half_even" }))).toEqual({
        name: "x",
        type: "decimal",
        precision: { scale: 2, rounding: "half_even" },
      });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ["decimal on a quantity", { type: "decimal" }, "unit_inference_failed/type"],
      ["another unit", { unit: UNITS.MI }, "unit_inference_failed/type"],
      ["another scale", { scale: 3 }, "rule_sql_rejected/type"],
      ["another rounding", { rounding: "half_even" }, "rule_sql_rejected/type"],
    ])("refuses %s that differs from what is inferred", (_, decl, code) => {
      expect(refused(T("distance", decl))).toBe(code);
    });

    it.each([
      ["a number without one", "pace"],
      ["text", "feeling"],
      ["an integer", "laps"],
    ])("refuses a unit on %s, as a unit error", (_, e) => {
      expect(refused(T(e, { unit: UNITS.KM }))).toBe("unit_inference_failed/type");
    });

    it.each<[string, string, Record<string, unknown>]>([
      ["a scale on a date", "date", { scale: 2 }],
      ["decimal on an integer", "laps", { type: "decimal" }],
    ])("refuses %s", (_, e, decl) => {
      expect(refused(T(e, decl))).toBe("rule_sql_rejected/type");
    });
  });
});

describe("limits (11 «代价»)", () => {
  it("text of at most 16 KB", () => {
    const pad = (n: number) => `SELECT count(date) AS x FROM runs /*${"a".repeat(n)}*/`;
    const base = pad(0).length;
    expect(refused(compileDerivedRule(rule(pad(16 * 1024 - base), ["x"])))).toBe("compiled");
    expect(refused(compileDerivedRule(rule(pad(16 * 1024 - base + 1), ["x"])))).toBe(
      "rule_sql_rejected/limit",
    );
    // Bytes, not characters.
    expect(
      refused(
        compileDerivedRule(
          rule(`SELECT count(date) AS x FROM runs /*${"说".repeat(5462)}*/`, ["x"]),
        ),
      ),
    ).toBe("rule_sql_rejected/limit");
  });
  it("an IN list of at most 1,000 items", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => i).join(", ");
    expect(refused(C(`laps IN (${list(1000)})`))).toBe("compiled");
    expect(refused(C(`laps IN (${list(1001)})`))).toBe("rule_sql_rejected/limit");
  });
  it("a CASE of at most 256 branches", () => {
    const c = (n: number) =>
      `CASE ${Array.from({ length: n }, (_, i) => `WHEN laps = ${i} THEN ${i}`).join(" ")} END`;
    expect(refused(C(c(256)))).toBe("compiled");
    expect(refused(C(c(257)))).toBe("rule_sql_rejected/limit");
  });
  it("expressions nested at most 32 deep", () => {
    const nest = (n: number) => `${"abs(".repeat(n)}laps${")".repeat(n)}`;
    // count( and the column take two of the 32.
    expect(refused(C(nest(30)))).toBe("compiled");
    expect(refused(C(nest(31)))).toBe("rule_sql_rejected/limit");
  });
  it("at most 2,000 syntax tree nodes", () => {
    // Every node counts, the String inside a column reference too.
    expect(refused(C(`laps IN (${Array.from({ length: 999 }, (_, i) => i).join(", ")})`))).toBe(
      "compiled",
    );
    expect(refused(C(`laps IN (${Array.from({ length: 999 }, () => "laps").join(", ")})`))).toBe(
      "rule_sql_rejected/limit",
    );
    const many = Array.from({ length: 700 }, () => "laps + 1 > 0").join(" AND ");
    expect(refused(C(many))).toBe("rule_sql_rejected/limit");
  });
});

describe("where a problem is", () => {
  it("gives the line of a node, counting bytes of the text before it", () => {
    const sql = "SELECT count(date) AS x\n  -- 说明：每周\nFROM runs\nWHERE lower(feeling) = 'a'";
    expect(detail(compileDerivedRule(rule(sql, ["x"])))).toMatchObject({
      path: "tables/5/rule/sql",
      line: 4,
      sql_reason: "function",
    });
  });
  it("gives the line of a syntax error, counting characters of the text before it", () => {
    const sql = "SELECT '说明说明说明' AS x,\n count(date) AS y\nFROM FROM runs";
    expect(detail(compileDerivedRule(rule(sql, ["x", "y"])))).toMatchObject({
      code: "rule_sql_rejected",
      line: 3,
    });
  });
  it("gives the line of FOR SYSTEM_TIME", () => {
    const sql = "SELECT count(date) AS x\nFROM runs -- 说明\n  FOR SYSTEM_TIME AS OF 1";
    expect(detail(compileDerivedRule(rule(sql, ["x"])))).toMatchObject({
      line: 3,
      sql_reason: "system_time",
    });
  });
  it("names only logical names, never physical ones", () => {
    const d = detail(compileDerivedRule(rule("SELECT count(dist) AS x FROM runs", ["x"])));
    expect(d.message).toBe("no column dist");
    expect(JSON.stringify(d)).not.toMatch(/t_t\d|f_f\d/);
  });
});

// Cases found missing by a mutation run over this module: each pins a branch no other case reached.
describe("printing: each form is printed as it was written", () => {
  const one = "CAST(1 AS bigint)";
  const two = "CAST(2 AS bigint)";
  it.each([
    ["laps IS DISTINCT FROM 1", `("t1"."f6" IS DISTINCT FROM ${one})`],
    ["laps IS NOT DISTINCT FROM 1", `("t1"."f6" IS NOT DISTINCT FROM ${one})`],
    ["laps BETWEEN 1 AND 2", `("t1"."f6" BETWEEN ${one} AND ${two})`],
    ["laps NOT BETWEEN 1 AND 2", `("t1"."f6" NOT BETWEEN ${one} AND ${two})`],
    ["race IS NOT FALSE", '("t1"."f10" IS NOT FALSE)'],
    ["race IS NOT TRUE", '("t1"."f10" IS NOT TRUE)'],
    ["GREATEST(laps, 1)", `GREATEST("t1"."f6", ${one})`],
    ["LEAST(pace, 2)", `LEAST("t1"."f7", ${two})`],
    ["race AND laps > 1", `("t1"."f10" AND ("t1"."f6" > ${one}))`],
    ["race OR NOT race", '("t1"."f10" OR (NOT "t1"."f10"))'],
    ["laps::numeric(10, 2)", 'CAST("t1"."f6" AS numeric(10, 2))'],
    ["feeling LIKE 'a!%' ESCAPE '!'", "(\"t1\".\"f4\" LIKE 'a!%' ESCAPE '!')"],
    ["laps NOT IN (1)", `("t1"."f6" NOT IN (${one}))`],
    // 32-bit values in PostgreSQL widened; positions taking only 32 bits keep the constant bare.
    ["length(feeling)", 'CAST(length("t1"."f4") AS bigint)'],
    ["strpos(feeling, 'a')", 'CAST(strpos("t1"."f4", \'a\') AS bigint)'],
    ["date - date", 'CAST(("t1"."f1" - "t1"."f1") AS bigint)'],
    ["date + 1", '("t1"."f1" + 1)'],
    ["substr(feeling, 2, 3)", 'substr("t1"."f4", 2, 3)'],
    ["round(pace, 1)", `round("t1"."f7", 1)`],
    ["-laps", '(- "t1"."f6")'],
    ["-7", "CAST(-7 AS bigint)"],
  ])("%s", (e, printed) => {
    expect(ok(C(e)).rule.sql).toBe(
      `SELECT count(${printed}) AS "f1" FROM "t1" WHERE ("t1"."f6" > CAST(0 AS bigint))`,
    );
  });

  it("sum of integers is widened back to bigint; the bound text reads back the same", () => {
    const input = rule("SELECT sum(laps) AS x, sum(pace) AS y FROM runs", ["x", "y"]);
    const r = ok(compileDerivedRule(input));
    expect(r.rule.sql).toBe(
      'SELECT CAST(sum("t1"."f6") AS bigint) AS "f1", sum("t1"."f7") AS "f2" FROM "t1"',
    );
    expect(r.fields[0]).toEqual({ name: "x", type: "integer" });
    expect(checkBoundRule({ ...input, sql: r.rule.sql })).toEqual(r);
  });

  it("a cast of a bigint to bigint is the bound text's own: refused in a rule as written", () => {
    expect(refused(C("CAST(laps AS bigint)"))).toBe("rule_sql_rejected/function");
  });

  it("table IDs of more than one digit", () => {
    const tables = TABLES.map((t): CompiledBaseTable => (t.id === "t1" ? { ...t, id: "t12" } : t));
    const r = ok(
      compileDerivedRule(rule("SELECT count(date) AS x FROM runs", ["x"], "none", { tables })),
    );
    expect(r.rule.sql).toBe('SELECT count("t12"."f1") AS "f1" FROM "t12"');
  });
});

describe("more accepted and refused forms", () => {
  it.each([
    "laps::numeric(9, 0)",
    "laps::numeric(1000, 2)",
    "started > '2026-11-10T08:00:00.5+08:00'",
  ])("accepts %s", (e) => {
    expect(refused(C(e))).toBe("compiled");
  });

  it.each([
    ["mod(feeling, laps)", "rule_sql_rejected/function"],
    ["sign(feeling)", "rule_sql_rejected/function"],
    ["left(laps, 2)", "rule_sql_rejected/function"],
    ["pace + date", "rule_sql_rejected/function"],
    ["make_date(2026, 1, 1)", "rule_sql_rejected/function"],
    ["saveslot_date(started, started)", "rule_sql_rejected/function"],
    ["abs(DISTINCT laps)", "rule_sql_rejected/node"],
    ["laps OPERATOR(pg_catalog.+) 1", "rule_sql_rejected/function"],
    ["laps::public.numeric", "rule_sql_rejected/function"],
  ])("refuses %s", (e, code) => {
    expect(refused(C(e))).toBe(code);
  });

  it.each([
    [
      "an aggregate over timestamps",
      "SELECT max(date::timestamp)::date AS x FROM runs",
      "rule_sql_rejected/function",
    ],
    [
      "a function in FROM",
      "SELECT count(date) AS x FROM generate_series(1, 3)",
      "rule_sql_rejected/node",
    ],
    ["ROLLUP", "SELECT count(date) AS x FROM runs GROUP BY ROLLUP(date)", "rule_sql_rejected/node"],
    ["SELECT INTO", "SELECT count(date) AS x INTO z FROM runs", "rule_sql_rejected/node"],
    [
      "an aggregate as a group key",
      "SELECT count(date) AS x FROM runs GROUP BY 1",
      "rule_sql_rejected/node",
    ],
    ["only comments", "/* only */ -- a comment", "rule_sql_rejected/not_select"],
  ])("refuses %s", (_, sql, code) => {
    expect(refused(compileDerivedRule(rule(sql, ["x"])))).toBe(code);
  });

  it("refuses a SELECT without output columns", () => {
    expect(refused(compileDerivedRule(rule("SELECT FROM runs", [])))).toBe(
      "rule_sql_rejected/node",
    );
  });

  it("refuses a declared field that is not an output, the first one included", () => {
    expect(
      detail(compileDerivedRule(rule("SELECT count(date) AS y FROM runs", ["x", "y"]))),
    ).toMatchObject({
      code: "rule_sql_rejected",
      sql_reason: "node",
      message: "the declared field x is not an output column",
    });
  });

  it("a NULL in a group key is not an aggregate", () => {
    expect(
      refused(
        compileDerivedRule(
          rule("SELECT COALESCE(feeling, NULL) AS k, count(date) AS x FROM runs GROUP BY 1", [
            "k",
            "x",
          ]),
        ),
      ),
    ).toBe("compiled");
  });

  it("depends on fields read in FILTER and in LIKE", () => {
    const r = ok(
      compileDerivedRule(
        rule(
          "SELECT count(date) FILTER (WHERE race AND feeling LIKE 'a%' ESCAPE '!') AS x FROM runs",
          ["x"],
        ),
      ),
    );
    expect(r.rule.depends_on).toEqual([
      { table: "t1", field: "f1" },
      { table: "t1", field: "f4" },
      { table: "t1", field: "f10" },
    ]);
    const g = ok(
      compileDerivedRule(
        rule("SELECT feeling LIKE 'a%' ESCAPE '!' AS k, count(date) AS x FROM runs GROUP BY 1", [
          "k",
          "x",
        ]),
      ),
    );
    expect(g.rule.scope).toEqual({ kind: "group", key: ["f1"], key_from_free_text: true });
  });

  it("a group key with LIKE and no ESCAPE", () => {
    const g = ok(
      compileDerivedRule(
        rule("SELECT feeling LIKE 'a%' AS k, count(date) AS x FROM runs GROUP BY 1", ["k", "x"]),
      ),
    );
    expect(g.rule.scope).toEqual({ kind: "group", key: ["f1"], key_from_free_text: true });
  });

  it("gives line 1 for a syntax error at the first character", () => {
    expect(detail(compileDerivedRule(rule("SELEC 1", ["x"])))).toMatchObject({ line: 1 });
  });

  it("gives line 2 for a syntax error after a leading newline", () => {
    expect(detail(compileDerivedRule(rule("\nSELEC 1", ["x"])))).toMatchObject({ line: 2 });
  });
});

describe("more derived field inference", () => {
  it.each<[string, unknown]>([
    [".05 + pace", { type: "decimal", precision: { scale: 3, rounding: "half_up" } }],
    [
      "distance::bigint",
      { type: "quantity", unit: UNITS.KM, precision: { scale: 0, rounding: "half_up" } },
    ],
    ["mod(pace, laps)", { type: "decimal", precision: { scale: 3, rounding: "half_up" } }],
    [
      "mod(distance, 2)",
      { type: "quantity", unit: UNITS.KM, precision: { scale: 2, rounding: "half_up" } },
    ],
    [
      "duration * 2",
      { type: "quantity", unit: UNITS.MIN, precision: { scale: 1, rounding: "half_even" } },
    ],
    ["CASE WHEN race THEN route ELSE route END", { type: "enum" }],
    ["COALESCE(route, feeling)", { type: "text" }],
    ["COALESCE(NULL, 'a')", { type: "text" }],
  ])("%s", (e, f) => {
    expect(field(T(e))).toEqual({ name: "x", ...(f as object) });
  });

  it.each([
    ["distance * distance", "unit_inference_failed/type"],
    ["(distance * duration) * 2", "unit_inference_failed/type"],
  ])("%s needs a declaration", (e, code) => {
    expect(refused(T(e))).toBe(code);
  });

  it("a quantity meets an average of plain numbers: refused", () => {
    expect(
      refused(compileDerivedRule(rule("SELECT sum(distance) + avg(laps) AS x FROM runs", ["x"]))),
    ).toBe("unit_inference_failed/type");
  });

  it("a timestamp cannot be a derived column", () => {
    expect(
      detail(
        compileDerivedRule(
          rule(
            "SELECT date_trunc('month', date::timestamp) AS k, count(date) AS x FROM runs GROUP BY 1",
            ["k", "x"],
            "bucketed",
          ),
        ),
      ),
    ).toMatchObject({ code: "rule_sql_rejected", sql_reason: "type", suggestion: "<x>::date" });
  });
});

// Types as PostgreSQL resolves them: the analysis's 64-bit integers, numeric-only functions,
// positions taking only 32 bits, and NULLs that nothing gives a type (11 «类型», «函数», «运算符»).
describe("types as PostgreSQL resolves them", () => {
  it.each([
    "round(laps)",
    "trunc(laps)",
    "floor(laps)",
    "ceil(laps)",
    "sign(laps)",
    "round(laps, 1)",
  ])("%s: numeric only, the integer cast suggested", (e) => {
    expect(detail(C(e))).toMatchObject({
      code: "rule_sql_rejected",
      sql_reason: "function",
      suggestion: "<integer>::numeric",
    });
  });

  it("round of an integer cast to numeric is accepted", () => {
    expect(refused(C("round(laps::numeric)"))).toBe("compiled");
    expect(
      refused(compileDerivedRule(rule("SELECT max(round(laps) / 3) AS x FROM runs", ["x"]))),
    ).toBe("rule_sql_rejected/function");
  });

  it("sum of integers is an integer: dividing it by count is integer division, refused", () => {
    expect(
      detail(compileDerivedRule(rule("SELECT sum(laps) / count(*) AS x FROM runs", ["x"]))),
    ).toMatchObject({ sql_reason: "function", suggestion: "cast one side: <x>::numeric" });
  });

  it("32-bit values are widened, so their product is 64-bit", () => {
    expect(
      ok(compileDerivedRule(rule("SELECT max(length(feeling) * 2000000000) AS x FROM runs", ["x"])))
        .rule.sql,
    ).toBe(
      'SELECT max((CAST(length("t1"."f4") AS bigint) * CAST(2000000000 AS bigint))) AS "f1" FROM "t1"',
    );
  });

  it.each([
    ["date + laps", "a column added to a date"],
    ["laps + date", "a column added to a date"],
    ["date - laps", "a column taken from a date"],
    ["date + 3000000000", "beyond 32 bits"],
    ["date + 1.5", "a decimal"],
    ["substr(feeling, laps)", "a column as substr's start"],
    ["substr(feeling, 1, laps)", "a column as substr's count"],
    ["substr(feeling, 1, -1)", "a negative count"],
    ["substr(feeling, 3000000000)", "beyond 32 bits"],
    ["left(feeling, laps)", "a column in left"],
    ["right(feeling, laps)", "a column in right"],
    ["split_part(feeling, ',', laps)", "a column as split_part's index"],
    ["split_part(feeling, ',', 0)", "index 0"],
    ["round(pace, laps)", "a column as round's digits"],
    ["trunc(pace, 1.5)", "a decimal as trunc's digits"],
  ])("a 32-bit position takes an integer constant: %s (%s)", (e) => {
    expect(refused(C(e))).toBe("rule_sql_rejected/function");
  });

  it.each([
    "substr(feeling, -2, 0)",
    "left(feeling, -1)",
    "split_part(feeling, ',', -1)",
    "date + 2147483647",
    "round(pace, -2)",
  ])("accepts the constant in %s", (e) => {
    expect(refused(C(e))).toBe("compiled");
  });

  it.each([
    "NULL + NULL",
    "-NULL",
    "NULL || NULL",
    "NULL || 'x'",
    "abs(NULL)",
    "COALESCE(NULL, NULL)",
    "NULL = NULL",
    "NULL LIKE 'a'",
    "NULLIF(NULL, NULL)",
    "CAST(NULL AS numeric)",
  ])("refuses an untyped NULL: %s", (e) => {
    expect(refused(C(e))).toBe("rule_sql_rejected/type");
  });

  it.each([
    ["sum(NULL)", "SELECT sum(NULL) AS x FROM runs WHERE laps > 0"],
    ["count(NULL)", "SELECT count(NULL) AS x FROM runs WHERE laps > 0"],
  ])("refuses an untyped NULL in an aggregate: %s", (_, sql) => {
    expect(refused(compileDerivedRule(rule(sql, ["x"])))).toBe("rule_sql_rejected/type");
  });

  it.each([
    "laps + NULL",
    "COALESCE(laps, NULL)",
    "feeling = NULL",
    "NULL IS NULL",
    "feeling || NULL",
    "COALESCE(NULL, 'a')",
    "CASE WHEN race THEN laps ELSE NULL END",
    "laps IN (1, NULL)",
    "feeling LIKE NULL",
  ])("accepts a NULL something gives a type: %s", (e) => {
    expect(refused(C(e))).toBe("compiled");
  });

  it("NULLIF of two string literals is text, not a literal taking the other side's type", () => {
    expect(
      refused(
        compileDerivedRule(
          rule("SELECT count(laps) AS x FROM runs WHERE date > NULLIF('2026-01-01', 'x')", ["x"]),
        ),
      ),
    ).toBe("rule_sql_rejected/type");
  });
});

describe("units through every step (11 «单位»)", () => {
  it.each([
    "distance * duration + 0",
    "distance * duration - 0.0",
    "distance * duration % 7",
    "mod(distance * duration, 7)",
    "(distance * duration)::bigint",
    "(distance * duration)::numeric(20, 2)",
    "-(distance * duration)",
    "abs(distance * duration)",
    "COALESCE(distance * duration, 0)",
    "CASE WHEN race THEN distance * duration ELSE 0 END",
  ])("%s: no unit inferable, a declaration needed", (e) => {
    expect(refused(compileDerivedRule(rule(`SELECT sum(${e}) AS x FROM runs`, ["x"])))).toBe(
      "unit_inference_failed/type",
    );
    expect(
      field(
        compileDerivedRule(
          rule(`SELECT sum(${e}) AS x FROM runs`, [{ name: "x", unit: UNITS.CNY }]),
        ),
      ),
    ).toMatchObject({ type: "quantity", unit: UNITS.CNY });
  });

  it("a product of quantities with a quantity: refused", () => {
    expect(
      refused(
        compileDerivedRule(
          rule("SELECT sum(distance * duration + distance) AS x FROM runs", ["x"]),
        ),
      ),
    ).toBe("unit_inference_failed/type");
  });
});

describe("statement, escape, scale and message cases", () => {
  it("numeric(p, s) with a scale above 12 is refused", () => {
    expect(refused(C("pace::numeric(30, 13)"))).toBe("rule_sql_rejected/type");
    expect(refused(C("pace::numeric(30, 12)"))).toBe("compiled");
  });

  it("mod keeps the inputs' rounding, as % does", () => {
    for (const e of ["mod(duration, 2)", "duration % 2"]) {
      expect(field(T(e))).toMatchObject({ precision: { rounding: "half_even" } });
    }
    for (const e of ["mod(pace, 2)", "pace % 2"]) {
      expect(refused(T(e, { rounding: "half_even" }))).toBe("rule_sql_rejected/type");
    }
  });

  it.each(["feeling", "'xy'", "'说说'", "NULL"])("ESCAPE %s is refused", (esc) => {
    expect(refused(C(`feeling LIKE 'a' ESCAPE ${esc}`))).toBe("rule_sql_rejected/function");
  });

  it.each(["''", "'!'", "'说'"])("ESCAPE %s is accepted", (esc) => {
    expect(refused(C(`feeling LIKE 'a' ESCAPE ${esc}`))).toBe("compiled");
  });

  it.each([
    "SELECT count(laps) AS x FROM runs;;",
    "SELECT count(laps) AS x FROM runs; ;",
    "; SELECT count(laps) AS x FROM runs",
  ])("one trailing semicolon at most: %s", (sql) => {
    expect(refused(compileDerivedRule(rule(sql, ["x"])))).toBe("rule_sql_rejected/not_select");
  });

  it("slot.alias.field is not a name", () => {
    expect(
      refused(
        compileDerivedRule(rule("SELECT count(health.r.laps) AS x FROM health.runs r", ["x"])),
      ),
    ).toBe("rule_sql_rejected/unknown_name");
  });

  it("text with a lone surrogate is refused at the entry", () => {
    expect(
      refused(
        compileDerivedRule(
          rule("SELECT count(laps) AS x FROM runs WHERE feeling = '\ud800'", ["x"]),
        ),
      ),
    ).toBe("rule_sql_rejected/syntax");
  });

  it("the parser running out of stack is a limit, in fixed words", () => {
    const d = detail(
      compileDerivedRule(rule(`SELECT count(${"- ".repeat(7000)}laps) AS x FROM runs`, ["x"])),
    );
    expect(d).toMatchObject({ code: "rule_sql_rejected", sql_reason: "limit" });
    expect(d.message).toBe("the rule is nested too deeply to parse");
  });

  it("a column named system_time after FOR in substring is no FOR SYSTEM_TIME", () => {
    expect(
      detail(
        compileDerivedRule(
          rule("SELECT count(substring(feeling FOR system_time)) AS x FROM runs", ["x"]),
        ),
      ).sql_reason,
    ).not.toBe("system_time");
  });

  it("an integer column with a declared type, scale or rounding: the article is right", () => {
    expect(detail(T("laps", { scale: 2 })).message).toBe(
      "x: an integer column takes no type, scale or rounding",
    );
  });

  it("date_trunc names its units in lower case", () => {
    expect(detail(C("date_trunc('MONTH', date::timestamp)")).message).toContain("lower case");
  });
});

describe("LIKE patterns cannot fail on the data (11 «确定性» 6)", () => {
  it.each([
    ["a column as the pattern", "feeling LIKE route"],
    ["an expression as the pattern", "feeling LIKE feeling || '%'"],
    ["a pattern ending in the default escape", "feeling LIKE 'a\\'"],
    ["a pattern ending in its escape", "feeling LIKE 'a!' ESCAPE '!'"],
    ["a pattern that is only its escape", "feeling NOT LIKE '!' ESCAPE '!'"],
  ])("refuses %s", (_, e) => {
    expect(refused(C(e))).toBe("rule_sql_rejected/function");
  });

  it.each([
    "feeling LIKE 'a\\\\'",
    "feeling LIKE 'a!!' ESCAPE '!'",
    "feeling LIKE 'a\\' ESCAPE ''",
    "feeling LIKE 'a\\' ESCAPE '!'",
    "feeling LIKE NULL",
  ])("accepts %s", (e) => {
    expect(refused(C(e))).toBe("compiled");
  });
});

describe("the walker on its own", () => {
  it("takes exactly one statement, whatever the checks before it let through", () => {
    // The text check refuses two statements first; the walker refuses them too.
    let stop: unknown;
    try {
      convertRule(rsqlParser().parse("SELECT 1; SELECT 2"));
    } catch (e) {
      stop = e instanceof RsqlError ? e.stop : e;
    }
    expect(stop).toMatchObject({ kind: "rejected", reason: "not_select" });
  });
});
