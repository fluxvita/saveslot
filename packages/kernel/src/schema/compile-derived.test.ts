// compileNewSlot with derived tables (03-data-model/07-schema-evolution.md «文档结构» 派生表 row,
// «例：新建 slot（v1 草稿）»; 09-event-format §7 `rule`, §5.5 `add_derived_table`; 06-derived.md):
// the compiled derived table, rule and field IDs, declarations, the warning for free-text group
// keys, the form and rules of derived tables and their fields, refs to them, and how a rule's
// errors come out among the document's.

import { beforeAll, describe, expect, it } from "vitest";
import { loadRsql } from "../rules/index.ts";
import { compile, type Doc, details, errorOf, eventIssues } from "./documents.fixture.ts";

beforeAll(() => loadRsql());

const ok = (r: ReturnType<typeof compile>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r;
};

/** 07 «例：新建 slot（v1 草稿）», whole. */
function health(): Doc {
  return {
    slot: "health",
    base_version: null,
    timezone: "Asia/Shanghai",
    tables: [
      {
        name: "runs",
        kind: "base",
        description: "每次跑步一行",
        time: { type: "event", field: "date" },
        fields: [
          {
            name: "date",
            type: "date",
            required: true,
            description: "跑步当天（slot 时区的自然日）",
          },
          {
            name: "distance",
            type: "quantity",
            unit: "km",
            required: true,
            min: 0,
            description: "距离",
          },
          { name: "duration", type: "quantity", unit: "min", min: 0, description: "用时" },
          { name: "feeling", type: "text", description: "跑后感受，用户原话" },
        ],
        duplicate_keys: [["date", "distance"]],
      },
      {
        name: "weekly_mileage",
        kind: "derived",
        description: "每周跑量，周一起算",
        rule: {
          sql: "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total_distance, count(*) AS run_count FROM runs GROUP BY 1",
          time_dependency: "bucketed",
        },
        fields: [
          { name: "week_start", description: "该周周一" },
          { name: "total_distance", description: "该周总距离" },
          { name: "run_count", description: "该周跑步次数" },
        ],
      },
    ],
  };
}

/** A copy of `health()` changed by `f`. */
function edit(f: (d: Doc) => void, base: Doc = health()): Doc {
  const d = structuredClone(base);
  f(d);
  return d;
}

/** A derived table over runs, appended to `health()`. */
function withRule(sql: string, fields: Doc[], timeDependency = "none"): Doc {
  return edit((d) => {
    d.tables.push({
      name: "extra",
      kind: "derived",
      description: "a derived table",
      rule: { sql, time_dependency: timeDependency },
      fields,
    });
  });
}
const f = (name: string, more: Doc = {}) => ({ name, description: `the ${name}`, ...more });

const KM = { code: "km", dimension: "length", to_base: "1000" };

describe("the compiled derived table", () => {
  it("07's example compiles whole: table, rule, fields, changes", () => {
    const r = ok(compile(health()));
    expect(r.compiled.tables[1]).toEqual({
      id: "t2",
      name: "weekly_mileage",
      kind: "derived",
      description: "每周跑量，周一起算",
      physical: { table: "d_t2_v1" },
      rule: {
        id: "r1",
        version: 1,
        rsql: "rsql@1",
        sql: `SELECT CAST(date_trunc('week', CAST("t1"."f1" AS timestamp)) AS date) AS "f1", sum("t1"."f2") AS "f2", count(*) AS "f3" FROM "t1" GROUP BY 1`,
        time_dependency: "bucketed",
        depends_on: [
          { table: "t1", field: "f1" },
          { table: "t1", field: "f2" },
        ],
        scope: { kind: "group", key: ["f1"], key_from_free_text: false },
      },
      fields: [
        { id: "f1", name: "week_start", type: "date", description: "该周周一" },
        {
          id: "f2",
          name: "total_distance",
          type: "quantity",
          unit: KM,
          precision: { scale: 6, rounding: "half_up" },
          description: "该周总距离",
        },
        { id: "f3", name: "run_count", type: "integer", description: "该周跑步次数" },
      ],
    });
    const created = {
      class: "create",
      compatible_with_old_writes: true,
      destructive: false,
      auto: true,
    };
    expect(r.changes).toEqual([
      { target: { slot: true }, change: "create_slot", ...created },
      { target: { table: "t1" }, change: "add_table", ...created },
      { target: { table: "t2" }, change: "add_derived_table", ...created },
    ]);
    expect(r.warnings).toEqual([]);
  });

  it("passes the strict parse of a schema.compiled event", () => {
    expect(eventIssues(compile(health()))).toEqual([]);
    expect(
      eventIssues(
        compile(
          withRule("SELECT feeling AS k, sum(distance * duration) AS x FROM runs GROUP BY 1", [
            f("k"),
            f("x", { type: "decimal" }),
          ]),
        ),
      ),
    ).toEqual([]);
  });

  it("numbers tables in document order, rules from the tenant's next rule number", () => {
    const d = edit((x) => {
      // The derived table first: it may read a table written after it.
      x.tables.reverse();
      x.tables.push({ ...structuredClone(x.tables[0]), name: "weekly_again" });
    });
    const r = ok(compile(d, { nextTableNumber: 5, nextRuleNumber: 40 }));
    expect(
      r.compiled.tables.map((t) => [
        t.id,
        t.kind,
        t.physical.table,
        t.kind === "derived" ? t.rule.id : "",
      ]),
    ).toEqual([
      ["t5", "derived", "d_t5_v1", "r40"],
      ["t6", "base", "t_t6_v1", ""],
      ["t7", "derived", "d_t7_v1", "r41"],
    ]);
    const [first] = r.compiled.tables;
    expect(first?.kind === "derived" && first.rule.sql).toContain('FROM "t6"');
    expect(r.changes.map((c) => c.change)).toEqual([
      "create_slot",
      "add_derived_table",
      "add_table",
      "add_derived_table",
    ]);
  });

  it("refuses rule numbers beyond nine digits", () => {
    expect(() => compile(health(), { nextRuleNumber: 1_000_000_000 })).toThrow(
      /rule IDs exhausted/,
    );
    const r = ok(compile(health(), { nextRuleNumber: 999_999_999 }));
    expect(r.compiled.tables[1]?.kind === "derived" && r.compiled.tables[1].rule.id).toBe(
      "r999999999",
    );
  });

  it("takes declared type, unit, scale and rounding where inference gives none", () => {
    const product = "sum(distance * duration)";
    const decimal = ok(
      compile(withRule(`SELECT ${product} AS x FROM runs`, [f("x", { type: "decimal" })])),
    );
    expect(decimal.compiled.tables[2]?.fields).toEqual([
      {
        id: "f1",
        name: "x",
        type: "decimal",
        precision: { scale: 12, rounding: "half_up" },
        description: "the x",
      },
    ]);
    const unit = ok(
      compile(withRule(`SELECT ${product} AS x FROM runs`, [f("x", { unit: "CNY" })])),
    );
    expect(unit.compiled.tables[2]?.fields).toEqual([
      {
        id: "f1",
        name: "x",
        type: "quantity",
        unit: { code: "CNY", dimension: "currency:CNY" },
        precision: { scale: 12, rounding: "half_up" },
        description: "the x",
      },
    ]);
    // A NULL operand leaves the scale to the declaration (10 «精度与舍入»).
    const scale = ok(
      compile(withRule("SELECT sum(distance + NULL) AS x FROM runs", [f("x", { scale: 3 })])),
    );
    expect(scale.compiled.tables[2]?.fields).toEqual([
      {
        id: "f1",
        name: "x",
        type: "quantity",
        unit: KM,
        precision: { scale: 3, rounding: "half_up" },
        description: "the x",
      },
    ]);
    // A declaration contradicting what is inferred: refused.
    expect(
      details(
        compile(withRule(`SELECT ${product} AS x FROM runs`, [f("x", { unit: "CNY", scale: 2 })])),
      ),
    ).toEqual(["tables/2/rule/sql rule_sql_rejected"]);
  });

  it("warns when a group key comes from free text, at the rule", () => {
    const r = ok(
      compile(
        withRule("SELECT feeling AS k, count(*) AS n FROM runs GROUP BY 1", [f("k"), f("n")]),
      ),
    );
    expect(r.warnings).toEqual([
      { code: "group_key_free_text", table: "extra", path: "tables/2/rule" },
    ]);
    expect(r.compiled.tables[2]?.kind === "derived" && r.compiled.tables[2].rule.scope).toEqual({
      kind: "group",
      key: ["f1"],
      key_from_free_text: true,
    });
    // A date key, or a whole aggregate: no warning.
    expect(ok(compile(health())).warnings).toEqual([]);
    expect(
      ok(compile(withRule("SELECT count(feeling) AS n FROM runs", [f("n")]))).warnings,
    ).toEqual([]);
  });

  it("names the slot's derived tables to the rule: reading one is not compiled yet", () => {
    expect(
      errorOf(compile(withRule("SELECT count(*) AS n FROM weekly_mileage", [f("n")]))),
    ).toEqual({
      code: "not_implemented",
      what: "reading a derived table in a derived rule is not compiled yet",
      param: "tables/2/rule/sql",
    });
  });
});

describe("the form of derived tables: invalid_argument", () => {
  const malformed = (param: string, more = {}) => ({
    code: "invalid_argument",
    reason: "malformed",
    param,
    ...more,
  });
  const missing = (param: string, more = {}) => ({
    code: "invalid_argument",
    reason: "missing",
    param,
    ...more,
  });
  // At a rule, its keys, or a sql written on the table: what a rule looks like; at its time
  // dependency also the values this version takes.
  const example = {
    example: {
      sql: "SELECT sum(distance) AS total_distance, count(*) AS run_count FROM runs",
      time_dependency: "none",
    },
  };
  const dependency = { ...example, allowed_values: ["none", "bucketed", "now"] };

  it.each<[string, (d: Doc) => void, object]>([
    ["no rule", (d) => delete d.tables[1].rule, missing("tables/1/rule", example)],
    ["no fields", (d) => delete d.tables[1].fields, missing("tables/1/fields")],
    [
      "rule not an object",
      (d) => (d.tables[1].rule = "SELECT"),
      malformed("tables/1/rule", example),
    ],
    ["no rule.sql", (d) => delete d.tables[1].rule.sql, missing("tables/1/rule/sql", example)],
    [
      "no rule.time_dependency",
      (d) => delete d.tables[1].rule.time_dependency,
      missing("tables/1/rule/time_dependency", dependency),
    ],
    [
      "rule.sql not a string",
      (d) => (d.tables[1].rule.sql = 1),
      malformed("tables/1/rule/sql", example),
    ],
    [
      "an unknown time_dependency",
      (d) => (d.tables[1].rule.time_dependency = "daily"),
      malformed("tables/1/rule/time_dependency", dependency),
    ],
    [
      "an unknown key in rule",
      (d) => (d.tables[1].rule.id = "r1"),
      malformed("tables/1/rule/id", example),
    ],
    [
      "the rule's sql written on the table",
      (d) => (d.tables[1].sql = "SELECT 1"),
      malformed("tables/1/sql", example),
    ],
    ["an unknown table key", (d) => (d.tables[1].bad = 1), malformed("tables/1/bad")],
    ["fields not an array", (d) => (d.tables[1].fields = {}), malformed("tables/1/fields")],
    ["a field not an object", (d) => (d.tables[1].fields[0] = "x"), malformed("tables/1/fields/0")],
    [
      "a field without a name",
      (d) => delete d.tables[1].fields[0].name,
      missing("tables/1/fields/0/name"),
    ],
    [
      "an unknown field key",
      (d) => (d.tables[1].fields[0].migrate = { sql: "x" }),
      malformed("tables/1/fields/0/migrate"),
    ],
    [
      "type not a string",
      (d) => (d.tables[1].fields[1].type = 1),
      malformed("tables/1/fields/1/type"),
    ],
    [
      "unit not a string",
      (d) => (d.tables[1].fields[1].unit = 1),
      malformed("tables/1/fields/1/unit"),
    ],
    [
      "a scale not an integer",
      (d) => (d.tables[1].fields[1].scale = 1.5),
      malformed("tables/1/fields/1/scale"),
    ],
    [
      "an unknown rounding",
      (d) => (d.tables[1].fields[1].rounding = "down"),
      malformed("tables/1/fields/1/rounding"),
    ],
  ])("%s", (_, change, error) => {
    expect(errorOf(compile(edit(change)))).toEqual(error);
  });

  it("the example a rule's form error gives compiles, with fields of its columns", () => {
    const e = errorOf(compile(edit((d) => delete d.tables[1].rule))) as { example?: unknown };
    ok(
      compile(
        edit((d) => {
          d.tables[1].rule = e.example;
          d.tables[1].fields = [d.tables[1].fields[1], d.tables[1].fields[2]];
        }),
      ),
    );
  });

  it("aliases on a derived table or field are compiled", () => {
    const r = compile(
      edit((d) => {
        d.tables[1].aliases = ["weekly"];
        d.tables[1].fields[0].aliases = ["monday"];
      }),
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const t = r.compiled.tables[1];
    expect(t?.aliases).toEqual(["weekly"]);
    expect(t?.fields[0]?.aliases).toEqual(["monday"]);
    expect(t?.fields[1]).not.toHaveProperty("aliases");
    expect(eventIssues(r)).toEqual([]);
  });
});

describe("aliases of derived tables and fields: validation_failed", () => {
  it("are checked like a base table's: against the names of the scope", () => {
    expect(
      details(
        compile(
          edit((d) => {
            d.tables[1].aliases = ["a", d.tables[0].name];
            d.tables[1].fields[0].aliases = [d.tables[1].fields[1].name];
            d.tables[1].fields[1].aliases = [d.tables[1].fields[1].name.toUpperCase()];
          }),
        ),
      ),
    ).toEqual([
      "tables/1/aliases/1 alias_invalid",
      "tables/1/fields/0/aliases/0 alias_invalid",
      "tables/1/fields/1/aliases/0 alias_invalid",
    ]);
  });
});

describe("aliases are no names in a rule's SQL", () => {
  const withAliases = (sql: string, fields: Doc[]) =>
    edit((d) => {
      d.tables[0].aliases = ["trips"];
      d.tables[0].fields[1].aliases = ["miles"];
      d.tables.push({
        name: "extra",
        kind: "derived",
        description: "a derived table",
        rule: { sql, time_dependency: "none" },
        fields,
      });
    });
  it("a table alias and a field alias are unknown names, the names compile", () => {
    const fields = [f("n")];
    const bad = (sql: string) => {
      const e = errorOf(compile(withAliases(sql, fields)));
      if (e.code !== "validation_failed") throw new Error(JSON.stringify(e));
      return e.details.map((x) => [x.path, x.code, x.sql_reason]);
    };
    expect(bad("SELECT count(*) AS n FROM trips")).toEqual([
      ["tables/2/rule/sql", "rule_sql_rejected", "unknown_name"],
    ]);
    expect(bad("SELECT sum(miles) AS n FROM runs")).toEqual([
      ["tables/2/rule/sql", "rule_sql_rejected", "unknown_name"],
    ]);
    ok(compile(withAliases("SELECT sum(distance) AS n FROM runs", [f("n", { unit: "km" })])));
  });
});

describe("the rules of derived tables: validation_failed", () => {
  it.each<[string, (d: Doc) => void, string[]]>([
    [
      "keys only base tables take",
      (d) => {
        d.tables[1].time = { type: "none" };
        d.tables[1].entity_key = ["week_start"];
        d.tables[1].together = [["week_start", "run_count"]];
        d.tables[1].duplicate_keys = [["week_start"]];
      },
      [
        "tables/1/time key_not_applicable",
        "tables/1/entity_key key_not_applicable",
        "tables/1/together key_not_applicable",
        "tables/1/duplicate_keys key_not_applicable",
      ],
    ],
    [
      "an external key",
      (d) => (d.tables[1].external_key = ["week_start"]),
      ["tables/1/external_key external_key_table_kind"],
    ],
    [
      "keys only base fields take",
      (d) =>
        Object.assign(d.tables[1].fields[2], {
          required: true,
          min: 0,
          max: 9,
          values: ["a"],
          ref: { table: "runs", target: "row" },
        }),
      [
        "tables/1/fields/2/required key_not_applicable",
        "tables/1/fields/2/min key_not_applicable",
        "tables/1/fields/2/max key_not_applicable",
        "tables/1/fields/2/values key_not_applicable",
        "tables/1/fields/2/ref key_not_applicable",
      ],
    ],
    [
      "a declared type other than decimal",
      (d) => (d.tables[1].fields[2].type = "integer"),
      ["tables/1/fields/2/type key_not_applicable"],
    ],
    [
      "a declared type that is no type",
      (d) => (d.tables[1].fields[2].type = "number"),
      ["tables/1/fields/2/type unknown_type"],
    ],
    [
      "a unit not in units@1",
      (d) => (d.tables[1].fields[1].unit = "furlong"),
      ["tables/1/fields/1/unit unit_unknown"],
    ],
    [
      "a unit with decimal",
      (d) => Object.assign(d.tables[1].fields[1], { type: "decimal", unit: "km" }),
      ["tables/1/fields/1/unit key_not_applicable"],
    ],
    [
      "a scale out of 0–12",
      (d) => (d.tables[1].fields[1].scale = 13),
      ["tables/1/fields/1/scale out_of_bounds"],
    ],
    [
      "a field without a description",
      (d) => delete d.tables[1].fields[0].description,
      ["tables/1/fields/0/description description_missing"],
    ],
    [
      "a reserved or repeated field name",
      (d) => {
        d.tables[1].fields[0].name = "row_id";
        d.tables[1].fields[2].name = "Total_Distance";
      },
      ["tables/1/fields/0/name reserved_name", "tables/1/fields/2/name duplicate_name"],
    ],
    ["no fields", (d) => (d.tables[1].fields = []), ["tables/1/fields out_of_bounds"]],
    [
      "a table without a description",
      (d) => delete d.tables[1].description,
      ["tables/1/description description_missing"],
    ],
    [
      "a name taken by a base table",
      (d) => (d.tables[1].name = "RUNS"),
      ["tables/1/name duplicate_name"],
    ],
    [
      "a rule on a base table",
      (d) => (d.tables[0].rule = { sql: "SELECT 1", time_dependency: "none" }),
      ["tables/0/rule key_not_applicable"],
    ],
    [
      "a ref to a derived table",
      (d) =>
        d.tables[0].fields.push({
          name: "week",
          type: "ref",
          description: "its week",
          ref: { table: "weekly_mileage", target: "row" },
        }),
      ["tables/0/fields/4/ref/table key_not_applicable"],
    ],
    [
      "a ref to a derived table qualified with this slot",
      (d) =>
        d.tables[0].fields.push({
          name: "week",
          type: "ref",
          description: "its week",
          ref: { table: "health.weekly_mileage", target: "entity" },
        }),
      ["tables/0/fields/4/ref/table key_not_applicable"],
    ],
  ])("%s", (_, change, expected) => {
    expect(details(compile(edit(change)))).toEqual(expected);
  });

  it("a derived field's type and scale: what they may be", () => {
    const full = (d: Doc) => (errorOf(compile(d)) as { details?: unknown }).details;
    expect(full(edit((d) => (d.tables[1].fields[1].type = "integer")))).toEqual([
      { path: "tables/1/fields/1/type", code: "key_not_applicable", allowed_values: ["decimal"] },
    ]);
    expect(full(edit((d) => (d.tables[1].fields[1].type = "number")))).toEqual([
      {
        path: "tables/1/fields/1/type",
        code: "unknown_type",
        allowed_values: [
          "text",
          "integer",
          "decimal",
          "boolean",
          "enum",
          "date",
          "zoned_datetime",
          "quantity",
          "ref",
        ],
      },
    ]);
    expect(full(edit((d) => (d.tables[1].fields[1].scale = -1)))).toEqual([
      { path: "tables/1/fields/1/scale", code: "out_of_bounds", min: "0", max: "12" },
    ]);
  });

  it("base-only keys on a derived field are reported whatever their value", () => {
    const d = edit((x) => Object.assign(x.tables[1].fields[0], { required: "x", values: 3 }));
    expect(details(compile(d))).toEqual([
      "tables/1/fields/0/required key_not_applicable",
      "tables/1/fields/0/values key_not_applicable",
    ]);
  });

  it("the document's own findings come first: a rule is not compiled then", () => {
    const d = edit((x) => {
      x.tables[0].fields[3].name = "valid";
      x.tables[1].rule.sql = "SELECT lower(feeling) AS week_start FROM runs";
    });
    expect(details(compile(d))).toEqual(["tables/0/fields/3/name reserved_name"]);
  });
});

describe("a rule's errors among the document's", () => {
  it("gives the rule's details at its path, with line, reason and suggestion, and no message", () => {
    const r = compile(
      withRule("SELECT count(*) AS n,\n  sum(distance) * 2\nFROM runs", [f("n"), f("x")]),
    );
    expect(errorOf(r)).toEqual({
      code: "validation_failed",
      details: [
        {
          path: "tables/2/rule/sql",
          code: "rule_sql_rejected",
          line: 2,
          sql_reason: "node",
          suggestion: "<expression> AS <field name>",
        },
      ],
    });
  });

  it.each([
    ["cross_slot_ref", "SELECT count(*) AS n FROM ledger.runs", "cross_slot_ref"],
    [
      "nondeterministic_function",
      "SELECT count(*) FILTER (WHERE date < now()) AS n FROM runs",
      "nondeterministic_function",
    ],
    [
      "unit_inference_failed",
      "SELECT sum(distance * duration) AS n FROM runs",
      "unit_inference_failed",
    ],
    ["a syntax error", "SELECT count(* AS n FROM runs", "rule_sql_rejected"],
  ])("%s", (_, sql, code) => {
    const e = errorOf(compile(withRule(sql, [f("n")])));
    expect(e).toMatchObject({
      code: "validation_failed",
      details: [{ path: "tables/2/rule/sql", code }],
    });
  });

  it("refuses a declared time dependency the rule does not have, suggesting the right one", () => {
    const d = edit((x) => (x.tables[1].rule.time_dependency = "none"));
    expect(errorOf(compile(d))).toEqual({
      code: "validation_failed",
      details: [
        {
          path: "tables/1/rule/sql",
          code: "rule_sql_rejected",
          suggestion: '"time_dependency": "bucketed"',
        },
      ],
    });
  });

  it("gives every rule's details, in document order", () => {
    const d = edit((x) => {
      x.tables[1].rule.sql = x.tables[1].rule.sql.replace("sum(distance)", "sum(lower(feeling))");
      x.tables.push({
        name: "second",
        kind: "derived",
        description: "another",
        rule: { sql: "SELECT count(dist) AS n FROM runs", time_dependency: "none" },
        fields: [f("n")],
      });
    });
    expect(details(compile(d))).toEqual([
      "tables/1/rule/sql rule_sql_rejected",
      "tables/2/rule/sql rule_sql_rejected",
    ]);
  });

  it("a rule's not_implemented wins over another's details; not_in_this_version over both", () => {
    const bad = { sql: "SELECT count(dist) AS n FROM runs", time_dependency: "none" };
    const notYet = { sql: "SELECT count(*) AS n FROM weekly_mileage", time_dependency: "none" };
    const notInVersion = { sql: "SELECT feeling AS n FROM runs", time_dependency: "none" };
    const add = (rules: object[]) =>
      edit((x) => {
        rules.forEach((rule, i) => {
          x.tables.push({
            name: `d${i}`,
            kind: "derived",
            description: "d",
            rule,
            fields: [f("n")],
          });
        });
      });
    expect(errorOf(compile(add([bad, notYet])))).toMatchObject({
      code: "not_implemented",
      param: "tables/3/rule/sql",
    });
    expect(errorOf(compile(add([bad, notYet, notInVersion])))).toEqual({
      code: "not_in_this_version",
      param: "tables/4/rule/sql",
    });
  });
});
