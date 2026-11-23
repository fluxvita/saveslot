// Duplicate keys, the parts that need no store (./duplicates.ts): which writes are compared, what
// counts as a match, the order and the cut at 10, and the rows left out. The stored rows come from
// a stand-in transaction; the end-to-end cases are in store-pglite (write-duplicates.test.ts).

import type {
  CompiledBaseTable,
  FieldId,
  FieldValue,
  RowId,
} from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import type { Judgement } from "../judge/index.ts";
import type { Tx } from "../store/ports.ts";
import {
  byLatest,
  createdInEffect,
  duplicateKeysOf,
  findDuplicates,
  MATCHED_MAX,
  matchesGroup,
} from "./duplicates.ts";

const row = (n: number) => `r_${String(n).padStart(2, "0")}${"A".repeat(24)}` as RowId;
const F = (s: string) => s as FieldId;
const TABLE = {
  id: "t1",
  name: "meals",
  kind: "base",
  description: "meals",
  time: { type: "none" },
  physical: { table: "t_t1_v1" },
  fields: [
    { id: "f1", name: "day", type: "date", description: "d" },
    { id: "f2", name: "note", type: "text", description: "n" },
  ],
  duplicate_keys: [[F("f1"), F("f2")], [F("f2")]],
} as unknown as CompiledBaseTable;

/** A stand-in transaction: the stored rows matching any query, with their last operation. */
function storeOf(stored: { row: RowId; last: number }[], queries: string[] = []): Tx {
  return {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("src_event"))
        return {
          rows: stored.map((x) => ({ row_id: x.row, field_id: "f2", src_event: x.last, src_k: 0 })),
        };
      return { rows: stored.map((x) => ({ row_id: x.row, last: x.last })) };
    },
  } as unknown as Tx;
}
const mine = (v: Record<string, FieldValue>) =>
  new Map(Object.entries(v).map(([f, x]) => [F(f), x]));
const find = (tx: Tx, values: Record<string, FieldValue>, excluded?: Set<string>) =>
  findDuplicates(tx, {
    table: TABLE,
    self: row(99),
    mine: mine(values),
    requestRows: [],
    at: { upTo: 49 as never },
    op: 50 as never,
    ...(excluded !== undefined ? { excluded } : {}),
  });

describe("which writes are compared", () => {
  const judged = (created: boolean, statuses: string[]) =>
    ({
      created,
      record: { items: statuses.map((status, k) => ({ target: `f${k + 1}`, status })) },
    }) as unknown as Judgement;

  it("a row the judgement created, all its items applied: whatever the op's intent", () => {
    // The judgement has no intent: an insert, or an update creating a row by key, is the same.
    expect(createdInEffect(judged(true, ["applied", "applied"]))).toBe(true);
    // A corroboration is in effect too.
    expect(createdInEffect(judged(true, ["applied", "corroborated"]))).toBe(true);
  });

  it("not a row created; created but awaiting; nothing written", () => {
    expect(createdInEffect(judged(false, ["applied"]))).toBe(false);
    expect(createdInEffect(judged(true, ["awaiting", "awaiting"]))).toBe(false);
    expect(createdInEffect(judged(true, []))).toBe(false);
  });

  it("a state table has no duplicate keys", () => {
    expect(
      duplicateKeysOf({ ...TABLE, time: { type: "state", granularity: "date" } } as never),
    ).toEqual([]);
    expect(duplicateKeysOf(TABLE)).toEqual([["f1", "f2"], ["f2"]]);
  });
});

describe("a match", () => {
  it("every field of the group the same value; empty or absent on either side is none", () => {
    const g = [F("f1"), F("f2")];
    expect(
      matchesGroup(g, mine({ f1: "2026-11-01", f2: "x" }), mine({ f1: "2026-11-01", f2: "x" })),
    ).toBe(true);
    expect(
      matchesGroup(g, mine({ f1: "2026-11-01", f2: "x" }), mine({ f1: "2026-11-01", f2: "y" })),
    ).toBe(false);
    expect(
      matchesGroup(g, mine({ f1: "2026-11-01", f2: null }), mine({ f1: "2026-11-01", f2: null })),
    ).toBe(false);
    expect(matchesGroup(g, mine({ f1: "2026-11-01" }), mine({ f1: "2026-11-01", f2: "x" }))).toBe(
      false,
    );
    // Text is not folded (10 «同值判据»).
    expect(matchesGroup([F("f2")], mine({ f2: "Tea" }), mine({ f2: "tea" }))).toBe(false);
  });

  it("latest written first, then by row ID", () => {
    const xs = [
      { row: row(2), last: 10, deps: [] },
      { row: row(1), last: 10, deps: [] },
      { row: row(3), last: 30, deps: [] },
    ];
    expect([...xs].sort(byLatest).map((x) => x.row)).toEqual([row(3), row(1), row(2)]);
  });
});

describe("findDuplicates", () => {
  it("the first group whose fields the new row has; at most 10 rows, latest first", async () => {
    const stored = Array.from({ length: 12 }, (_, i) => ({ row: row(i), last: i + 1 }));
    // f1 empty: the first group is skipped; the second (f2) matches.
    const m = await find(storeOf(stored), { f1: null, f2: "x" });
    expect(m?.keys).toEqual(["f2"]);
    expect(m?.matched).toHaveLength(MATCHED_MAX);
    expect(m?.matched).toEqual(
      stored
        .slice(2)
        .reverse()
        .map((x) => x.row),
    );
    expect(m?.depsOf.get(row(11))).toEqual([{ event: 12, field: "f2", k: 0 }]);
  });

  it("both groups would match: the first in the schema's order is the one recorded", async () => {
    const m = await find(storeOf([{ row: row(1), last: 1 }]), { f1: "2026-11-01", f2: "x" });
    expect(m?.keys).toEqual(["f1", "f2"]);
  });

  it("no group the new row has every field of: nothing asked, nothing matched", async () => {
    const queries: string[] = [];
    expect(await find(storeOf([{ row: row(1), last: 1 }], queries), { f1: null })).toBeUndefined();
    expect(queries).toEqual([]);
  });

  it("rows in a confirmed deletion are left out (fixed case, until its apply leaves the tables as after it)", async () => {
    const tx = storeOf([
      { row: row(1), last: 5 },
      { row: row(2), last: 4 },
    ]);
    expect((await find(tx, { f1: "2026-11-01", f2: "x" }))?.matched).toEqual([row(1), row(2)]);
    expect((await find(tx, { f1: "2026-11-01", f2: "x" }, new Set([row(1)])))?.matched).toEqual([
      row(2),
    ]);
    expect(
      await find(tx, { f1: "2026-11-01", f2: "x" }, new Set([row(1), row(2)])),
    ).toBeUndefined();
  });
});
