// Naming a row read as of a moment (08 «状态机 · 已退役»: by the compiled definition of the version
// in effect then), on the definitions directly. What a version switches to on the same physical
// table (names, texts) is named as then; a version answered by another physical table (a field
// added or dropped, 07 «改动分类与迁移手段») is not read here yet, and says so rather than naming
// the rows as now.

import type {
  CompiledBaseTable,
  CompiledSchema,
  FieldValue,
} from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { byName, namedAsOf } from "./history.ts";

const table = (o: {
  name: string;
  physical: string;
  fields: readonly [string, string][];
}): CompiledBaseTable =>
  ({
    id: "t1",
    name: o.name,
    kind: "base",
    description: "one row per expense",
    time: { type: "event", field: "f1" },
    physical: { table: o.physical },
    fields: o.fields.map(([id, name]) => ({ id, name, type: "text", description: name })),
  }) as unknown as CompiledBaseTable;

const schema = (sv: number, name: string, t: CompiledBaseTable): CompiledSchema =>
  ({
    compiler: 1,
    rsql: "rsql@1",
    slot: `sl_${"4".repeat(16)}`,
    name,
    sv,
    timezone: "Asia/Shanghai",
    tables: [t],
  }) as unknown as CompiledSchema;

/** A row as the current version stores it: every field of the current version, by ID. */
const VALUES: Record<string, FieldValue> = { f1: "2026-11-02", f2: "tea", f3: "cash" };

describe("a row read as of a version is named as that version defines it", () => {
  it("a rename and a description changed since: the version's names, the same fields", () => {
    // What a version switches to on the same physical table: names and texts only.
    const then = table({
      name: "expenses",
      physical: "t_t1_v1",
      fields: [
        ["f1", "date"],
        ["f2", "note"],
      ],
    });
    const now = {
      ...table({
        name: "expenses",
        physical: "t_t1_v1",
        fields: [
          ["f1", "day"],
          ["f2", "note"],
        ],
      }),
      description: "every expense",
    } as CompiledBaseTable;
    const shown = namedAsOf(schema(1, "ledger", then), { slot: "ledger", table: now });
    expect(byName(shown.table, VALUES)).toEqual({ date: "2026-11-02", note: "tea" });
    expect(shown.table.description).toBe("one row per expense");
    // The current version itself: its own names.
    expect(byName(now, VALUES)).toEqual({ day: "2026-11-02", note: "tea" });
  });

  it("a field renamed since has the version's name, and so have the table and the slot", () => {
    const then = table({
      name: "expenses",
      physical: "t_t1_v1",
      fields: [
        ["f1", "date"],
        ["f2", "note"],
      ],
    });
    const now = table({
      name: "spending",
      physical: "t_t1_v1",
      fields: [
        ["f1", "date"],
        ["f2", "memo"],
      ],
    });
    const shown = namedAsOf(schema(1, "ledger", then), { slot: "books", table: now });
    expect(shown.slot).toBe("ledger");
    expect(shown.table.name).toBe("expenses");
    expect(byName(shown.table, VALUES)).toEqual({ date: "2026-11-02", note: "tea" });
  });

  it("another physical table then: not_in_this_version; no definition: internal; no such table then: as now", () => {
    const now = table({
      name: "spending",
      physical: "t_t1_v2",
      fields: [
        ["f1", "date"],
        ["f2", "memo"],
      ],
    });
    const rebuilt = table({
      name: "expenses",
      physical: "t_t1_v1",
      fields: [
        ["f1", "date"],
        ["f2", "note"],
      ],
    });
    // Reading a retired physical table comes with the migrations that build it: not named as now.
    expect(() => namedAsOf(schema(1, "ledger", rebuilt), { slot: "books", table: now })).toThrow(
      expect.objectContaining({
        code: "not_in_this_version",
        detail: expect.objectContaining({ reason: "not_implemented" }),
      }),
    );
    // The same, with that physical table empty (restructured while never written): no row then,
    // named as that version has it.
    expect(namedAsOf(schema(1, "ledger", rebuilt), { slot: "books", table: now }, true)).toEqual({
      slot: "ledger",
      table: rebuilt,
    });
    // A version switched to without its definition in the log: the log at odds with itself.
    expect(() => namedAsOf(undefined, { slot: "books", table: now })).toThrow(
      expect.objectContaining({
        code: "internal",
        detail: expect.objectContaining({ reason: "inconsistent" }),
      }),
    );
    // A table the version has not: no row of it then; named as now.
    const without = { ...schema(1, "ledger", rebuilt), tables: [] } as unknown as CompiledSchema;
    expect(namedAsOf(without, { slot: "books", table: now })).toEqual({
      slot: "books",
      table: now,
    });
  });
});
