// compileChange: a draft that changes an existing slot — the matching of tables and fields, the
// changes it classifies and their policy class, the definition of the next version, the errors and
// their order (03-data-model/07-schema-evolution.md «schema 文档格式», «改动分类与迁移手段»;
// 04-contract «schema_draft»). Fictional names, the ledger of ./documents.fixture.ts as version 1.

import type { ChangeTarget, CompiledSchema } from "@fluxvita/saveslot-contract-core";
import { parseEvent } from "@fluxvita/saveslot-contract-core";
import { beforeAll, describe, expect, it } from "vitest";
import { loadRsql } from "../rules/index.ts";
import { compileChange } from "./compile-change.ts";
import { compile, type Doc, ledger, SLOT_ID } from "./documents.fixture.ts";
import { filledDocument } from "./fill.ts";
import type { CompileChangeInput, CompileChangeResult } from "./model.ts";
import { DEFAULT_SLOT_POLICY } from "./policy.ts";

const v1 = (): CompiledSchema => {
  const r = compile(ledger());
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.compiled;
};

/** The draft a caller reads back from the catalog: ids filled, `base_version` 1. */
const filled = (src: Doc, c: CompiledSchema): Doc => filledDocument(src, c);
const base = (): Doc => filled(ledger(), v1());

/** Only the tables of the draft that `names` lists: the draft lists what it changes. */
function listing(names: string[], f: (d: Doc) => void = () => {}): Doc {
  const d = structuredClone(base());
  d.tables = d.tables.filter((t: Doc) => names.includes(t.name));
  f(d);
  return d;
}

const run = (
  document: unknown,
  o: Partial<Omit<CompileChangeInput, "document">> = {},
): CompileChangeResult =>
  compileChange({
    document,
    current: v1(),
    existingSlotNames: ["ledger", "other"],
    nextTableNumber: 7,
    autoApply: DEFAULT_SLOT_POLICY.auto_apply,
    unused: () => false,
    ...o,
  });

const ok = (r: CompileChangeResult) => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r;
};
const err = (r: CompileChangeResult) => {
  if (r.ok) throw new Error("compiled");
  return r.error;
};
const detailsOf = (r: CompileChangeResult) => {
  const e = err(r);
  if (e.code !== "validation_failed") throw new Error(JSON.stringify(e));
  return e.details.map((d) => `${d.path} ${d.code}`);
};
const codes = (r: CompileChangeResult) => ok(r).changes.map((c) => c.change);
const table = (r: CompileChangeResult, name: string) =>
  ok(r).compiled.tables.find((t) => t.name === name);

describe("an unchanged draft", () => {
  it("is version 2 with no changes, and every kept table says which version built it", () => {
    const r = ok(run(listing([])));
    expect(r.changes).toEqual([]);
    expect(r.outcome).toBe("applied");
    expect(r.targetVersion).toBe(2);
    expect(r.compiled.sv).toBe(2);
    expect(r.compiled.tables.map((t) => t.physical)).toEqual(
      v1().tables.map((t) => ({ table: t.physical.table, since: 1 })),
    );
    // Nothing but `sv` and `since` differs from version 1.
    expect({
      ...r.compiled,
      sv: 1,
      tables: r.compiled.tables.map((t) => ({ ...t, physical: { table: t.physical.table } })),
    }).toEqual(v1());
  });

  it("lists every table whole and still changes nothing", () => {
    const r = ok(run(base()));
    expect(r.changes).toEqual([]);
  });

  it("keeps `since` of a table built in an earlier version", () => {
    const second = ok(run(listing([])));
    const d = filled(ledger(), second.compiled);
    d.tables = [];
    const third = ok(run(d, { current: second.compiled }));
    expect(third.targetVersion).toBe(3);
    expect(third.compiled.tables.every((t) => t.physical.since === 1)).toBe(true);
  });
});

describe("changes that touch the catalog only", () => {
  it("renames the slot: confirmed, never automatic", () => {
    const r = ok(run(listing([], (d) => (d.rename_to = "books"))));
    expect(r.compiled.name).toBe("books");
    expect(r.changes).toEqual([
      {
        target: { slot: true },
        change: "rename_slot",
        class: "metadata",
        compatible_with_old_writes: true,
        destructive: false,
        auto: false,
      },
    ]);
    expect(r.outcome).toBe("pending");
  });

  it("renames a table and a field by ID; automatic only where nobody else uses them", () => {
    const d = listing(["expenses"], (x) => {
      x.tables[0].name = "spending";
      x.tables[0].fields[3].name = "memo";
    });
    const r = ok(run(d));
    expect(codes(r)).toEqual(["rename_table", "rename_field"]);
    expect(r.changes.map((c) => c.auto)).toEqual([false, false]);
    expect(r.outcome).toBe("pending");
    expect(table(r, "spending")?.fields[3]?.name).toBe("memo");
    expect(table(r, "spending")?.id).toBe("t1");
    expect(table(r, "spending")?.fields[3]?.id).toBe("f4");

    const seen: ChangeTarget[] = [];
    const unused = ok(
      run(d, {
        unused: (t) => {
          seen.push(t);
          return true;
        },
      }),
    );
    expect(unused.changes.map((c) => c.auto)).toEqual([true, true]);
    expect(unused.outcome).toBe("applied");
    expect(seen).toEqual([{ table: "t1" }, { table: "t1", field: "f4" }]);
    // The policy decides: a slot without `rename_unused` confirms either way.
    const policy = ok(run(d, { unused: () => true, autoApply: ["description"] }));
    expect(policy.changes.map((c) => c.auto)).toEqual([false, false]);
  });

  it("matches a field by name without ASCII case when no ID is written", () => {
    const d = listing(["expenses"], (x) => {
      for (const f of x.tables[0].fields) delete f.id;
      delete x.tables[0].id;
      x.tables[0].name = "EXPENSES";
      x.tables[0].fields[3].name = "NOTE";
    });
    const r = ok(run(d));
    // The names are written differently only in case: a rename, both.
    expect(codes(r)).toEqual(["rename_table", "rename_field"]);
    expect(table(r, "EXPENSES")?.id).toBe("t1");
  });

  it("changes a description and aliases: automatic under the default policy", () => {
    const r = ok(
      run(
        listing(["expenses"], (d) => {
          d.tables[0].description = "every expense";
          d.tables[0].aliases = ["spending"];
          d.tables[0].fields[3].description = "text";
          d.tables[0].fields[3].aliases = ["memo"];
        }),
      ),
    );
    expect(codes(r)).toEqual([
      "change_description",
      "change_aliases",
      "change_description",
      "change_aliases",
    ]);
    expect(r.changes.every((c) => c.auto && c.class === "metadata")).toBe(true);
    expect(r.outcome).toBe("applied");
    expect(table(r, "expenses")).toMatchObject({
      description: "every expense",
      aliases: ["spending"],
    });
    expect(table(r, "expenses")?.fields[3]).toMatchObject({ aliases: ["memo"] });
  });

  it("removes aliases", () => {
    const first = ok(run(listing(["expenses"], (d) => (d.tables[0].aliases = ["spending"]))));
    const d = filled(ledger(), first.compiled);
    d.tables = d.tables.filter((t: Doc) => t.name === "expenses");
    d.tables[0].aliases = [];
    const r = ok(run(d, { current: first.compiled }));
    expect(codes(r)).toEqual(["change_aliases"]);
    expect(table(r, "expenses")).not.toHaveProperty("aliases");
  });

  it("changes duplicate_keys: automatic; together: confirmed", () => {
    const r = ok(
      run(
        listing(["expenses"], (d) => {
          d.tables[0].duplicate_keys = [["date", "amount"]];
          d.tables[0].together = [["category", "amount", "note"]];
        }),
      ),
    );
    expect(r.changes.map((c) => [c.change, c.auto])).toEqual([
      ["change_duplicate_keys", true],
      ["change_together", false],
    ]);
    expect(table(r, "expenses")).toMatchObject({
      duplicate_keys: [["f1", "f3"]],
      together: [["f2", "f3", "f4"]],
    });
  });

  it("takes the order of groups and of fields in a group as no change", () => {
    const r = ok(
      run(
        listing(["expenses"], (d) => {
          d.tables[0].together = [["amount", "category"]];
          d.tables[0].duplicate_keys = [["category", "date", "amount"]];
        }),
      ),
    );
    expect(r.changes).toEqual([]);
  });

  it("drops a duplicate_keys or together that the draft no longer writes", () => {
    const r = ok(
      run(
        listing(["expenses"], (d) => {
          delete d.tables[0].together;
          delete d.tables[0].duplicate_keys;
        }),
      ),
    );
    expect(codes(r)).toEqual(["change_duplicate_keys", "change_together"]);
    expect(table(r, "expenses")).not.toHaveProperty("together");
    expect(table(r, "expenses")).not.toHaveProperty("duplicate_keys");
  });

  it("loosens constraints: required to optional, a bound, enum values, scale — one change per field", () => {
    const r = ok(
      run(
        listing(["expenses"], (d) => {
          const f = d.tables[0].fields;
          f[2].required = false; // amount
          delete f[2].min;
          f[1].values = ["food", "rent", "fun"]; // category
          f[5].scale = 6; // rate, was 4
        }),
      ),
    );
    expect(
      r.changes.map((c) => [c.change, "field" in c.target ? c.target.field : "", c.auto]),
    ).toEqual([
      ["loosen_constraint", "f2", true],
      ["loosen_constraint", "f3", true],
      ["loosen_constraint", "f6", true],
    ]);
    const t = table(r, "expenses");
    expect(t?.fields[2]).not.toHaveProperty("required");
    expect(t?.fields[2]).not.toHaveProperty("min");
    expect(t?.fields[1]).toMatchObject({ values: ["food", "rent", "fun"] });
    expect(t?.fields[5]).toMatchObject({ precision: { scale: 6, rounding: "half_even" } });
    expect(r.outcome).toBe("applied");
  });

  it("loosens a bound the other way: a larger max, a smaller min; tightens either, not compiled yet", () => {
    const d = ledger();
    d.tables[0].fields[2].min = 10;
    d.tables[0].fields[2].max = 100;
    const start = compile(d);
    if (!start.ok) throw new Error("not compiled");
    const draft = (f: (x: Doc) => void) => {
      const x = filled(d, start.compiled);
      x.tables = x.tables.filter((t: Doc) => t.name === "expenses");
      f(x.tables[0].fields[2]);
      return run(x, { current: start.compiled });
    };
    const loosened = ok(
      draft((f) => {
        f.min = 5;
        f.max = 200;
      }),
    );
    expect(codes(loosened)).toEqual(["loosen_constraint"]);
    expect(table(loosened, "expenses")?.fields[2]).toMatchObject({ min: "5", max: "200" });
    expect(codes(draft((f) => (f.min = 5)))).toEqual(["loosen_constraint"]);
    // One bound looser and the other tighter is a tightening.
    expect(
      err(
        draft((f) => {
          f.min = 5;
          f.max = 50;
        }),
      ).code,
    ).toBe("not_implemented");
    expect(err(draft((f) => (f.max = 50))).code).toBe("not_implemented");
  });

  it("takes an enum's values only reordered as a loosening: automatic", () => {
    const r = ok(
      run(listing(["expenses"], (d) => (d.tables[0].fields[1].values = ["rent", "food"]))),
    );
    expect(r.changes.map((c) => [c.change, c.auto])).toEqual([["loosen_constraint", true]]);
    expect(table(r, "expenses")?.fields[1]).toMatchObject({ values: ["rent", "food"] });
    // Values added and reordered in one draft is one change too.
    const both = ok(
      run(listing(["expenses"], (d) => (d.tables[0].fields[1].values = ["rent", "fun", "food"]))),
    );
    expect(codes(both)).toEqual(["loosen_constraint"]);
  });

  it("drops a table: confirmed, destructive, no old write accepted", () => {
    const r = ok(run(listing([], (d) => (d.drop_tables = ["settings"]))));
    expect(r.changes).toEqual([
      {
        target: { table: "t4" },
        change: "drop_table",
        class: "metadata",
        compatible_with_old_writes: false,
        destructive: true,
        auto: false,
      },
    ]);
    expect(r.compiled.tables.map((t) => t.name)).toEqual(["expenses", "accounts", "rooms"]);
    expect(r.outcome).toBe("pending");
  });

  it("adds a base table: numbered from the next free number, built in the next version", () => {
    const r = ok(
      run(
        listing([], (d) => {
          d.tables.push({
            name: "budgets",
            kind: "base",
            description: "a budget",
            time: { type: "none" },
            fields: [{ name: "label", type: "text", description: "what for" }],
          });
        }),
      ),
    );
    expect(r.changes).toEqual([
      {
        target: { table: "t7" },
        change: "add_table",
        class: "create",
        compatible_with_old_writes: true,
        destructive: false,
        auto: true,
      },
    ]);
    const t = table(r, "budgets");
    expect(t).toMatchObject({ id: "t7", physical: { table: "t_t7_v2" } });
    expect(t).not.toHaveProperty("physical.since");
    expect(t?.fields[0]?.id).toBe("f1");
    expect(r.outcome).toBe("applied");
  });

  it("adds a table that refers to a table the draft does not list", () => {
    const r = ok(
      run(
        listing([], (d) => {
          d.tables.push({
            name: "payments",
            kind: "base",
            description: "a payment",
            time: { type: "none" },
            fields: [
              {
                name: "from",
                type: "ref",
                description: "an account",
                ref: { table: "accounts", target: "entity" },
              },
            ],
          });
        }),
      ),
    );
    expect(table(r, "payments")?.fields[0]).toMatchObject({
      ref: { table: "t2", target: "entity" },
    });
  });

  it("warns of a single-field external key of a new table, at the draft's position", () => {
    const r = ok(
      run(
        listing([], (d) => {
          d.tables.push({
            name: "imports",
            kind: "base",
            description: "from outside",
            time: { type: "none" },
            fields: [{ name: "ext", type: "text", required: true, description: "its key" }],
            external_key: ["ext"],
          });
        }),
      ),
    );
    expect(r.warnings).toEqual([
      { code: "single_field_external_key", table: "imports", path: "tables/0/external_key" },
    ]);
  });

  it("is `pending` when any one change is not automatic", () => {
    const r = ok(
      run(
        listing(["expenses"], (d) => {
          d.tables[0].description = "every expense";
          d.tables[0].together = [["category", "amount", "note"]];
        }),
      ),
    );
    expect(r.outcome).toBe("pending");
  });
});

describe("the definition of the next version", () => {
  it("passes the strict parse of a schema.compiled event", () => {
    const r = ok(
      run(
        listing(["expenses"], (d) => {
          d.rename_to = "books";
          d.tables[0].aliases = ["spending"];
          d.tables[0].fields[2].required = false;
          d.tables.push({
            name: "budgets",
            kind: "base",
            description: "a budget",
            time: { type: "none" },
            fields: [{ name: "label", type: "text", description: "what for" }],
          });
        }),
      ),
    );
    const p = parseEvent(
      {
        type: "schema.compiled",
        v: 1,
        seq: 30,
        op: 29,
        at: "2026-11-10T03:00:00.000Z",
        prev_hash: "a".repeat(64),
        actor: `u_${"1".repeat(26)}`,
        slot: SLOT_ID,
      },
      {
        target: {
          draft_id: `d_${"1".repeat(16)}`,
          target_version: r.targetVersion,
          outcome: r.outcome,
        },
        compiled: r.compiled,
        changes: r.changes,
      },
    );
    expect(p.ok ? [] : p.kind === "invalid" ? p.issues : p.shapes).toEqual([]);
  });

  it("is the same twice, and changes nothing when its own result is written back", () => {
    const d = listing(["expenses"], (x) => {
      x.tables[0].description = "every expense";
      x.tables[0].fields[2].required = false;
    });
    const a = ok(run(d));
    expect(ok(run(d))).toEqual(a);
    const back = filled(ledger(), a.compiled);
    back.tables = back.tables.filter((t: Doc) => t.name === "expenses");
    back.tables[0].description = "every expense";
    back.tables[0].fields[2].required = false;
    const again = ok(run(back, { current: a.compiled }));
    expect(again.changes).toEqual([]);
  });
});

describe("what is not compiled yet is named by its change code", () => {
  const what = (r: CompileChangeResult) => {
    const e = err(r);
    if (e.code !== "not_implemented") throw new Error(JSON.stringify(e));
    return [e.what, e.param];
  };
  const on = (f: (e: Doc) => void) => run(listing(["expenses"], (d) => f(d.tables[0])));

  it.each([
    [
      "a field to add",
      (e: Doc) => e.fields.push({ name: "tip", type: "integer", description: "a tip" }),
      "add_optional_field",
      "tables/0/fields/9",
    ],
    [
      "a required field to add",
      (e: Doc) =>
        e.fields.push({ name: "tip", type: "integer", required: true, description: "a tip" }),
      "add_required_field",
      "tables/0/fields/9",
    ],
    [
      "a field to drop",
      (e: Doc) => {
        e.drop_fields = ["pieces"];
        e.fields.splice(4, 1);
      },
      "drop_field",
      "tables/0/drop_fields",
    ],
    [
      "a field made required",
      (e: Doc) => (e.fields[3].required = true),
      "tighten_constraint",
      "tables/0/fields/3/required",
    ],
    [
      "a bound raised",
      (e: Doc) => (e.fields[2].min = 5),
      "tighten_constraint",
      "tables/0/fields/2",
    ],
    ["a bound added", (e: Doc) => (e.fields[4].min = 0), "tighten_constraint", "tables/0/fields/4"],
    [
      "an enum value removed",
      (e: Doc) => (e.fields[1].values = ["food"]),
      "tighten_constraint",
      "tables/0/fields/1/values",
    ],
    [
      "a scale reduced",
      (e: Doc) => (e.fields[5].scale = 2),
      "change_precision",
      "tables/0/fields/5",
    ],
    [
      "a rounding changed",
      (e: Doc) => (e.fields[5].rounding = "half_up"),
      "change_precision",
      "tables/0/fields/5",
    ],
    ["a type changed", (e: Doc) => (e.fields[4].type = "text"), "change_type", "tables/0/fields/4"],
    [
      "a unit of the same dimension",
      (e: Doc) => (e.fields[2].unit = "USD"),
      "change_dimension",
      "tables/0/fields/2/unit",
    ],
    [
      "a ref retargeted",
      (e: Doc) => (e.fields[8].ref.table = "rooms"),
      "change_ref",
      "tables/0/fields/8/ref",
    ],
    ["the time type", (e: Doc) => (e.time = { type: "none" }), "change_time_type", "tables/0/time"],
    [
      "the time field",
      (e: Doc) => {
        e.fields[7].required = true;
        e.time = { type: "event", field: "at" };
      },
      "change_time_field",
      "tables/0/time/field",
    ],
    [
      "an external key added",
      (e: Doc) => (e.external_key = ["note"]),
      "add_external_key",
      "tables/0/external_key",
    ],
  ])("%s", (_, f, change, param) => {
    expect(what(on(f))).toEqual([change, param]);
  });

  it("tells a unit of the same dimension (change_unit) from another dimension", () => {
    const d = ledger();
    d.tables[0].fields[3] = {
      name: "distance",
      type: "quantity",
      unit: "km",
      description: "how far",
    };
    const start = compile(d);
    if (!start.ok) throw new Error("not compiled");
    const draft = (unit: string) => {
      const x = filled(d, start.compiled);
      x.tables = x.tables.filter((t: Doc) => t.name === "expenses");
      x.tables[0].fields[3].unit = unit;
      return run(x, { current: start.compiled });
    };
    expect(what(draft("mi"))).toEqual(["change_unit", "tables/0/fields/3/unit"]);
    expect(what(draft("kg"))).toEqual(["change_dimension", "tables/0/fields/3/unit"]);
  });

  it("an entity key changed, a granularity changed", () => {
    expect(
      what(
        run(
          listing(["accounts"], (d) => {
            d.tables[0].fields[1].required = true;
            d.tables[0].entity_key = ["limit"];
          }),
        ),
      ),
    ).toEqual(["change_entity_key", "tables/0/entity_key"]);
    expect(
      what(run(listing(["accounts"], (d) => (d.tables[0].time.granularity = "instant")))),
    ).toEqual(["change_granularity", "tables/0/time/granularity"]);
  });

  it("a time zone, a migrate, a backfill, a derived table", () => {
    expect(what(run(listing([], (d) => (d.timezone = "UTC"))))).toEqual([
      "change_timezone",
      "timezone",
    ]);
    expect(what(on((e) => (e.fields[4].migrate = { sql: "pieces" })))).toEqual([
      "a migrate in a change",
      "tables/0/fields/4/migrate",
    ]);
    expect(what(on((e) => (e.fields[4].backfill = { const: 0 })))).toEqual([
      "a backfill in a change",
      "tables/0/fields/4/backfill",
    ]);
    expect(
      what(
        run(
          listing([], (d) => {
            d.tables.push({
              name: "totals",
              kind: "derived",
              description: "d",
              rule: { sql: "SELECT 1", time_dependency: "none" },
              fields: [],
            });
          }),
        ),
      ),
    ).toEqual(["add_derived_table", "tables/0"]);
  });
});

describe("errors, and the order they come in", () => {
  it("field_unmatched: a current field neither matched nor dropped, never a deletion", () => {
    const e = err(run(listing(["expenses"], (d) => d.tables[0].fields.splice(3, 2))));
    expect(e).toEqual({
      code: "field_unmatched",
      fields: [
        { table: "expenses", id: "f4", name: "note" },
        { table: "expenses", id: "f5", name: "pieces" },
      ],
    });
  });

  it("draft_outdated: base_version is not the current version", () => {
    expect(err(run(listing([], (d) => (d.base_version = 2))))).toEqual({
      code: "draft_outdated",
      reason: "base_version",
      current_sv: 1,
    });
    // Outdated is told first, whatever else is wrong with the draft.
    for (const f of [
      (d: Doc) => (d.extends = "official"),
      (d: Doc) => (d.tables = "x"),
      (d: Doc) => d.tables.push({ name: "t", kind: "derived" }),
      (d: Doc) => (d.timezone = "UTC"),
    ])
      expect(
        err(
          run(
            listing([], (d) => {
              d.base_version = 9;
              f(d);
            }),
          ),
        ),
      ).toEqual({ code: "draft_outdated", reason: "base_version", current_sv: 1 });
    expect(err(run(listing([], (d) => (d.base_version = 0))))).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "base_version",
    });
    expect(err(run(listing([], (d) => delete d.base_version)))).toEqual({
      code: "invalid_argument",
      reason: "missing",
      param: "base_version",
    });
  });

  it("not_in_this_version: extends and compatibility come right after the version", () => {
    expect(err(run(listing([], (d) => (d.extends = "official"))))).toEqual({
      code: "not_in_this_version",
      param: "extends",
    });
    expect(
      err(
        run(
          listing(["expenses"], (d) => {
            d.tables[0].compatibility = "full";
            d.tables[0].fields = "x";
          }),
        ),
      ),
    ).toEqual({ code: "not_in_this_version", param: "tables/0/compatibility" });
  });

  it("an ID of nothing is malformed, a name of nothing is a new table", () => {
    expect(err(run(listing(["expenses"], (d) => (d.tables[0].id = "t99"))))).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "tables/0/id",
    });
    expect(err(run(listing(["expenses"], (d) => (d.tables[0].fields[0].id = "f99"))))).toEqual({
      code: "invalid_argument",
      reason: "malformed",
      param: "tables/0/fields/0/id",
    });
    expect(err(run(listing(["expenses"], (d) => (d.tables[0].id = "x1"))))).toMatchObject({
      param: "tables/0/id",
    });
  });

  it("the form of the document is a form error, at its position", () => {
    expect(err(run(listing([], (d) => (d.drop_tables = "settings"))))).toMatchObject({
      code: "invalid_argument",
      param: "drop_tables",
    });
    expect(err(run(listing([], (d) => (d.rename_to = 3))))).toMatchObject({ param: "rename_to" });
    expect(err(run("x"))).toMatchObject({ code: "invalid_argument", param: "" });
    expect(
      err(run(listing(["expenses"], (d) => (d.tables[0].fields[0].requried = true)))),
    ).toMatchObject({
      param: "tables/0/fields/0/requried",
    });
  });

  const details = (r: CompileChangeResult) => {
    const e = err(r);
    if (e.code !== "validation_failed") throw new Error(JSON.stringify(e));
    return e.details.map((d) => `${d.path} ${d.code}`);
  };

  it("the compilation rules apply to what the draft lists, at the draft's positions", () => {
    expect(
      details(
        run(
          listing(["expenses", "settings"], (d) => {
            d.tables[0].description = "";
            d.tables[1].name = "expenses";
          }),
        ),
      ),
    ).toEqual(["tables/0/description description_missing", "tables/1/name duplicate_name"]);
  });

  it("a rename to the name of another table, or of a slot, is refused", () => {
    expect(details(run(listing(["settings"], (d) => (d.tables[0].name = "Rooms"))))).toEqual([
      "tables/0/name duplicate_name",
    ]);
    expect(details(run(listing([], (d) => (d.rename_to = "OTHER"))))).toEqual([
      "slot duplicate_name",
    ]);
  });

  it("a table renamed to the name a dropped table had is fine", () => {
    const r = ok(
      run(
        listing(["rooms"], (d) => {
          d.tables[0].name = "settings";
          d.drop_tables = ["settings"];
        }),
      ),
    );
    expect(codes(r)).toEqual(["rename_table", "drop_table"]);
  });

  it("drop_tables names what is not there, or a table twice, or one the draft also lists", () => {
    expect(details(run(listing([], (d) => (d.drop_tables = ["nope"]))))).toEqual([
      "drop_tables/0 unknown_reference",
    ]);
    expect(details(run(listing([], (d) => (d.drop_tables = ["settings", "t4"]))))).toEqual([
      "drop_tables/1 duplicate_entry",
    ]);
    expect(details(run(listing(["settings"], (d) => (d.drop_tables = ["settings"]))))).toEqual([
      "drop_tables/0 duplicate_entry",
    ]);
  });

  it("still_referenced: a table something retained refers to", () => {
    const r = err(run(listing([], (d) => (d.drop_tables = ["accounts"]))));
    expect(r).toMatchObject({ code: "validation_failed" });
    const d = (r as unknown as { details: unknown[] }).details;
    expect(d).toEqual([
      { path: "drop_tables/0", code: "still_referenced", referenced_by: ["expenses.account"] },
    ]);
  });

  it("still_referenced gives a position when the dependent is in the draft; dropping both is fine", () => {
    const r = err(
      run(
        listing(["expenses"], (d) => {
          d.drop_tables = ["accounts"];
        }),
      ),
    );
    // The listed table's own reference to the dropped table is unknown too.
    expect((r as unknown as { details: unknown[] }).details).toContainEqual({
      path: "drop_tables/0",
      code: "still_referenced",
      referenced_by: ["tables/0/fields/8"],
    });
    // The dependent is dropped in the same draft: nothing is left pointing at the table.
    const both = ok(run(listing([], (d) => (d.drop_tables = ["accounts", "expenses"]))));
    expect(codes(both)).toEqual(["drop_table", "drop_table"]);
  });

  it("a slot left without a base table is refused", () => {
    expect(
      details(
        run(listing([], (d) => (d.drop_tables = ["expenses", "accounts", "rooms", "settings"]))),
      ),
    ).toContain("tables out_of_bounds");
  });
});

describe("findings between two tables, and what a drop list names", () => {
  /** Version 1 of `ledger()` changed by `f` first: the starting point of a draft. */
  const from = (f: (d: Doc) => void) => {
    const d = ledger();
    f(d);
    const c = compile(d);
    if (!c.ok) throw new Error(JSON.stringify(c.error));
    const draftOn = (g: (x: Doc) => void, names: string[]) => {
      const x = filled(d, c.compiled);
      x.tables = x.tables.filter((t: Doc) => names.includes(t.name));
      g(x);
      return run(x, { current: c.compiled });
    };
    return draftOn;
  };

  it("a listed table renamed to the name of a table listed after it, or not listed, is refused", () => {
    // `rooms` is t3, after `expenses` and not in the draft.
    expect(detailsOf(run(listing(["expenses"], (d) => (d.tables[0].name = "Rooms"))))).toEqual([
      "tables/0/name duplicate_name",
    ]);
    // Listed after it.
    expect(
      detailsOf(run(listing(["expenses", "rooms"], (d) => (d.tables[0].name = "rooms")))),
    ).toEqual(["tables/1/name duplicate_name"]);
  });

  it("a listed table renamed to another table's alias is refused on the listed table", () => {
    const draftOn = from((d) => (d.tables[2].aliases = ["spending"]));
    expect(detailsOf(draftOn((x) => (x.tables[0].name = "spending"), ["expenses"]))).toEqual([
      "tables/0/name duplicate_name",
    ]);
    // An alias of the listed table that is another table's name: on the alias.
    expect(
      detailsOf(run(listing(["expenses"], (d) => (d.tables[0].aliases = ["settings"])))),
    ).toEqual(["tables/0/aliases/0 alias_invalid"]);
  });

  it("an alias that is a name the same draft renames away is refused", () => {
    expect(
      detailsOf(
        run(
          listing(["expenses", "settings"], (d) => {
            d.tables[0].fields[3].name = "memo";
            d.tables[0].fields[3].aliases = ["note"];
            d.tables[1].name = "config";
            d.tables[1].aliases = ["SETTINGS"];
          }),
        ),
      ),
    ).toEqual(["tables/0/fields/3/aliases/0 alias_invalid", "tables/1/aliases/0 alias_invalid"]);
  });

  it("drop_tables names by name first, by ID only when no table has the name", () => {
    // A table named `t1` is t4; the table whose ID is t1 is `expenses`.
    const draftOn = from((d) => (d.tables[3].name = "t1"));
    const r = ok(draftOn((x) => (x.drop_tables = ["t1"]), []));
    expect(r.changes.map((c) => c.target)).toEqual([{ table: "t4" }]);
    expect(r.compiled.tables.map((t) => t.name)).toEqual(["expenses", "accounts", "rooms"]);
    // No table has the name `t4`: the ID.
    expect(
      ok(run(listing([], (d) => (d.drop_tables = ["t4"])))).changes.map((c) => c.target),
    ).toEqual([{ table: "t4" }]);
  });

  it("a dependent dropped or changed in the same draft does not keep the table referenced", () => {
    // The ref field dropped with the table: what is not compiled yet is the drop of the field.
    const dropped = err(
      run(
        listing(["expenses"], (d) => {
          d.drop_tables = ["accounts"];
          d.tables[0].drop_fields = ["account"];
          d.tables[0].fields.splice(8, 1);
        }),
      ),
    );
    expect(dropped).toMatchObject({ code: "not_implemented", what: "drop_field" });
    // The ref field made text: its change is change_ref.
    const changed = err(
      run(
        listing(["expenses"], (d) => {
          d.drop_tables = ["accounts"];
          d.tables[0].fields[8] = { id: "f9", name: "account", type: "text", description: "x" };
        }),
      ),
    );
    expect(changed).toMatchObject({ code: "not_implemented", what: "change_ref" });
  });

  it("a new table or field named what the draft renames away is refused for that", () => {
    expect(
      detailsOf(
        run(
          listing(["expenses", "settings"], (d) => {
            d.tables[0].fields[3].name = "memo";
            d.tables[0].fields.push({ name: "note", type: "text", description: "a new note" });
            d.tables[1].name = "config";
            d.tables.push({
              name: "settings",
              kind: "base",
              description: "new",
              time: { type: "none" },
              fields: [{ name: "k", type: "text", description: "k" }],
            });
          }),
        ),
      ),
    ).toEqual(["tables/0/fields/9/name name_renamed_away", "tables/2/name name_renamed_away"]);
  });

  it("a reference written with another slot's prefix is not this slot's dependent", () => {
    const e = err(
      run(
        listing(["expenses"], (d) => {
          d.drop_tables = ["accounts"];
          d.tables[0].fields[8].ref.table = "other.accounts";
        }),
      ),
    );
    expect(e).toMatchObject({ code: "validation_failed" });
    const found = (e as unknown as { details: { path: string; code: string }[] }).details;
    expect(found.map((d) => d.code)).not.toContain("still_referenced");
  });

  it("a reference by a name another table is renamed to in the draft means that table", () => {
    // accounts dropped, rooms renamed accounts: expenses.account now names rooms, so it is not
    // still referenced; it points at another table now, which is change_ref.
    const e = err(
      run(
        listing(["expenses", "rooms"], (d) => {
          d.drop_tables = ["accounts"];
          d.tables[1].name = "accounts";
        }),
      ),
    );
    expect(e).toMatchObject({ code: "not_implemented", what: "change_ref" });
  });

  it("a name taken twice brings no findings on the references by that name", () => {
    expect(detailsOf(run(listing(["expenses"], (d) => (d.tables[0].name = "accounts"))))).toEqual([
      "tables/0/name duplicate_name",
    ]);
  });

  it("a new derived table named what a table is renamed away from by its ID", () => {
    expect(
      detailsOf(
        run(
          listing(["settings"], (d) => {
            d.tables[0].name = "config";
            d.tables.push({ name: "settings", kind: "derived", description: "d" });
          }),
        ),
      ),
    ).toEqual(["tables/1/name name_renamed_away"]);
  });

  it("an alias that is a name the draft drops is refused: the name still counts as taken", () => {
    expect(
      detailsOf(
        run(
          listing(["expenses"], (d) => {
            d.drop_tables = ["settings"];
            d.tables[0].aliases = ["settings"];
          }),
        ),
      ),
    ).toEqual(["tables/0/aliases/0 alias_invalid"]);
    expect(
      err(
        run(
          listing(["expenses"], (d) => {
            d.tables[0].drop_fields = ["pieces"];
            d.tables[0].fields.splice(4, 1);
            d.tables[0].fields[3].aliases = ["pieces"];
          }),
        ),
      ),
    ).toMatchObject({ code: "validation_failed" });
  });

  it("a field to or from ref is change_ref", () => {
    const what = (r: CompileChangeResult) => {
      const e = err(r);
      return e.code === "not_implemented" ? e.what : e.code;
    };
    expect(
      what(
        run(
          listing(["expenses"], (d) => {
            d.tables[0].fields[4] = {
              id: "f5",
              name: "pieces",
              type: "ref",
              description: "how many",
              ref: { table: "accounts", target: "entity" },
            };
          }),
        ),
      ),
    ).toBe("change_ref");
  });

  it("the changes come in one order, however the draft orders its tables and fields", () => {
    const draft = (reverse: boolean) =>
      run(
        listing(["expenses", "accounts", "settings"], (d) => {
          d.rename_to = "books";
          d.tables[0].description = "every expense";
          d.tables[0].fields[3].name = "memo";
          d.tables[0].fields[1].values = ["food", "rent", "fun"];
          d.tables[1].aliases = ["wallets"];
          d.tables[2].fields[0].description = "the key";
          d.drop_tables = ["rooms"];
          d.tables.push({
            name: "budgets",
            kind: "base",
            description: "a budget",
            time: { type: "none" },
            fields: [{ name: "label", type: "text", description: "what for" }],
          });
          if (reverse) {
            d.tables.reverse();
            for (const t of d.tables) t.fields.reverse();
          }
        }),
      );
    const a = ok(draft(false));
    expect(JSON.stringify(ok(draft(true)).changes)).toBe(JSON.stringify(a.changes));
    expect(a.changes.map((c) => [c.change, c.target])).toEqual([
      ["rename_slot", { slot: true }],
      ["change_description", { table: "t1" }],
      ["loosen_constraint", { table: "t1", field: "f2" }],
      ["rename_field", { table: "t1", field: "f4" }],
      ["change_aliases", { table: "t2" }],
      ["change_description", { table: "t4", field: "f1" }],
      ["drop_table", { table: "t3" }],
      ["add_table", { table: "t7" }],
    ]);
  });

  describe("a derived table", () => {
    beforeAll(() => loadRsql());
    it("dropped: not destructive, old writes unaffected", () => {
      const draftOn = from((d) =>
        d.tables.push({
          name: "totals",
          kind: "derived",
          description: "how many settings",
          rule: {
            sql: "SELECT key AS k, count(*) AS n FROM settings GROUP BY key",
            time_dependency: "none",
          },
          fields: [
            { name: "k", description: "the key" },
            { name: "n", description: "how many" },
          ],
        }),
      );
      const r = ok(draftOn((x) => (x.drop_tables = ["totals"]), []));
      expect(r.changes).toEqual([
        {
          target: { table: "t5" },
          change: "drop_table",
          class: "metadata",
          compatible_with_old_writes: true,
          destructive: false,
          auto: false,
        },
      ]);
      // A base table it reads, dropped while it stays: still referenced, by the derived table's name.
      expect(detailsOf(draftOn((x) => (x.drop_tables = ["settings"]), []))).toEqual([
        "drop_tables/0 still_referenced",
      ]);
    });
  });
});
