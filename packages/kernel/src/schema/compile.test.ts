// compileNewSlot: the compiled definition, IDs, defaults and changes of a new slot
// (03-data-model/07-schema-evolution.md «schema 文档格式»; 09-event-format §5.5, §7), the form of
// the document, the keys v1 does not support and what is not compiled yet, and the order of errors.

import { describe, expect, it } from "vitest";
import { CHANGES_V1, COMPILED_V1 } from "../apply/slot.fixture.ts";
import {
  compile,
  type Doc,
  edit,
  errorOf,
  eventIssues,
  ledger,
  SLOT_ID,
} from "./documents.fixture.ts";

const ok = (r: ReturnType<typeof compile>) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r;
};

describe("the compiled definition", () => {
  it("equals apply's hand-written version 1, aliases aside", () => {
    const r = ok(compile(ledger()));
    const { aliases: _, ...expenses } = COMPILED_V1.tables[0];
    expect(r.compiled).toEqual({
      ...COMPILED_V1,
      tables: [expenses, ...COMPILED_V1.tables.slice(1)],
    });
    expect(r.changes).toEqual(CHANGES_V1);
    expect(r.outcome).toBe("applied");
    expect(r.targetVersion).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it("passes the strict parse of a schema.compiled event", () => {
    expect(eventIssues(compile(ledger()))).toEqual([]);
  });

  it("numbers tables from the tenant's next free number, fields from 1 in each table", () => {
    const r = ok(compile(ledger(), { nextTableNumber: 7 }));
    expect(r.compiled.tables.map((t) => [t.id, t.physical.table])).toEqual([
      ["t7", "t_t7_v1"],
      ["t8", "t_t8_v1"],
      ["t9", "t_t9_v1"],
      ["t10", "t_t10_v1"],
    ]);
    const [expenses] = r.compiled.tables;
    expect(expenses?.fields.map((f) => f.id)).toEqual([
      "f1",
      "f2",
      "f3",
      "f4",
      "f5",
      "f6",
      "f7",
      "f8",
      "f9",
    ]);
    // References follow the table numbers.
    expect(expenses?.fields[8]).toMatchObject({ ref: { table: "t8", target: "entity" } });
    expect(r.changes.map((c) => c.target)).toEqual([
      { slot: true },
      { table: "t7" },
      { table: "t8" },
      { table: "t9" },
      { table: "t10" },
    ]);
    expect(eventIssues(r)).toEqual([]);
  });

  it("records version 1, compiler 1, the current whitelist and the slot as given", () => {
    const r = ok(compile(ledger()));
    expect(r.compiled).toMatchObject({
      compiler: 1,
      rsql: "rsql@1",
      slot: SLOT_ID,
      name: "ledger",
      sv: 1,
      timezone: "Asia/Shanghai",
    });
  });

  it("fills precision defaults: a currency's minor unit, else 6; half_up", () => {
    const fields = (unit: string) =>
      ok(
        compile(
          edit((d) => {
            d.tables[0].fields[2].unit = unit;
            d.tables[0].fields[5] = { name: "rate", type: "decimal", description: "a rate" };
          }),
        ),
      ).compiled.tables[0]?.fields as unknown as Record<string, unknown>[];
    expect(fields("JPY")[2]?.["precision"]).toEqual({ scale: 0, rounding: "half_up" });
    expect(fields("KWD")[2]?.["precision"]).toEqual({ scale: 3, rounding: "half_up" });
    expect(fields("CNY")[2]?.["precision"]).toEqual({ scale: 2, rounding: "half_up" });
    expect(fields("km")[2]?.["precision"]).toEqual({ scale: 6, rounding: "half_up" });
    expect(fields("km")[5]?.["precision"]).toEqual({ scale: 6, rounding: "half_up" });
  });

  it("keeps a declared scale and rounding over the defaults", () => {
    const f = ok(
      compile(
        edit((d) => {
          d.tables[0].fields[2].scale = 0;
          d.tables[0].fields[2].rounding = "half_even";
        }),
      ),
    ).compiled.tables[0]?.fields[2];
    expect(f).toMatchObject({ precision: { scale: 0, rounding: "half_even" } });
  });

  it("writes the unit from units@1: to_base only for convertible units", () => {
    const unit = (u: string) => {
      const f = ok(compile(edit((d) => (d.tables[0].fields[2].unit = u)))).compiled.tables[0]
        ?.fields[2];
      return (f as unknown as Record<string, unknown> | undefined)?.["unit"];
    };
    expect(unit("mi")).toEqual({ code: "mi", dimension: "length", to_base: "1609.344" });
    expect(unit("floz")).toEqual({ code: "floz", dimension: "volume", to_base: "0.0295735295625" });
    expect(unit("USD")).toEqual({ code: "USD", dimension: "currency:USD" });
    expect(unit("degF")).toEqual({ code: "degF", dimension: "temperature:degF" });
  });

  it("writes min and max as canonical decimals, from numbers or strings", () => {
    const f = (min: unknown, max: unknown) =>
      ok(
        compile(
          edit((d) => {
            d.tables[0].fields[5].min = min;
            d.tables[0].fields[5].max = max;
          }),
        ),
      ).compiled.tables[0]?.fields[5];
    expect(f(0, "1.5")).toMatchObject({ min: "0", max: "1.5" });
    expect(f(-0, 7)).toMatchObject({ min: "0", max: "7" });
    expect(f("-0.50", "12.3400")).toMatchObject({ min: "-0.5", max: "12.34" });
    expect(f("-0", "123456789012345678.000000000001")).toMatchObject({
      min: "0",
      max: "123456789012345678.000000000001",
    });
  });

  it("accepts enum values with inner white space and composed characters", () => {
    const r = ok(
      compile(edit((d) => (d.tables[0].fields[1].values = ["eating out", "caf\u00e9"]))),
    );
    expect(r.compiled.tables[0]?.fields[1]).toMatchObject({ values: ["eating out", "café"] });
  });

  it("writes a scale of -0 as 0", () => {
    const f = ok(compile(edit((d) => (d.tables[0].fields[5].scale = -0)))).compiled.tables[0]
      ?.fields[5] as unknown as { precision: { scale: number } };
    expect(Object.is(f.precision.scale, 0)).toBe(true);
  });

  it("writes required only when true", () => {
    const fs = ok(compile(edit((d) => (d.tables[0].fields[3].required = false)))).compiled.tables[0]
      ?.fields;
    expect(fs?.[3]).not.toHaveProperty("required");
    expect(fs?.[0]).toHaveProperty("required", true);
  });

  it("keeps empty groups as written, and leaves out keys not written", () => {
    const r = ok(
      compile(
        edit((d) => {
          d.tables[0].together = [];
          d.tables[0].duplicate_keys = [];
        }),
      ),
    );
    expect(r.compiled.tables[0]).toMatchObject({ together: [], duplicate_keys: [] });
    expect(r.compiled.tables[2]).not.toHaveProperty("entity_key");
    expect(r.compiled.tables[3]).not.toHaveProperty("together");
    expect(eventIssues(r)).toEqual([]);
  });

  it("resolves names in keys and refs without ASCII case", () => {
    const r = ok(
      compile(
        edit((d) => {
          d.tables[0].time.field = "DATE";
          d.tables[0].fields[8].ref.table = "Accounts";
          d.tables[1].entity_key = ["NAME"];
        }),
      ),
    );
    expect(r.compiled.tables[0]).toMatchObject({ time: { type: "event", field: "f1" } });
    expect(r.compiled.tables[1]).toMatchObject({ entity_key: ["f1"] });
  });

  it("accepts a ref to its own table and a ref qualified with this slot", () => {
    const r = ok(
      compile(
        edit((d) => {
          d.tables[3].fields.push({
            name: "parent",
            type: "ref",
            description: "parent setting",
            ref: { table: "settings", target: "row" },
          });
          d.tables[0].fields[8].ref.table = "LEDGER.accounts";
        }),
      ),
    );
    expect(r.compiled.tables[3]?.fields[1]).toMatchObject({ ref: { table: "t4", target: "row" } });
    expect(r.compiled.tables[0]?.fields[8]).toMatchObject({ ref: { table: "t2" } });
    expect(eventIssues(r)).toEqual([]);
  });

  it("compiles an external key and warns when it has one field", () => {
    const one = ok(compile(edit((d) => (d.tables[3].external_key = ["key"]))));
    expect(one.compiled.tables[3]).toMatchObject({ external_key: ["f1"] });
    expect(one.warnings).toEqual([
      { code: "single_field_external_key", path: "tables/3/external_key" },
    ]);
    expect(eventIssues(one)).toEqual([]);
    const two = ok(
      compile(
        edit((d) => {
          d.tables[0].fields.push({ name: "origin", type: "text", description: "source system" });
          d.tables[0].external_key = ["origin", "pieces"];
        }),
      ),
    );
    expect(two.compiled.tables[0]).toMatchObject({ external_key: ["f10", "f5"] });
    expect(two.warnings).toEqual([]);
  });

  it("accepts a slot without tables", () => {
    const r = ok(compile(edit((d) => (d.tables = []))));
    expect(r.compiled.tables).toEqual([]);
    expect(r.changes).toEqual([CHANGES_V1[0]]);
    expect(eventIssues(r)).toEqual([]);
  });
});

describe("the spec's examples", () => {
  // 07 «例：新建 slot（v1 草稿）», its base table (the whole example: ./compile-derived.test.ts).
  it("health", () => {
    const r = ok(
      compile({
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
        ],
      }),
    );
    expect(r.compiled.tables[0]).toMatchObject({
      id: "t1",
      time: { type: "event", field: "f1" },
      duplicate_keys: [["f1", "f2"]],
    });
    expect(r.compiled.tables[0]?.fields.map((f) => [f.id, f.name])).toEqual([
      ["f1", "date"],
      ["f2", "distance"],
      ["f3", "duration"],
      ["f4", "feeling"],
    ]);
    expect(eventIssues(r)).toEqual([]);
  });

  // 07 «例：状态类表».
  it("marketing", () => {
    const r = ok(
      compile({
        slot: "marketing",
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [
          {
            name: "budgets",
            kind: "base",
            description: "各类别的月度预算",
            time: { type: "state", granularity: "date" },
            entity_key: ["category"],
            fields: [
              { name: "category", type: "text", required: true, description: "预算类别" },
              {
                name: "amount",
                type: "quantity",
                unit: "CNY",
                required: true,
                min: 0,
                description: "月度预算金额",
              },
            ],
          },
        ],
      }),
    );
    expect(r.compiled.tables[0]).toMatchObject({
      entity_key: ["f1"],
      fields: [
        { id: "f1" },
        {
          id: "f2",
          unit: { code: "CNY", dimension: "currency:CNY" },
          precision: { scale: 2, rounding: "half_up" },
          min: "0",
        },
      ],
    });
    expect(eventIssues(r)).toEqual([]);
  });
});

describe("keys v1 does not support: not_in_this_version", () => {
  it.each([
    ["extends on the document", (d: Doc) => (d["extends"] = "x"), "extends"],
    ["compatibility on the document", (d: Doc) => (d["compatibility"] = "x"), "compatibility"],
    ["extends on a table", (d: Doc) => (d.tables[1].extends = "x"), "tables/1/extends"],
    [
      "compatibility on a table",
      (d: Doc) => (d.tables[0].compatibility = "x"),
      "tables/0/compatibility",
    ],
    [
      "reextract on a field",
      (d: Doc) => (d.tables[0].fields[3].reextract = { from: [], instructions: "x" }),
      "tables/0/fields/3/reextract",
    ],
  ])("%s", (_, f, param) => {
    expect(errorOf(compile(edit(f)))).toEqual({ code: "not_in_this_version", param });
  });

  it("wins over everything else", () => {
    const d = edit((x) => {
      x.tables[0].reextract = 1;
      x.tables[1].kind = "derived";
      x.tables[0].fields[3].reextract = {};
      x.slot = "_bad";
    });
    expect(errorOf(compile(d))).toEqual({
      code: "not_in_this_version",
      param: "tables/0/fields/3/reextract",
    });
  });
});

describe("in v1, not compiled yet: not_implemented", () => {
  it.each([
    ["a draft changing a slot", (d: Doc) => (d.base_version = 1), "base_version"],
    ["aliases on a table", (d: Doc) => (d.tables[1].aliases = ["a"]), "tables/1/aliases"],
    [
      "aliases on a field",
      (d: Doc) => (d.tables[0].fields[1].aliases = ["a"]),
      "tables/0/fields/1/aliases",
    ],
  ])("%s", (name, f, param) => {
    const what = name.startsWith("aliases") ? "aliases" : name;
    expect(errorOf(compile(edit(f)))).toEqual({ code: "not_implemented", what, param });
  });

  it("wins over form and rule errors", () => {
    const d = edit((x) => {
      x.tables[0].fields[1].aliases = ["a"];
      x.tables[0].unknown = 1;
      x.slot = "_bad";
    });
    expect(errorOf(compile(d))).toMatchObject({ code: "not_implemented", what: "aliases" });
  });
});

describe("the form of the document: invalid_argument", () => {
  const malformed = (param: string) => ({ code: "invalid_argument", reason: "malformed", param });
  const missing = (param: string) => ({ code: "invalid_argument", reason: "missing", param });

  it.each<[string, unknown, object]>([
    ["not an object", [], malformed("")],
    ["null", null, malformed("")],
    ["no slot", edit((d) => delete d.slot), missing("slot")],
    ["no base_version", edit((d) => delete d.base_version), missing("base_version")],
    [
      "base_version not null nor a number",
      edit((d) => (d.base_version = "1")),
      malformed("base_version"),
    ],
    ["no timezone", edit((d) => delete d.timezone), missing("timezone")],
    ["no tables", edit((d) => delete d.tables), missing("tables")],
    ["tables not an array", edit((d) => (d.tables = {})), malformed("tables")],
    ["slot not a string", edit((d) => (d.slot = 1)), malformed("slot")],
    ["timezone not a string", edit((d) => (d.timezone = null)), malformed("timezone")],
    ["an unknown key", edit((d) => (d.slots = 1)), malformed("slots")],
    // Keys only a change to a slot has.
    ["rename_to", edit((d) => (d.rename_to = "x")), malformed("rename_to")],
    ["drop_tables", edit((d) => (d.drop_tables = [])), malformed("drop_tables")],
    ["a table id", edit((d) => (d.tables[0].id = "t1")), malformed("tables/0/id")],
    ["drop_fields", edit((d) => (d.tables[0].drop_fields = [])), malformed("tables/0/drop_fields")],
    [
      "a field id",
      edit((d) => (d.tables[0].fields[0].id = "f1")),
      malformed("tables/0/fields/0/id"),
    ],
    [
      "migrate",
      edit((d) => (d.tables[0].fields[3].migrate = { sql: "x" })),
      malformed("tables/0/fields/3/migrate"),
    ],
    [
      "backfill",
      edit((d) => (d.tables[0].fields[3].backfill = { const: "x" })),
      malformed("tables/0/fields/3/backfill"),
    ],
    ["a table not an object", edit((d) => (d.tables[1] = "x")), malformed("tables/1")],
    ["a table without kind", edit((d) => delete d.tables[1].kind), missing("tables/1/kind")],
    [
      "a kind neither base nor derived",
      edit((d) => (d.tables[1].kind = "view")),
      malformed("tables/1/kind"),
    ],
    ["a table without name", edit((d) => delete d.tables[1].name), missing("tables/1/name")],
    ["a table without time", edit((d) => delete d.tables[1].time), missing("tables/1/time")],
    ["a table without fields", edit((d) => delete d.tables[1].fields), missing("tables/1/fields")],
    ["fields not an array", edit((d) => (d.tables[1].fields = {})), malformed("tables/1/fields")],
    [
      "a description not a string",
      edit((d) => (d.tables[1].description = 1)),
      malformed("tables/1/description"),
    ],
    ["time not an object", edit((d) => (d.tables[1].time = "state")), malformed("tables/1/time")],
    ["time without type", edit((d) => (d.tables[1].time = {})), missing("tables/1/time/type")],
    [
      "an unknown time type",
      edit((d) => (d.tables[1].time.type = "period")),
      malformed("tables/1/time/type"),
    ],
    [
      "an event time without field",
      edit((d) => delete d.tables[0].time.field),
      missing("tables/0/time/field"),
    ],
    [
      "an event time field not a string",
      edit((d) => (d.tables[0].time.field = 1)),
      malformed("tables/0/time/field"),
    ],
    [
      "a state time without granularity",
      edit((d) => delete d.tables[1].time.granularity),
      missing("tables/1/time/granularity"),
    ],
    [
      "an unknown granularity",
      edit((d) => (d.tables[1].time.granularity = "month")),
      malformed("tables/1/time/granularity"),
    ],
    [
      "a key of another time type",
      edit((d) => (d.tables[3].time.field = "key")),
      malformed("tables/3/time/field"),
    ],
    [
      "entity_key not a list of strings",
      edit((d) => (d.tables[1].entity_key = [1])),
      malformed("tables/1/entity_key/0"),
    ],
    [
      "external_key not an array",
      edit((d) => (d.tables[3].external_key = "key")),
      malformed("tables/3/external_key"),
    ],
    [
      "together not a list of lists",
      edit((d) => (d.tables[0].together = ["category"])),
      malformed("tables/0/together/0"),
    ],
    [
      "duplicate_keys not an array",
      edit((d) => (d.tables[0].duplicate_keys = 1)),
      malformed("tables/0/duplicate_keys"),
    ],
    [
      "a field not an object",
      edit((d) => (d.tables[1].fields[1] = 1)),
      malformed("tables/1/fields/1"),
    ],
    [
      "a field without name",
      edit((d) => delete d.tables[1].fields[1].name),
      missing("tables/1/fields/1/name"),
    ],
    [
      "a field without type",
      edit((d) => delete d.tables[1].fields[1].type),
      missing("tables/1/fields/1/type"),
    ],
    [
      "a type not a string",
      edit((d) => (d.tables[1].fields[1].type = 1)),
      malformed("tables/1/fields/1/type"),
    ],
    [
      "an enum without values",
      edit((d) => delete d.tables[0].fields[1].values),
      missing("tables/0/fields/1/values"),
    ],
    [
      "a quantity without unit",
      edit((d) => delete d.tables[0].fields[2].unit),
      missing("tables/0/fields/2/unit"),
    ],
    [
      "a ref without ref",
      edit((d) => delete d.tables[0].fields[8].ref),
      missing("tables/0/fields/8/ref"),
    ],
    [
      "required not a boolean",
      edit((d) => (d.tables[1].fields[1].required = "yes")),
      malformed("tables/1/fields/1/required"),
    ],
    [
      "a misspelt key",
      edit((d) => (d.tables[1].fields[1].requried = true)),
      malformed("tables/1/fields/1/requried"),
    ],
    [
      "values not strings",
      edit((d) => (d.tables[0].fields[1].values = ["a", 1])),
      malformed("tables/0/fields/1/values/1"),
    ],
    [
      "unit not a string",
      edit((d) => (d.tables[0].fields[2].unit = { code: "CNY" })),
      malformed("tables/0/fields/2/unit"),
    ],
    [
      "scale not an integer",
      edit((d) => (d.tables[0].fields[5].scale = 1.5)),
      malformed("tables/0/fields/5/scale"),
    ],
    [
      "an unknown rounding",
      edit((d) => (d.tables[0].fields[5].rounding = "down")),
      malformed("tables/0/fields/5/rounding"),
    ],
    [
      "ref not an object",
      edit((d) => (d.tables[0].fields[8].ref = "accounts")),
      malformed("tables/0/fields/8/ref"),
    ],
    [
      "ref without target",
      edit((d) => delete d.tables[0].fields[8].ref.target),
      missing("tables/0/fields/8/ref/target"),
    ],
    [
      "an unknown ref target",
      edit((d) => (d.tables[0].fields[8].ref.target = "column")),
      malformed("tables/0/fields/8/ref/target"),
    ],
    [
      "ref table not a string",
      edit((d) => (d.tables[0].fields[8].ref.table = 2)),
      malformed("tables/0/fields/8/ref/table"),
    ],
    [
      "an unknown ref key",
      edit((d) => (d.tables[0].fields[8].ref.field = "x")),
      malformed("tables/0/fields/8/ref/field"),
    ],
    // Numbers: exact round trips only.
    [
      "min beyond the safe integers",
      edit((d) => (d.tables[0].fields[4].min = 2 ** 53)),
      malformed("tables/0/fields/4/min"),
    ],
    [
      "min written with an exponent",
      edit((d) => (d.tables[0].fields[5].min = 1e-7)),
      malformed("tables/0/fields/5/min"),
    ],
    // A fraction is written as a string: a parsed number no longer tells what was written.
    [
      "max a JSON number with a fraction",
      edit((d) => (d.tables[0].fields[5].max = 1.5)),
      malformed("tables/0/fields/5/max"),
    ],
    // Strings are well-formed Unicode.
    [
      "a lone surrogate in a description",
      edit((d) => (d.tables[0].fields[3].description = "\ud800")),
      malformed("tables/0/fields/3/description"),
    ],
    [
      "a lone surrogate in a name",
      edit((d) => (d.tables[1].name = "a\udc00")),
      malformed("tables/1/name"),
    ],
    [
      "a lone surrogate in the time zone",
      edit((d) => (d.timezone = "Asia/\ud83d")),
      malformed("timezone"),
    ],
    [
      "a lone surrogate in a key list",
      edit((d) => (d.tables[1].entity_key = ["\ud800name"])),
      malformed("tables/1/entity_key/0"),
    ],
    // Enum values: NFC, no control characters, no surrounding white space.
    [
      "an enum value not in NFC",
      edit((d) => (d.tables[0].fields[1].values = ["food", "cafe\u0301"])),
      malformed("tables/0/fields/1/values/1"),
    ],
    [
      "an enum value with a control character",
      edit((d) => (d.tables[0].fields[1].values = ["fo\u0007od"])),
      malformed("tables/0/fields/1/values/0"),
    ],
    [
      "an enum value with a line break",
      edit((d) => (d.tables[0].fields[1].values = ["food", "rent\n"])),
      malformed("tables/0/fields/1/values/1"),
    ],
    [
      "an enum value with leading white space",
      edit((d) => (d.tables[0].fields[1].values = ["\u3000food"])),
      malformed("tables/0/fields/1/values/0"),
    ],
    [
      "an enum value with trailing white space",
      edit((d) => (d.tables[0].fields[1].values = ["food "])),
      malformed("tables/0/fields/1/values/0"),
    ],
    [
      "max as a string with an exponent",
      edit((d) => (d.tables[0].fields[5].max = "1e3")),
      malformed("tables/0/fields/5/max"),
    ],
    [
      "max as a string with a plus sign",
      edit((d) => (d.tables[0].fields[5].max = "+1")),
      malformed("tables/0/fields/5/max"),
    ],
    [
      "max with a leading zero",
      edit((d) => (d.tables[0].fields[5].max = "01")),
      malformed("tables/0/fields/5/max"),
    ],
    [
      "min a boolean",
      edit((d) => (d.tables[0].fields[5].min = true)),
      malformed("tables/0/fields/5/min"),
    ],
  ])("%s", (_, doc, error) => {
    expect(errorOf(compile(doc))).toEqual(error);
  });

  // A known limit: the compiler sees the parsed number. 1.0000000000000001 parses to exactly 1, a
  // safe integer, and is taken as 1. Only the entry, which has the JSON text, could tell.
  it("takes a number that parses to a safe integer as that integer", () => {
    expect(
      ok(compile(edit((d) => (d.tables[0].fields[5].max = JSON.parse("1.0000000000000001")))))
        .compiled.tables[0]?.fields[5],
    ).toMatchObject({ max: "1" });
  });

  it("accepts the largest safe integer written as a number", () => {
    expect(
      ok(compile(edit((d) => (d.tables[0].fields[4].max = 2 ** 53 - 1)))).compiled.tables[0]
        ?.fields[4],
    ).toMatchObject({ max: "9007199254740991" });
  });

  it("reports the first form error in document order, before rule errors", () => {
    const d = edit((x) => {
      x.slot = "_bad";
      x.tables[1].fields[0].bad = 1;
      x.tables[2].fields[0].bad = 1;
    });
    expect(errorOf(compile(d))).toEqual(malformed("tables/1/fields/0/bad"));
  });
});

describe("the caller's input", () => {
  it("refuses a slot ID or a table or rule number that is not one", () => {
    expect(() => compile(ledger(), { nextRuleNumber: 0 })).toThrow(/rule number/);
    expect(() => compile(ledger(), { nextRuleNumber: 2.5 })).toThrow(/rule number/);
    expect(() => compile(ledger(), { slotId: "sl_x" as never })).toThrow(/slot ID/);
    expect(() => compile(ledger(), { nextTableNumber: 0 })).toThrow(/table number/);
    expect(() => compile(ledger(), { nextTableNumber: 1.5 })).toThrow(/table number/);
    expect(() => compile(ledger(), { nextTableNumber: 999_999_997 })).toThrow(/exhausted/);
    expect(ok(compile(ledger(), { nextTableNumber: 999_999_996 })).compiled.tables[3]?.id).toBe(
      "t999999999",
    );
  });
});
