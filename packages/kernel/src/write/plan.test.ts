// The pure pieces of the write pipeline: a compiled table as judge sees it, whether a write must
// refresh derived tables (K5), the visibility check point, and today in the slot's time zone.

import { describe, expect, it } from "vitest";
import { COMPILED_V1 } from "../apply/slot.fixture.ts";
import { refreshesDerived, tableShape, todayIn, writable } from "./plan.ts";

const field = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: id,
  type: "text",
  description: id,
  ...extra,
});

describe("tableShape", () => {
  it("kinds by time type; required fields, valued without constant backfills; groups", () => {
    const t = {
      id: "t1",
      name: "x",
      kind: "base",
      description: "x",
      physical: { table: "t_t1_v1" },
      time: { type: "state", granularity: "date" },
      fields: [
        field("f1", { required: true }),
        field("f2", { required: true, backfill: { const: "a" } }),
        field("f3"),
      ],
      together: [["f1", "f3"]],
    };
    expect(tableShape(t as never)).toEqual({
      kind: "state",
      fields: ["f1", "f2", "f3"],
      valued: ["f1"],
      required: ["f1", "f2"],
      groups: [["f1", "f3"]],
    });
    expect(tableShape({ ...t, time: { type: "none" } } as never).kind).toBe("timeless");
    expect(tableShape({ ...t, time: { type: "event", field: "f1" } } as never).kind).toBe("event");
  });
});

describe("refreshesDerived", () => {
  const derived = (dependency: string, table = "t1") => ({
    id: "t9",
    name: "d",
    kind: "derived",
    description: "d",
    physical: { table: "t_t9_v1" },
    fields: [],
    rule: {
      id: "r1",
      version: 1,
      rsql: "rsql@1",
      sql: "SELECT 1",
      time_dependency: dependency,
      depends_on: [{ table, field: "f1" }],
      scope: { kind: "tenant" },
    },
  });
  const with_ = (...tables: unknown[]) => ({ ...COMPILED_V1, tables }) as never;
  it("only when a kept rule reads the table", () => {
    expect(refreshesDerived(with_(derived("bucketed")), "t1" as never)).toBe(true);
    expect(refreshesDerived(with_(derived("none")), "t1" as never)).toBe(true);
    // Computed at read time: nothing kept, nothing to refresh.
    expect(refreshesDerived(with_(derived("now")), "t1" as never)).toBe(false);
    // A derived table reading another table.
    expect(refreshesDerived(with_(derived("bucketed", "t2")), "t1" as never)).toBe(false);
    expect(refreshesDerived(with_(), "t1" as never)).toBe(false);
  });
});

describe("writable and todayIn", () => {
  it("visibility all passes; anything else does not (scoped visibility is not implemented)", () => {
    expect(writable({ kind: "all" }, "sl", "t1")).toBe(true);
    expect(writable({ kind: "scoped" }, "sl", "t1")).toBe(false);
  });
  it("the date in the slot's time zone", () => {
    expect(todayIn("2026-11-04T17:30:00.000Z", "Asia/Shanghai")).toBe("2026-11-05");
    expect(todayIn("2026-11-04T17:30:00.000Z", "UTC")).toBe("2026-11-04");
    expect(todayIn("2026-11-05T03:00:00.000Z", "America/Los_Angeles")).toBe("2026-11-04");
  });
});
