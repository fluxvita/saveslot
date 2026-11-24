// `referableIn`: a table may be referred to when a ref field names it in any schema version
// the slot has had, not only the current one.

import type { CompiledSchema, TableId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { referableIn, replayShape } from "./plan.ts";

const table = (id: string, refTo?: string) => ({
  id,
  name: id,
  kind: "base",
  description: id,
  time: { type: "none" },
  physical: { table: `t_${id}_v1` },
  fields: [
    { id: `${id}a`, name: "a", type: "text", description: "a" },
    ...(refTo !== undefined
      ? [
          {
            id: `${id}r`,
            name: "r",
            type: "ref",
            description: "r",
            ref: { table: refTo, target: "row" },
          },
        ]
      : []),
  ],
});
const version = (...tables: ReturnType<typeof table>[]) =>
  ({ tables }) as unknown as CompiledSchema;

describe("referableIn", () => {
  it("a ref field naming the table, in some version: referable; none in any: not", () => {
    const v1 = version(table("t1"), table("t2", "t1"));
    const v2 = version(table("t1"), table("t2"));
    expect(referableIn([v2], "t1" as TableId)).toBe(false);
    expect(referableIn([v1, v2], "t1" as TableId)).toBe(true);
    expect(referableIn([v1, v2], "t2" as TableId)).toBe(false);
  });

  it("a table referring to itself is referable", () => {
    expect(referableIn([version(table("t1", "t1"))], "t1" as TableId)).toBe(true);
  });
});

describe("replayShape", () => {
  it("gives referable always, from every version", () => {
    const v1 = version(table("t1"), table("t2", "t1"));
    const v2 = version(table("t1"), table("t2"));
    const t1 = v2.tables[0] as never;
    expect(replayShape(t1, [v2]).referable).toBe(false);
    expect(replayShape(t1, [v1, v2]).referable).toBe(true);
  });
});
