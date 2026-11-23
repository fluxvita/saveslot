// compileChange: a draft that changes an existing slot — the matching of tables and fields, the
// changes it classifies and their policy class, the definition of the next version, the errors and
// their order (03-data-model/07-schema-evolution.md «schema 文档格式», «改动分类与迁移手段»;
// 04-contract «schema_draft»). Fictional names, the ledger of ./documents.fixture.ts as version 1.

import type {
  ChangeTarget,
  CompiledBaseTable,
  CompiledSchema,
} from "@fluxvita/saveslot-contract-core";
import { parseEvent } from "@fluxvita/saveslot-contract-core";
import { beforeAll, describe, expect, it } from "vitest";
import { loadRsql } from "../rules/index.ts";
import { compileChange } from "./compile-change.ts";
import { documentOf } from "./document-of.ts";
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
    // Every table written unless a case says otherwise.
    neverWritten: () => false,
    targetVersion: (o.current ?? v1()).sv + 1,
    formerNames: { tables: [], fields: new Map() },
    // Field numbers taken up to 11 in every table (a given-up version's included): f12 is next.
    nextFieldNumber: () => 12,
    // A value is its own canonical form here, but "bad", which is no value of any field.
    constValue: (_f, raw, path) =>
      raw === "bad" ? { detail: { path, code: "type_mismatch" } } : { value: raw as never },
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

  it("loosens a bound the other way: a larger max, a smaller min; tightens either, handed back to be checked", () => {
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
    // One bound looser and the other tighter is both; a tighter one is checked (07 «收紧约束»).
    const both = ok(
      draft((f) => {
        f.min = 5;
        f.max = 50;
      }),
    );
    expect(codes(both)).toEqual(["loosen_constraint", "tighten_constraint"]);
    expect(both.checks.map((k) => k.path)).toEqual(["tables/0/fields/2"]);
    expect(codes(draft((f) => (f.max = 50)))).toEqual(["tighten_constraint"]);
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
  it("takes the version number it is given: numbers skip when drafts were rejected", () => {
    const r = ok(
      run(
        listing([], (d) => (d.rename_to = "books")),
        { targetVersion: 4 },
      ),
    );
    expect(r.targetVersion).toBe(4);
    expect(r.compiled.sv).toBe(4);
    const t = ok(
      run(
        listing([], (d) =>
          d.tables.push({
            name: "budgets",
            kind: "base",
            description: "a budget",
            time: { type: "none" },
            fields: [{ name: "label", type: "text", description: "what for" }],
          }),
        ),
        { targetVersion: 4 },
      ),
    );
    expect(table(t, "budgets")?.physical).toEqual({ table: "t_t7_v4" });
    expect(() => run(listing([]), { targetVersion: 1 })).toThrow();
  });

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

describe("changes that rebuild a table (08 «物理做法»; 07 «改动分类»)", () => {
  beforeAll(() => loadRsql());
  const on = (f: (e: Doc) => void, o: Partial<Omit<CompileChangeInput, "document">> = {}) =>
    run(
      listing(["expenses"], (d) => f(d.tables[0])),
      o,
    );
  const records = (r: CompileChangeResult) =>
    ok(r).changes.map((c) => [
      c.change,
      c.target,
      c.class,
      c.compatible_with_old_writes,
      c.destructive,
      c.auto,
    ]);
  const expenses = (r: CompileChangeResult) => ok(r).compiled.tables[0] as CompiledBaseTable;
  const field = (r: CompileChangeResult, id: string) =>
    expenses(r).fields.find((f) => f.id === id) as Doc | undefined;
  const t1 = { table: "t1" };

  it("a table rebuilt gets a physical table of the new version; one not rebuilt keeps its own", () => {
    const r = on((e) => e.fields.push({ name: "tip", type: "integer", description: "a tip" }));
    expect(expenses(r).physical).toEqual({ table: "t_t1_v2" });
    expect(ok(r).compiled.tables[1]?.physical).toEqual({ table: "t_t2_v1", since: 1 });
    // A rename alone builds nothing.
    expect(expenses(on((e) => (e.fields[3].name = "memo"))).physical).toEqual({
      table: "t_t1_v1",
      since: 1,
    });
  });

  it("an optional field added: automatic, old writes taken, its ID the table's next one", () => {
    const r = on((e) => e.fields.push({ name: "tip", type: "integer", description: "a tip" }));
    expect(records(r)).toEqual([
      ["add_optional_field", { ...t1, field: "f12" }, "metadata", true, false, true],
    ]);
    expect(ok(r).outcome).toBe("applied");
    expect(field(r, "f12")).toMatchObject({ name: "tip", type: "integer" });
    // Two added: numbered on, in the draft's order, after the fields kept.
    const two = on((e) =>
      e.fields.push(
        { name: "tip", type: "integer", description: "a tip" },
        { name: "who", type: "text", description: "who paid" },
      ),
    );
    expect(
      expenses(two)
        .fields.slice(-2)
        .map((f) => [f.id, f.name]),
    ).toEqual([
      ["f12", "tip"],
      ["f13", "who"],
    ]);
  });

  it("a required field added: a constant backfill, always; deterministic, waits", () => {
    const tip = { name: "tip", type: "integer", required: true, description: "a tip" };
    expect(detailsOf(on((e) => e.fields.push(tip)))).toEqual([
      "tables/0/fields/9 backfill_const_required",
    ]);
    const r = on((e) => e.fields.push({ ...tip, backfill: { const: 0 } }));
    expect(records(r)).toEqual([
      ["add_required_field", { ...t1, field: "f12" }, "deterministic", true, false, false],
    ]);
    expect(ok(r).outcome).toBe("pending");
    expect(field(r, "f12")).toMatchObject({ required: true, backfill: { const: 0 } });
  });

  it("a field dropped: old writes refused, data lost; gone from the version", () => {
    const r = on((e) => {
      e.drop_fields = ["pieces"];
      e.fields.splice(4, 1);
    });
    expect(records(r)).toEqual([
      ["drop_field", { ...t1, field: "f5" }, "metadata", false, true, false],
    ]);
    expect(field(r, "f5")).toBeUndefined();
    expect(expenses(r).physical).toEqual({ table: "t_t1_v2" });
  });

  it("a field a derived table reads cannot be dropped: still_referenced, naming the derived table", () => {
    const d = ledger();
    d.tables.push({
      name: "spend",
      kind: "derived",
      description: "spent per day",
      rule: {
        sql: "SELECT date, count(pieces) AS n FROM expenses GROUP BY date",
        time_dependency: "bucketed",
      },
      fields: [
        { name: "date", description: "the day" },
        { name: "n", description: "how many" },
      ],
    });
    const start = compile(d);
    if (!start.ok) throw new Error(JSON.stringify(start));
    const x = filled(d, start.compiled);
    x.tables = x.tables.filter((t: Doc) => t.name === "expenses");
    x.tables[0].drop_fields = ["pieces"];
    x.tables[0].fields.splice(4, 1);
    const e = err(run(x, { current: start.compiled }));
    expect(e).toMatchObject({
      code: "validation_failed",
      details: [
        { path: "tables/0/drop_fields/0", code: "still_referenced", referenced_by: ["spend"] },
      ],
    });
  });

  it("a field its own table's time field or keys still use: still_referenced, by their positions in the draft", () => {
    const dropping = (table: string, name: string, f: (t: Doc) => void = () => {}) =>
      run(
        listing([table], (d) => {
          const t = d.tables[0];
          t.drop_fields = [name];
          t.fields = t.fields.filter((x: Doc) => x.name !== name);
          f(t);
        }),
      );
    const referencedBy = (r: CompileChangeResult) =>
      (err(r) as unknown as { details: { code: string; referenced_by?: string[] }[] }).details
        .filter((x) => x.code === "still_referenced")
        .flatMap((x) => x.referenced_by ?? []);
    expect(referencedBy(dropping("expenses", "date"))).toEqual(
      expect.arrayContaining(["tables/0/time/field", "tables/0/duplicate_keys/0/0"]),
    );
    expect(referencedBy(dropping("expenses", "category"))).toEqual(
      expect.arrayContaining(["tables/0/together/0/0", "tables/0/duplicate_keys/0/1"]),
    );
    expect(referencedBy(dropping("accounts", "name"))).toEqual(["tables/0/entity_key/0"]);
    // Judged on the table as the draft leaves it: keys no longer using it do not keep it.
    const r = dropping("expenses", "note", (t) => {
      t.together = [["category", "amount"]];
    });
    expect(codes(r)).toEqual(["drop_field"]);
    expect(
      codes(
        dropping("expenses", "category", (t) => {
          t.together = [];
          t.duplicate_keys = [["date", "amount"]];
        }),
      ),
    ).toContain("drop_field");
  });

  it("a bound tightened without a backfill: compiled, the field handed back to be checked", () => {
    const r = on((e) => (e.fields[2].min = 5));
    expect(records(r)).toEqual([
      ["tighten_constraint", { ...t1, field: "f3" }, "deterministic", true, true, false],
    ]);
    expect(ok(r).checks).toEqual([
      {
        table: "t1",
        field: expect.objectContaining({ id: "f3", min: "5" }),
        path: "tables/0/fields/2",
      },
    ]);
    // With a constant: nothing to check, the constant kept.
    const w = on((e) => {
      e.fields[2].min = 5;
      e.fields[2].backfill = { const: { value: "5", unit: "CNY" } };
    });
    expect(ok(w).checks).toEqual([]);
    expect(field(w, "f3")).toMatchObject({ backfill: { const: { value: "5", unit: "CNY" } } });
  });

  describe("a bound across a change of unit or precision: compared as the new unit has it (07 «收紧约束»)", () => {
    /** Version 1 with field f4 a quantity as given; a draft changing it. */
    const across = (f4: Doc, change: (f: Doc) => void) => {
      const d = ledger();
      d.tables[0].fields[3] = { name: "weight", type: "quantity", description: "how heavy", ...f4 };
      const start = compile(d);
      if (!start.ok) throw new Error("not compiled");
      const x = filled(d, start.compiled);
      x.tables = x.tables.filter((t: Doc) => t.name === "expenses");
      change(x.tables[0].fields[3]);
      return run(x, { current: start.compiled });
    };
    const kinds = (r: CompileChangeResult) =>
      ok(r)
        .changes.filter((c) => "field" in c.target)
        .map((c) => c.change);
    const notYet = {
      code: "not_in_this_version",
      reason: "not_implemented",
      param: "tables/0/fields/3",
    };

    it("kg to g with max 10 made 5000: tightened (10000 g), not loosened", () => {
      const r = across({ unit: "kg", max: 10 }, (f) => {
        f.unit = "g";
        f.max = 5000;
        f.backfill = { const: { value: "0", unit: "g" } };
      });
      expect(kinds(r)).toEqual(["tighten_constraint", "change_unit"]);
    });

    it("m to km with min 5 left as written: tightened (5 m is 0.005 km)", () => {
      const r = across({ unit: "m", min: 5 }, (f) => {
        f.unit = "km";
        f.backfill = { const: { value: "5", unit: "km" } };
      });
      expect(kinds(r)).toEqual(["tighten_constraint", "change_unit"]);
    });

    it("the same bound in the new unit is no change of it: kg to g, max 10 made 10000", () => {
      const r = across({ unit: "kg", max: 10 }, (f) => {
        f.unit = "g";
        f.max = 10000;
      });
      // Nothing tightened or loosened; still bounded, so what breaks it would need converting.
      expect(err(r)).toEqual(notYet);
    });

    it("counting what breaks it would need converting or rounding anew: not in this version yet", () => {
      // A unit changed and a bound tightened, no backfill.
      expect(
        err(
          across({ unit: "kg", max: 10 }, (f) => {
            f.unit = "g";
            f.max = 5000;
          }),
        ),
      ).toEqual(notYet);
      // A unit changed on a bounded field, the bound looser.
      expect(
        err(
          across({ unit: "kg", max: 10 }, (f) => {
            f.unit = "g";
            f.max = 20000;
          }),
        ),
      ).toEqual(notYet);
      // A scale reduced on a bounded field: a value may round past the bound.
      expect(err(across({ unit: "kg", max: 5 }, (f) => (f.scale = 0)))).toEqual(notYet);
      // Neither: a unit changed on a field with no bound, a rounding changed on a bounded one.
      expect(kinds(across({ unit: "kg" }, (f) => (f.unit = "g")))).toEqual(["change_unit"]);
      expect(kinds(across({ unit: "kg", max: 5 }, (f) => (f.rounding = "half_even")))).toEqual([
        "change_precision",
      ]);
    });
  });

  it("an enum value taken away is tightened; a value added beside it loosens too", () => {
    const r = on((e) => (e.fields[1].values = ["food", "travel"]));
    expect(ok(r).changes.map((c) => c.change)).toEqual(["loosen_constraint", "tighten_constraint"]);
    expect(ok(r).checks.map((k) => k.path)).toEqual(["tables/0/fields/1"]);
  });

  it("optional made required: a constant backfill, always, not a check", () => {
    expect(detailsOf(on((e) => (e.fields[3].required = true)))).toEqual([
      "tables/0/fields/3 backfill_const_required",
    ]);
    const r = on((e) => {
      e.fields[3].required = true;
      e.fields[3].backfill = { const: "none" };
    });
    expect(ok(r).checks).toEqual([]);
    expect(field(r, "f4")).toMatchObject({ required: true, backfill: { const: "none" } });
  });

  it("precision: a scale reduced loses digits; a rounding changed does not", () => {
    expect(records(on((e) => (e.fields[5].scale = 2)))).toEqual([
      ["change_precision", { ...t1, field: "f6" }, "deterministic", true, true, false],
    ]);
    const r = on((e) => (e.fields[5].rounding = "half_up"));
    expect(records(r)).toEqual([
      ["change_precision", { ...t1, field: "f6" }, "deterministic", true, false, false],
    ]);
    expect(field(r, "f6")).toMatchObject({ precision: { scale: 4, rounding: "half_up" } });
  });

  it("a backfill: both forms, the expression form, on a field not tightened, a constant not of the field", () => {
    expect(
      detailsOf(
        on((e) => {
          e.fields[2].min = 5;
          e.fields[2].backfill = { const: 5, sql: "1" };
        }),
      ),
    ).toEqual(["tables/0/fields/2/backfill backfill_both_forms"]);
    expect(
      err(
        on((e) => {
          e.fields[2].min = 5;
          e.fields[2].backfill = { sql: "amount + 1" };
        }),
      ),
    ).toMatchObject({ code: "not_in_this_version", what: "a backfill expression" });
    expect(err(on((e) => (e.fields[3].backfill = { const: "x" })))).toMatchObject({
      code: "invalid_argument",
      param: "tables/0/fields/3/backfill",
    });
    expect(
      detailsOf(
        on((e) => {
          e.fields[3].required = true;
          e.fields[3].backfill = { const: "bad" };
        }),
      ),
    ).toEqual(["tables/0/fields/3/backfill/const type_mismatch"]);
  });
});

/**
 * A change the first version does not take (07 «确定性转换怎么重放»: they need a `migrate`): what,
 * where, and the reason (`table_written`: allowed on a table never written; none: on no table).
 */
const later = (r: CompileChangeResult) => {
  const e = err(r);
  if (e.code !== "not_in_this_version") throw new Error(JSON.stringify(e));
  return [e.what, e.param, e.reason ?? null];
};

describe("on a table written: a type or dimension changed, a migrate, a backfill expression are not in this version", () => {
  const on = (f: (e: Doc) => void) => run(listing(["expenses"], (d) => f(d.tables[0])));

  it.each([
    [
      "a type changed",
      (e: Doc) => (e.fields[4].type = "text"),
      "change_type",
      "tables/0/fields/4/type",
      "table_written",
    ],
    [
      "a unit of another dimension (another currency)",
      (e: Doc) => (e.fields[2].unit = "USD"),
      "change_dimension",
      "tables/0/fields/2/unit",
      "table_written",
    ],
    [
      "a migrate",
      (e: Doc) => (e.fields[4].migrate = { sql: "pieces" }),
      "migrate",
      "tables/0/fields/4/migrate",
      null,
    ],
    [
      "a backfill expression",
      (e: Doc) => {
        e.fields[4].min = 1;
        e.fields[4].backfill = { sql: "pieces + 1" };
      },
      "a backfill expression",
      "tables/0/fields/4/backfill/sql",
      null,
    ],
  ])("%s", (_, f, change, param, reason) => {
    expect(later(on(f))).toEqual([change, param, reason]);
  });
});

describe("on a table never written: a type or dimension changed compiles as metadata (07 «从未被写入的表上改结构»)", () => {
  const expenses = (r: CompileChangeResult) => table(r, "expenses") as unknown as Doc;
  const on = (f: (e: Doc) => void, o: Parameters<typeof run>[1] = {}) =>
    run(
      listing(["expenses"], (d) => f(d.tables[0])),
      { neverWritten: () => true, ...o },
    );

  it("a type changed: the field compiled anew under its ID, no migrate, a new empty physical table", () => {
    const r = ok(on((e) => (e.fields[4].type = "text")));
    const was = (v1().tables.find((t) => t.name === "expenses") as unknown as Doc).fields[4];
    const t = expenses(r);
    expect(t.fields[4]).toEqual({
      id: was.id,
      name: "pieces",
      type: "text",
      description: "how many",
    });
    expect(t.physical).toEqual({ table: `t_${t.id}_v2` });
    expect(r.changes).toEqual([
      {
        target: { table: t.id, field: was.id },
        change: "change_type",
        class: "metadata",
        compatible_with_old_writes: false,
        destructive: false,
        auto: false,
        as_never_written: true,
      },
    ]);
  });

  it.each<[string, (e: Doc) => unknown, string, boolean]>([
    [
      "a field dropped",
      (e: Doc) => {
        e.fields.splice(5, 1);
        e.drop_fields = ["rate"];
      },
      "drop_field",
      false,
    ],
    [
      "a required field added",
      (e: Doc) =>
        e.fields.push({
          name: "who",
          type: "text",
          required: true,
          description: "payer",
          backfill: { const: "me" },
        }),
      "add_required_field",
      false,
    ],
    ["a scale made smaller", (e: Doc) => (e.fields[5].scale = 1), "change_precision", false],
    ["a bound tightened", (e: Doc) => (e.fields[4].min = 1), "tighten_constraint", false],
  ])(
    "%s: metadata, nothing lost, marked as_never_written (old writes refused: not compatible), a new physical table",
    (_, f, change, compatible) => {
      const r = ok(on(f));
      const t = expenses(r);
      expect(t.physical).toEqual({ table: `t_${t.id}_v2` });
      expect(r.changes).toEqual([
        expect.objectContaining({
          change,
          class: "metadata",
          compatible_with_old_writes: compatible,
          destructive: false,
          auto: false,
          as_never_written: true,
        }),
      ]);
    },
  );

  it("a unit of the same dimension: marked; a scale made smaller on a bounded field: compiled, nothing to convert", () => {
    const d = ledger();
    d.tables[0].fields[3] = {
      name: "distance",
      type: "quantity",
      unit: "km",
      description: "how far",
    };
    const start = compile(d);
    if (!start.ok) throw new Error("not compiled");
    const x = filled(d, start.compiled);
    x.tables = x.tables.filter((t: Doc) => t.name === "expenses");
    x.tables[0].fields[3].unit = "mi";
    const mi = ok(run(x, { current: start.compiled, neverWritten: () => true }));
    expect(mi.changes).toEqual([
      expect.objectContaining({ change: "change_unit", class: "metadata", as_never_written: true }),
    ]);
    // A written table would need each value converted to count what breaks the bound.
    const smaller = (o: Parameters<typeof run>[1]) =>
      run(
        listing(["expenses"], (e) => {
          e.tables[0].fields[2].scale = 1;
        }),
        o,
      );
    expect(ok(smaller({ neverWritten: () => true })).changes).toEqual([
      expect.objectContaining({ change: "change_precision", as_never_written: true }),
    ]);
    expect(err(smaller({}))).toMatchObject({
      code: "not_in_this_version",
      reason: "not_implemented",
    });
  });

  it("a unit of another dimension: the field takes the new unit and its default scale", () => {
    const r = ok(on((e) => (e.fields[2].unit = "USD")));
    const f = expenses(r).fields[2];
    expect(f.unit).toMatchObject({ code: "USD" });
    expect(f.precision).toEqual({ scale: 2, rounding: "half_up" });
    expect(codes(r)).toEqual(["change_dimension"]);
    expect(r.changes[0]).toMatchObject({ class: "metadata", compatible_with_old_writes: false });
  });

  it("automatic only with restructure_unused in the policy and the table unused", () => {
    const change = (o: Parameters<typeof run>[1]) =>
      ok(on((e) => (e.fields[4].type = "text"), o)).changes[0]?.auto;
    // The default policy has restructure_unused; this version counts every table as used.
    expect(change({})).toBe(false);
    expect(change({ unused: () => true, autoApply: [] })).toBe(false);
    expect(change({ unused: () => true, autoApply: ["restructure_unused"] })).toBe(true);
  });

  it("renamed with it: the rename recorded too; made required: a constant backfill still needed", () => {
    expect(
      codes(
        on((e) => {
          e.fields[4].type = "text";
          e.fields[4].name = "count";
        }),
      ),
    ).toEqual(["rename_field", "change_type"]);
    expect(
      detailsOf(
        on((e) => {
          e.fields[4].type = "text";
          e.fields[4].required = true;
        }),
      ),
    ).toEqual(["tables/0/fields/4 backfill_const_required"]);
    const filledIn = ok(
      on((e) => {
        e.fields[4].type = "text";
        e.fields[4].required = true;
        e.fields[4].backfill = { const: "one" };
      }),
    );
    expect(expenses(filledIn).fields[4]).toMatchObject({
      required: true,
      backfill: { const: "one" },
    });
    expect(
      err(
        on((e) => {
          e.fields[4].type = "text";
          e.fields[4].backfill = { const: "one" };
        }),
      ),
    ).toMatchObject({ code: "invalid_argument", param: "tables/0/fields/4/backfill" });
  });

  it("a migrate is still not in this version; a table written is judged by its own ID", () => {
    expect(later(on((e) => (e.fields[4].migrate = { sql: "pieces" })))).toEqual([
      "migrate",
      "tables/0/fields/4/migrate",
      null,
    ]);
    const id = (v1().tables.find((t) => t.name === "expenses") as unknown as Doc).id;
    expect(
      later(on((e) => (e.fields[4].type = "text"), { neverWritten: (t) => t !== id })),
    ).toEqual(["change_type", "tables/0/fields/4/type", "table_written"]);
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
    // The same dimension compiles: converted from the old unit, with no migrate (07 «确定性转换怎么重放»).
    const same = ok(draft("mi"));
    expect(same.changes).toEqual([
      expect.objectContaining({ target: { table: "t1", field: "f4" }, change: "change_unit" }),
    ]);
    const f4 = (same.compiled.tables[0] as CompiledBaseTable).fields[3] as Doc;
    expect(f4.unit).toMatchObject({ code: "mi" });
    expect(f4).not.toHaveProperty("migrate");
    expect(later(draft("kg"))).toEqual([
      "change_dimension",
      "tables/0/fields/3/unit",
      "table_written",
    ]);
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

  it("a time zone, a derived table", () => {
    expect(what(run(listing([], (d) => (d.timezone = "UTC"))))).toEqual([
      "change_timezone",
      "timezone",
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

  it("an alias may not be a name still resolvable from an earlier version", () => {
    const formerNames = {
      tables: ["expenses", "outgoings"],
      fields: new Map([["t1", ["note", "remark"]]]),
    };
    expect(
      details(
        run(
          listing(["expenses"], (d) => {
            d.tables[0].aliases = ["Outgoings", "spending"];
            d.tables[0].fields[3].aliases = ["REMARK"];
          }),
          { formerNames },
        ),
      ),
    ).toEqual(["tables/0/aliases/0 alias_invalid", "tables/0/fields/3/aliases/0 alias_invalid"]);
    // Another table's old field names are another scope; a new table has no old names.
    expect(
      codes(
        run(
          listing(["settings"], (d) => (d.tables[0].fields[0].aliases = ["remark"])),
          { formerNames },
        ),
      ),
    ).toEqual(["change_aliases"]);
    // A rule broken earlier in the order is the one reported, once.
    const r = err(
      run(
        listing(["expenses"], (d) => (d.tables[0].aliases = [" outgoings"])),
        { formerNames },
      ),
    );
    expect(r).toMatchObject({
      details: [{ path: "tables/0/aliases/0", code: "alias_invalid", reason: "surrounding_space" }],
    });
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
    // The ref field dropped with the table: both dropped, nothing left referring to it.
    const dropped = ok(
      run(
        listing(["expenses"], (d) => {
          d.drop_tables = ["accounts"];
          d.tables[0].drop_fields = ["account"];
          d.tables[0].fields.splice(8, 1);
        }),
      ),
    );
    expect(dropped.changes.map((c) => [c.change, c.target])).toEqual([
      ["drop_field", { table: "t1", field: "f9" }],
      ["drop_table", { table: "t2" }],
    ]);
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
    const SQL = "SELECT key AS k, count(*) AS n FROM settings GROUP BY key";
    /** Version 1 with a derived table over settings.key, and its catalog document. */
    const withTotals = () => {
      const d = ledger();
      d.tables.push({
        name: "totals",
        kind: "derived",
        description: "how many settings",
        rule: { sql: SQL, time_dependency: "none" },
        fields: [
          { name: "k", description: "the key" },
          { name: "n", description: "how many" },
        ],
      });
      const c = compile(d);
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      return c.compiled;
    };
    const texts = new Map([["t5", SQL]]);

    it("listed as the catalog gives it, rule text the same: unchanged, as if not listed", () => {
      const v1 = withTotals();
      const doc = documentOf(v1, 1, (id) => texts.get(id));
      expect(ok(run(doc, { current: v1, ruleTexts: texts })).changes).toEqual([]);
      // Without the texts it cannot be told unchanged: not compiled yet, as before.
      expect(err(run(doc, { current: v1 }))).toMatchObject({
        code: "not_implemented",
        what: "a change to a derived table",
      });
    });

    it("a table never written: a field its rule reads cannot change type (the rule would be compiled again)", () => {
      const withRule = withTotals();
      const doc = documentOf(withRule, 1, (id) => texts.get(id));
      doc["tables"] = (doc["tables"] as Doc[]).filter((t) => t.name === "settings");
      (doc["tables"] as Doc[])[0].fields[0].type = "integer";
      const o = { current: withRule, ruleTexts: texts, neverWritten: () => true };
      expect(err(run(doc, o))).toEqual({
        code: "not_in_this_version",
        reason: "not_implemented",
        what: "change_type",
        param: "tables/0/fields/0/type",
      });
      // The same table without the rule: compiled.
      const plain = ok(run(doc, { ...o, current: v1() }));
      expect(plain.changes.map((c) => c.change)).toEqual(["change_type"]);
    });

    it("precision of a field a rule reads: a larger scale on any table, a rounding on a table never written, not in this version", () => {
      const RATES = "SELECT date AS d, sum(rate) AS r FROM expenses GROUP BY date";
      const d = ledger();
      d.tables.push({
        name: "rates",
        kind: "derived",
        description: "rates by day",
        rule: { sql: RATES, time_dependency: "bucketed" },
        fields: [
          { name: "d", description: "the day" },
          { name: "r", description: "the sum" },
        ],
      });
      const c = compile(d);
      if (!c.ok) throw new Error(JSON.stringify(c.error));
      const id = c.compiled.tables.find((t) => t.name === "rates")?.id as string;
      const rateTexts = new Map([[id, RATES]]);
      const draft = (f: (rate: Doc) => void) => {
        const x = filled(d, c.compiled);
        x.tables = x.tables.filter((t: Doc) => t.name === "expenses");
        f(x.tables[0].fields[5]);
        return x;
      };
      // A larger scale (a loosened constraint, automatic), on a table written: the rule declares
      // the scale it computes.
      expect(
        err(
          run(
            draft((r) => (r.scale = 6)),
            { current: c.compiled, ruleTexts: rateTexts },
          ),
        ),
      ).toEqual({
        code: "not_in_this_version",
        reason: "not_implemented",
        what: "change_precision",
        param: "tables/0/fields/5/scale",
      });
      // The rounding only, on a table never written: named by the rounding.
      expect(
        err(
          run(
            draft((r) => (r.rounding = "half_up")),
            { current: c.compiled, ruleTexts: rateTexts, neverWritten: () => true },
          ),
        ),
      ).toEqual({
        code: "not_in_this_version",
        reason: "not_implemented",
        what: "change_precision",
        param: "tables/0/fields/5/rounding",
      });
      // Without the rule: a larger scale is a loosened constraint, as before.
      expect(
        ok(
          run(
            draft((r) => (r.scale = 6)),
            { current: v1() },
          ),
        ).changes.map((x) => x.change),
      ).toEqual(["loosen_constraint"]);
    });

    it("unchanged after a field its rule reads is renamed: the text keeps the old name", () => {
      const v1 = withTotals();
      const renamed = documentOf(v1, 1, (id) => texts.get(id));
      const settings = (renamed["tables"] as Doc[]).find((t) => t.name === "settings");
      settings.fields[0].name = "label";
      const v2 = ok(run(renamed, { current: v1, ruleTexts: texts, unused: () => true }));
      expect(v2.changes.map((c) => c.change)).toEqual(["rename_field"]);
      // The rule is bound by IDs; the catalog's text is as written, `key` and all.
      const doc = documentOf(v2.compiled, 2, (id) => texts.get(id));
      const totals = (doc["tables"] as Doc[]).find((t) => t.name === "totals");
      expect(totals.rule.sql).toBe(SQL);
      expect(totals.rule.depends_on).toEqual(["settings.label"]);
      // Submitted as it is: nothing changed, the old name not resolved again (no former names).
      const again = run(doc, { current: v2.compiled, ruleTexts: texts, targetVersion: 3 });
      expect(ok(again).changes).toEqual([]);
    });

    it.each([
      ["its rule text", (t: Doc) => (t.rule.sql = `${SQL} `)],
      ["its description", (t: Doc) => (t.description = "how many keys")],
      ["a field's description", (t: Doc) => (t.fields[0].description = "a key")],
      ["its aliases", (t: Doc) => (t.aliases = ["counts"])],
      ["its time dependency", (t: Doc) => (t.rule.time_dependency = "bucketed")],
      ["a field's inferred type", (t: Doc) => (t.fields[1].type = "decimal")],
      ["a filled key of its rule", (t: Doc) => (t.rule.version = 2)],
    ])("changed in %s: a change to a derived table, not compiled yet", (_, f) => {
      const v1 = withTotals();
      const doc = documentOf(v1, 1, (id) => texts.get(id));
      f((doc["tables"] as Doc[]).find((t) => t.name === "totals"));
      expect(err(run(doc, { current: v1, ruleTexts: texts }))).toMatchObject({
        code: "not_implemented",
        what: "a change to a derived table",
        param: "tables/4",
      });
    });

    it("the catalog's document of any table, submitted as it is, changes nothing", () => {
      const v1 = withTotals();
      const doc = documentOf(v1, 1, (id) => texts.get(id));
      for (const t of doc["tables"] as Doc[]) {
        const one = { ...doc, tables: [t] };
        expect(ok(run(one, { current: v1, ruleTexts: texts })).changes).toEqual([]);
      }
    });

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
