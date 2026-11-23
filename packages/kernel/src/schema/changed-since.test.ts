// changedSinceOf (07-schema-evolution «原则» 4; 04-contract-types `schema_incompatible`): what refuses
// an old write, read off the changes each switched version recorded.

import type { SchemaChangeCode } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { changedSinceOf, type RecordedChange, type SwitchedVersion } from "./changed-since.ts";

const field = (change: SchemaChangeCode, compatible: boolean, f = "f2"): RecordedChange => ({
  change,
  target: { table: "t1", field: f },
  compatible_with_old_writes: compatible,
});
const table = (change: SchemaChangeCode, compatible: boolean, t = "t1"): RecordedChange => ({
  change,
  target: { table: t },
  compatible_with_old_writes: compatible,
});
const v = (sv: number, ...changes: RecordedChange[]): SwitchedVersion => ({ sv, changes });
const entries = (versions: SwitchedVersion[], sv: number) => [
  ...changedSinceOf(versions, sv).entries(),
];

describe("changedSinceOf", () => {
  it("a field changed incompatibly: that field; a table dropped: the whole table", () => {
    expect(entries([v(2, field("drop_field", false))], 1)).toEqual([["t1/f2", "drop_field"]]);
    expect(entries([v(2, table("drop_table", false))], 1)).toEqual([["t1/*", "drop_table"]]);
  });

  it("a change compiled as on a table never written (as_never_written): the whole table, compatible or not", () => {
    const marked = (change: SchemaChangeCode, compatible: boolean): RecordedChange => ({
      ...field(change, compatible),
      as_never_written: true,
    });
    expect(entries([v(2, marked("change_type", false))], 1)).toEqual([["t1/*", "change_type"]]);
    expect(entries([v(2, marked("drop_field", false))], 1)).toEqual([["t1/*", "drop_field"]]);
    expect(entries([v(2, marked("tighten_constraint", true))], 1)).toEqual([
      ["t1/*", "tighten_constraint"],
    ]);
    // A table restructured, a field dropped with it (07 «从未被写入的表上改结构», the decision's
    // example): named by the first change the version records, the table's own (fixed case).
    const own = (change: SchemaChangeCode): RecordedChange => ({
      ...table(change, false),
      as_never_written: true,
    });
    expect(
      entries(
        [v(2, own("change_time_type"), own("change_entity_key"), marked("drop_field", false))],
        1,
      ),
    ).toEqual([["t1/*", "change_time_type"]]);
    // A later version still wins over an earlier one.
    expect(entries([v(2, own("change_time_type")), v(3, marked("drop_field", false))], 1)).toEqual([
      ["t1/*", "drop_field"],
    ]);
    // Not marked: by field and by compatibility, as before.
    expect(entries([v(2, field("change_type", false))], 1)).toEqual([["t1/f2", "change_type"]]);
    expect(entries([v(2, field("tighten_constraint", true))], 1)).toEqual([]);
  });

  it.each([
    "rename_field",
    "change_description",
    "change_aliases",
    "add_optional_field",
    "add_required_field",
    "loosen_constraint",
    "tighten_constraint",
    "change_unit",
    "change_precision",
  ] as const)("%s, compatible as recorded: refuses nothing", (change) => {
    expect(entries([v(2, field(change, true))], 1)).toEqual([]);
  });

  it("a derived table dropped is recorded compatible: nothing; a rule changed: nothing", () => {
    expect(entries([v(2, table("drop_table", true))], 1)).toEqual([]);
    const rule: RecordedChange = {
      change: "change_rule",
      target: { table: "t3", rule: true },
      compatible_with_old_writes: false,
    };
    expect(entries([v(2, rule)], 1)).toEqual([]);
    const slot: RecordedChange = {
      change: "rename_slot",
      target: {},
      compatible_with_old_writes: false,
    };
    expect(entries([v(2, slot)], 1)).toEqual([]);
  });

  it("only versions after the one given, every one of them; the latest change of a target wins", () => {
    const vs = [
      v(1, table("create_slot" as SchemaChangeCode, true)),
      v(2, field("change_type", false)),
      v(4, field("drop_field", false), field("change_type", false, "f5")),
      v(5, table("drop_table", false, "t2")),
    ];
    expect(entries(vs, 1)).toEqual([
      ["t1/f2", "drop_field"],
      ["t1/f5", "change_type"],
      ["t2/*", "drop_table"],
    ]);
    expect(entries(vs, 2)).toEqual([
      ["t1/f2", "drop_field"],
      ["t1/f5", "change_type"],
      ["t2/*", "drop_table"],
    ]);
    expect(entries(vs, 4)).toEqual([["t2/*", "drop_table"]]);
    expect(entries(vs, 5)).toEqual([]);
    // Given out of order: the same.
    expect(entries([...vs].reverse(), 1)).toEqual(entries(vs, 1));
  });
});
