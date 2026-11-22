// The order notices come in and are cut by (04-contract §13): deletion_overdue, migration_progress,
// schema_updated, pending_items; each kind's own order kept; at most three.

import { describe, expect, it } from "vitest";
import { orderedNotices } from "./operations.ts";

const n = (code: string, slot: string) => ({ code, slot });

describe("orderedNotices", () => {
  it("by kind, then as each kind came; three at most", () => {
    expect(
      orderedNotices([
        n("pending_items", "a"),
        n("pending_items", "b"),
        n("schema_updated", "b"),
        n("deletion_overdue", "c"),
        n("schema_updated", "a"),
      ]),
    ).toEqual([n("deletion_overdue", "c"), n("schema_updated", "b"), n("schema_updated", "a")]);
    expect(
      orderedNotices([
        n("pending_items", "a"),
        n("migration_progress", "a"),
        n("schema_updated", "a"),
      ]),
    ).toEqual([n("migration_progress", "a"), n("schema_updated", "a"), n("pending_items", "a")]);
    expect(orderedNotices([])).toEqual([]);
  });
});
