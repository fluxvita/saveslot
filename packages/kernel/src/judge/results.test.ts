// What a deletion event says of a row (09 §5.9 `results`, `outcome`, `recreated`), on judged logs.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import type { Op, TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, STATE } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { itemsByRecords } from "./fates.ts";
import type { Restatement } from "./model.ts";
import { deletionResult } from "./replay-deletion.ts";
import { rowResult } from "./results.ts";
import { deletedContributions, judged } from "./scenarios.fixture.ts";
import { RowState } from "./state.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const w = (
  op: number,
  seen: number,
  fields: Record<string, string>,
  o: { from?: string; to?: string; explicit?: boolean; ack?: boolean; state?: boolean } = {},
): Op => ({
  kind: "write",
  op,
  event: op + 1,
  seen,
  ...(o.state === false
    ? {}
    : {
        valid: {
          from: { mode: "given", value: d(o.from ?? "10-01") },
          to: o.to === undefined ? { mode: "open" } : { mode: "given", value: d(o.to) },
        },
      }),
  fields: Object.fromEntries(
    Object.entries(fields).map(([f, value]) => [
      f,
      { value, sources: [`S${op}${f}`], ...(o.explicit ? { explicit: true } : {}) },
    ]),
  ) as never,
  ...(o.ack ? { acknowledge: ["overwrite"] as const } : {}),
});

function run(schema: TableSchema, ops: Op[], sources: string[], pending: string[] = []) {
  const { table, steps } = judged(schema, ops, []);
  expect(steps).toHaveLength(ops.length);
  const kept = steps.map((x) => x.op);
  const isState = schema.kind === "state";
  const all = deletedContributions(kept, new Set([...pending, ...sources]), isState);
  const before = deletedContributions(kept, new Set(pending), isState);
  return deletionResult(
    table,
    steps.map((x) => x.judgement.record),
    all,
    before,
    itemsByRecords(
      new RowState(
        table,
        steps.map((x) => x.judgement.record),
      ),
    ),
    () => [],
  );
}

describe("outcome", () => {
  it("state table, a value gone back to an earlier one: resegmented; the stretch listed with what cuts it", () => {
    const r = run(
      STATE,
      [w(10, 0, { f2: "1" }), w(20, 10, { f2: "2" }, { from: "11-01", ack: true })],
      ["S20f2"],
    );
    expect(r.outcome).toBe("resegmented");
    expect(r.result.stretches).toEqual([
      {
        field: "f2",
        j: 0,
        value: "1",
        carried: [{ event: 11, target: "f2", k: 0 }],
        valid: [{ from: d("10-01"), to: null }],
        deps: [{ event: 11, target: "f2", k: 0 }],
      },
    ]);
    // The gap before 10-01 is cut by #11 (09 §5.9: the revokes leaving it and what cuts it).
    expect(r.result.gaps).toEqual({
      gaps: [{ from: null, to: d("10-01") }],
      deps: [{ event: 11, target: "f2", k: 0 }],
    });
  });

  it("event table, a value gone back to an earlier one: fields_reverted, j = 0, no interval", () => {
    const r = run(
      EVENT,
      [
        w(10, 0, { f2: "1" }, { state: false }),
        w(20, 10, { f2: "2" }, { state: false, ack: true }),
      ],
      ["S20f2"],
    );
    expect(r.outcome).toBe("fields_reverted");
    expect(r.result.stretches).toEqual([
      { field: "f2", j: 0, value: "1", carried: [{ event: 11, target: "f2", k: 0 }], deps: [] },
    ]);
    expect(r.result.gaps).toBeUndefined();
  });

  it.each([
    ["state", STATE, true],
    ["event", EVENT, false],
  ] as const)("%s table, the only write deleted: deleted", (_, schema, state) => {
    const r = run(schema, [w(10, 0, { f2: "1" }, { state })], ["S10f2"]);
    expect(r.outcome).toBe("deleted");
    expect(r.result.stretches).toEqual([]);
  });

  it.each([
    ["state", STATE, true],
    ["event", EVENT, false],
  ] as const)(
    "%s table, an optional field's only value deleted: kept_fields_cleared",
    (_, schema, state) => {
      const r = run(
        schema,
        [w(10, 0, { f2: "1" }, { state }), w(20, 10, { f3: "x" }, { state })],
        ["S20f3"],
      );
      expect(r.outcome).toBe("kept_fields_cleared");
      expect(r.result.stretches.map((x) => [x.field, x.value])).toEqual([["f3", null]]);
    },
  );

  it.each([
    ["state", STATE, true],
    ["event", EVENT, false],
  ] as const)(
    "%s table, the same value from another write: sources_changed",
    (_, schema, state) => {
      // #20 points at evidence for the same value: a corroboration; #10's deleted, #20 gives it.
      const r = run(
        schema,
        [w(10, 0, { f2: "1" }, { state }), w(20, 10, { f2: "1" }, { state, explicit: true })],
        ["S10f2"],
      );
      expect(r.outcome).toBe("sources_changed");
      expect(r.result.stretches.map((x) => [x.field, x.value, x.carried])).toEqual([
        ["f2", "1", [{ event: 21, target: "f2", k: 0 }]],
      ]);
    },
  );

  it("state table, the row exists only after the deletion: fields_reverted", () => {
    const r = run(
      STATE,
      [
        w(10, 0, { f2: "1" }),
        {
          kind: "revoke",
          op: 20,
          event: 21,
          seen: 10,
          valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
          validSources: ["R20"],
        },
      ],
      ["R20"],
    );
    expect(r.result.existedBefore).toBe(false);
    expect(r.result.existsAfter).toBe(true);
    expect(r.outcome).toBe("fields_reverted");
  });

  it("nothing of the row changes: not listed", () => {
    const r = run(STATE, [w(10, 0, { f2: "1" }), w(20, 10, { f3: "x" })], ["S99"]);
    expect(r.result.listed).toBe(false);
    expect(r.outcome).toBeUndefined();
  });
});

describe("listing", () => {
  it("the creating write deleted, the row kept by a later write: recreated, every field listed", () => {
    // Event table: #10 creates with f2; #20 writes f2 and f3. S10 deleted: #20 creates the row.
    const r = run(
      EVENT,
      [
        w(10, 0, { f2: "1" }, { state: false }),
        w(20, 10, { f2: "1", f3: "x" }, { state: false, explicit: true }),
      ],
      ["S10f2"],
    );
    expect(r.result.recreated).toEqual([
      { event: 11, created: false },
      { event: 21, created: true },
    ]);
    expect(r.result.stretches.map((x) => x.field)).toEqual(["f2", "f3"]);
  });

  it("a revoke with an interval deleted: the row listed, the stretches meeting it, the gaps after", () => {
    const r = run(
      STATE,
      [
        w(10, 0, { f2: "1" }),
        {
          kind: "revoke",
          op: 20,
          event: 21,
          seen: 10,
          valid: {
            from: { mode: "given", value: d("11-01") },
            to: { mode: "given", value: d("11-05") },
          },
          validSources: ["R20"],
        },
      ],
      ["R20"],
    );
    expect(r.result.listed).toBe(true);
    expect(r.result.stretches.map((x) => [x.field, x.valid])).toEqual([
      ["f2", [{ from: d("10-01"), to: null }]],
    ]);
    expect(r.result.gaps?.gaps).toEqual([{ from: null, to: d("10-01") }]);
  });

  it("a deletion still pending before: the state before is its replay", () => {
    // S20 already deleted by a pending deletion; this one deletes S10: the row goes from #10's
    // value (as before) to nothing.
    const r = run(
      STATE,
      [w(10, 0, { f2: "1" }), w(20, 10, { f2: "2" }, { from: "11-01", ack: true })],
      ["S10f2"],
      ["S20f2"],
    );
    expect(r.result.existedBefore).toBe(true);
    expect(r.outcome).toBe("deleted");
  });
});

describe("listing, one rule at a time (the same state before and after)", () => {
  // #10 f2 = 1 from 10-01; #20 f2 = 2 from 11-05: two stretches, nothing changes.
  const { table, steps } = judged(
    STATE,
    [w(10, 0, { f2: "1" }), w(20, 10, { f2: "2" }, { from: "11-05", ack: true })],
    [],
  );
  const state = steps.at(-1)?.state as RowState;
  const stretches = (r: ReturnType<typeof rowResult>) => r.stretches.map((x) => [x.field, x.valid]);

  it("nothing changed, nothing restated, nothing touched: not listed", () => {
    expect(rowResult(state, state, [], undefined).listed).toBe(false);
  });

  it("a stretch given by a restated item is listed, the others not", () => {
    const restated: Restatement[] = [
      {
        item: { event: 21, target: "f2", k: 0 },
        status: "applied",
        valid: [{ from: d("11-05"), to: null }],
        deps: [],
      },
    ];
    expect(stretches(rowResult(state, state, restated, undefined))).toEqual([
      ["f2", [{ from: d("11-05"), to: null }]],
    ]);
  });

  it("existence items touched: the stretches meeting their intervals are listed, with the gaps", () => {
    const r = rowResult(state, state, [], [{ from: d("10-02"), to: d("10-03") }]);
    expect(stretches(r)).toEqual([["f2", [{ from: d("10-01"), to: d("11-05") }]]]);
    expect(r.gaps?.gaps).toEqual([{ from: null, to: d("10-01") }]);
    void table;
  });
});

describe("a stretch's deps", () => {
  it("the carried item and what cuts it at each end", () => {
    // #10 1 from 10-01; #20 2 on [11-01, 11-05); #30 3 from 11-05. S20 deleted: #11 gives
    // [10-01, 11-05), cut at 11-05 by #31.
    const r = run(
      STATE,
      [
        w(10, 0, { f2: "1" }),
        w(20, 10, { f2: "2" }, { from: "11-01", to: "11-05", ack: true }),
        w(30, 20, { f2: "3" }, { from: "11-05", ack: true }),
      ],
      ["S20f2"],
    );
    expect(r.result.stretches.map((x) => [x.valid, x.deps])).toEqual([
      [
        [{ from: d("10-01"), to: d("11-05") }],
        [
          { event: 11, target: "f2", k: 0 },
          { event: 31, target: "f2", k: 0 },
        ],
      ],
    ]);
  });
});

describe("gaps", () => {
  it("a listed entity gives every gap after, resting on the revokes leaving them and what cuts them", () => {
    // #20 revokes [11-01, 11-05); #30 writes 2 from 11-10. S30 deleted: listed; the gap
    // [11-01, 11-05) rests on #21 and on #11 cutting it at both ends.
    const r = run(
      STATE,
      [
        w(10, 0, { f2: "1" }),
        {
          kind: "revoke",
          op: 20,
          event: 21,
          seen: 10,
          valid: {
            from: { mode: "given", value: d("11-01") },
            to: { mode: "given", value: d("11-05") },
          },
        },
        w(30, 20, { f2: "2" }, { from: "11-10", ack: true }),
      ],
      ["S30f2"],
    );
    expect(r.result.gaps?.gaps).toEqual([
      { from: null, to: d("10-01") },
      { from: d("11-01"), to: d("11-05") },
    ]);
    expect(r.result.gaps?.deps).toContainEqual({ event: 21, target: "existence", k: 0 });
    // The stretch from 11-05 is cut at its start by the gap #21 leaves.
    const after = r.result.stretches.find((x) => x.valid?.[0]?.from === d("11-05"));
    expect(after?.deps).toContainEqual({ event: 21, target: "existence", k: 0 });
  });
});

describe("a stretch cut where a required field has no value (09 §3.5: the fields deciding has a value)", () => {
  // f2 required. #10 f2=1 from 10-01; #15 f2=2 from 10-20; #20 f3=x from 10-05. S10 deleted: the
  // entity has no value before 10-20, where #16 starts; the f3 stretch now starts there.
  const ops = [
    w(10, 0, { f2: "1" }),
    w(15, 10, { f2: "2" }, { from: "10-20", ack: true }),
    w(20, 15, { f3: "x" }, { from: "10-05" }),
  ];

  it("its deps name the required field's giver at the boundary", () => {
    const r = run(STATE, ops, ["S10f2"]);
    const f3 = r.result.stretches.find((x) => x.field === "f3");
    expect(f3?.valid).toEqual([{ from: d("10-20"), to: null }]);
    expect(f3?.deps).toEqual(
      expect.arrayContaining([
        { event: 21, target: "f3", k: 0 },
        { event: 16, target: "f2", k: 0 },
      ]),
    );
  });

  it("so a later deletion of that giver clears the block", () => {
    const first = run(STATE, ops, ["S10f2"]);
    const second = run(STATE, ops, ["S15f2"], ["S10f2"]);
    const gone = new Set([
      ...deletedContributions(
        judged(STATE, ops, []).steps.map((x) => x.op),
        new Set(["S15f2"]),
        true,
      ),
      ...second.replay.restated.map((x) => `${x.item.event}/${x.item.target}`),
    ]);
    for (const b of first.result.stretches) {
      expect({
        f: b.field,
        cleared: b.deps.some((x) => gone.has(`${x.event}/${x.target}`)),
      }).toEqual({
        f: b.field,
        cleared: true,
      });
    }
  });

  it("an optional field's only write deleted: listed as none, resting on what makes the entity", () => {
    const r = run(
      STATE,
      [w(10, 0, { f2: "1" }), w(20, 10, { f3: "x" }, { from: "11-01" })],
      ["S20f3"],
    );
    expect(r.result.stretches).toEqual([
      {
        field: "f3",
        j: 0,
        value: null,
        carried: [],
        valid: [{ from: d("10-01"), to: null }],
        deps: [{ event: 11, target: "f2", k: 0 }],
      },
    ]);
  });
});

describe("a no_value write-back's stretch (09 §5.9 «列哪些»: class 2, deps name it)", () => {
  it("restated by the deletion: listed as none, its deps naming the write-back", () => {
    // #15 f3=y from 11-01; #20 f3=x from 10-01 to the next change; #30 undoes #20: a no_value
    // write-back on f3. S15f3 deleted: #20's interval runs on, and the write-back with it.
    const ops: Op[] = [
      w(10, 0, { f2: "1" }),
      w(15, 10, { f3: "y" }, { from: "11-01" }),
      {
        ...w(20, 15, { f3: "x" }),
        valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "next_change" } },
      } as Op,
      { kind: "undo", op: 30, event: 31, target: 20, includeLater: false } as Op,
    ];
    const r = run(STATE, ops, ["S15f3"]);
    expect(r.replay.restated.map((x) => [x.item, x.content?.kind ?? "value"])).toContainEqual([
      { event: 31, target: "f3", k: 0 },
      "no_value",
    ]);
    const f3 = r.result.stretches.find((x) => x.field === "f3");
    expect(f3).toMatchObject({ value: null, carried: [], valid: [{ from: d("10-01"), to: null }] });
    expect(f3?.deps).toContainEqual({ event: 31, target: "f3", k: 0 });
  });

  it("the same state before and after, the write-back only restated: listed", () => {
    const { table, steps } = judged(
      STATE,
      [
        w(10, 0, { f2: "1" }),
        w(20, 10, { f3: "x" }),
        { kind: "undo", op: 30, event: 31, target: 20, includeLater: false } as Op,
      ],
      [],
    );
    const state = new RowState(
      table,
      steps.map((x) => x.judgement.record),
    );
    const wb = state.items.find((x) => x.event === 31);
    expect(wb?.content.kind).toBe("no_value");
    const restated = [
      {
        item: { event: 31, target: wb?.target, k: wb?.k },
        status: "applied",
        valid: wb?.valid,
        deps: [],
        content: { kind: "no_value" },
      },
    ] as unknown as Restatement[];
    const res = rowResult(state, state, restated, undefined);
    expect(res.listed).toBe(true);
    expect(res.stretches.map((x) => [x.field, x.value, x.deps])).toContainEqual([
      "f3",
      null,
      expect.arrayContaining([{ event: 31, target: "f3", k: 0 }]),
    ]);
  });
});

describe("a deletion still pending before this one (the state before is its replay)", () => {
  it("the same source pending and deleted again: nothing new, not listed", () => {
    const ops = [
      w(10, 0, { f2: "1" }),
      w(20, 10, { f2: "2" }, { from: "11-01", ack: true }),
      w(30, 20, { f2: "3" }, { from: "11-10", ack: true }),
    ];
    const r = run(STATE, ops, ["S30f2"], ["S30f2"]);
    expect(r.result.listed).toBe(false);
    expect(r.outcome).toBeUndefined();
    // Against the records as written, the same deletion lists the row.
    expect(run(STATE, ops, ["S30f2"]).result.listed).toBe(true);
  });

  it("a revoke's interval source pending and deleted again: its existence item not touched again", () => {
    const rv = {
      kind: "revoke",
      op: 20,
      event: 21,
      seen: 10,
      valid: {
        from: { mode: "given", value: d("11-01") },
        to: { mode: "given", value: d("11-05") },
      },
      validSources: ["R20"],
    } as Op;
    const ops = [w(10, 0, { f2: "1" }), rv];
    const r = run(STATE, ops, ["R20"], ["R20"]);
    expect(r.result.listed).toBe(false);
    expect(run(STATE, ops, ["R20"]).result.listed).toBe(true);
  });
});

describe("a stretch's deps at its ends, by the definition (09 §3.5)", () => {
  it("a covered contribution with an end there counts", () => {
    // #10 f2=1 from 10-01; #20 f2=2 on [11-01, 11-10); #30 f2=3 on the same stretch, over #20.
    // #30's stretch, listed by a restatement of it: at both ends #20 ends too, covered.
    const { table, steps } = judged(
      STATE,
      [
        w(10, 0, { f2: "1" }),
        w(20, 10, { f2: "2" }, { from: "11-01", to: "11-10", ack: true }),
        w(30, 20, { f2: "3" }, { from: "11-01", to: "11-10", ack: true }),
      ],
      [],
    );
    const state = new RowState(
      table,
      steps.map((x) => x.judgement.record),
    );
    const it30 = state.items.find((x) => x.event === 31);
    const restated = [
      {
        item: { event: 31, target: "f2", k: it30?.k },
        status: "applied",
        valid: it30?.valid,
        deps: [],
      },
    ] as unknown as Restatement[];
    const s = rowResult(state, state, restated, undefined).stretches.find(
      (x) => x.valid?.[0]?.from === d("11-01"),
    );
    expect(s?.carried).toEqual([{ event: 31, target: "f2", k: 0 }]);
    expect(s?.deps).toContainEqual({ event: 21, target: "f2", k: 0 });
  });

  it("an existence item with an end there counts, covered or not", () => {
    // #10 f2=1 from 10-01; #20 revokes [11-01, 11-05); #30, having seen #20, fills the hole and
    // runs on: f2=3 from 11-01. #10's stretch ends at 11-01, where #30 starts and #20 starts too.
    const { table, steps } = judged(
      STATE,
      [
        w(10, 0, { f2: "1" }),
        {
          kind: "revoke",
          op: 20,
          event: 21,
          seen: 10,
          valid: {
            from: { mode: "given", value: d("11-01") },
            to: { mode: "given", value: d("11-05") },
          },
        } as Op,
        w(30, 20, { f2: "3" }, { from: "11-01", ack: true }),
      ],
      [],
    );
    expect(steps).toHaveLength(3);
    const state = new RowState(
      table,
      steps.map((x) => x.judgement.record),
    );
    const it10 = state.items.find((x) => x.event === 11);
    const restated = [
      {
        item: { event: 11, target: "f2", k: it10?.k },
        status: "applied",
        valid: it10?.valid,
        deps: [],
      },
    ] as unknown as Restatement[];
    const s = rowResult(state, state, restated, undefined).stretches.find(
      (x) => x.carried[0]?.event === 11,
    );
    expect(s?.valid).toEqual([{ from: d("10-01"), to: d("11-01") }]);
    expect(s?.deps).toContainEqual({ event: 21, target: "existence", k: 0 });
  });

  it("a no_value write-back's stretch names it, also where neither of its ends is the write-back's", () => {
    // #20 f3=x from 10-01; #30 undoes it: a no_value write-back on f3 from 10-01 on. #40 f3=y on
    // [10-01, 10-05), #50 f3=z from 11-01: the write-back shows on [10-05, 11-01) only.
    const { table, steps } = judged(
      STATE,
      [
        w(10, 0, { f2: "1" }),
        w(20, 10, { f3: "x" }),
        { kind: "undo", op: 30, event: 31, target: 20, includeLater: false } as Op,
        w(40, 31, { f3: "y" }, { to: "10-05", ack: true }),
        w(50, 41, { f3: "z" }, { from: "11-01", ack: true }),
      ],
      [],
    );
    expect(steps).toHaveLength(5);
    const state = new RowState(
      table,
      steps.map((x) => x.judgement.record),
    );
    const wb = state.items.find((x) => x.event === 31);
    expect(wb?.content.kind).toBe("no_value");
    const restated = [
      {
        item: { event: 31, target: "f3", k: wb?.k },
        status: "applied",
        valid: wb?.valid,
        deps: [],
        content: { kind: "no_value" },
      },
    ] as unknown as Restatement[];
    const s = rowResult(state, state, restated, undefined).stretches.find((x) => x.field === "f3");
    expect(s).toMatchObject({
      value: null,
      carried: [],
      valid: [{ from: d("10-05"), to: d("11-01") }],
    });
    expect(s?.deps).toContainEqual({ event: 31, target: "f3", k: 0 });
  });
});

describe("a stretch that becomes a gap, every field's stretches as they were", () => {
  // #10 f2=1, f3=a from 10-01; #20 revokes [11-01, 11-07); #30 (seen #10) writes f2=2 there: a
  // candidate (it met the revoke); #40 (seen #20) writes f2=1 from 11-01 to the next change,
  // filling the gap. Deleting S30 and S40 leaves [11-01, 11-07) a gap again: no field's stretch
  // changed where there still is one, but the entity differs, so it is listed and the gap given
  // with `existence` (09 §5.9 «列哪些»).
  const ops: Op[] = [
    w(10, 0, { f2: "1", f3: "a" }),
    {
      kind: "revoke",
      op: 20,
      event: 21,
      seen: 10,
      valid: {
        from: { mode: "given", value: d("11-01") },
        to: { mode: "given", value: d("11-07") },
      },
    } as Op,
    w(30, 10, { f2: "2" }, { from: "11-01", to: "11-07" }),
    {
      ...w(40, 20, { f2: "1" }, { from: "11-01", ack: true }),
      valid: { from: { mode: "given", value: d("11-01") }, to: { mode: "next_change" } },
    } as Op,
  ];
  it("listed, with the gap", () => {
    const r = run(STATE, ops, ["S30f2", "S40f2"]);
    expect(r.result.listed).toBe(true);
    expect(r.result.gaps?.gaps).toContainEqual({ from: d("11-01"), to: d("11-07") });
    expect(r.outcome).toBe("resegmented");
  });
});
