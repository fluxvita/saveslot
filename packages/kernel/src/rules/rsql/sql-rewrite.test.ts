// Rewriting a checked `sql` query to what is executed (./sql-rewrite.ts; 11-restricted-sql.md
// «处理步骤» 7–8), offline: the text and the statements of the read record, read as text and, where
// the structure is the point, as the parse tree of the text. What the database does with the text
// is run in store-pglite (sql-*.test.ts).

import { beforeAll, describe, expect, it } from "vitest";
import { loadRsql, rsqlParser } from "./load.ts";
import { derivedSchema, rule } from "./rules.fixture.ts";
import { check, health, ledger } from "./sql.fixture.ts";
import type { SqlSlot } from "./sql.ts";
import { rewriteSql, type SqlCall, SqlNotImplemented, SqlRuntime } from "./sql-rewrite.ts";

beforeAll(async () => {
  await loadRsql();
});

const NOW = "2026-11-05T04:00:00.000Z";

/** A call that gives each `$n` the value in `values`, and the day `2026-11-05` in any zone. */
const call = (values: Record<number, string | number | boolean | null> = {}): SqlCall => ({
  param: (n) => values[n] ?? null,
  now: NOW,
  today: () => "2026-11-05",
  operand: (o) => (o.base.k === "str" ? o.base.value.slice(0, 10) : "2026-11-05"),
  current: (g) => (g === "date" ? "2026-11-05" : NOW),
});

function analysed(
  sql: string,
  params: readonly unknown[] = [],
  slots: readonly SqlSlot[] = [health()],
) {
  const r = check(sql, params, slots);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return { analysis: r.analysis, slots };
}

function rewrite(
  sql: string,
  values: Record<number, string | number | boolean | null> = {},
  slots?: readonly SqlSlot[],
) {
  const a = analysed(
    sql,
    Object.keys(values).map((k) => values[Number(k)]),
    slots,
  );
  return rewriteSql({ ...a, call: call(values) });
}

/** The columns a parse tree refers to, as written, and the tables it reads. */
function parsed(text: string) {
  const tree = rsqlParser().parse(text) as { stmts: unknown[] };
  const refs: string[][] = [];
  const tables: string[] = [];
  const walk = (n: unknown): void => {
    if (Array.isArray(n)) {
      for (const x of n) walk(x);
      return;
    }
    if (n === null || typeof n !== "object") return;
    for (const [k, v] of Object.entries(n)) {
      if (k === "ColumnRef") {
        refs.push(
          (v as { fields: { String?: { sval: string }; A_Star?: unknown }[] }).fields.map(
            (f) => f.String?.sval ?? "*",
          ),
        );
      }
      if (k === "RangeVar") {
        const r = v as { schemaname?: string; relname: string };
        tables.push(`${r.schemaname ?? ""}.${r.relname}`);
      }
      walk(v);
    }
  };
  walk(tree.stmts);
  return { refs, tables };
}

describe("a table reference", () => {
  it("is a subquery of the current version's physical table without the revoked rows, under the logical names", () => {
    const { main } = rewrite("SELECT r.laps, r.race FROM runs r");
    expect(main.text).toContain(
      `(SELECT "row_id" AS "row_id", "f_f1" AS "date", "f_f2" AS "distance", "f_f3" AS "duration", "f_f4" AS "feeling", "f_f5" AS "route", "f_f6" AS "laps", "f_f7" AS "pace", "f_f8" AS "started", "f_f9" AS "shoe", "f_f10" AS "race", "f_f11" AS "uphill" FROM "public"."t_t1_v1" WHERE NOT "revoked") AS "t1"`,
    );
    expect(main.params).toEqual([]);
  });

  it("is written with the schema of the table, and nothing in the text reads a table without one", () => {
    const { main } = rewrite(
      "SELECT 1 FROM runs a JOIN shoes b ON b.row_id = a.shoe WHERE a.laps IN (SELECT laps FROM runs)",
    );
    const { tables } = parsed(main.text);
    expect(tables.length).toBeGreaterThan(0);
    for (const t of tables) expect(t).toMatch(/^public\.t_t[1-9][0-9]*_v1$/);
  });

  it("does not show a physical column the caller cannot see, and writes every outer column as alias.name", () => {
    const { main } = rewrite(
      "SELECT r.laps, s.model FROM runs r JOIN shoes s ON s.row_id = r.shoe",
    );
    // The outer query's columns are all `"t<n>"."name"` or `"p".` ones; the physical names stay inside
    // the subqueries that are the FROM items.
    const outer = main.text.replace(
      /\(SELECT [^()]*FROM "public"\."t_[^"]+" WHERE NOT "revoked"\)/g,
      "()",
    );
    expect(outer).not.toMatch(/"revoked"|"f_f[0-9]+/);
    for (const ref of parsed(main.text).refs) {
      if (ref.length === 2) expect(ref[0]).toMatch(/^(t[1-9][0-9]*|c[1-9][0-9]*)$/);
    }
  });

  it("is the stored table of a derived table, its fields under their names", () => {
    const { main } = rewrite("SELECT week, km FROM weekly");
    expect(main.text).toContain(
      `(SELECT "f_f1" AS "week", "f_f2" AS "km" FROM "public"."d_t9_v1") AS "t1"`,
    );
  });

  it("is the current segments of a state table, merged, cut to the time", () => {
    const { main, times } = rewrite("SELECT category FROM budgets");
    expect(main.text).toContain(
      `"valid_from" <= CAST($1 AS date) AND ("valid_to" IS NULL OR "valid_to" > CAST($2 AS date))`,
    );
    expect(main.params).toEqual(["2026-11-05", "2026-11-05"]);
    expect(main.text).toContain("coalesce(");
    expect(times).toEqual([{ slot: "sl_health", read: { at: "2026-11-05" } }]);
  });

  it("takes the clause's times, as the call resolves them", () => {
    const at = rewrite("SELECT category FROM budgets FOR VALID_TIME AS OF '2026-11-12'");
    expect(at.main.params).toEqual(["2026-11-12", "2026-11-12"]);
    const during = rewrite(
      "SELECT category FROM budgets FOR VALID_TIME FROM '2026-10-01' TO '2026-11-12'",
    );
    expect(during.main.text).toContain(
      `"valid_from" < CAST($1 AS date) AND ("valid_to" IS NULL OR "valid_to" > CAST($2 AS date))`,
    );
    expect(during.main.params).toEqual(["2026-11-12", "2026-10-01"]);
    expect(during.times[0]?.read).toEqual({ during: ["2026-10-01", "2026-11-12"] });
  });

  it("is refused when the interval does not run forward", () => {
    expect(() =>
      rewrite("SELECT category FROM budgets FOR VALID_TIME FROM '2026-11-12' TO '2026-10-01'"),
    ).toThrow(SqlRuntime);
  });
});

describe("the values of the call", () => {
  it("are parameters cast to the type the analysis found, numbered in the order they are written", () => {
    const { main } = rewrite("SELECT laps FROM runs WHERE laps > $1 AND feeling = $2 LIMIT $3", {
      1: "3",
      2: "ok",
      3: "10",
    });
    expect(main.text).toContain(`"t1"."laps" > CAST($1 AS bigint)`);
    expect(main.text).toContain(`"t1"."feeling" = CAST($2 AS text)`);
    expect(main.text).toContain(`LIMIT CAST($3 AS bigint)`);
    expect(main.params).toEqual(["3", "ok", "10"]);
  });

  it("are the call's own for saveslot_now() and saveslot_today()", () => {
    const { main } = rewrite("SELECT saveslot_now() AS n, saveslot_today() AS d FROM shoes");
    expect(main.text).toContain(`CAST($1 AS timestamptz) AS "c1", CAST($2 AS date) AS "c2"`);
    expect(main.params).toEqual([NOW, "2026-11-05"]);
  });

  it("leave no spelling of the caller's in the text: not an alias, not an output name", () => {
    const { main } = rewrite(
      `SELECT secret_alias_q.laps AS "Secret_Out" FROM runs AS secret_alias_q WHERE secret_alias_q.feeling = 'x' ORDER BY 1`,
    );
    expect(main.text).not.toMatch(/secret_alias_q|Secret_Out/i);
    expect(main.text).toContain(`AS "c1"`);
  });
});

describe("the output", () => {
  it("names the columns of the top level c1 … cN, so two of one name are two columns", () => {
    const { main } = rewrite("SELECT 1 AS x, 2 AS x");
    expect(main.text).toBe(`SELECT 1 AS "c1", 2 AS "c2"`);
  });

  it("names those of each branch of a set operation too", () => {
    const { main } = rewrite("SELECT laps AS a FROM runs UNION SELECT 1 AS b");
    expect(main.text.match(/AS "c1"/g)).toHaveLength(2);
  });

  it("guards the divisor of /, % and mod() with NULLIF(…, 0)", () => {
    const { main } = rewrite(
      "SELECT CAST(laps AS numeric) / laps AS a, laps % laps AS b, mod(laps, laps) AS c, CAST(laps AS numeric) / NULLIF(laps, 5) AS d FROM runs",
    );
    expect(main.text).toContain(`/ NULLIF("t1"."laps", 0))`);
    expect(main.text).toContain(`% NULLIF("t1"."laps", 0))`);
    expect(main.text).toContain(`mod("t1"."laps", NULLIF("t1"."laps", 0))`);
    // A divisor the caller already wrote NULLIF around is guarded all the same.
    expect(main.text).toContain(`NULLIF(NULLIF("t1"."laps", 5), 0)`);
  });
});

describe("what this version does not read", () => {
  it("saveslot_date: the internal date column is not built", () => {
    expect(() => rewrite("SELECT saveslot_date(started) FROM runs")).toThrow(SqlNotImplemented);
  });
});

describe("a derived table computed when read (11 «改写»)", () => {
  /** `health` whose derived table `weekly` is the rule given, depending on today. */
  const withRule = (sql: string, fields: readonly string[]) =>
    health({ tables: derivedSchema(rule(sql, fields, "now")).tables });

  it("is its rule as a subquery, today a parameter, values rounded as stored; no physical derived table", () => {
    const slot = withRule(
      "SELECT sum(distance) AS total, sum(duration) AS minutes FROM runs WHERE date > saveslot_today() - 7",
      ["total", "minutes"],
    );
    const r = rewrite("SELECT total, minutes FROM weekly", {}, [slot]);
    expect(r.main.params).toEqual(["2026-11-05"]);
    expect(r.main.text).toContain(`(CAST($1 AS date) - 7)`);
    expect(r.main.text).not.toContain("d_t9_v1");
    // The session's search path is pg_catalog: the physical table is qualified.
    expect(r.main.text).toContain(`FROM "public"."t_t1_v1" WHERE NOT revoked`);
    // distance is half_up to 2 places; duration half_even to 1.
    expect(r.main.text).toContain(`round("r"."f1", 2) AS "f1"`);
    expect(r.main.text).toContain(
      `CASE WHEN mod(abs("r"."f2") * 10, 2) = 0.5 THEN trunc("r"."f2", 1) ELSE round("r"."f2", 1) END AS "f2"`,
    );
    // A whole aggregate with no input row has no row, as `query` gives it.
    expect(r.main.text).toContain(`WHERE "r"."inputs" > 0`);
  });

  it("two slots in different zones in one statement: each expansion takes today in its own slot's zone", () => {
    const tables = derivedSchema(
      rule("SELECT count(laps) AS n FROM runs WHERE date = saveslot_today()", ["n"], "now"),
    ).tables;
    const slots = [
      health({ tables }),
      health({ slot: "sl_away", name: "away", timezone: "America/Los_Angeles", tables }),
    ];
    const a = analysed("SELECT h.n, w.n FROM health.weekly h CROSS JOIN away.weekly w", [], slots);
    // 2026-11-05T04:00Z is 11-05 in Shanghai and 11-04 in Los Angeles.
    const zoned: SqlCall = {
      ...call(),
      today: (zone) => (zone === "America/Los_Angeles" ? "2026-11-04" : "2026-11-05"),
    };
    const r = rewriteSql({ ...a, call: zoned });
    expect(r.main.params).toEqual(["2026-11-05", "2026-11-04"]);
    expect(r.tables.map((t) => [t.slot, t.table.id, t.refs])).toEqual([
      ["sl_health", "t1", [undefined]],
      ["sl_away", "t1", [undefined]],
    ]);
  });

  it("is recorded on the base tables its rule reads, each whole; a state table's point is its time", () => {
    const r = rewrite("SELECT total FROM weekly", {}, [
      withRule("SELECT sum(amount) AS total FROM budgets", ["total"]),
    ]);
    expect(r.tables.map((t) => [t.table.id, t.refs])).toEqual([["t3", [undefined]]]);
    expect(r.times).toEqual([{ slot: "sl_health", read: { at: "2026-11-05" } }]);
    expect(r.main.params).toEqual(["2026-11-05"]);
  });
});

describe("the statements of the read record", () => {
  const ids = (sql: string, slots?: readonly SqlSlot[]) =>
    rewrite(sql, {}, slots).tables.map((t) => ({
      table: t.table.id,
      refs: t.refs.map((r) => (r === undefined ? "alone-not" : r.text)),
    }));

  it("reads the identities of one table through its own level, whatever grouping, limit and order sit above it", () => {
    const [t] = ids(
      "SELECT route, count(*) FROM runs WHERE laps > 3 GROUP BY route HAVING count(*) > 1 ORDER BY 1 LIMIT 2",
    );
    expect(t?.table).toBe("t1");
    const text = t?.refs[0] as string;
    expect(text).toMatch(
      /^SELECT DISTINCT "t1"\."row_id" AS "id" FROM \(SELECT .* AS "t1" WHERE \("t1"\."laps" > 3\) LIMIT 1001$/,
    );
    expect(text).not.toMatch(/GROUP BY|HAVING|ORDER BY/);
  });

  it("takes a state table's entity, a derived table's partition, and a table once however often it is referenced", () => {
    const first = (sql: string) => rewrite(sql).tables[0];
    expect(first("SELECT 1 FROM budgets")?.refs[0]?.text).toContain(`"t1"."entity_id" AS "id"`);
    expect(first("SELECT 1 FROM weekly")?.refs[0]?.text).toContain(`"t1"."partition_id" AS "id"`);
    expect(first("SELECT 1 FROM shoes")?.refs[0]?.text).toContain(`"t1"."row_id" AS "id"`);
    const twice = rewrite("SELECT (SELECT count(*) FROM budgets) AS n FROM budgets");
    expect(twice.tables).toHaveLength(1);
    expect(twice.tables[0]?.refs).toHaveLength(2);
  });

  it.each([
    "SELECT 1 FROM runs r JOIN shoes s ON s.row_id = r.shoe",
    "SELECT 1 FROM runs r LEFT JOIN shoes s ON s.row_id = r.shoe",
    "SELECT 1 FROM runs r, shoes s",
    "SELECT 1 FROM runs r CROSS JOIN weekly w LIMIT 1",
    "SELECT 1 FROM runs r, (SELECT 1 AS a) AS q",
    "SELECT 1 FROM runs r JOIN shoes s ON s.row_id = r.shoe JOIN budgets b ON b.category = r.route",
  ])(
    "gives no statement for a level of two or more references, which is recorded whole: %s",
    (sql) => {
      const { tables } = rewrite(sql);
      expect(tables.length).toBeGreaterThan(0);
      for (const t of tables) expect(t.refs).toEqual([undefined]);
    },
  );

  it("gives a statement to a level of one reference even beside a join in another level", () => {
    const { tables } = rewrite(
      "SELECT (SELECT count(*) FROM runs r JOIN budgets b ON b.category = r.route) AS n FROM shoes",
    );
    const byTable = new Map(tables.map((t) => [t.table.id, t.refs]));
    expect(byTable.get("t5")?.[0]?.text).toMatch(/^SELECT DISTINCT/);
    expect(byTable.get("t1")).toEqual([undefined]);
    expect(byTable.get("t3")).toEqual([undefined]);
  });

  it("runs a subquery that stands alone on its own, and its table is read through its own level", () => {
    const got = ids("SELECT (SELECT max(laps) FROM runs WHERE race) AS m FROM runs");
    expect(got).toHaveLength(1);
    expect(got[0]?.refs).toHaveLength(2);
    expect(got[0]?.refs.every((r) => r !== "alone-not")).toBe(true);
  });

  it("gives none for a table in a subquery that reads the outer query's columns: the table is recorded whole", () => {
    const got = ids(
      "SELECT (SELECT 1 FROM shoes s WHERE s.row_id = r.shoe LIMIT 1) AS one FROM runs r",
    );
    const byTable = new Map(got.map((t) => [t.table, t.refs]));
    expect(byTable.get("t5")).toEqual(["alone-not"]);
    expect(byTable.get("t1")?.[0]).toMatch(/^SELECT DISTINCT/);
  });

  it.each([
    "SELECT 1 FROM runs r WHERE EXISTS (SELECT 1 FROM shoes s WHERE s.row_id = r.shoe)",
    "SELECT 1 FROM runs WHERE laps IN (SELECT laps FROM runs WHERE race)",
    "SELECT 1 FROM runs WHERE laps > (SELECT min(laps) FROM runs)",
    "SELECT 1 FROM runs WHERE race AND (laps > 1 OR laps IN (SELECT laps FROM runs))",
    "SELECT 1 FROM runs WHERE (SELECT count(*) FROM runs a, runs b, runs c WHERE a.route <> runs.route) >= 0",
    "SELECT 1 FROM runs s WHERE s.route IN (SELECT a.route FROM runs a, runs b, runs c)",
  ])("gives no statement for a level of one reference whose WHERE has a subquery: %s", (sql) => {
    const { tables } = rewrite(sql);
    const outer = tables.find((t) => t.table.id === "t1");
    // The table is read once or more; every reference of it is given up, not just the outer one.
    expect(outer?.refs).toEqual([undefined]);
  });

  it("gives up every reference of a table when one of them cannot be read by row: no statement is run for it", () => {
    const { tables } = rewrite(
      "SELECT (SELECT count(*) FROM runs a, shoes s) AS n, (SELECT max(laps) FROM runs WHERE race) AS m FROM runs",
    );
    expect(tables.find((t) => t.table.id === "t1")?.refs).toEqual([undefined]);
    // The other table is read in a level of a join as well: whole, too.
    expect(tables.find((t) => t.table.id === "t5")?.refs).toEqual([undefined]);
  });

  it("never carries common table expressions in a statement: a level that reads one is a level of more than a table", () => {
    const { tables } = rewrite(
      "WITH x AS (SELECT row_id FROM shoes) SELECT (SELECT count(*) FROM x) AS n FROM runs",
    );
    for (const t of tables)
      for (const r of t.refs) if (r !== undefined) expect(r.text).not.toMatch(/^WITH/);
    expect(tables.find((t) => t.table.id === "t1")?.refs[0]?.text).toMatch(/^SELECT DISTINCT/);
  });

  it("keeps a table of another slot apart from one of the same name", () => {
    const slots = [health(), ledger()];
    const all = rewrite("SELECT 1 FROM health.expenses h, ledger.expenses l", {}, slots);
    expect(all.tables.map((t) => `${t.slotName}.${t.table.name}`).sort()).toEqual([
      "health.expenses",
      "ledger.expenses",
    ]);
  });
});
