// Input marks of derived rows (04-contract.md §7) against a fake transaction and rule evaluation:
// a member whose group key does not decode is skipped, other errors are not; with no flags on the
// table the members are not asked for.

import type { CompiledDerivedTable } from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { RuleEvaluationError } from "../rules/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { inputMarks } from "./derived.ts";

const item = (c: string) => `pi_${c.repeat(16)}`;
const table = {
  id: "t9",
  rule: { depends_on: [{ table: "t1", field: "f2" }] },
} as unknown as CompiledDerivedTable;
const key = canonicalize(["a"]);

/** Answers the flags query with `flags` and the members query with `members`; records the SQL. */
function fakeTx(
  flags: { row_id: string; flag: string; item_id: string; fields: string | null }[],
  members: { row_id: string; k: string }[],
) {
  const asked: string[] = [];
  const tx: ReadTx = {
    async query<R>(sql: string) {
      asked.push(sql);
      const rows = sql.includes("FROM flags")
        ? flags.map((f) => ({ ...f, spans: null, type: null }))
        : members;
      return { rows: rows as R[] } as never;
    },
  };
  return { tx, asked };
}

/** Decodes a member's key from `k`; `bad` does not decode, `boom` fails otherwise. */
const evaluation = {
  base: "t1",
  membersAmong: (rows: readonly string[]) => ({
    sql: "SELECT members",
    params: [[...rows]] as const,
  }),
  decodeMember(r: Readonly<Record<string, unknown>>) {
    if (r["k"] === "bad") throw new RuleEvaluationError("f1" as never, "date_out_of_range", "bad");
    if (r["k"] === "boom") throw new Error("boom");
    return { key: [r["k"]] as never, row: r["row_id"] as string };
  },
} as never;

describe("input marks", () => {
  it("a member whose key does not decode is skipped; the others still count", async () => {
    const { tx } = fakeTx(
      [
        { row_id: "r1", flag: "disputed", item_id: item("A"), fields: '["f2"]' },
        { row_id: "r2", flag: "awaiting", item_id: item("B"), fields: '["f2"]' },
      ],
      [
        { row_id: "r1", k: "bad" },
        { row_id: "r2", k: "a" },
      ],
    );
    const marks = await inputMarks(tx, evaluation, table, [key]);
    expect(marks.get(key)).toEqual({
      disputed: 0,
      awaiting: 1,
      flagged: 0,
      premise_changed: 0,
      items: [item("B")],
    });
  });

  it("any other error of a member is not swallowed", async () => {
    const { tx } = fakeTx(
      [{ row_id: "r1", flag: "disputed", item_id: item("A"), fields: '["f2"]' }],
      [{ row_id: "r1", k: "boom" }],
    );
    await expect(inputMarks(tx, evaluation, table, [key])).rejects.toThrow("boom");
  });

  it("no flags on the fields the rule depends on: all 0, members not asked for", async () => {
    const { tx, asked } = fakeTx(
      [{ row_id: "r1", flag: "disputed", item_id: item("A"), fields: '["f4"]' }],
      [{ row_id: "r1", k: "a" }],
    );
    const marks = await inputMarks(tx, evaluation, table, [key]);
    expect(marks.get(key)).toEqual({
      disputed: 0,
      awaiting: 0,
      flagged: 0,
      premise_changed: 0,
      items: [],
    });
    expect(asked.some((s) => s.includes("SELECT members"))).toBe(false);
  });

  it("the members asked for are the flagged rows only", async () => {
    const among: string[][] = [];
    const e = {
      ...(evaluation as object),
      membersAmong: (rows: readonly string[]) => {
        among.push([...rows]);
        return { sql: "SELECT members", params: [[...rows]] as const };
      },
    } as never;
    const { tx } = fakeTx(
      [
        { row_id: "r2", flag: "disputed", item_id: item("A"), fields: null },
        { row_id: "r3", flag: "disputed", item_id: item("B"), fields: '["f4"]' },
      ],
      [{ row_id: "r2", k: "a" }],
    );
    await inputMarks(tx, e, table, [key]);
    expect(among).toEqual([["r2"]]);
  });
});
