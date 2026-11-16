// The pure pieces of the write pipeline: a compiled table as judge sees it, whether a write must
// refresh derived tables (K5), the visibility check point, and today in the slot's time zone.

import { describe, expect, it } from "vitest";
import { tableShape, todayIn, writable } from "./plan.ts";

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
