// Pin: visibility by field is not implemented (04-contract §12; 03-data-model/11-restricted-sql.md
// «处理步骤» 3). A credential whose range names fields of a table is refused as an internal error by
// every read that resolves names, `sql` included; until fields are implemented, nothing narrows a
// table's fields silently. When this changes, the `sql` front end must hide the fields it does not
// show, by the same rule as `unknown_name` (a name not visible is a name not there).

import type { CompiledSchema, SlotId, TableId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import type { ReadTx } from "../store/ports.ts";
import { type Visibility, visibleSlots } from "./slots.ts";
import { ReadError } from "./types.ts";

const compiled: CompiledSchema = {
  tables: [
    {
      id: "t1",
      name: "runs",
      kind: "base",
      description: "one run per row",
      time: { type: "none" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "laps", type: "integer", required: true, description: "laps" },
        { id: "f2", name: "note", type: "text", description: "free text" },
      ],
    },
  ],
} as unknown as CompiledSchema;

const tx: ReadTx = {
  query: async <R>() =>
    ({
      rows: [
        {
          id: "sl_a",
          name: "health",
          timezone: "UTC",
          current_sv: 1,
          body: JSON.stringify(compiled),
        },
      ] as R[],
    }) as never,
};

const scoped = (table: { table: TableId; fields?: readonly string[] }): Visibility => ({
  kind: "scoped",
  slots: [{ slot: "sl_a" as SlotId, tables: [table] }],
});

describe("visibility by field", () => {
  it("is refused as an internal error, whichever fields are named, in the words it has today", async () => {
    for (const fields of [["f1"], [], ["f1", "f2"]]) {
      const e = await visibleSlots(tx, scoped({ table: "t1" as TableId, fields })).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(ReadError);
      expect(e).toMatchObject({
        code: "internal",
        message: "visibility by field is not implemented",
      });
    }
  });

  it("does not come into it when a table is named without fields, or the whole slot, or everything", async () => {
    const ok = async (v: Visibility) =>
      (await visibleSlots(tx, v)).map((s) => s.tables.map((t) => t.name));
    expect(await ok(scoped({ table: "t1" as TableId }))).toEqual([["runs"]]);
    expect(await ok({ kind: "scoped", slots: [{ slot: "sl_a" as SlotId }] })).toEqual([["runs"]]);
    expect(await ok({ kind: "all" })).toEqual([["runs"]]);
    expect(await ok(scoped({ table: "t9" as TableId }))).toEqual([[]]);
  });
});
