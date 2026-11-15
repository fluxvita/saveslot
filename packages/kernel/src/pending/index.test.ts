// The entry blocks of an item event (09-event-format §5.8): the interval as its spans, never their
// hull; entries on the unit "existence" of both kinds.

import { describe, expect, it } from "vitest";
import { contentBlocks } from "./index.ts";

const dep = { event: 7, target: "f2", k: 0 };

describe("contentBlocks", () => {
  it("an interval of several spans is given span by span", () => {
    expect(
      contentBlocks({
        scope: {
          valid: [
            { from: "2026-11-05", to: "2026-11-07" },
            { from: "2026-11-12", to: null },
          ],
          deps: [dep],
        },
      }),
    ).toEqual({
      scope_valid: {
        spans: [{ from: "2026-11-05", to: "2026-11-07" }, { from: "2026-11-12" }],
        deps: [{ event: 7, field: "f2", k: 0 }],
      },
    });
  });

  it("no spans, no scope_valid", () => {
    expect(contentBlocks({ scope: { valid: [], deps: [dep] } })).toEqual({});
  });

  it("existence: a revoked stretch with its revoke, a stretch with a value without op", () => {
    expect(
      contentBlocks({
        current: [
          {
            field: "existence",
            revoked: true,
            valid: { from: "2026-11-05", to: "2026-11-07" },
            op: 9,
            deps: [{ event: 9, target: "existence", k: 0 }],
          },
          { field: "existence", valid: { from: "2026-11-07", to: null }, deps: [dep] },
        ],
      }),
    ).toEqual({
      "current/0": {
        field: "existence",
        revoked: true,
        op: 9,
        valid: { from: "2026-11-05", to: "2026-11-07" },
        deps: [{ event: 9, existence: 0 }],
      },
      "current/1": {
        field: "existence",
        valid: { from: "2026-11-07" },
        deps: [{ event: 7, field: "f2", k: 0 }],
      },
    });
  });

  it("a gap filled: an overwritten stretch without a value, its op only when a revoke left it", () => {
    expect(
      contentBlocks({
        impact: [
          { kind: "overwritten_segment", field: "f2", value: null, op: 9, deps: [dep] },
          { kind: "overwritten_segment", field: "f2", value: null, deps: [dep] },
        ],
      }),
    ).toEqual({
      "impact/0": {
        kind: "overwritten_segment",
        field: "f2",
        value: null,
        op: 9,
        deps: [{ event: 7, field: "f2", k: 0 }],
      },
      "impact/1": {
        kind: "overwritten_segment",
        field: "f2",
        value: null,
        deps: [{ event: 7, field: "f2", k: 0 }],
      },
    });
  });
});
