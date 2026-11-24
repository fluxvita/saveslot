// The item layer of a deletion (fates.ts), on judged logs.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import type { Op, TableSchema } from "@fluxvita/saveslot-reference";
import { STATE } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { advance, openItems } from "./fates.fixture.ts";
import { type ItemsGiven, itemsByRecords, itemsResult, pendingIn } from "./fates.ts";
import { contributionKey } from "./model.ts";
import { deletionResult, replayDeletion } from "./replay-deletion.ts";
import { type Decision, deletedContributions, judged } from "./scenarios.fixture.ts";
import { RowState } from "./state.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const w = (
  op: number,
  seen: number,
  fields: Record<string, string>,
  o: { from?: string; to?: string; ack?: boolean } = {},
): Op => ({
  kind: "write",
  op,
  event: op + 1,
  seen,
  now: d("11-05"),
  valid: {
    from: { mode: "given", value: d(o.from ?? "10-01") },
    to: o.to === undefined ? { mode: "open" } : { mode: "given", value: d(o.to) },
  },
  fields: Object.fromEntries(
    Object.entries(fields).map(([f, value]) => [f, { value, sources: [`S${op}${f}`] }]),
  ) as never,
  ...(o.ack ? { acknowledge: ["overwrite"] as const } : {}),
});

/** The log judged, the sources deleted (`pending`: by deletions still pending before this one). */
function run(
  ops: Op[],
  sources: string[],
  o: {
    pending?: string[];
    items?: (s: RowState) => ItemsGiven;
    schema?: TableSchema;
    decisions?: Decision[];
  } = {},
) {
  const schema = o.schema ?? STATE;
  const { table, steps } = judged(schema, ops, o.decisions ?? []);
  expect(steps).toHaveLength(ops.length + (o.decisions?.length ?? 0));
  const kept = steps.map((x) => x.op);
  const isState = schema.kind === "state";
  const pending = o.pending ?? [];
  const all = deletedContributions(kept, new Set([...pending, ...sources]), isState);
  const before = deletedContributions(kept, new Set(pending), isState);
  const records = steps.map((x) => x.judgement.record);
  const written = new RowState(table, records);
  const res = deletionResult(table, records, all, before, (o.items ?? itemsByRecords)(written), []);
  return { ...res, records, written, table };
}

const fates = (r: ReturnType<typeof run>) =>
  Object.fromEntries([...r.items.fates].map(([k, f]) => [k, f]));

// #10 f2=1; #20, having seen #10, writes 2; #30, having seen only #10, writes 3: a candidate
// against #20 (03-deletion «推论» r11).
const conflict = [w(10, 0, { f2: "1" }), w(20, 10, { f2: "2" }), w(30, 10, { f2: "3" })];

describe("an item's candidates", () => {
  it("s_17: the only candidate's source deleted — removed, the item superseded", () => {
    const r = run(conflict, ["S30f2"]);
    expect(fates(r)).toEqual({ "31/f2": { kind: "removed", item: "31:f2" } });
    expect(r.items.superseded).toEqual(["31:f2"]);
    expect(r.items.refreshed).toEqual([]);
    expect(r.items.opened).toEqual([]);
  });

  // #40, having seen only #10 too, writes 4: a second candidate, in the same item.
  const two = [...conflict, w(40, 10, { f2: "4" })];
  const oneItem = (s: RowState): ItemsGiven => {
    const g = itemsByRecords(s);
    return {
      original: new Map([...g.of].map(([k]) => [k, "pi_a"])),
      of: new Map([...g.of].map(([k]) => [k, "pi_a"])),
      items: new Map([
        [
          "pi_a",
          { kind: "conflict", unit: { fields: ["f2" as never] }, standing: { kind: "open" } },
        ],
      ]),
    };
  };

  it("two candidates, one's source deleted — removed, the item refreshed and still pending", () => {
    const r = run(two, ["S40f2"], { items: oneItem });
    // #31 in the same open item before and after: no fate.
    expect(fates(r)).toEqual({ "41/f2": { kind: "removed", item: "pi_a" } });
    expect(r.items.superseded).toEqual([]);
    expect(r.items.refreshed).toEqual([
      { item: "pi_a", cause: "entries_deleted", left: ["41/f2"], back: [] },
    ]);
  });

  it("the value in effect deleted — the only candidate takes effect, the item superseded", () => {
    const r = run(conflict, ["S20f2"]);
    expect(fates(r)).toEqual({ "31/f2": { kind: "now_effective", item: "31:f2" } });
    expect(r.items.superseded).toEqual(["31:f2"]);
  });

  it("the value in effect deleted, two candidates — one takes effect, the other has no fate: refreshed, the item still pending", () => {
    const r = run(two, ["S20f2"], { items: oneItem });
    expect(fates(r)).toEqual({
      "31/f2": { kind: "now_effective", item: "pi_a" },
    });
    expect(r.items.superseded).toEqual([]);
    expect(r.items.refreshed).toEqual([
      { item: "pi_a", cause: "entries_deleted", left: ["31/f2"], back: [] },
    ]);
    expect(r.items.opened).toEqual([]);
  });

  it("nothing of the item touched — no fate changes the item", () => {
    const r = run([...conflict, w(50, 49, { f3: "x" })], ["S50f3"]);
    expect(fates(r)).toEqual({});
    expect(r.items.superseded).toEqual([]);
    expect(r.items.refreshed).toEqual([]);
  });
});

describe("a change of kind", () => {
  // #10 f2=5000; #20 from 11-10 writes 4000 (a change point); #25, having seen #20, writes 6000
  // on [10-20, 11-10); #30, having seen #20 only, from 11-02 open: a candidate against #25, and it
  // erases #20's change point.
  const log = [
    w(10, 0, { f2: "5000" }),
    w(20, 10, { f2: "4000" }, { from: "11-10" }),
    w(25, 20, { f2: "6000" }, { from: "10-20", to: "11-10" }),
    w(30, 20, { f2: "7000" }, { from: "11-02" }),
  ];

  it("as judged: #30 a candidate", () => {
    const r = run(log, []);
    expect(r.records[3]).toMatchObject({ items: [{ target: "f2", status: "candidate" }] });
  });

  it("the conflict deleted, still of high impact — succeeded by an awaiting item, conflict_cleared_by_deletion", () => {
    const r = run(log, ["S25f2"]);
    expect(fates(r)).toEqual({
      "31/f2": { kind: "succeeded", item: "31:f2", succeeds: "31:f2", as: "awaiting" },
    });
    expect(r.items.superseded).toEqual(["31:f2"]);
    expect(r.items.opened).toEqual([
      {
        succeeds: "31:f2",
        kind: "awaiting",
        unit: { fields: ["f2"] },
        reason: "conflict_cleared_by_deletion",
        members: ["31/f2"],
      },
    ]);
  });
});

describe("the two cases of the candidate level left to the item level (checklist #2, #3)", () => {
  it("#2: a candidate an undo's record covers is no pending item, before or after", () => {
    // As replay-deletion.test.ts: #20's f2 a candidate, its f3 in effect; #30 undoes #20.
    const ops: Op[] = [
      w(5, 0, { f2: "0" }),
      w(10, 5, { f2: "1" }),
      w(20, 5, { f2: "2", f3: "x" }),
      { kind: "undo", op: 30, event: 31, target: 20, seen: 29, acknowledge: ["overwrite"] },
    ];
    const r = run(ops, ["S10f2"]);
    expect(r.records[2]).toMatchObject({
      items: [
        { target: "f2", status: "candidate" },
        { target: "f3", status: "applied" },
      ],
    });
    // Pending before (a conflict item); after, it takes effect and the undo's record takes it back
    // over the whole of it: it leaves pending, and its item is superseded, no item opened.
    expect(fates(r)).toEqual({ "21/f2": { kind: "closed_by_revert", item: "21:f2" } });
    expect(r.items.superseded).toEqual(["21:f2"]);
    expect(r.items.opened).toEqual([]);
    expect(r.items.restored).toEqual([]);
  });

  it("#3: the item a later write overwrote stays superseded; the candidate is in no open item before or after, no fate", () => {
    const ops = [
      w(5, 0, { f2: "0" }),
      w(10, 5, { f2: "1" }),
      w(20, 5, { f2: "2" }),
      w(30, 20, { f2: "3" }),
    ];
    const overwritten = (s: RowState): ItemsGiven => {
      const g = itemsByRecords(s);
      return {
        original: g.of,
        of: g.of,
        items: new Map(
          [...g.items].map(([id, x]) => [
            id,
            id === "21:f2" ? { ...x, standing: { kind: "superseded", reason: "overwritten" } } : x,
          ]),
        ),
      };
    };
    const r = run(ops, ["S30f2"], { items: overwritten });
    // At the candidate level it is a candidate on both sides; its item closed for another reason
    // than a deletion: its pending membership does not change, nothing is said (a fate only for what the deletion moves).
    expect(fates(r)).toEqual({});
    expect(r.items.superseded).toEqual([]);
    expect(r.items.restored).toEqual([]);
    expect(r.items.opened).toEqual([]);
  });
});

describe("pending again after an earlier deletion put it in effect", () => {
  // The classification alone, on two states: before, #30 in effect (an earlier deletion of #20's
  // value, its item superseded as deleted); after, a candidate again.
  const { table, steps } = judged(STATE, conflict, []);
  const records = steps.map((x) => x.judgement.record);
  const asWritten = new RowState(table, records);
  const earlier = replayDeletion(table, records, new Set([contributionKey(21, "f2")])).state;
  const given = (standing: { kind: "superseded"; reason: string } | { kind: "resolved" }) => {
    const g = itemsByRecords(asWritten);
    return {
      original: g.of,
      of: g.of,
      items: new Map([...g.items].map(([id, x]) => [id, { ...x, standing }])),
    };
  };

  it("its item superseded as deleted, the same kind — restored", () => {
    const r = itemsResult(
      earlier,
      asWritten,
      records,
      given({ kind: "superseded", reason: "deleted" }),
    );
    expect(Object.fromEntries(r.fates)).toEqual({
      "31/f2": { kind: "restored", item: "31:f2", restores: "31:f2" },
    });
    expect(r.restored).toEqual(["31:f2"]);
    expect(r.opened).toEqual([]);
  });

  it("its item resolved — closed before and after, no fate, nothing opened", () => {
    const r = itemsResult(earlier, asWritten, records, given({ kind: "resolved" }));
    expect(Object.fromEntries(r.fates)).toEqual({});
    expect(r.opened).toEqual([]);
  });

  it("its item still open (refreshed when it left) — back in it: refreshed again, not superseded", () => {
    // Two candidates in one item; before, #30 in effect (an earlier deletion of #20's value) and
    // #40 pending; after, #30 pending again.
    const { table: t2, steps: s2 } = judged(STATE, [...conflict, w(40, 10, { f2: "4" })], []);
    const recs = s2.map((x) => x.judgement.record);
    const one = (s: RowState): ItemsGiven => {
      const g = itemsByRecords(s);
      return {
        original: new Map([...g.of].map(([k]) => [k, "pi_a"])),
        of: new Map([...g.of].map(([k]) => [k, "pi_a"])),
        items: new Map([
          [
            "pi_a",
            { kind: "conflict", unit: { fields: ["f2" as never] }, standing: { kind: "open" } },
          ],
        ]),
      };
    };
    const written = new RowState(t2, recs);
    const before = replayDeletion(t2, recs, new Set([contributionKey(21, "f2")])).state;
    const r = itemsResult(before, written, recs, one(written));
    expect(Object.fromEntries(r.fates)).toEqual({
      "31/f2": { kind: "rejoined", item: "pi_a", into: "pi_a" },
    });
    expect(r.refreshed).toEqual([
      { item: "pi_a", cause: "entries_restored", left: [], back: ["31/f2"] },
    ]);
    expect(r.superseded).toEqual([]);
    // And when the one pending before leaves as the other comes back: refreshed, not superseded,
    // in one refresh with both lists (09 §5.8: one `item.refreshed` an item an operation; a member
    // leaving makes it `entries_deleted`).
    const after = replayDeletion(t2, recs, new Set([contributionKey(41, "f2")])).state;
    const r2 = itemsResult(before, after, recs, one(written));
    expect(Object.fromEntries(r2.fates)).toEqual({
      "31/f2": { kind: "rejoined", item: "pi_a", into: "pi_a" },
      "41/f2": { kind: "removed", item: "pi_a" },
    });
    expect(r2.superseded).toEqual([]);
    expect(r2.refreshed).toEqual([
      { item: "pi_a", cause: "entries_deleted", left: ["41/f2"], back: ["31/f2"] },
    ]);
  });

  it("a pending (event, target) with no item given is refused, never opened silently", () => {
    expect(() =>
      itemsResult(earlier, asWritten, records, {
        original: new Map(),
        of: new Map(),
        items: new Map(),
      }),
    ).toThrow(/no item given/);
  });
});

describe("two deletions in turn: the original item is the one when written", () => {
  // #10 5000 from 10-01; #15 4500 on [11-01, 11-05); #20 4000 from 11-10 (a change point); #25,
  // having seen #20, 6000 on [11-06, 11-10); #27, having seen #10 only, 6600 on [11-01, 11-05): a
  // candidate against #15; #30, having seen #20, 7000 from 11-02 on: a candidate against #25, and
  // it erases #20's change point (of high impact).
  const log = [
    w(10, 0, { f2: "5000" }),
    w(15, 10, { f2: "4500" }, { from: "11-01", to: "11-05" }),
    w(20, 15, { f2: "4000" }, { from: "11-10" }),
    w(25, 20, { f2: "6000" }, { from: "11-06", to: "11-10" }),
    w(27, 10, { f2: "6600" }, { from: "11-01", to: "11-05" }),
    w(30, 20, { f2: "7000" }, { from: "11-02" }),
  ];
  const { table, steps } = judged(STATE, log, []);
  const records = steps.map((x) => x.judgement.record);
  const kept = steps.map((x) => x.op);
  const gone = (s: string[]) => deletedContributions(kept, new Set(s), true);
  const given = itemsByRecords(new RowState(table, records));
  /** The first deletion, then the second with the first pending before it. */
  const inTurn = (first: string[], second: string[]) => {
    const one = deletionResult(table, records, gone(first), new Set(), given, []);
    const between = advance(given, one.items);
    const all = gone([...first, ...second]);
    const two = deletionResult(table, records, all, gone(first), between, []);
    return { one, between, two, end: advance(between, two.items) };
  };

  it("as judged: #27 and #30 candidates", () => {
    expect(records.map((r) => ("items" in r ? r.items.map((x) => x.status) : []))).toEqual([
      ["applied"],
      ["applied"],
      ["applied"],
      ["applied"],
      ["candidate"],
      ["candidate"],
    ]);
  });

  it("#25 deleted, then #15: awaiting and succeeded, then a conflict again — the original restored, its successor superseded", () => {
    const { one, two, end } = inTurn(["S25f2"], ["S15f2"]);
    expect(Object.fromEntries(one.items.fates)["31/f2"]).toEqual({
      kind: "succeeded",
      item: "31:f2",
      succeeds: "31:f2",
      as: "awaiting",
    });
    const successor = "31:f2>awaiting";
    expect(Object.fromEntries(two.items.fates)).toEqual({
      "28/f2": { kind: "now_effective", item: "28:f2" },
      "31/f2": { kind: "restored", item: successor, restores: "31:f2" },
    });
    expect(two.items.restored).toEqual(["31:f2"]);
    expect(two.items.superseded).toEqual(["28:f2", successor]);
    expect(two.items.opened).toEqual([]);
    // Both at once: #30 a conflict throughout, in its original item; the open items the same.
    const once = deletionResult(table, records, gone(["S25f2", "S15f2"]), new Set(), given, []);
    expect(Object.fromEntries(once.items.fates)["31/f2"]).toBeUndefined();
    expect(openItems(end, two.replay.state)).toEqual(
      openItems(advance(given, once.items), once.replay.state),
    );
    expect(openItems(end, two.replay.state)).toEqual(["31:f2 conflict: 31/f2"]);
  });

  it("#25 deleted, then #27: awaiting both times — it stays in the item that succeeded the original", () => {
    const { two, end } = inTurn(["S25f2"], ["S27f2"]);
    expect(Object.fromEntries(two.items.fates)).toEqual({
      "28/f2": { kind: "removed", item: "28:f2" },
    });
    expect(two.items.opened).toEqual([]);
    expect(openItems(end, two.replay.state)).toEqual(["31:f2 awaiting: 31/f2"]);
  });
});

describe("itemsByRecords (fixed cases and comparisons only)", () => {
  it("a conflict a resolution closed is resolved; one not, open", () => {
    const j = judged(STATE, conflict, []);
    const open = itemsByRecords(
      new RowState(
        j.table,
        j.steps.map((x) => x.judgement.record),
      ),
    );
    expect(open.items.get("31:f2")?.standing).toEqual({ kind: "open" });
    const { table: t, steps } = judged(STATE, conflict, [
      { after: 2, pick: 0, kind: "keep", flag: 0, focus: false },
    ]);
    expect(steps.map((x) => x.op.kind)).toEqual(["write", "write", "write", "resolve"]);
    const g = itemsByRecords(
      new RowState(
        t,
        steps.map((x) => x.judgement.record),
      ),
    );
    expect(g.items.get("31:f2")?.standing).toEqual({ kind: "resolved" });
  });

  it("an awaiting write a person confirmed is resolved", () => {
    // #30, having seen #20, erases #20's change point at 11-10 from 11-02 on: awaiting.
    const log = [
      w(10, 0, { f2: "5000" }),
      w(20, 10, { f2: "4000" }, { from: "11-10" }),
      w(30, 20, { f2: "7000" }, { from: "11-02" }),
    ];
    const open = judged(STATE, log, []);
    expect(open.steps[2]?.judgement.record).toMatchObject({
      items: [{ target: "f2", status: "awaiting" }],
    });
    const { table: t, steps } = judged(STATE, log, [
      { after: 2, pick: 0, kind: "confirm", flag: 0, focus: false },
    ]);
    expect(steps.map((x) => x.op.kind)).toEqual(["write", "write", "write", "confirm"]);
    const g = itemsByRecords(
      new RowState(
        t,
        steps.map((x) => x.judgement.record),
      ),
    );
    expect(g.items.get("31:awaiting")?.standing).toEqual({ kind: "resolved" });
    expect(
      itemsByRecords(
        new RowState(
          open.table,
          open.steps.map((x) => x.judgement.record),
        ),
      ).items.get("31:awaiting")?.standing,
    ).toEqual({ kind: "open" });
  });
});

describe("what a person decided is not pending (deviation one)", () => {
  it("a candidate a resolution closed has no fate in a deletion that leaves it as it was", () => {
    const r = run([...conflict, w(50, 49, { f3: "x" })], ["S50f3"], {
      decisions: [{ after: 2, pick: 0, kind: "keep", flag: 0, focus: false }],
    });
    expect(r.records.map((x) => x.kind)).toEqual([
      "write",
      "write",
      "write",
      "keep_effective",
      "write",
    ]);
    expect(Object.fromEntries(r.items.fates)).toEqual({});
  });

  it("an awaiting write a person confirmed has no fate either", () => {
    const log = [
      w(10, 0, { f2: "5000" }),
      w(20, 10, { f2: "4000" }, { from: "11-10" }),
      w(30, 20, { f2: "7000" }, { from: "11-02" }),
      w(50, 49, { f3: "x" }),
    ];
    const r = run(log, ["S50f3"], {
      decisions: [{ after: 2, pick: 0, kind: "confirm", flag: 0, focus: false }],
    });
    expect(r.records.map((x) => x.kind)).toEqual(["write", "write", "write", "confirm", "write"]);
    expect(Object.fromEntries(r.items.fates)).toEqual({});
  });
});

describe("the original item still open (only refreshed): back to its kind, back in it (03-deletion «删除结果的定义»)", () => {
  // #30 a candidate against #25, of high impact; #40 a candidate against #22; both in one item.
  const log = [
    w(10, 0, { f2: "5000" }),
    w(15, 10, { f2: "4500" }, { from: "11-01", to: "11-05" }),
    w(20, 15, { f2: "4000" }, { from: "11-10" }),
    w(22, 20, { f2: "100" }, { from: "10-01", to: "10-05" }),
    w(25, 22, { f2: "6000" }, { from: "11-06", to: "11-10" }),
    w(27, 10, { f2: "6600" }, { from: "11-01", to: "11-05" }),
    w(30, 22, { f2: "7000" }, { from: "11-02" }),
    w(40, 20, { f2: "200" }, { from: "10-01", to: "10-05" }),
  ];
  const { table, steps } = judged(STATE, log, []);
  const records = steps.map((x) => x.judgement.record);
  const kept = steps.map((x) => x.op);
  const gone = (s: string[]) => deletedContributions(kept, new Set(s), true);
  const g0 = itemsByRecords(new RowState(table, records));
  const inA = (k: string, v: string) => (k === "31/f2" || k === "41/f2" ? "pi_a" : v);
  const given: ItemsGiven = {
    original: new Map([...g0.of].map(([k, v]) => [k, inA(k, v)])),
    of: new Map([...g0.of].map(([k, v]) => [k, inA(k, v)])),
    items: new Map([
      ...g0.items,
      ["pi_a", { kind: "conflict", unit: { fields: ["f2" as never] }, standing: { kind: "open" } }],
    ]),
  };

  it("#25 then #15: awaiting in a successor, then back in pi_a; the successor superseded; as both at once", () => {
    const one = deletionResult(table, records, gone(["S25f2"]), new Set(), given, []);
    expect(one.items.refreshed).toEqual([
      { item: "pi_a", cause: "entries_deleted", left: ["31/f2"], back: [] },
    ]);
    expect(one.items.opened.map((x) => [x.succeeds, x.kind, x.members])).toEqual([
      ["pi_a", "awaiting", ["31/f2"]],
    ]);
    const between = advance(given, one.items);
    const two = deletionResult(
      table,
      records,
      gone(["S25f2", "S15f2"]),
      gone(["S25f2"]),
      between,
      [],
    );
    expect(Object.fromEntries(two.items.fates)).toEqual({
      "28/f2": { kind: "now_effective", item: "28:f2" },
      "31/f2": { kind: "rejoined", item: "pi_a>awaiting", into: "pi_a" },
    });
    expect(two.items.superseded).toEqual(["28:f2", "pi_a>awaiting"]);
    expect(two.items.refreshed).toEqual([
      { item: "pi_a", cause: "entries_restored", left: [], back: ["31/f2"] },
    ]);
    expect(two.items.opened).toEqual([]);
    const once = deletionResult(table, records, gone(["S25f2", "S15f2"]), new Set(), given, []);
    expect(openItems(advance(between, two.items), two.replay.state)).toEqual(
      openItems(advance(given, once.items), once.replay.state),
    );
    expect(openItems(advance(given, once.items), once.replay.state)).toEqual([
      "pi_a conflict: 31/f2,41/f2",
    ]);
  });
});

describe("an item closed for another reason, a deletion not touching it: no fate", () => {
  it("no fate", () => {
    const ops = [
      w(5, 0, { f2: "0" }),
      w(10, 5, { f2: "1" }),
      w(20, 5, { f2: "2" }),
      w(30, 20, { f2: "3" }),
      w(50, 49, { f3: "x" }),
    ];
    const overwritten = (s: RowState): ItemsGiven => {
      const g = itemsByRecords(s);
      return {
        original: g.of,
        of: g.of,
        items: new Map(
          [...g.items].map(([id, x]) => [
            id,
            id === "21:f2" ? { ...x, standing: { kind: "superseded", reason: "overwritten" } } : x,
          ]),
        ),
      };
    };
    const r = run(ops, ["S50f3"], { items: overwritten });
    expect(fates(r)).toEqual({});
  });
});

describe("a successor of the same kind superseded by a deletion, pending again of its kind: restored", () => {
  // As «two deletions in turn», the states before and after given directly: before, #30 in
  // effect; after (S25 deleted only), awaiting. The items: its original (conflict) and the
  // successor (awaiting) both superseded by deletions, the successor the one it is in now.
  const log = [
    w(10, 0, { f2: "5000" }),
    w(15, 10, { f2: "4500" }, { from: "11-01", to: "11-05" }),
    w(20, 15, { f2: "4000" }, { from: "11-10" }),
    w(25, 20, { f2: "6000" }, { from: "11-06", to: "11-10" }),
    w(27, 10, { f2: "6600" }, { from: "11-01", to: "11-05" }),
    w(30, 20, { f2: "7000" }, { from: "11-02" }),
  ];
  it("the successor restored, not the original (of the other kind)", () => {
    const { table, steps } = judged(STATE, log, []);
    const records = steps.map((x) => x.judgement.record);
    const kept = steps.map((x) => x.op);
    const gone = (s: string[]) => deletedContributions(kept, new Set(s), true);
    const g = itemsByRecords(new RowState(table, records));
    const dead = { kind: "superseded", reason: "deleted" } as const;
    const given: ItemsGiven = {
      original: g.of,
      of: new Map([...g.of].map(([k, v]) => [k, k === "31/f2" ? "S1" : v])),
      items: new Map([
        ...[...g.items].map(
          ([id, x]) => [id, id === "31:f2" ? { ...x, standing: dead } : x] as const,
        ),
        ["S1", { kind: "awaiting", unit: { fields: ["f2" as never] }, standing: dead }],
      ]),
    };
    // S25, S20, S15 and S27 deleted: #30 erases no change point and meets no change: in effect.
    const before = replayDeletion(table, records, gone(["S25f2", "S20f2", "S15f2", "S27f2"])).state;
    const after = replayDeletion(table, records, gone(["S25f2"])).state;
    expect(pendingIn(before, 31, "f2" as never)).toBeUndefined();
    expect(pendingIn(after, 31, "f2" as never)).toBe("awaiting");
    const r = itemsResult(before, after, records, given);
    // (Only #30 is looked at: #27, deleted in the state before, is given here as open.)
    expect(r.fates.get("31/f2")).toEqual({ kind: "restored", item: "S1", restores: "S1" });
    expect(r.restored).toContain("S1");
    expect(r.restored).not.toContain("31:f2");
  });
});

describe("a write in effect in part when written, its part in effect going back: returned", () => {
  // #10 f2=1; #20 (seen #10) f2=2 on [11-01, 11-03); #30 (seen #20) f2=2 on [11-07, 11-09); #40,
  // having seen #10, points at evidence for f2=1 on [11-01, 11-09): the same as now on [11-03,
  // 11-07) (corroborated), a candidate where #20 and #30 changed it. S10 deleted: on [11-03, 11-07)
  // there is no value now, #40 changes it there, and goes back pending there too.
  const log: Op[] = [
    w(10, 0, { f2: "1" }),
    w(20, 10, { f2: "2" }, { from: "11-01", to: "11-03", ack: true }),
    w(30, 20, { f2: "2" }, { from: "11-07", to: "11-09", ack: true }),
    {
      ...w(40, 10, { f2: "1" }, { from: "11-01", to: "11-09" }),
      fields: { f2: { value: "1", sources: ["S40f2"], explicit: true } },
    } as Op,
  ];
  const statuses = (r: ReturnType<typeof run>) =>
    ((r.records[3] as unknown as { items?: { status: string }[] }).items ?? [])
      .map((x) => x.status)
      .sort();

  it("its item open: back in it, merged, the item refreshed", () => {
    const r = run(log, ["S10f2"]);
    expect(statuses(r)).toEqual(["candidate", "candidate", "corroborated"]);
    expect(fates(r)).toEqual({ "41/f2": { kind: "returned", item: "41:f2", into: "merged" } });
    expect(r.items.refreshed).toEqual([
      { item: "41:f2", cause: "entries_restored", left: [], back: ["41/f2"] },
    ]);
    expect(r.items.superseded).toEqual([]);
  });

  it("its item resolved (kept in effect): back closed by the decision", () => {
    const r = run(log, ["S10f2"], {
      decisions: [{ after: 3, pick: 0, kind: "keep", flag: 0, focus: false }],
    });
    expect(r.records.map((x) => x.kind)).toEqual([
      "write",
      "write",
      "write",
      "write",
      "keep_effective",
    ]);
    expect(fates(r)).toEqual({
      "41/f2": { kind: "returned", item: "41:f2", into: "closed_by_decision" },
    });
    expect(r.items.refreshed).toEqual([]);
  });

  it("its item superseded as overwritten: back closed with it", () => {
    const r = run(log, ["S10f2"], {
      items: (s) => {
        const g = itemsByRecords(s);
        return {
          original: g.of,
          of: g.of,
          items: new Map(
            [...g.items].map(([id, x]) => [
              id,
              id === "41:f2"
                ? { ...x, standing: { kind: "superseded", reason: "overwritten" } }
                : x,
            ]),
          ),
        };
      },
    });
    expect(fates(r)).toEqual({
      "41/f2": { kind: "returned", item: "41:f2", into: "closed_with_supersession" },
    });
  });
});

describe("a new conflict item on a group takes the group as its unit", () => {
  it("awaiting before, a conflict after: the successor's unit is {f2, f3}", () => {
    // The kind-change log on a table with f2 and f3 in a group; the classification alone, from
    // the state with #25's value deleted (#30 awaiting) to the records as written (a candidate),
    // its original item an awaiting one.
    const GROUPED = { ...STATE, groups: [["f2", "f3"]] } as TableSchema;
    const log = [
      w(10, 0, { f2: "5000" }),
      w(20, 10, { f2: "4000" }, { from: "11-10" }),
      w(25, 20, { f2: "6000" }, { from: "11-06", to: "11-10" }),
      w(30, 20, { f2: "7000" }, { from: "11-02" }),
    ];
    const { table, steps } = judged(GROUPED, log, []);
    const records = steps.map((x) => x.judgement.record);
    const asWritten = new RowState(table, records);
    const before = replayDeletion(table, records, new Set([contributionKey(26, "f2")])).state;
    expect(pendingIn(before, 31, "f2" as never)).toBe("awaiting");
    expect(pendingIn(asWritten, 31, "f2" as never)).toBe("conflict");
    const given: ItemsGiven = {
      original: new Map([["31/f2", "pi_w"]]),
      of: new Map([["31/f2", "pi_w"]]),
      items: new Map([
        [
          "pi_w",
          { kind: "awaiting", unit: { fields: ["f2" as never] }, standing: { kind: "open" } },
        ],
      ]),
    };
    const r = itemsResult(before, asWritten, records, given);
    expect(r.opened).toEqual([
      {
        succeeds: "pi_w",
        kind: "conflict",
        unit: { fields: ["f2", "f3"] },
        reason: "stale_write",
        members: ["31/f2"],
      },
    ]);
  });
});

describe("returned by the write's record: in effect in part when written", () => {
  const explicit = (o: Op): Op =>
    ({ ...o, fields: { f2: { value: "1", sources: ["S40f2"], explicit: true } } }) as Op;
  // As above: #40 corroborated on [11-03, 11-07), a candidate around it.
  const inPart: Op[] = [
    w(10, 0, { f2: "1" }),
    w(20, 10, { f2: "2" }, { from: "11-01", to: "11-03", ack: true }),
    w(30, 20, { f2: "2" }, { from: "11-07", to: "11-09", ack: true }),
    explicit(w(40, 10, { f2: "1" }, { from: "11-01", to: "11-09" })),
  ];
  /** {S20, S30} deleted first (#40 corroborated in full), then S10 too (a candidate in full). */
  const twice = (decisions: Decision[]) => {
    const { table, steps } = judged(STATE, inPart, decisions);
    const records = steps.map((x) => x.judgement.record);
    const kept = steps.map((x) => x.op);
    const gone = (s: string[]) => deletedContributions(kept, new Set(s), true);
    const g = itemsByRecords(new RowState(table, records));
    const one = deletionResult(table, records, gone(["S20f2", "S30f2"]), new Set(), g, []);
    const two = deletionResult(
      table,
      records,
      gone(["S20f2", "S30f2", "S10f2"]),
      gone(["S20f2", "S30f2"]),
      advance(g, one.items),
      [],
    );
    return { one, two };
  };

  it("kept in effect by a decision, then a candidate in full again: returned, closed by the decision", () => {
    const { one, two } = twice([{ after: 3, pick: 0, kind: "keep", flag: 0, focus: false }]);
    expect(Object.fromEntries(one.items.fates)).toEqual({});
    expect(one.replay.state.items.filter((x) => x.event === 41).map((x) => x.status)).toEqual([
      "corroborated",
    ]);
    expect(Object.fromEntries(two.items.fates)).toEqual({
      "41/f2": { kind: "returned", item: "41:f2", into: "closed_by_decision" },
    });
  });

  it("no decision: the second deletion leaves no conflict, it takes effect in full, no fate", () => {
    const { one, two } = twice([]);
    expect(one.items.superseded).toEqual(["41:f2"]);
    expect(two.replay.state.items.filter((x) => x.event === 41).map((x) => x.status)).toEqual([
      "applied",
    ]);
    expect(Object.fromEntries(two.items.fates)).toEqual({});
  });

  it("its item superseded by a deletion, a part going back: merged and the item restored", () => {
    // The classification alone, from the state corroborated in full ({S20, S30} deleted, the item
    // superseded then) to one with a part a candidate (S10 deleted alone).
    const { table, steps } = judged(STATE, inPart, []);
    const records = steps.map((x) => x.judgement.record);
    const kept = steps.map((x) => x.op);
    const gone = (s: string[]) => deletedContributions(kept, new Set(s), true);
    const before = replayDeletion(table, records, gone(["S20f2", "S30f2"])).state;
    const after = replayDeletion(table, records, gone(["S10f2"])).state;
    const g = itemsByRecords(new RowState(table, records));
    const given: ItemsGiven = {
      ...g,
      items: new Map(
        [...g.items].map(([id, x]) => [
          id,
          id === "41:f2" ? { ...x, standing: { kind: "superseded", reason: "deleted" } } : x,
        ]),
      ),
    };
    const r = itemsResult(before, after, records, given);
    expect(Object.fromEntries(r.fates)).toEqual({
      "41/f2": { kind: "returned", item: "41:f2", into: "merged" },
    });
    expect(r.restored).toEqual(["41:f2"]);
  });

  it("a candidate in full when written gets no returned, whatever deletions do to it", () => {
    // #40 against #20 and #30 everywhere: a candidate in full. S20 deleted: corroborated on
    // [11-01, 11-03); S10 too: a candidate there again. It comes back as pending again, not returned.
    const ops: Op[] = [
      w(10, 0, { f2: "1" }),
      w(20, 10, { f2: "2" }, { from: "11-01", to: "11-03", ack: true }),
      w(30, 20, { f2: "3" }, { from: "11-03", to: "11-05", ack: true }),
      explicit(w(40, 10, { f2: "1" }, { from: "11-01", to: "11-05" })),
    ];
    for (const decisions of [
      [],
      [{ after: 3, pick: 0, kind: "keep", flag: 0, focus: false }],
    ] as Decision[][]) {
      const { table, steps } = judged(STATE, ops, decisions);
      const records = steps.map((x) => x.judgement.record);
      expect(
        (records[3] as unknown as { items: { status: string }[] }).items.map((x) => x.status),
      ).toEqual(["candidate"]);
      const kept = steps.map((x) => x.op);
      const gone = (s: string[]) => deletedContributions(kept, new Set(s), true);
      const g = itemsByRecords(new RowState(table, records));
      const r = deletionResult(table, records, gone(["S20f2", "S10f2"]), gone(["S20f2"]), g, []);
      expect([...r.items.fates.values()].filter((f) => f.kind === "returned")).toEqual([]);
    }
  });
});

describe("an item superseded for another reason, its own candidate's source deleted", () => {
  it("not a member of an open item before: no fate", () => {
    const ops = [
      w(5, 0, { f2: "0" }),
      w(10, 5, { f2: "1" }),
      w(20, 5, { f2: "2" }),
      w(30, 20, { f2: "3" }),
    ];
    const r = run(ops, ["S20f2"], {
      items: (s) => {
        const g = itemsByRecords(s);
        return {
          original: g.of,
          of: g.of,
          items: new Map(
            [...g.items].map(([id, x]) => [
              id,
              id === "21:f2"
                ? { ...x, standing: { kind: "superseded", reason: "overwritten" } }
                : x,
            ]),
          ),
        };
      },
    });
    expect(fates(r)).toEqual({});
  });
});

describe("the other kind, its original item still open with others pending (only refreshed)", () => {
  // #41 and #71 are f2 candidates in one item. S3 deleted: #71 in effect, the item refreshed (#41
  // still pending). S2 deleted too: #71 pending again, awaiting now: a new item succeeds the
  // original, which stays open with #41 (03-deletion «删除不增加未决事项», the kind changed).
  const ops: Op[] = [
    w(10, 0, { f2: "1" }, { ack: true }),
    {
      ...w(20, 10, { f2: "3" }, { from: "11-03", ack: true }),
      fields: { f2: { value: "3", sources: ["S1"] } },
    } as Op,
    {
      ...w(30, 20, { f2: "1" }, { from: "11-01", to: "11-05", ack: true }),
      fields: { f2: { value: "1", sources: ["S2"] } },
    } as Op,
    {
      ...w(40, 0, { f2: "9" }, { from: "11-01", to: "11-03" }),
      fields: { f2: { value: "9", sources: ["S6"] } },
    } as Op,
    {
      ...w(50, 40, { f2: "3" }, { from: "11-01", to: "11-03", ack: true }),
      fields: { f2: { value: "3", sources: ["S3"] } },
    } as Op,
    {
      ...w(70, 30, { f2: "9" }, { from: "11-01", to: "11-05" }),
      fields: { f2: { value: "9", sources: ["S6"] } },
    } as Op,
  ];
  const { table, steps } = judged(STATE, ops, []);
  const records = steps.map((x) => x.judgement.record);
  const kept = steps.map((x) => x.op);
  const gone = (s: string[]) => deletedContributions(kept, new Set(s), true);
  const g = itemsByRecords(new RowState(table, records));
  const inOne = (k: string, v: string) => (k === "41/f2" || k === "71/f2" ? "41:f2" : v);
  const given: ItemsGiven = {
    original: new Map([...g.of].map(([k, v]) => [k, inOne(k, v)])),
    of: new Map([...g.of].map(([k, v]) => [k, inOne(k, v)])),
    items: g.items,
  };

  it("S3 then S2: the original refreshed, then succeeded while still open; as both at once", () => {
    expect(
      records.map((r) => ("items" in r ? r.items.map((x) => x.status).join(",") : "")),
    ).toEqual(["applied", "applied", "applied", "candidate", "applied", "candidate"]);
    const one = deletionResult(table, records, gone(["S3"]), new Set(), given, []);
    expect(Object.fromEntries(one.items.fates)).toEqual({
      "71/f2": { kind: "now_effective", item: "41:f2" },
    });
    expect(one.items.refreshed.map((x) => [x.item, x.left])).toEqual([["41:f2", ["71/f2"]]]);
    const between = advance(given, one.items);
    const two = deletionResult(table, records, gone(["S3", "S2"]), gone(["S3"]), between, []);
    expect(Object.fromEntries(two.items.fates)).toEqual({
      "71/f2": { kind: "succeeded", item: "41:f2", succeeds: "41:f2", as: "awaiting" },
    });
    expect(two.items.superseded).toEqual([]);
    expect(two.items.opened.map((x) => [x.succeeds, x.kind, x.members])).toEqual([
      ["41:f2", "awaiting", ["71/f2"]],
    ]);
    const once = deletionResult(table, records, gone(["S3", "S2"]), new Set(), given, []);
    const end = openItems(advance(between, two.items), two.replay.state);
    expect(end).toEqual(openItems(advance(given, once.items), once.replay.state));
    expect(end).toEqual(["41:f2 awaiting: 71/f2", "41:f2 conflict: 41/f2"]);
  });
});

describe("in effect in part when written, its part going back, pending after of another kind: succeeded, not back in its item", () => {
  // #10 f2=9 from 10-01 (S4); #20 f2=9 from 11-03 (a no-op); #30 (seen #20) f2=1 from 11-05;
  // #40 (seen #30) f2=1 from 11-01: awaiting (it takes away the change point 11-05); #60 (seen
  // #20) f2=9 from 11-01 to the next change, pointing at its evidence: a corroboration on
  // [11-01, 11-05), a candidate from 11-05, in the conflict item 61:f2. Deleting S4 clears the
  // conflict and leaves the part in effect going back; #61 is pending after, still of high
  // impact: awaiting. Not merged back into the conflict item (another kind): the conflict item is
  // superseded and a new awaiting item succeeds it (03-deletion «冲突消失但仍属高影响、将转为待确认
  // 的写入»), as a cancellation of a later deletion of #61 leaves it.
  const src = (value: string, source: string, explicit = false) => ({
    f2: { value, sources: [source], ...(explicit ? { explicit: true } : {}) },
  });
  const ops: Op[] = [
    { ...w(10, 0, {}), seen: 0, fields: src("9", "S4") } as Op,
    { ...w(20, 0, {}, { from: "11-03" }), fields: src("9", "S5") } as Op,
    { ...w(30, 20, {}, { from: "11-05", ack: true }), fields: src("1", "S5") } as Op,
    { ...w(40, 30, {}, { from: "11-01" }), fields: src("1", "S1") } as Op,
    {
      ...w(60, 20, {}, { from: "11-01" }),
      valid: { from: { mode: "given", value: d("11-01") }, to: { mode: "next_change" } },
      fields: src("9", "S3", true),
    } as Op,
  ];
  it("61:f2 superseded, an awaiting item succeeding it", () => {
    const r = run(ops, ["S4"]);
    expect(r.records[4]).toMatchObject({
      items: [
        { target: "f2", status: "corroborated" },
        { target: "f2", status: "candidate" },
      ],
    });
    expect(r.replay.state.items.filter((x) => x.event === 61).map((x) => x.status)).toEqual([
      "awaiting",
    ]);
    expect(fates(r)).toMatchObject({
      "61/f2": { kind: "succeeded", succeeds: "61:f2", as: "awaiting" },
    });
    expect(r.items.superseded).toEqual(["61:f2"]);
    expect(r.items.refreshed).toEqual([]);
    expect(r.items.opened).toMatchObject([
      { succeeds: "61:f2", kind: "awaiting", members: ["61/f2"] },
    ]);
  });
});
