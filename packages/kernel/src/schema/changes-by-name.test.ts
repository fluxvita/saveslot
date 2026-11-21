// changesByName (04-contract-types §5.3 `SchemaChange`): targets by names, from the version the
// draft compiles to, else from the one it was written on.

import type { CompiledSchema, SchemaChangeRecord } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { changesByName } from "./changes-by-name.ts";

const table = (id: string, name: string, fields: [string, string][]) => ({
  id,
  name,
  kind: "base",
  description: "x",
  time: { type: "none" },
  physical: { table: `t_${id}_v1` },
  fields: fields.map(([fid, fname]) => ({ id: fid, name: fname, type: "text", description: "x" })),
});
const version = (sv: number, tables: ReturnType<typeof table>[]) =>
  ({
    compiler: 1,
    rsql: "rsql@1",
    slot: "sl_4444444444444444",
    name: "ledger",
    sv,
    timezone: "Asia/Shanghai",
    tables,
  }) as unknown as CompiledSchema;
const record = (target: SchemaChangeRecord["target"], change: string) =>
  ({
    target,
    change,
    class: "metadata",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  }) as unknown as SchemaChangeRecord;

// Version 1: expenses (note, memo), settings (key). Version 2: expenses renamed spending, its
// field note renamed remark and memo dropped; settings dropped.
const BEFORE = version(1, [
  table("t1", "expenses", [
    ["f1", "note"],
    ["f2", "memo"],
  ]),
  table("t2", "settings", [["f1", "key"]]),
]);
const NEXT = version(2, [table("t1", "spending", [["f1", "remark"]])]);

describe("changesByName", () => {
  it("names a table and field as the version compiled to has them", () => {
    expect(
      changesByName(
        [
          record({ table: "t1" }, "rename_table"),
          record({ table: "t1", field: "f1" }, "rename_field"),
        ] as never,
        NEXT,
        BEFORE,
      ).map((c) => c.target),
    ).toEqual([{ table: "spending" }, { table: "spending", field: "remark" }]);
  });

  it("a field the new version no longer has: its name in the version written on", () => {
    // The table is still there under its new name; the field is gone from it.
    expect(
      changesByName([record({ table: "t1", field: "f2" }, "drop_field")] as never, NEXT, BEFORE)[0]
        ?.target,
    ).toEqual({ table: "spending", field: "memo" });
  });

  it("a table the new version no longer has: its name in the version written on", () => {
    expect(
      changesByName([record({ table: "t2" }, "drop_table")] as never, NEXT, BEFORE)[0]?.target,
    ).toEqual({ table: "settings" });
  });

  it("the slot by its name after the change, a rule, and an ID neither version has, as they are", () => {
    expect(
      changesByName(
        [
          record({ slot: true } as never, "rename_slot"),
          record({ table: "t1", rule: true } as never, "change_rule"),
          record({ table: "t9", field: "f9" }, "rename_field"),
        ] as never,
        { ...NEXT, name: "books" },
        BEFORE,
      ).map((c) => c.target),
    ).toEqual([
      { slot: true, name: "books" },
      { table: "spending", rule: true },
      { table: "t9", field: "f9" },
    ]);
  });

  it("keeps the rest of each record", () => {
    const [c] = changesByName([record({ table: "t1" }, "rename_table")] as never, NEXT, BEFORE);
    expect(c).toEqual({
      target: { table: "spending" },
      change: "rename_table",
      class: "metadata",
      compatible_with_old_writes: true,
      destructive: false,
      auto: true,
    });
  });
});
