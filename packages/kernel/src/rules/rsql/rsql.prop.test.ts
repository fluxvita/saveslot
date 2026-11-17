// Properties of the derived rule compiler (03-data-model/11-restricted-sql.md):
//
// 1. Rules of this version's subset (./rsql-testing.fixture.ts) compile; their time dependency is
//    the generator's; and the ID-bound text they print reads back as the same rule: the structure
//    of the rule as written (names resolved to IDs, places left out) equals the structure of its
//    bound text, and checking the bound text gives the same result. Comparing structures, not the
//    two compilations' printed texts, catches a printer that drops something consistently.
// 2. Nothing outside the whitelist passes (11 «白名单的实现是"不认识的一律拒绝"»), and each refused
//    construct is refused for its own reason: every sample carries the outcome it must get, and is
//    put in a place that compiles with a harmless value instead (checked first), so nothing else in
//    the rule can be what refused it. Each class must be tried in a minimum share of samples.

import fc from "fast-check";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  checkBoundRule,
  compileDerivedRule,
  type DerivedRuleResult,
  ruleShape,
} from "./derived.ts";
import { loadRsql } from "./load.ts";
import {
  FORMS,
  type GeneratedRule,
  generatedRule,
  Hits,
  propRuns,
  rule,
} from "./rsql-testing.fixture.ts";

vi.setConfig({ testTimeout: 60_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 50_000, markInterruptAsFailure: true });
beforeAll(() => loadRsql());

/** A rule reading no field (count(*) alone) stops as not yet compiled: not a failure of the generator. */
const readsNoField = (r: DerivedRuleResult) =>
  !r.ok && r.error.code === "not_implemented" && r.error.what.includes("reads no field");

/** `code/sql_reason`, the error code, or "compiled". */
function outcome(r: DerivedRuleResult): string {
  if (r.ok) return "compiled";
  if (r.error.code !== "validation_failed") return r.error.code;
  const [d] = r.error.details;
  return `${d.code}${d.sql_reason !== undefined ? `/${d.sql_reason}` : ""}`;
}

/** Compiles `g`; when it compiles, checks it as property 1 says and gives back its bound text. */
function compiledReadsBack(g: GeneratedRule): string | undefined {
  const input = rule(g.sql, g.fields, g.timeDependency);
  const r = compileDerivedRule(input);
  if (readsNoField(r)) return undefined;
  if (!r.ok) throw new Error(`${g.sql}\n→ ${JSON.stringify(r.error)}`);
  expect(r.rule.time_dependency).toBe(g.timeDependency);
  const bound = { ...input, sql: r.rule.sql };
  const written = ruleShape(input, "names");
  expect(written).toBeDefined();
  expect(ruleShape(bound, "ids"), `${g.sql}\n→ ${r.rule.sql}`).toBe(written);
  expect(checkBoundRule(bound)).toEqual(r);
  return r.rule.sql;
}

describe("rules of this version's subset", () => {
  it("reach each form whose type PostgreSQL resolves differently by a fixed rule, which reads back", () => {
    for (const f of FORMS) {
      const bound = compiledReadsBack(f.example);
      expect({ form: f.name, bound }).toEqual({ form: f.name, bound: expect.any(String) });
      expect({ form: f.name, reached: f.reached(f.example.sql, bound as string) }).toEqual({
        form: f.name,
        reached: true,
      });
    }
  });

  it("compile, with the generator's time dependency, and their bound text reads back as the same rule", () => {
    const hits = new Hits(0.9);
    const reached = new Map<string, number>();
    fc.assert(
      fc.property(
        generatedRule,
        hits.track((g) => {
          const bound = compiledReadsBack(g);
          if (bound === undefined) return;
          hits.hit();
          for (const f of FORMS) {
            if (f.reached(g.sql, bound)) reached.set(f.name, (reached.get(f.name) ?? 0) + 1);
          }
        }),
      ),
      { numRuns: propRuns(600) },
    );
    hits.check();
    if (process.env["RSQL_FORMS"] !== undefined)
      console.log(
        FORMS.map((f) => `${f.name} ${((reached.get(f.name) ?? 0) / hits.hits).toFixed(3)}`).join(
          "\n",
        ),
      );
    // Each form is checked by its fixed rule above; here only that the generator still draws every
    // form at all. The rarest form is in about 4.9% of the rules (measured on 20,000), so with at
    // least 540 rules compiled (90% of 600) a form missing entirely while the generator is sound
    // has a probability of about 0.951^540 ≈ 2e-12; for all forms together, about 3e-12.
    for (const f of FORMS) {
      expect({ form: f.name, reached: (reached.get(f.name) ?? 0) > 0 }).toEqual({
        form: f.name,
        reached: true,
      });
    }
  });
});

// --- outside the whitelist ------------------------------------------------------------------------

type Class = "node" | "function" | "operator" | "cast" | "name" | "statement" | "clause";

const R = "rule_sql_rejected";
const N = "nondeterministic_function";

/**
 * Constructs refused inside an expression, with the outcome each must get. `output`: an aggregate
 * or window form, put as an output column, not inside `count(…)` (where nesting is refused too).
 */
const REFUSED: Readonly<
  Record<
    "node" | "function" | "operator" | "cast",
    readonly (readonly [string, string, "output"?])[]
  >
> = {
  node: [
    ["ARRAY[laps]", `${R}/node`],
    ["ROW(laps, 1)", `${R}/node`],
    ["(laps)[1]", `${R}/node`],
    ['feeling COLLATE "C"', `${R}/node`],
    ["B'1010'", `${R}/node`],
    ["X'ff'", `${R}/node`],
    ["1e5", `${R}/node`],
    ["$1", `${R}/node`],
    ["laps = ANY('{1}')", `${R}/node`],
    ["laps = ALL('{1}')", `${R}/node`],
    ["laps BETWEEN SYMMETRIC 1 AND 2", `${R}/node`],
    ["CURRENT_DATE", `${N}/node`],
    ["CURRENT_USER", `${N}/node`],
    ["SESSION_USER", `${N}/node`],
    ["user", `${N}/node`],
    ["LOCALTIME", `${N}/node`],
    ["xmlelement(name a)", `${R}/node`],
    ["JSON_OBJECT('a': 1)", `${R}/node`],
    ["GROUPING(laps)", `${R}/node`],
    ["abs(VARIADIC laps)", `${R}/node`],
    ["percentile_cont(0.5) WITHIN GROUP (ORDER BY pace)", `${R}/node`, "output"],
    ["sum(laps ORDER BY laps)", `${R}/node`, "output"],
    ["sum(DISTINCT laps)", `${R}/node`, "output"],
    ["count(*) FILTER (WHERE sum(laps) > 0)", `${R}/node`, "output"],
    ["row_number() OVER ()", `${N}/function`, "output"],
    ["lag(laps) OVER (ORDER BY date)", `${N}/function`, "output"],
  ],
  function: [
    ["lower(feeling)", `${R}/function`],
    ["upper(feeling)", `${R}/function`],
    ["initcap(feeling)", `${R}/function`],
    ["now()", `${N}/function`],
    ["random()", `${N}/function`],
    ["clock_timestamp()", `${N}/function`],
    ["pg_sleep(1)", `${R}/function`],
    ["pg_read_file('/etc/passwd')", `${R}/function`],
    ["current_setting('search_path')", `${N}/function`],
    ["set_config('a', 'b', false)", `${N}/function`],
    ["make_date(2026, 1, 1)", `${R}/function`],
    ["sqrt(pace)", `${R}/function`],
    ["power(pace, 2)", `${R}/function`],
    ["date_part('year', date)", `${R}/function`],
    ["to_char(laps, '9')", `${N}/function`],
    ["concat(feeling, 'x')", `${N}/function`],
    ["regexp_replace(feeling, 'a', 'b')", `${R}/function`],
    ["string_agg(feeling, ',')", `${R}/function`, "output"],
    ["array_agg(laps)", `${R}/function`, "output"],
    ["json_agg(laps)", `${R}/function`, "output"],
    ["stddev(pace)", `${R}/function`, "output"],
    ["txid_current()", `${R}/function`],
    ["nextval('s')", `${R}/function`],
    ["pg_catalog.abs(laps)", `${R}/function`],
    ["public.abs(laps)", `${R}/function`],
    ['"lower"(feeling)', `${R}/function`],
    ["date_trunc('hour', date::timestamp)::date", `${R}/function`],
    ["date_trunc('week', date)", `${N}/function`],
    ["EXTRACT(epoch FROM date)", `${R}/function`],
    ["generate_series(1, 3)", `${R}/function`],
    ["round(laps)", `${R}/function`],
    ["substr(feeling, laps)", `${R}/function`],
    ["date + laps", `${R}/function`],
  ],
  operator: [
    ["feeling ILIKE 'a'", `${R}/function`],
    ["feeling ~ 'a'", `${R}/function`],
    ["feeling ~* 'a'", `${R}/function`],
    ["feeling !~ 'a'", `${R}/function`],
    ["feeling SIMILAR TO 'a'", `${R}/function`],
    ["feeling ~~ 'a'", `${R}/function`],
    ["laps ^ 2", `${R}/function`],
    ["laps & 1", `${R}/function`],
    ["laps | 1", `${R}/function`],
    ["laps # 1", `${R}/function`],
    ["laps << 1", `${R}/function`],
    ["|/ pace", `${R}/function`],
    ["@ laps", `${R}/function`],
    ["laps OPERATOR(pg_catalog.+) 1", `${R}/function`],
    ["laps / 2", `${R}/function`],
    ["feeling || laps", `${R}/function`],
    ["date * 2", `${R}/function`],
    ["feeling LIKE 'a' ESCAPE 'xy'", `${R}/function`],
  ],
  cast: [
    ["laps::text", `${N}/function`],
    ["laps::varchar", `${N}/function`],
    ["laps::int4", `${R}/function`],
    ["laps::integer", `${R}/function`],
    ["laps::smallint", `${R}/function`],
    ["laps::float8", `${R}/function`],
    ["laps::real", `${R}/function`],
    ["pace::double precision", `${R}/function`],
    ["laps::bool", `${R}/function`],
    ["laps::json", `${R}/function`],
    ["laps::regclass", `${R}/function`],
    ["laps::oid", `${R}/function`],
    ["laps::money", `${R}/function`],
    ["laps::bigint", `${R}/function`],
    ["pace::numeric(5)", `${R}/node`],
    ["pace::numeric(30, 13)", `${R}/type`],
    ["date::timestamptz", `${N}/function`],
    ["started::date", `${N}/function`],
    ["started::timestamp", `${R}/function`],
    ["'1'::numeric", `${R}/function`],
    ["feeling::bigint", `${R}/function`],
    ["INTERVAL '1 day'", `${R}/function`],
    ["laps::bigint[]", `${R}/node`],
    ["CAST(feeling AS text)", `${N}/function`],
  ],
};

/** Places for an expression of any type, inside an aggregate's argument, WHERE, HAVING, FILTER. */
const SCALAR_PLACES: readonly ((x: string) => string)[] = [
  (x) => `SELECT route AS k, count(${x}) AS n FROM runs WHERE laps > 0 GROUP BY 1`,
  (x) =>
    `SELECT route AS k, count(*) AS n FROM runs WHERE laps > 0 AND (${x}) IS NOT NULL GROUP BY 1`,
  (x) =>
    `SELECT route AS k, count(*) AS n FROM runs WHERE laps > 0 GROUP BY 1 HAVING count(${x}) > 0`,
  (x) =>
    `SELECT route AS k, count(CASE WHEN race THEN ${x} END) AS n FROM runs WHERE laps > 0 GROUP BY 1`,
  (x) => `SELECT route AS k, count(COALESCE(${x}, ${x})) AS n FROM runs WHERE laps > 0 GROUP BY 1`,
  (x) =>
    `SELECT route AS k, count(*) FILTER (WHERE (${x}) IS NULL) AS n FROM runs WHERE laps > 0 GROUP BY 1`,
  (x) => `SELECT route AS k, count(((((${x}))))) AS n FROM runs WHERE laps > 0 GROUP BY 1`,
  (x) =>
    `SELECT route AS k, count(${x}) AS n FROM runs WHERE laps > 0 AND laps IN (1, 2) GROUP BY 1`,
];

/** Places for an aggregate or window form: an output column. */
const OUTPUT_PLACES: readonly ((x: string) => string)[] = [
  (x) => `SELECT route AS k, ${x} AS n FROM runs WHERE laps > 0 GROUP BY 1`,
  (x) => `SELECT route AS k, (${x}) AS n FROM runs WHERE laps > 0 GROUP BY route`,
  (x) => `SELECT ${x} AS n, route AS k FROM runs WHERE laps > 0 GROUP BY 2`,
];

/** Harmless values that compile in each kind of place. */
const FILLER = { scalar: "laps", output: "count(laps)" } as const;

const BASE = "SELECT route AS k, count(laps) AS n FROM runs WHERE laps > 0 GROUP BY 1";

/** Names in place of the table or a column of BASE. */
const NAMES: readonly (readonly [string, string, string])[] = [
  ["FROM runs", "FROM pg_class", `${R}/unknown_name`],
  ["FROM runs", "FROM pg_catalog.pg_proc", "cross_slot_ref/unknown_name"],
  ["FROM runs", "FROM information_schema.tables", "cross_slot_ref/unknown_name"],
  ["FROM runs", "FROM t_t1_v1", `${R}/unknown_name`],
  ["FROM runs", "FROM events", `${R}/unknown_name`],
  ["FROM runs", "FROM ledger.runs", "cross_slot_ref/unknown_name"],
  ["FROM runs", 'FROM "pg_shadow"', `${R}/unknown_name`],
  ["laps > 0", "f_f6 > 0", `${R}/unknown_name`],
  ["laps > 0", "xmin > 0", `${R}/unknown_name`],
  ["laps > 0", "ctid IS NOT NULL", `${R}/unknown_name`],
  ["laps > 0", "entity_id IS NOT NULL", `${R}/unknown_name`],
  ["laps > 0", "pg_catalog.laps > 0", `${R}/unknown_name`],
  ["laps > 0", "health.r.laps > 0", `${R}/unknown_name`],
];

/** Whole statements that are no SELECT, or not one. */
const STATEMENTS: readonly (readonly [string, string])[] = [
  ...[
    "INSERT INTO runs (laps) VALUES (1)",
    "UPDATE runs SET laps = 1",
    "DELETE FROM runs",
    "DROP TABLE runs",
    "TRUNCATE runs",
    "CREATE TABLE x (a int)",
    "ALTER TABLE runs ADD COLUMN x int",
    "SET search_path TO public",
    "RESET ALL",
    "SHOW search_path",
    "COPY runs TO STDOUT",
    "DO $$ BEGIN END $$",
    "CALL p()",
    "PREPARE p AS SELECT 1",
    "EXECUTE p",
    "LISTEN c",
    "NOTIFY c",
    "LOCK TABLE runs",
    "VACUUM runs",
    "ANALYZE runs",
    "EXPLAIN SELECT 1",
    "BEGIN",
    "COMMIT",
    `${BASE}; DROP TABLE runs`,
    `${BASE};;`,
  ].map((s) => [s, `${R}/not_select`] as const),
  ["VALUES (1)", `${R}/node`],
];

/** SELECT clauses outside this version's shape, each in BASE. */
const CLAUSES: readonly (readonly [string, string])[] = [
  [BASE.replace("FROM runs", "INTO x FROM runs"), `${R}/node`],
  [`${BASE} FOR UPDATE`, `${R}/node`],
  [BASE.replace("FROM runs", "FROM runs FOR SYSTEM_TIME AS OF 1"), `${R}/system_time`],
  [BASE.replace("FROM runs", "FROM ONLY runs"), `${R}/node`],
  [`${BASE} LIMIT 1`, `${N}/node`],
  [`${BASE} OFFSET 1`, `${N}/node`],
  [`${BASE} ORDER BY 1`, `${N}/node`],
  [BASE.replace("SELECT route", "SELECT DISTINCT ON (route) route"), `${N}/node`],
  [BASE.replace("FROM runs", "FROM runs TABLESAMPLE SYSTEM (10)"), `${R}/node`],
  [BASE.replace("FROM runs", "FROM LATERAL (SELECT 1) AS s"), `${R}/node`],
  [`WITH RECURSIVE s AS (SELECT 1) ${BASE}`, `${R}/node`],
  [`WITH s AS (SELECT 1) ${BASE}`, "not_implemented"],
  [`${BASE} UNION ${BASE}`, "not_implemented"],
  [BASE.replace("FROM runs", "FROM generate_series(1, 3)"), `${R}/node`],
  [BASE.replace("GROUP BY 1", "GROUP BY ROLLUP(route)"), `${R}/node`],
  [BASE.replace("GROUP BY 1", "GROUP BY DISTINCT route"), `${R}/node`],
];

/** Letter case, comments, line breaks: the same construct, the same outcome. */
function variant(sql: string, how: number): string {
  switch (how) {
    case 0:
      return sql;
    case 1:
      // Keywords and names, not string constants (their case is their value).
      return sql
        .split(/('(?:[^']|'')*')/)
        .map((part, i) => (i % 2 === 1 ? part : part.toUpperCase()))
        .join("")
        .replace("FROM RUNS", "FROM runs");
    case 2:
      return sql.replaceAll(" ", " /* c */ ");
    case 3:
      return sql.replaceAll("(", "( ").replaceAll(" ", "\n");
    default:
      return `-- x\n${sql} -- y`;
  }
}

interface Sample {
  readonly cls: Class;
  readonly sql: string;
  readonly expected: string;
}

const how = fc.integer({ min: 0, max: 4 });
const sample: fc.Arbitrary<Sample> = fc.oneof(
  ...(["node", "function", "operator", "cast"] as const).map((cls) =>
    fc
      .tuple(fc.constantFrom(...REFUSED[cls]), fc.nat(), how)
      .map(([[x, expected, where], i, h]) => {
        const places = where === "output" ? OUTPUT_PLACES : SCALAR_PLACES;
        const place = places[i % places.length] as (x: string) => string;
        return { cls, sql: variant(place(x), h), expected };
      }),
  ),
  fc.tuple(fc.constantFrom(...NAMES), how).map(([[a, b, expected], h]) => ({
    cls: "name" as const,
    sql: variant(BASE.replace(a, b), h),
    expected,
  })),
  fc
    .tuple(fc.constantFrom(...STATEMENTS), how)
    .map(([[s, expected], h]) => ({ cls: "statement" as const, sql: variant(s, h), expected })),
  fc
    .tuple(fc.constantFrom(...CLAUSES), how)
    .map(([[s, expected], h]) => ({ cls: "clause" as const, sql: variant(s, h), expected })),
);

describe("outside the whitelist", () => {
  it("every place compiles with a harmless value, in every variant", () => {
    for (let h = 0; h <= 4; h++) {
      for (const p of SCALAR_PLACES)
        expect(outcome(compileDerivedRule(rule(variant(p(FILLER.scalar), h), ["k", "n"])))).toBe(
          "compiled",
        );
      for (const p of OUTPUT_PLACES)
        expect(outcome(compileDerivedRule(rule(variant(p(FILLER.output), h), ["k", "n"])))).toBe(
          "compiled",
        );
      expect(outcome(compileDerivedRule(rule(variant(BASE, h), ["k", "n"])))).toBe("compiled");
    }
  });

  it("nothing passes; each construct is refused for its own reason; each class is tried", () => {
    const tried = new Map<Class, number>();
    const hits = new Hits(0.9);
    fc.assert(
      fc.property(
        sample,
        hits.track(({ cls, sql, expected }) => {
          const got = outcome(compileDerivedRule(rule(sql, ["k", "n"])));
          expect(got, sql).toBe(expected);
          tried.set(cls, (tried.get(cls) ?? 0) + 1);
          hits.hit();
        }),
      ),
      { numRuns: propRuns(3000) },
    );
    hits.check();
    const runs = [...tried.values()].reduce((a, b) => a + b, 0);
    for (const cls of [
      "node",
      "function",
      "operator",
      "cast",
      "name",
      "statement",
      "clause",
    ] as const) {
      expect({ cls, triedShare: (tried.get(cls) ?? 0) / runs >= 0.1 }).toEqual({
        cls,
        triedShare: true,
      });
    }
  });
});
