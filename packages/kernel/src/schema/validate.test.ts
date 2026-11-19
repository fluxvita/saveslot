// The compilation rules of a new slot's document, one by one: each rule accepts what it allows and
// reports what it does not, with the detail code and the position (03-data-model/07-schema-evolution.md
// «schema 文档格式»; 10-types-and-units.md; 04-contract «schema_draft»). Accepted cases also pass the
// strict parse of a `schema.compiled` event.

import { describe, expect, it } from "vitest";
import { compile, type Doc, details, edit, errorOf, eventIssues } from "./documents.fixture.ts";

/** The document compiles, and its event parses. */
const accepts = (d: Doc, o: Parameters<typeof compile>[1] = {}) => {
  const r = compile(d, o);
  expect(r.ok ? [] : [JSON.stringify(r.error)]).toEqual([]);
  expect(eventIssues(r)).toEqual([]);
};
const rejects = (d: Doc, ...expected: string[]) => expect(details(compile(d))).toEqual(expected);

const field = (t: number, f: number, patch: Record<string, unknown>) =>
  edit((d) => Object.assign(d.tables[t].fields[f], patch));
const drop = (t: number, f: number, ...keys: string[]) =>
  edit((d) => {
    for (const k of keys) delete d.tables[t].fields[f][k];
  });

describe("names", () => {
  it("slot names: letters, digits and underscores, a letter first, at most 63", () => {
    accepts(edit((d) => (d.slot = `L${"a_1".repeat(20)}xy`)));
    rejects(
      edit((d) => (d.slot = `L${"a".repeat(63)}`)),
      "slot reserved_name",
    );
    rejects(
      edit((d) => (d.slot = "_ledger")),
      "slot reserved_name",
    );
    rejects(
      edit((d) => (d.slot = "1ledger")),
      "slot reserved_name",
    );
    rejects(
      edit((d) => (d.slot = "led-ger")),
      "slot reserved_name",
    );
    rejects(
      edit((d) => (d.slot = "账本")),
      "slot reserved_name",
    );
    rejects(
      edit((d) => (d.slot = "")),
      "slot reserved_name",
    );
  });

  it("slot names are unique in the tenant without ASCII case", () => {
    accepts(
      edit(() => {}),
      { existingSlotNames: ["health", "ledgers"] },
    );
    expect(
      details(
        compile(
          edit(() => {}),
          { existingSlotNames: ["Ledger"] },
        ),
      ),
    ).toEqual(["slot duplicate_name"]);
  });

  it("table names: the same syntax, unique in the slot without ASCII case", () => {
    accepts(edit((d) => (d.tables[3].name = "Settings2")));
    rejects(
      edit((d) => (d.tables[3].name = "_settings")),
      "tables/3/name reserved_name",
    );
    rejects(
      edit((d) => (d.tables[3].name = "my settings")),
      "tables/3/name reserved_name",
    );
    rejects(
      edit((d) => (d.tables[3].name = "ROOMS")),
      "tables/3/name duplicate_name",
    );
  });

  it("field names: the same syntax, unique in the table without ASCII case", () => {
    accepts(field(1, 1, { name: "Limit_2" }));
    // The same name in another table is another field.
    accepts(field(1, 1, { name: "note" }));
    rejects(field(1, 1, { name: "2limit" }), "tables/1/fields/1/name reserved_name");
    rejects(field(1, 1, { name: "NAME" }), "tables/1/fields/1/name duplicate_name");
  });

  it("reserves five field names, without ASCII case", () => {
    for (const name of [
      "valid",
      "valid_from",
      "valid_to",
      "row_id",
      "entity_id",
      "Valid_From",
      "ROW_ID",
    ]) {
      rejects(field(1, 1, { name }), "tables/1/fields/1/name reserved_name");
    }
    // Only as field names; and only these.
    accepts(edit((d) => (d.tables[3].name = "valid")));
    accepts(field(1, 1, { name: "validity" }));
  });
});

describe("descriptions", () => {
  it("are required and not empty, on tables and fields", () => {
    rejects(
      edit((d) => delete d.tables[2].description),
      "tables/2/description description_missing",
    );
    rejects(
      edit((d) => (d.tables[2].description = "")),
      "tables/2/description description_missing",
    );
    rejects(drop(2, 0, "description"), "tables/2/fields/0/description description_missing");
    rejects(field(2, 0, { description: "" }), "tables/2/fields/0/description description_missing");
    // White space only is no description.
    rejects(
      field(2, 0, { description: " \t\n\u3000" }),
      "tables/2/fields/0/description description_missing",
    );
    rejects(
      edit((d) => (d.tables[2].description = "  ")),
      "tables/2/description description_missing",
    );
    accepts(field(2, 0, { description: " who " }));
  });

  it("are at most 500 code points", () => {
    accepts(field(2, 0, { description: "𝄞".repeat(500) }));
    rejects(
      field(2, 0, { description: "a".repeat(501) }),
      "tables/2/fields/0/description out_of_bounds",
    );
    rejects(
      edit((d) => (d.tables[2].description = "说".repeat(501))),
      "tables/2/description out_of_bounds",
    );
  });

  it("must not carry the surfaces' boundary markers", () => {
    accepts(field(2, 0, { description: "untrusted-data is a phrase" }));
    rejects(
      field(2, 0, { description: "who <untrusted-data-1a2b>" }),
      "tables/2/fields/0/description untrusted_marker",
    );
    rejects(
      edit((d) => (d.tables[2].description = "x</untrusted-data-1a2b>")),
      "tables/2/description untrusted_marker",
    );
  });
});

describe("time zone", () => {
  // Provisional: what the runtime's Intl.DateTimeFormat accepts, kept as written.
  it.each([
    "Asia/Shanghai",
    "UTC",
    "Asia/Kolkata",
    "Asia/Calcutta",
    "asia/shanghai",
    "Etc/GMT+8",
    "America/Argentina/Buenos_Aires",
  ])("accepts %s and keeps it as written", (tz) => {
    const d = edit((x) => (x.timezone = tz));
    accepts(d);
    const r = compile(d);
    expect(r.ok && r.compiled.timezone).toBe(tz);
  });
  // Offsets and short names without a `/` are not IANA names, even when the runtime takes them.
  it.each([
    "Mars/Olympus",
    "",
    "Asia/Shanghai ",
    "+08:00",
    "CST",
    "GMT",
    "EST",
    "utc",
    "Etc/UTC/",
    "/UTC",
  ])("refuses %j", (tz) => {
    rejects(
      edit((d) => (d.timezone = tz)),
      "timezone timezone_unknown",
    );
  });
});

describe("field types and their keys", () => {
  it("knows nine types", () => {
    rejects(field(2, 0, { type: "string" }), "tables/2/fields/0/type unknown_type");
    rejects(field(2, 0, { type: "Text" }), "tables/2/fields/0/type unknown_type");
    // The keys of an unknown type are not judged.
    rejects(field(2, 0, { type: "json", min: 0 }), "tables/2/fields/0/type unknown_type");
    // Names of built-in object properties are unknown types too.
    for (const type of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      rejects(field(2, 0, { type }), "tables/2/fields/0/type unknown_type");
    }
  });

  it.each([
    ["min", 0, "text"],
    ["max", 1, "boolean"],
    ["values", ["a"], "text"],
    ["unit", "km", "decimal"],
    ["scale", 2, "integer"],
    ["rounding", "half_up", "integer"],
    ["ref", { table: "rooms", target: "entity" }, "text"],
  ])("takes %s only on its types", (key, value, type) => {
    rejects(field(2, 0, { type, [key]: value }), `tables/2/fields/0/${key} key_not_applicable`);
  });

  it("integer bounds are 64-bit integers", () => {
    accepts(field(1, 1, { min: "-9223372036854775808", max: "9223372036854775807" }));
    rejects(field(1, 1, { min: "-9223372036854775809" }), "tables/1/fields/1/min out_of_bounds");
    rejects(field(1, 1, { max: "9223372036854775808" }), "tables/1/fields/1/max out_of_bounds");
    rejects(field(1, 1, { max: "1.5" }), "tables/1/fields/1/max out_of_bounds");
    // Out of range and above max: one finding on each, not a second one on max.
    rejects(
      field(1, 1, { min: "9223372036854775809", max: "9223372036854775808" }),
      "tables/1/fields/1/min out_of_bounds",
      "tables/1/fields/1/max out_of_bounds",
    );
  });

  it("decimal and quantity bounds have at most 18 integer digits", () => {
    accepts(field(0, 5, { min: "-999999999999999999.5", max: "999999999999999999.999" }));
    rejects(field(0, 5, { max: "1000000000000000000" }), "tables/0/fields/5/max out_of_bounds");
    rejects(field(0, 2, { min: "-1000000000000000000.1" }), "tables/0/fields/2/min out_of_bounds");
  });

  it("min is not above max", () => {
    accepts(field(0, 5, { min: "1.5", max: "1.50" }));
    accepts(field(0, 5, { min: "-2", max: "-1.99" }));
    rejects(field(0, 5, { min: "1.51", max: "1.5" }), "tables/0/fields/5/max out_of_bounds");
    rejects(field(1, 1, { min: 10, max: 9 }), "tables/1/fields/1/max out_of_bounds");
    rejects(field(0, 5, { min: "-1", max: "-1.5" }), "tables/0/fields/5/max out_of_bounds");
  });

  it("takes more decimal places in bounds than the scale", () => {
    accepts(field(0, 5, { scale: 0, min: "0.125" }));
  });

  it("scale is 0 to 12", () => {
    accepts(field(0, 5, { scale: 0 }));
    accepts(field(0, 2, { scale: 12 }));
    rejects(field(0, 5, { scale: 13 }), "tables/0/fields/5/scale out_of_bounds");
    rejects(field(0, 2, { scale: -1 }), "tables/0/fields/2/scale out_of_bounds");
  });

  it("enum values: 1 to 200, each 1 to 64 code points, case-sensitive, no repeats", () => {
    accepts(field(0, 1, { values: Array.from({ length: 200 }, (_, i) => `v${i}`) }));
    accepts(field(0, 1, { values: ["Food", "food", "说".repeat(64), "𝄞".repeat(64)] }));
    rejects(field(0, 1, { values: [] }), "tables/0/fields/1/values out_of_bounds");
    rejects(
      field(0, 1, { values: Array.from({ length: 201 }, (_, i) => `v${i}`) }),
      "tables/0/fields/1/values out_of_bounds",
    );
    rejects(field(0, 1, { values: ["a", ""] }), "tables/0/fields/1/values/1 out_of_bounds");
    rejects(field(0, 1, { values: ["a".repeat(65)] }), "tables/0/fields/1/values/0 out_of_bounds");
    rejects(field(0, 1, { values: ["a", "b", "a"] }), "tables/0/fields/1/values/2 duplicate_entry");
  });

  it("quantity units come from units@1, case-sensitive", () => {
    for (const unit of ["km", "/min", "%", "1", "Cel", "floz", "ug", "XAF", "CHE"])
      accepts(field(0, 2, { unit }));
    const unknown = (unit: string) => {
      const e = errorOf(compile(field(0, 2, { unit })));
      return e.code === "validation_failed" ? e.details : e;
    };
    expect(unknown("KM")).toEqual([
      { path: "tables/0/fields/2/unit", code: "unit_unknown", allowed_units: ["km"] },
    ]);
    expect(unknown("公里")).toEqual([
      { path: "tables/0/fields/2/unit", code: "unit_unknown", allowed_units: ["km"] },
    ]);
    // "cup" would suggest CUP (Cuban peso) by case; a plural is not read as a currency's code.
    expect(unknown("cups")).toEqual([
      { path: "tables/0/fields/2/unit", code: "unit_unknown", allowed_units: [] },
    ]);
    // A plural and a full spelling.
    expect(unknown("kcals")).toEqual([
      { path: "tables/0/fields/2/unit", code: "unit_unknown", allowed_units: ["kcal"] },
    ]);
    expect(unknown("kilometers")).toEqual([
      { path: "tables/0/fields/2/unit", code: "unit_unknown", allowed_units: ["km"] },
    ]);
    // Months and years are not units; codes without a minor unit are left out.
    for (const unit of ["mo", "XAU", "XDR", "XXX", "dL"]) {
      expect(unknown(unit)).toMatchObject([{ code: "unit_unknown" }]);
    }
  });
});

describe("refs", () => {
  it("name a table of this slot", () => {
    rejects(
      field(0, 8, { ref: { table: "acounts", target: "entity" } }),
      "tables/0/fields/8/ref/table unknown_reference",
    );
    rejects(
      field(0, 8, { ref: { table: "health.accounts", target: "entity" } }),
      "tables/0/fields/8/ref/table cross_slot_ref",
    );
    rejects(
      field(0, 8, { ref: { table: "ledger.acounts", target: "entity" } }),
      "tables/0/fields/8/ref/table unknown_reference",
    );
  });

  it("point at a row of an event or timeless table, an entity of a state table", () => {
    accepts(field(0, 8, { ref: { table: "settings", target: "row" } }));
    accepts(field(0, 8, { ref: { table: "expenses", target: "row" } }));
    accepts(field(0, 8, { ref: { table: "rooms", target: "entity" } }));
    rejects(
      field(0, 8, { ref: { table: "accounts", target: "row" } }),
      "tables/0/fields/8/ref/target key_not_applicable",
    );
    rejects(
      field(0, 8, { ref: { table: "settings", target: "entity" } }),
      "tables/0/fields/8/ref/target key_not_applicable",
    );
    rejects(
      field(0, 8, { ref: { table: "expenses", target: "entity" } }),
      "tables/0/fields/8/ref/target key_not_applicable",
    );
  });
});

describe("tables", () => {
  it("have at least one field", () => {
    rejects(
      edit((d) => (d.tables[2].fields = [])),
      "tables/2/fields out_of_bounds",
    );
  });

  it("the event time is a required date or zoned date-time field of the table", () => {
    accepts(
      edit((d) => {
        d.tables[0].time.field = "at";
        d.tables[0].fields[7].required = true;
      }),
    );
    rejects(
      edit((d) => (d.tables[0].time.field = "day")),
      "tables/0/time/field unknown_reference",
    );
    // Of another type and not required: one finding for each.
    rejects(
      edit((d) => (d.tables[0].time.field = "note")),
      "tables/0/time/field key_not_applicable",
      "tables/0/time/field key_not_applicable",
    );
    rejects(
      edit((d) => (d.tables[0].time.field = "at")),
      "tables/0/time/field key_not_applicable",
    );
    rejects(field(0, 0, { required: false }), "tables/0/time/field key_not_applicable");
  });

  it("entity_key: on state tables, not empty, required fields of the table, each once", () => {
    accepts(
      edit((d) => {
        d.tables[1].fields[1].required = true;
        d.tables[1].entity_key = ["name", "limit"];
      }),
    );
    rejects(
      edit((d) => (d.tables[3].entity_key = ["key"])),
      "tables/3/entity_key key_not_applicable",
    );
    rejects(
      edit((d) => (d.tables[0].entity_key = ["date"])),
      "tables/0/entity_key key_not_applicable",
    );
    rejects(
      edit((d) => (d.tables[1].entity_key = [])),
      "tables/1/entity_key out_of_bounds",
    );
    rejects(
      edit((d) => (d.tables[1].entity_key = ["title"])),
      "tables/1/entity_key/0 unknown_reference",
    );
    rejects(
      edit((d) => (d.tables[1].entity_key = ["limit"])),
      "tables/1/entity_key/0 entity_key_not_required",
    );
    rejects(
      edit((d) => (d.tables[1].entity_key = ["name", "Name"])),
      "tables/1/entity_key/1 duplicate_entry",
    );
  });

  it("external_key: on event and timeless tables, 1 to 4 text, enum or integer fields, each once", () => {
    // Without the conflict group, so that `category` (an enum) can be a key field.
    const keyed = (keys: string[], t = 0, more: (d: Doc) => void = () => {}) =>
      edit((d) => {
        delete d.tables[0].together;
        d.tables[t].external_key = keys;
        more(d);
      });
    const x1 = (d: Doc) => d.tables[0].fields.push({ name: "x1", type: "text", description: "x" });
    accepts(keyed(["note", "category", "pieces"]));
    accepts(keyed(["note", "category", "pieces", "x1"], 0, x1));
    accepts(keyed(["key"], 3));
    rejects(keyed(["name"], 1), "tables/1/external_key external_key_table_kind");
    rejects(keyed(["guest"], 2), "tables/2/external_key external_key_table_kind");
    rejects(keyed([]), "tables/0/external_key out_of_bounds");
    rejects(
      keyed(["note", "category", "pieces", "x1", "date"], 0, x1),
      "tables/0/external_key out_of_bounds",
      "tables/0/external_key/4 external_key_field_type",
    );
    rejects(keyed(["origin"]), "tables/0/external_key/0 unknown_reference");
    rejects(keyed(["note", "NOTE"]), "tables/0/external_key/1 duplicate_entry");
    for (const name of ["date", "amount", "rate", "paid", "at", "account"]) {
      rejects(keyed([name]), "tables/0/external_key/0 external_key_field_type");
    }
  });

  it("external_key fields are not in together", () => {
    rejects(
      edit((d) => (d.tables[0].external_key = ["note", "category"])),
      "tables/0/external_key/1 external_key_in_together",
    );
    accepts(edit((d) => (d.tables[0].external_key = ["note", "pieces"])));
    // Names compare without ASCII case, as declared and as listed.
    rejects(
      edit((d) => {
        d.tables[0].fields[3].name = "Note";
        d.tables[0].together = [["NOTE", "pieces"]];
        d.tables[0].external_key = ["note"];
      }),
      "tables/0/external_key/0 external_key_in_together",
    );
  });

  it("together: groups of two fields or more of the table, a field in at most one group", () => {
    accepts(
      edit(
        (d) =>
          (d.tables[0].together = [
            ["category", "amount"],
            ["note", "pieces", "rate"],
          ]),
      ),
    );
    rejects(
      edit((d) => (d.tables[0].together = [["note"]])),
      "tables/0/together/0 out_of_bounds",
    );
    rejects(
      edit((d) => (d.tables[0].together = [[]])),
      "tables/0/together/0 out_of_bounds",
    );
    rejects(
      edit((d) => (d.tables[0].together = [["note", "nope"]])),
      "tables/0/together/0/1 unknown_reference",
    );
    rejects(
      edit((d) => (d.tables[0].together = [["note", "note", "rate"]])),
      "tables/0/together/0/1 duplicate_entry",
    );
    rejects(
      edit(
        (d) =>
          (d.tables[0].together = [
            ["category", "amount"],
            ["note", "Amount"],
          ]),
      ),
      "tables/0/together/1/1 duplicate_entry",
    );
  });

  it("duplicate_keys: on event and timeless tables, non-empty groups of fields of the table", () => {
    accepts(edit((d) => (d.tables[3].duplicate_keys = [["key"], ["KEY"]])));
    rejects(
      edit((d) => (d.tables[1].duplicate_keys = [["name"]])),
      "tables/1/duplicate_keys key_not_applicable",
    );
    rejects(
      edit((d) => (d.tables[0].duplicate_keys = [[]])),
      "tables/0/duplicate_keys/0 out_of_bounds",
    );
    rejects(
      edit((d) => (d.tables[0].duplicate_keys = [["date", "day"]])),
      "tables/0/duplicate_keys/0/1 unknown_reference",
    );
    rejects(
      edit((d) => (d.tables[0].duplicate_keys = [["date", "date"]])),
      "tables/0/duplicate_keys/0/1 duplicate_entry",
    );
  });
});

describe("findings", () => {
  it("are all reported, in document order", () => {
    rejects(
      edit((d) => {
        d.slot = "_ledger";
        d.timezone = "Nowhere/City";
        d.tables[0].fields[1].values = ["a", "a"];
        d.tables[0].time.field = "note";
        d.tables[1].name = "Expenses";
        d.tables[1].entity_key = ["limit"];
        d.tables[3].fields[0].type = "json";
      }),
      "slot reserved_name",
      "timezone timezone_unknown",
      "tables/0/fields/1/values/1 duplicate_entry",
      // The ref to `accounts` no longer finds it.
      "tables/0/fields/8/ref/table unknown_reference",
      "tables/0/time/field key_not_applicable",
      "tables/0/time/field key_not_applicable",
      "tables/1/name duplicate_name",
      "tables/1/entity_key/0 entity_key_not_required",
      "tables/3/fields/0/type unknown_type",
    );
  });
});

describe("how large a slot may be (08-open-questions «接口的数值与细则»)", () => {
  const errorDetails = (r: ReturnType<typeof compile>) =>
    (
      errorOf(r) as unknown as {
        details: { path: string; code: string; min?: string; max?: string }[];
      }
    ).details;
  /** A base table without time, references or keys. */
  const plain = (name: string) => ({
    name,
    kind: "base",
    description: "a table",
    time: { type: "none" },
    fields: [{ name: "note", type: "text", description: "a note" }],
  });
  /** The document with `n` tables: its own, then plain ones; or `n` plain ones when fewer. */
  const tables = (n: number) =>
    edit((d) => {
      const own = d.tables.length <= n ? d.tables : [];
      d.tables = [
        ...own,
        ...Array.from({ length: n - own.length }, (_, i) => plain(`t${i}`)),
      ] as typeof d.tables;
    });
  /** The document with `n` fields in its first table: its own, then optional texts. */
  const fields = (n: number) =>
    edit((d) => {
      const own = d.tables[0].fields;
      const more = Array.from({ length: n - own.length }, (_, i) => ({
        name: `f${i}`,
        type: "text",
        description: "a field",
      }));
      d.tables[0].fields = [...own, ...more];
    });

  it("at most 100 tables in a slot: 100 compile, 101 do not, said with the bound", () => {
    accepts(tables(100));
    expect(errorDetails(compile(tables(101)))).toEqual([
      { path: "tables", code: "out_of_bounds", max: "100" },
    ]);
  });

  it("at most 200 fields in a table: 200 compile, 201 do not, said with the bound", () => {
    accepts(fields(200));
    expect(errorDetails(compile(fields(201)))).toEqual([
      { path: "tables/0/fields", code: "out_of_bounds", max: "200" },
    ]);
  });

  it("at most 100 slots in a tenant: the 100th compiles, the 101st does not", () => {
    const names = (n: number) => Array.from({ length: n }, (_, i) => `s${i}`);
    accepts(
      edit(() => {}),
      { existingSlotNames: names(99) },
    );
    expect(
      errorDetails(
        compile(
          edit(() => {}),
          { existingSlotNames: names(100) },
        ),
      ),
    ).toEqual([{ path: "slot", code: "out_of_bounds", max: "100" }]);
  });

  it("at least one field in a table, said with the bound as the others are", () => {
    expect(errorDetails(compile(edit((d) => (d.tables[0].fields = []))))).toContainEqual({
      path: "tables/0/fields",
      code: "out_of_bounds",
      min: "1",
    });
  });

  it("at least one base table: one compiles, none does not", () => {
    accepts(tables(1));
    expect(errorDetails(compile(edit((d) => (d.tables = []))))).toEqual([
      { path: "tables", code: "out_of_bounds", min: "1" },
    ]);
  });
});

describe("what a detail says besides its code (04-contract «schema_draft»)", () => {
  /** The whole details of a document that does not compile. */
  const full = (d: Doc) => {
    const e = errorOf(compile(d));
    if (e.code !== "validation_failed") throw new Error(JSON.stringify(e));
    return e.details;
  };
  const DEC = `${"9".repeat(18)}.${"9".repeat(12)}`;
  const INT = { min: "-9223372036854775808", max: "9223372036854775807" };
  const oob = (path: string, bounds: { min?: string; max?: string }) => [
    { path, code: "out_of_bounds", ...bounds },
  ];

  it("out_of_bounds gives the bounds that apply to the value at its path", () => {
    expect(full(edit((d) => (d.tables[0].description = "x".repeat(501))))).toEqual(
      oob("tables/0/description", { max: "500" }),
    );
    // A type's range: both ends, whichever end was passed.
    expect(full(field(1, 1, { min: "-9223372036854775809" }))).toEqual(
      oob("tables/1/fields/1/min", INT),
    );
    expect(full(field(1, 1, { max: "9223372036854775808" }))).toEqual(
      oob("tables/1/fields/1/max", INT),
    );
    expect(full(field(0, 5, { max: "1000000000000000000" }))).toEqual(
      oob("tables/0/fields/5/max", { min: `-${DEC}`, max: DEC }),
    );
    expect(full(field(0, 2, { min: "-1000000000000000000.1" }))).toEqual(
      oob("tables/0/fields/2/min", { min: `-${DEC}`, max: DEC }),
    );
    // A max smaller than the min: on the max, the min given (canonical) as its lower bound.
    expect(full(field(0, 5, { min: "1.510", max: "1.5" }))).toEqual(
      oob("tables/0/fields/5/max", { min: "1.51" }),
    );
    expect(full(field(0, 5, { scale: 13 }))).toEqual(
      oob("tables/0/fields/5/scale", { min: "0", max: "12" }),
    );
    expect(full(field(0, 1, { values: [] }))).toEqual(
      oob("tables/0/fields/1/values", { min: "1", max: "200" }),
    );
    expect(full(field(0, 1, { values: Array.from({ length: 201 }, (_, i) => `v${i}`) }))).toEqual(
      oob("tables/0/fields/1/values", { min: "1", max: "200" }),
    );
    expect(full(field(0, 1, { values: ["a", ""] }))).toEqual(
      oob("tables/0/fields/1/values/1", { min: "1", max: "64" }),
    );
    expect(full(field(0, 1, { values: ["a".repeat(65)] }))).toEqual(
      oob("tables/0/fields/1/values/0", { min: "1", max: "64" }),
    );
    expect(full(edit((d) => (d.tables[1].entity_key = [])))).toEqual(
      oob("tables/1/entity_key", { min: "1" }),
    );
    const keyed = (keys: string[]) =>
      edit((d) => {
        delete d.tables[0].together;
        d.tables[0].external_key = keys;
      });
    expect(full(keyed([]))).toEqual(oob("tables/0/external_key", { min: "1", max: "4" }));
    expect(full(keyed(["note", "category", "pieces", "note2", "paid"]))).toEqual([
      ...oob("tables/0/external_key", { min: "1", max: "4" }),
      { path: "tables/0/external_key/3", code: "unknown_reference" },
      { path: "tables/0/external_key/4", code: "external_key_field_type" },
    ]);
    expect(full(edit((d) => (d.tables[0].together = [["note"]])))).toEqual(
      oob("tables/0/together/0", { min: "2" }),
    );
    expect(full(edit((d) => (d.tables[0].duplicate_keys = [[]])))).toEqual(
      oob("tables/0/duplicate_keys/0", { min: "1" }),
    );
  });

  it("unknown_type gives every field type", () => {
    expect(full(field(0, 3, { type: "string" }))).toEqual([
      {
        path: "tables/0/fields/3/type",
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
  });

  it("the event time's field: the types it may have, or that it is not required, or both", () => {
    const types = {
      path: "tables/0/time/field",
      code: "key_not_applicable",
      allowed_values: ["date", "zoned_datetime"],
    };
    const required = {
      path: "tables/0/time/field",
      code: "key_not_applicable",
      reason: "not_required",
    };
    const time = (name: string, more: (d: Doc) => void = () => {}) =>
      edit((d) => {
        d.tables[0].time.field = name;
        more(d);
      });
    expect(full(time("pieces", (d) => (d.tables[0].fields[4].required = true)))).toEqual([types]);
    expect(full(time("at"))).toEqual([required]);
    expect(full(time("note"))).toEqual([types, required]);
  });
});
