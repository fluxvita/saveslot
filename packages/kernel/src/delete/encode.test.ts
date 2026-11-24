// A restatement as the deletion event writes it (09 §5.9 `restated/<k>`): a carried item's new
// value names what it carries in `deps` too, on every kind of table (09 §5.9, the `value` and
// `sources` row; §3.5 rule 1), so that a later deletion of what it carries lists the block.

import type { FieldId, Seq } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import type { Restatement } from "../judge/index.ts";
import { restatementOut } from "./encode.ts";

const f2 = "f2" as FieldId;

describe("restatementOut", () => {
  it("event table, a take's or a revert's carried item with a new value: deps name what it carries", () => {
    // Judge gives an event or timeless table's restatement no deps; the carried item is in them.
    const r: Restatement = {
      item: { event: 51 as Seq, target: f2, k: 0 },
      status: "applied",
      deps: [],
      content: { kind: "value", value: "3" },
      carried: [{ event: 31 as Seq, target: f2, k: 0 }],
    };
    expect(restatementOut(r)).toEqual({
      event: 51,
      field: "f2",
      k: 0,
      status: "applied",
      deps: [{ event: 31, field: "f2", k: 0 }],
      value: "3",
      sources: [{ kind: "value", carried: { event: 31, field: "f2", k: 0 } }],
    });
  });

  it("a write-back with no value carries nothing: no deps of its own", () => {
    const r: Restatement = {
      item: { event: 61 as Seq, target: f2, k: 0 },
      status: "applied",
      deps: [],
      content: { kind: "no_value" },
    };
    expect(restatementOut(r)).toEqual({
      event: 61,
      field: "f2",
      k: 0,
      status: "applied",
      no_value: true,
    });
  });
});
