// A ref target this request reads from the store is read once (write/refs.ts `stored`): the ops of
// a request naming the same target share what was read.

import type { CompiledBaseTable, TableId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import type { RecordedItem } from "../judge/index.ts";
import type { Tx } from "../store/ports.ts";
import { refProblems, type StoredTargets } from "./refs.ts";

const NOTES = {
  id: "t3",
  name: "notes",
  kind: "base",
  description: "notes",
  time: { type: "none" },
  physical: { table: "t_t3_v1" },
  fields: [{ id: "f5", name: "text", type: "text", required: true, description: "text" }],
} as unknown as CompiledBaseTable;
const PAYMENTS = {
  id: "t2",
  name: "payments",
  kind: "base",
  description: "payments",
  time: { type: "none" },
  physical: { table: "t_t2_v1" },
  fields: [
    {
      id: "f4",
      name: "note",
      type: "ref",
      description: "a note",
      ref: { table: "t3", target: "row" },
    },
  ],
} as unknown as CompiledBaseTable;
const TARGET = `r_${"7".repeat(26)}`;

/** A store holding one note with no events: every query counted. */
function countingTx() {
  const queries: string[] = [];
  const tx = {
    query: async (sql: string) => {
      queries.push(sql);
      return { rows: sql.includes("row_origins") ? [{ table_id: "t3" }] : [] };
    },
    exec: async () => {},
  } as unknown as Tx;
  return { tx, queries };
}

const giving = (value: string): RecordedItem =>
  ({
    target: "f4",
    k: 0,
    status: "applied",
    valid: [],
    content: { kind: "value", value },
    deps: [],
  }) as unknown as RecordedItem;

describe("a ref target read from the store", () => {
  it("is read once for the ops of a request naming it", async () => {
    const { tx, queries } = countingTx();
    const stored: StoredTargets = new Map();
    const check = (index: number) =>
      refProblems(tx, {
        index,
        slot: "ledger",
        table: PAYMENTS,
        tableOf: (id: TableId) => (id === "t3" ? NOTES : id === "t2" ? PAYMENTS : undefined),
        items: [giving(TARGET)],
        known: () => undefined,
        visible: () => true,
        stored,
        at: { upTo: 10 as never },
      });
    expect(await check(0)).toEqual([]);
    const once = queries.length;
    expect(once).toBeGreaterThan(0);
    expect(await check(1)).toEqual([]);
    expect(await check(2)).toEqual([]);
    expect(queries.length).toBe(once);
  });
});
