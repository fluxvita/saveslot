// evaluateRule: the rewriting of a derived rule's bound text into a query over the physical tables
// (03-data-model/11-restricted-sql.md «处理步骤» 7), the decoding of its rows (09-event-format §1.3;
// 10-types-and-units «精度与舍入»), the rules this version does not evaluate, and the row checksum
// (09 §5.13). Running the queries is tested on PGlite (store-pglite derived-eval.prop.test.ts).

import { createHash } from "node:crypto";
import { canonicalize, type JsonValue } from "@fluxvita/saveslot-contract-core";
import { beforeAll, describe, expect, it } from "vitest";
import { compileDerivedRule } from "./derived.ts";
import {
  evaluateRule,
  evaluationRefusal,
  RuleEvaluationError,
  roundDecimalText,
  rowChecksum,
} from "./evaluate.ts";
import { loadRsql } from "./load.ts";
import { derivedSchema, rule, TABLES } from "./rules.fixture.ts";

beforeAll(() => loadRsql());

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
const LOGICAL_RUNS =
  'WITH "t1" AS (SELECT row_id, "f_f1" AS "f1", "f_f2" AS "f2", "f_f3" AS "f3", "f_f4" AS "f4", "f_f5" AS "f5", "f_f6" AS "f6", "f_f7" AS "f7", "f_f8" AS "f8", "f_f9" AS "f9", "f_f10" AS "f10", "f_f11" AS "f11" FROM "t_t1_v1" WHERE NOT revoked)';

const evaluated = (sql: string, fields: readonly string[], td: "none" | "bucketed" = "none") =>
  evaluateRule(derivedSchema(rule(sql, fields, td)), "t9");
/** The rule body as printed for evaluation (inside `FROM (…) AS "r"`). */
const body = (sql: string, fields: readonly string[]) => {
  const all = evaluated(sql, fields).all.sql;
  return all.slice(all.indexOf("FROM (SELECT") + 6, all.lastIndexOf(') AS "r"'));
};

describe("the rewritten query", () => {
  it("weekly_mileage (06-cli 3.1): the logical table in front, the bound text as printed, results as text", () => {
    const e = evaluated(WEEKLY, WEEKLY_FIELDS, "bucketed");
    expect(e.all).toEqual({
      sql: `${LOGICAL_RUNS} SELECT CAST("r"."f1" AS text) AS "f1", CAST("r"."f2" AS text) AS "f2", CAST("r"."f3" AS text) AS "f3", CAST("r"."f4" AS text) AS "f4", CAST("r"."f5" AS text) AS "f5", CAST("r"."f6" AS text) AS "f6" FROM (SELECT CAST(date_trunc('week', CAST("t1"."f1" AS timestamp)) AS date) AS "f1", sum("t1"."f2") AS "f2", count(*) AS "f3", count(DISTINCT "t1"."f1") AS "f4", min("t1"."f1") AS "f5", max("t1"."f1") AS "f6" FROM "t1" GROUP BY 1) AS "r"`,
      params: [],
    });
  });

  it("a partition: the key compared with a typed parameter, NULL included", () => {
    const e = evaluated(WEEKLY, WEEKLY_FIELDS, "bucketed");
    const p = e.partition(["2026-11-02"]);
    expect(p.sql).toBe(`${e.all.sql} WHERE "r"."f1" IS NOT DISTINCT FROM CAST($1 AS date)`);
    expect(p.params).toEqual(["2026-11-02"]);
    expect(e.partition([null]).params).toEqual([null]);
    expect(() => e.partition([])).toThrow("key of another length");
  });

  it("key parameters are cast by the key field's type", () => {
    const cast = (key: string, field: string) =>
      evaluated(`SELECT ${key} AS k, count(*) AS n FROM runs GROUP BY 1`, ["k", "n"]).partition([
        field === "q" ? { value: "1.5", unit: "km" } : field === "b" ? true : "x",
      ]);
    expect(cast("route", "t").sql).toMatch(/CAST\(\$1 AS text\)$/);
    expect(cast("laps", "t").sql).toMatch(/CAST\(\$1 AS bigint\)$/);
    expect(cast("race", "b").sql).toMatch(/CAST\(\$1 AS boolean\)$/);
    expect(cast("pace", "t").sql).toMatch(/CAST\(\$1 AS numeric\)$/);
    const q = cast("distance", "q");
    expect(q.sql).toMatch(/CAST\(\$1 AS numeric\)$/);
    expect(q.params).toEqual(["1.5"]);
  });

  it("a whole aggregate counts its input rows; a grouped rule does not", () => {
    const w = evaluated("SELECT sum(distance) AS total FROM runs", ["total"]);
    expect(w.all.sql).toContain('count(*) AS "inputs" FROM "t1"');
    expect(w.all.sql).toContain('SELECT CAST("r"."f1" AS text) AS "f1", "r"."inputs" FROM');
    expect(w.partition([])).toEqual(w.all);
    expect(evaluated(WEEKLY, WEEKLY_FIELDS, "bucketed").all.sql).not.toContain("inputs");
  });

  it("quotients are guarded to 45 places and divisors go through NULLIF; % and mod() only NULLIF", () => {
    expect(body("SELECT sum(pace) / count(*) AS x FROM runs", ["x"])).toContain(
      '(CAST(sum("t1"."f7") AS numeric(1000, 45)) / NULLIF(count(*), 0)) AS "f1"',
    );
    expect(body("SELECT avg(distance) AS x FROM runs", ["x"])).toContain(
      'avg(CAST("t1"."f2" AS numeric(1000, 45))) AS "f1"',
    );
    expect(body("SELECT avg(pace) FILTER (WHERE race) AS x FROM runs", ["x"])).toContain(
      'avg(CAST("t1"."f7" AS numeric(1000, 45))) FILTER (WHERE "t1"."f10") AS "f1"',
    );
    expect(body("SELECT max(laps % 3) AS x FROM runs", ["x"])).toContain(
      'max(("t1"."f6" % NULLIF(CAST(3 AS bigint), 0)))',
    );
    expect(body("SELECT max(mod(laps, laps)) AS x FROM runs", ["x"])).toContain(
      'max(mod("t1"."f6", NULLIF("t1"."f6", 0)))',
    );
  });

  it("the bound text as stored is printed without any of that", () => {
    const r = compileDerivedRule(rule("SELECT avg(pace) / count(*) AS x FROM runs", ["x"]));
    if (!r.ok) throw new Error("not compiled");
    expect(r.rule.sql).not.toMatch(/NULLIF|numeric\(1000|inputs/);
  });

  it("integer / integer is refused by the compiler: nothing to guard there", () => {
    const r = compileDerivedRule(rule("SELECT sum(laps) / count(*) AS x FROM runs", ["x"]));
    expect(r.ok ? "compiled" : r.error.code).toBe("validation_failed");
  });
});

describe("rules this version does not evaluate", () => {
  const schema = (sql: string, fields: readonly string[], td: "none" | "bucketed" | "now") =>
    derivedSchema(rule(sql, fields, td));

  it("depending on today, saveslot_date, a decimal key that may have more places than its scale", () => {
    const cases: [string, readonly string[], "none" | "bucketed" | "now", unknown][] = [
      [
        "SELECT count(*) AS n FROM runs WHERE date > saveslot_today() - 30",
        ["n"],
        "now",
        { kind: "today" },
      ],
      [
        "SELECT saveslot_date(started) AS d, count(*) AS n FROM runs GROUP BY 1",
        ["d", "n"],
        "bucketed",
        { kind: "saveslot_date" },
      ],
      [
        "SELECT count(*) AS n FROM runs WHERE saveslot_date(started) > DATE '2026-01-01'",
        ["n"],
        "none",
        { kind: "saveslot_date" },
      ],
      [
        "SELECT pace / 2 AS k, count(*) AS n FROM runs GROUP BY 1",
        ["k", "n"],
        "none",
        { kind: "decimal_key", field: "f1" },
      ],
      [
        "SELECT count(*) AS n, distance * laps AS k FROM runs GROUP BY 2",
        ["n", "k"],
        "none",
        undefined,
      ],
      ["SELECT pace + 1 AS k, count(*) AS n FROM runs GROUP BY 1", ["k", "n"], "none", undefined],
      [
        "SELECT round(pace, 1) AS k, count(*) AS n FROM runs GROUP BY 1",
        ["k", "n"],
        "none",
        undefined,
      ],
      // An integer key: no places to lose.
      ["SELECT laps * 2 AS k, count(*) AS n FROM runs GROUP BY 1", ["k", "n"], "none", undefined],
      [WEEKLY, WEEKLY_FIELDS, "bucketed", undefined],
    ];
    for (const [sql, fields, td, want] of cases) {
      const s = schema(sql, fields, td);
      expect({ sql, refusal: evaluationRefusal(s, "t9") }).toEqual({ sql, refusal: want });
      if (want !== undefined)
        expect(() => evaluateRule(s, "t9")).toThrow("not evaluated in this version");
      else expect(() => evaluateRule(s, "t9")).not.toThrow();
    }
  });

  it("decimal group keys: taken when the bound of their places is within the inferred scale", () => {
    const refused = (key: string, more: Parameters<typeof rule>[3] = {}) => {
      const sql = `SELECT ${key} AS k, count(*) AS n FROM ${more.tables === undefined ? "runs" : "lab"} GROUP BY 1`;
      return evaluationRefusal(derivedSchema(rule(sql, ["k", "n"], "none", more)), "t9")?.kind;
    };
    const taken = [
      "pace",
      "distance",
      "pace + pace",
      "-pace",
      "pace - 1",
      "pace % 2",
      "mod(pace, 2)",
      "abs(pace)",
      "round(pace, 1)",
      "trunc(pace)",
      "floor(pace)",
      "ceil(pace)",
      "sign(pace)",
      "pace::numeric(10, 2)",
      "COALESCE(pace, 0)",
      "GREATEST(pace, 1)",
      "NULLIF(pace, 0)",
      // A WHEN condition is not a result.
      "CASE WHEN laps > 2 THEN pace ELSE 0 END",
      "CASE WHEN pace IS NULL THEN 0 ELSE pace END",
      "EXTRACT(year FROM date)",
      "EXTRACT(month FROM date)",
      // The places are pinned whatever is inside.
      "(pace / 2)::numeric(10, 2)",
      "round(pace / 3, 2)",
      "round(pace * 2, 1)",
      "trunc(distance * 2)",
      // A product's places are the sum of its factors'.
      "pace * 2",
      "pace * laps",
    ];
    const refusedKeys = [
      "pace / 2",
      "pace * pace * pace * pace * pace",
      "COALESCE(pace / 2, 0)",
      "CASE WHEN race THEN pace / laps END",
      "abs(pace / 3)",
      // A constant written with more places than the scale inferred for it (capped at 12).
      "pace % 0.0000000000003",
      "pace + 0.0000000000004",
    ];
    for (const k of taken) expect({ k, refused: refused(k) }).toEqual({ k, refused: undefined });
    for (const k of refusedKeys)
      expect({ k, refused: refused(k) }).toEqual({ k, refused: "decimal_key" });
    // Two factors of scale 7: 14 places, the inferred scale capped at 12.
    const lab = {
      ...TABLES[0],
      fields: [
        ...(TABLES[0]?.fields ?? []),
        {
          id: "f12",
          name: "x",
          type: "decimal",
          description: "x",
          precision: { scale: 7, rounding: "half_up" },
        },
      ],
      name: "lab",
    } as (typeof TABLES)[number];
    expect(refused("x * x", { tables: [lab] })).toBe("decimal_key");
    expect(refused("x * laps", { tables: [lab] })).toBeUndefined();
  });

  it("a compiled definition as the log keeps it (JCS, keys in sorted order) is evaluated", () => {
    const s = derivedSchema(rule(WEEKLY, WEEKLY_FIELDS, "bucketed"));
    const stored = JSON.parse(canonicalize(s as unknown as JsonValue)) as typeof s;
    expect(evaluateRule(stored, "t9").all).toEqual(evaluateRule(s, "t9").all);
    expect(evaluationRefusal(stored, "t9")).toBeUndefined();
  });

  it("a derived table whose field IDs are not f1…fn in order is not evaluated", () => {
    const s = derivedSchema(rule(WEEKLY, WEEKLY_FIELDS, "bucketed"));
    const swapped = {
      ...s,
      tables: s.tables.map((t) =>
        t.kind === "derived"
          ? {
              ...t,
              fields: t.fields.map((f, i) => ({
                ...f,
                id: i === 0 ? "f2" : i === 1 ? "f1" : f.id,
              })),
            }
          : t,
      ),
    } as typeof s;
    expect(() => evaluateRule(swapped, "t9")).toThrow("derived field IDs are not f1…f6 in order");
  });
});

describe("decoding", () => {
  it("weekly_mileage: field values as in events, the key in the rule's key order", () => {
    const e = evaluated(WEEKLY, WEEKLY_FIELDS, "bucketed");
    expect(
      e.decode({
        f1: "2026-11-02",
        f2: "31.00",
        f3: "3",
        f4: "3",
        f5: "2026-11-03",
        f6: "2026-11-08",
      }),
    ).toEqual({
      values: {
        f1: "2026-11-02",
        f2: { value: "31", unit: "km" },
        f3: "3",
        f4: "3",
        f5: "2026-11-03",
        f6: "2026-11-08",
      },
      key: ["2026-11-02"],
    });
  });

  it("a whole aggregate with no input row is no derived row; with inputs it is one even when NULL", () => {
    const w = evaluated(
      "SELECT sum(distance) AS total, count(*) FILTER (WHERE race) AS races FROM runs",
      ["total", "races"],
    );
    expect(w.decode({ f1: null, f2: "0", inputs: "0" })).toBeUndefined();
    expect(w.decode({ f1: null, f2: "0", inputs: "2" })).toEqual({
      values: { f1: null, f2: "0" },
      key: [],
    });
  });

  it("decimals are rounded to the field's precision: half_up and half_even at and near half", () => {
    // distance: scale 2 half_up; duration: scale 1 half_even. avg keeps the scale of its input
    // when it is 6 or more, else 6: declare the fields' scale as the analysis infers it.
    expect(roundDecimalText("1.005", 2, "half_up")).toBe("1.01");
    expect(roundDecimalText("1.005", 2, "half_even")).toBe("1");
    expect(roundDecimalText("1.015", 2, "half_even")).toBe("1.02");
    expect(roundDecimalText("1.0049999999", 2, "half_up")).toBe("1");
    expect(roundDecimalText("1.00500000000001", 2, "half_even")).toBe("1.01");
    expect(roundDecimalText("-1.005", 2, "half_up")).toBe("-1.01");
    expect(roundDecimalText("-1.005", 2, "half_even")).toBe("-1");
    expect(roundDecimalText("-0.004", 2, "half_up")).toBe("0");
    expect(roundDecimalText("12.5", 0, "half_even")).toBe("12");
    expect(roundDecimalText("13.5", 0, "half_even")).toBe("14");
    expect(roundDecimalText("0.000", 2, "half_up")).toBe("0");
    expect(roundDecimalText("120", 2, "half_up")).toBe("120");
    expect(roundDecimalText("9.999", 2, "half_up")).toBe("10");
  });
});

describe("results the event format cannot represent", () => {
  it("a date outside 0001–9999, a decimal with more than 18 integer digits: a rule evaluation error", () => {
    const e = evaluated("SELECT max(date + 400) AS d, sum(pace) AS p FROM runs", ["d", "p"]);
    const err = (row: Record<string, unknown>) => {
      try {
        e.decode({ inputs: "1", ...row });
      } catch (x) {
        return x instanceof RuleEvaluationError ? [x.code, x.reason, x.field] : String(x);
      }
      return "decoded";
    };
    expect(err({ f1: "10001-01-04", f2: "1" })).toEqual([
      "rule_eval_failed",
      "date_out_of_range",
      "f1",
    ]);
    expect(err({ f1: "0001-12-31 BC", f2: "1" })).toEqual([
      "rule_eval_failed",
      "date_out_of_range",
      "f1",
    ]);
    expect(err({ f1: "9999-12-31", f2: "999999999999999999.9994" })).toBe("decoded");
    expect(err({ f1: "9999-12-31", f2: "-1000000000000000000" })).toEqual([
      "rule_eval_failed",
      "number_out_of_range",
      "f2",
    ]);
    // Rounding up can carry into a 19th digit.
    expect(err({ f1: "0001-01-01", f2: "999999999999999999.9996" })).toEqual([
      "rule_eval_failed",
      "number_out_of_range",
      "f2",
    ]);
  });
});

describe("rowChecksum (09 §5.13)", () => {
  it("SHA-256 of the JCS of the values by field ID", () => {
    const values = { f2: { value: "31", unit: "km" }, f10: "3", f1: "2026-11-02" } as const;
    const jcs = '{"f1":"2026-11-02","f10":"3","f2":{"unit":"km","value":"31"}}';
    expect(rowChecksum(values)).toBe(createHash("sha256").update(jcs).digest("hex"));
  });
});
