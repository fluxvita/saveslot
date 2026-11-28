// The restatements of a deletion's replay (09 §5.9 `restated/<k>`, rules 1 and 2) and the indices
// of replayed items (03-deletion «回掉的权威定义» step 6), on hand-made blocks.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import type { ItemRef, OpRecord, RecordedItem, Restatement } from "./model.ts";
import { type GivenBlock, givenByRecords, overlay, renumber, restatements } from "./restate.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const iv = (from: string, to: string | null) => [{ from: d(from), to: to === null ? null : d(to) }];
const f2 = "f2" as FieldId;
const ref = (event: number, k = 0): ItemRef => ({ event, target: f2, k });
const item = (
  k: number,
  from: string,
  to: string | null,
  o: Partial<RecordedItem> = {},
): RecordedItem => ({
  target: f2,
  k,
  status: "applied",
  valid: iv(from, to),
  content: { kind: "value", value: "1" },
  deps: [],
  ...o,
});
const write = (op: number, items: RecordedItem[]): OpRecord =>
  ({
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    kind: "write",
    seen: op - 1,
    seenExplicit: true,
    now: d("11-05"),
    explicit: [],
    items,
    noop: [],
    ack: [],
  }) as OpRecord;
const block = (x: RecordedItem): GivenBlock => ({
  k: x.k,
  status: x.status,
  valid: x.valid,
  deps: x.deps,
  content: x.content,
});

describe("renumber (step 6)", () => {
  it("an item cut in two keeps its index on the first piece; the new piece takes the next", () => {
    const written = [item(0, "11-01", "11-09")];
    const fresh = [item(0, "11-05", "11-09"), item(1, "11-01", "11-03")];
    expect(renumber(fresh, written.map(block), written).map((x) => [x.k, x.valid])).toEqual([
      [0, iv("11-01", "11-03")],
      [1, iv("11-05", "11-09")],
    ]);
  });

  it("two items of one write landing on one: the smallest index stays", () => {
    const written = [item(0, "11-01", "11-03"), item(1, "11-05", "11-09")];
    const fresh = [item(0, "11-01", "11-09")];
    expect(renumber(fresh, written.map(block), written).map((x) => x.k)).toEqual([0]);
  });

  it("an index a deletion gave (no write-time block) lands by its block as last given", () => {
    const written = [item(0, "11-01", "11-03")];
    const latest = [block(item(0, "11-01", "11-03")), block(item(1, "11-07", "11-09"))];
    const fresh = [item(0, "11-01", "11-03"), item(1, "11-07", "11-09"), item(2, "11-04", "11-05")];
    expect(renumber(fresh, latest, written).map((x) => [x.k, x.valid])).toEqual([
      [0, iv("11-01", "11-03")],
      [2, iv("11-04", "11-05")],
      [1, iv("11-07", "11-09")],
    ]);
  });
  it("an index last given as dropped lands by its landing block; one a deletion numbered with no block left is not used again", () => {
    // k 1 was given by a deletion and since restated as dropped (landing: [11-07, 11-09)); k 2 was
    // given by a deletion and dropped with no interval left (09 §5.7: only an index as written
    // takes its number back). A replay with three items: k 1 lands, the new one takes 3.
    const written = [item(0, "11-01", "11-03")];
    const latest = [
      block(item(0, "11-01", "11-03")),
      {
        ...block(item(1, "11-07", "11-09")),
        status: "dropped" as const,
        valid: [],
        landing: iv("11-07", "11-09"),
      },
      { ...block(item(2, "11-04", "11-05")), status: "dropped" as const, valid: [] },
    ];
    const fresh = [item(0, "11-01", "11-03"), item(1, "11-04", "11-05"), item(2, "11-07", "11-09")];
    expect(renumber(fresh, latest, written).map((x) => [x.k, x.valid])).toEqual([
      [0, iv("11-01", "11-03")],
      [3, iv("11-04", "11-05")],
      [1, iv("11-07", "11-09")],
    ]);
  });

  it("an index as written with no interval block left takes its number back before a new one", () => {
    // k 1 was written, its block since gone (nothing to land by): a replay with two items reuses
    // it for the second before a new number.
    const written = [item(0, "11-01", "11-03"), { ...item(1, "11-07", "11-09"), valid: [] }];
    const latest = [
      block(item(0, "11-01", "11-03")),
      { ...block(item(1, "11-07", "11-09")), status: "dropped" as const, valid: [] },
    ];
    const fresh = [item(0, "11-01", "11-03"), item(1, "11-04", "11-05")];
    expect(renumber(fresh, latest, written).map((x) => [x.k, x.valid])).toEqual([
      [0, iv("11-01", "11-03")],
      [1, iv("11-04", "11-05")],
    ]);
  });

  it("an index lands by its write-time block, not by the block a deletion gave it since", () => {
    // k 0 was written on [11-01, 11-03); a deletion since restated it on [11-07, 11-09). It stays
    // on the item meeting its write-time block.
    const written = [item(0, "11-01", "11-03")];
    const latest = [block(item(0, "11-07", "11-09"))];
    const fresh = [item(0, "11-01", "11-03"), item(1, "11-07", "11-09")];
    expect(renumber(fresh, latest, written).map((x) => [x.k, x.valid])).toEqual([
      [0, iv("11-01", "11-03")],
      [1, iv("11-07", "11-09")],
    ]);
  });
});

describe("restatements (§5.9)", () => {
  const w10 = write(10, [item(0, "10-01", null)]);
  const w20 = write(20, [item(0, "11-01", "11-10", { deps: [ref(31)] })]);
  const w30 = write(30, [item(0, "11-10", null, { content: { kind: "value", value: "3" } })]);
  const logged = [w10, w20, w30];
  const latest = givenByRecords(logged);

  it("nothing changed, nothing deleted: none", () => {
    expect(restatements(logged, latest, new Set(), true)).toEqual([]);
  });

  it("rule 1: an interval that differs from the block last given", () => {
    const replayed = [w10, write(20, [item(0, "11-01", null, { deps: [] })])];
    expect(restatements(replayed, latest, new Set(["31/f2"]), true)).toEqual([
      { item: ref(21), status: "applied", valid: iv("11-01", null), deps: [] },
    ]);
  });

  it("rule 1: only the deps differ", () => {
    const replayed = [w10, write(20, [item(0, "11-01", "11-10", { deps: [ref(11)] })]), w30];
    expect(restatements(replayed, latest, new Set(), true)).toEqual([
      { item: ref(21), status: "applied", valid: iv("11-01", "11-10"), deps: [ref(11)] },
    ]);
  });

  it("rule 1: only the interval differs", () => {
    const replayed = [w10, write(20, [item(0, "11-02", "11-10", { deps: [ref(31)] })]), w30];
    expect(restatements(replayed, latest, new Set(), true)).toEqual([
      { item: ref(21), status: "applied", valid: iv("11-02", "11-10"), deps: [ref(31)] },
    ]);
  });

  it("rule 2: a block resting on a restated contribution is restated as it is, to a fixed point", () => {
    // #31 is restated (a candidate now); #21's block rests on #31: restated though unchanged; #41
    // rests on #21: restated in turn.
    const w40 = write(40, [item(0, "12-01", null, { deps: [ref(21)] })]);
    const before = [...logged, w40];
    const replayed = [
      w10,
      w20,
      write(30, [
        item(0, "11-10", null, { status: "candidate", content: { kind: "value", value: "3" } }),
      ]),
      w40,
    ];
    expect(
      restatements(replayed, givenByRecords(before), new Set(), true).map((r) => [
        r.item.event,
        r.status,
      ]),
    ).toEqual([
      [21, "applied"],
      [31, "candidate"],
      [41, "applied"],
    ]);
  });

  it("rule 2, a carried item: restated when what it carries is deleted or restated as dropped, not when restated otherwise", () => {
    // Event table. #31 a candidate; #51 a take carrying it (its sources without an interval have
    // no deps, 09 §3.5 rule 1).
    const c31 = write(30, [
      item(0, "11-01", null, { status: "candidate", content: { kind: "value", value: "3" } }),
    ]);
    const take = write(50, [
      item(0, "11-01", null, { content: { kind: "value", value: "3" }, carried: [ref(31)] }),
    ]);
    const given = givenByRecords([w10, c31, take]);
    const of = (r: ReturnType<typeof restatements>) => r.map((x) => [x.item.event, x.status]);
    // #31 restated, still a contribution (applied now): the take is not restated.
    const applied = write(30, [item(0, "11-01", null, { content: { kind: "value", value: "3" } })]);
    expect(of(restatements([w10, applied, take], given, new Set(), false))).toEqual([
      [31, "applied"],
    ]);
    // #31 no longer an item (restated as dropped): the take is restated as it is.
    expect(of(restatements([w10, take], given, new Set(), false))).toEqual([
      [31, "dropped"],
      [51, "applied"],
    ]);
    // #31 deleted: the take is restated as it is.
    expect(of(restatements([w10, take], given, new Set(["31/f2"]), false))).toEqual([
      [51, "applied"],
    ]);
  });

  it("an index given that is no longer an item, not deleted: dropped; a deleted one: not restated", () => {
    const replayed = [w10, w30];
    expect(restatements(replayed, latest, new Set(), true)).toEqual([
      { item: ref(21), status: "dropped", deps: [] },
    ]);
    expect(restatements(replayed, latest, new Set(["21/f2"]), true)).toEqual([]);
  });

  it("rule 2 to a fixed point, whatever the log order of the chain", () => {
    // #21 rests on #41, #41 on #31: one pass in log order would stop at #41.
    const a = write(20, [item(0, "11-01", "11-10", { deps: [ref(41)] })]);
    const b = write(30, [item(0, "11-10", null)]);
    const c = write(40, [item(0, "12-01", null, { deps: [ref(31)] })]);
    const before = [w10, a, b, c];
    const replayed = [w10, a, write(30, [item(0, "11-10", null, { status: "candidate" })]), c];
    expect(
      restatements(replayed, givenByRecords(before), new Set(), true).map((r) => [
        r.item.event,
        r.status,
      ]),
    ).toEqual([
      [21, "applied"],
      [31, "candidate"],
      [41, "applied"],
    ]);
  });

  it("an item last given as dropped and back again is restated; one still not an item is not dropped again", () => {
    // A deletion restated #21 as dropped; #31's index too. Now #21 is an item again (its block as
    // written); #31 is still not.
    const dropped = (k: number, was: RecordedItem): GivenBlock => ({
      k,
      status: "dropped",
      valid: [],
      landing: was.valid,
      deps: [],
      content: was.content,
    });
    const last = new Map(latest);
    last.set("21/f2", [dropped(0, item(0, "11-01", "11-10"))]);
    last.set("31/f2", [dropped(0, item(0, "11-10", null))]);
    const replayed = [w10, w20];
    expect(restatements(replayed, last, new Set(), true)).toEqual([
      { item: ref(21), status: "applied", valid: iv("11-01", "11-10"), deps: [ref(31)] },
    ]);
  });

  it("a new index is restated; on an event table without valid", () => {
    const replayed = [
      w10,
      write(20, [item(0, "11-01", "11-03", { deps: [ref(31)] }), item(1, "11-05", "11-10")]),
      w30,
    ];
    expect(restatements(replayed, latest, new Set(), false)).toEqual([
      { item: ref(21, 1), status: "applied", deps: [] },
    ]);
  });
});

describe("overlay: the blocks last given with a deletion's restatements laid over", () => {
  const given = new Map<string, GivenBlock[]>([
    [
      "21/f2",
      [
        {
          k: 0,
          status: "applied",
          valid: iv("11-01", null),
          deps: [ref(21)],
          content: { kind: "value", value: "2" },
        },
      ],
    ],
  ]);

  it("a carried item's new value names what it carries in its deps, as the event writes it", () => {
    // 09 §5.9: a block with an interval lists the item its value is carried from in its deps too.
    const r: Restatement = {
      item: ref(21),
      status: "applied",
      valid: iv("11-01", null),
      deps: [ref(31)],
      content: { kind: "value", value: "1" },
      carried: [ref(11), ref(31)],
    };
    const [b] = overlay(given, [r], new Set(), []).get("21/f2") ?? [];
    expect(b?.deps).toEqual([ref(31), ref(11)]);
    expect(b?.carried).toEqual([ref(11), ref(31)]);
  });

  it("a restatement carrying nothing keeps its deps as they are", () => {
    const r: Restatement = {
      item: ref(21),
      status: "applied",
      valid: iv("11-01", null),
      deps: [ref(31)],
      content: { kind: "value", value: "2" },
    };
    const [b] = overlay(given, [r], new Set(), []).get("21/f2") ?? [];
    expect(b?.deps).toEqual([ref(31)]);
  });
});

describe("overlay onto an index with no block of its own (numbered anew by a replay), by each way", () => {
  // #21's only block is index 0, "2". Overlay does not know which event restates (a deletion or a
  // cancellation): ways 2 and 3 are the same call to it, told apart by what came before.
  const given = new Map<string, GivenBlock[]>([
    [
      "21/f2",
      [
        {
          k: 0,
          status: "applied",
          valid: iv("11-01", null),
          deps: [],
          content: { kind: "value", value: "2" },
        },
      ],
    ],
  ]);
  // #21 as written: its one item, "2" (what an item of the write itself holds, whatever index).
  const WRITTEN = [write(20, [item(0, "11-01", null, { content: { kind: "value", value: "2" } })])];
  const dropped: Restatement = { item: ref(21, 1), status: "dropped", deps: [] };
  const inEffect: Restatement = {
    item: ref(21, 1),
    status: "corroborated",
    valid: iv("11-03", "11-05"),
    deps: [],
  };
  const at = (m: Map<string, GivenBlock[]>, et: string, k: number) =>
    (m.get(et) ?? []).find((b) => b.k === k);

  it("1. first given in effect, with no value: its write's content", () => {
    expect(at(overlay(given, [inEffect], new Set(), WRITTEN), "21/f2", 1)?.content).toEqual({
      kind: "value",
      value: "2",
    });
  });

  it("2. given as dropped, then a cancellation restates it in effect: its write's content", () => {
    const afterDeletion = overlay(given, [dropped], new Set(), WRITTEN);
    // The dropped block holds no content: the index had none of its own, and none is made up.
    expect(at(afterDeletion, "21/f2", 1)?.content).toBeUndefined();
    expect(at(overlay(afterDeletion, [inEffect], new Set(), WRITTEN), "21/f2", 1)?.content).toEqual(
      {
        kind: "value",
        value: "2",
      },
    );
  });

  it("3. given as dropped by a deletion, then another deletion restates it in effect: the same", () => {
    const afterFirst = overlay(given, [dropped], new Set(), WRITTEN);
    const afterSecond = overlay(
      afterFirst,
      [{ ...inEffect, status: "applied" }],
      new Set(),
      WRITTEN,
    );
    expect([at(afterSecond, "21/f2", 1)?.status, at(afterSecond, "21/f2", 1)?.content]).toEqual([
      "applied",
      { kind: "value", value: "2" },
    ]);
  });

  it("4. a carried item's new index: the content each restatement gives, kept while dropped", () => {
    const carried = (value: string): Restatement => ({
      ...inEffect,
      content: { kind: "value", value },
      carried: [ref(11)],
    });
    const once = overlay(given, [carried("1")], new Set(), WRITTEN);
    expect(at(once, "21/f2", 1)?.content).toEqual({ kind: "value", value: "1" });
    const gone = overlay(once, [dropped], new Set(), WRITTEN);
    expect(at(gone, "21/f2", 1)?.content).toEqual({ kind: "value", value: "1" });
    const back = overlay(gone, [carried("3")], new Set(), WRITTEN);
    expect(at(back, "21/f2", 1)?.content).toEqual({ kind: "value", value: "3" });
  });

  it("5. a write-back first given by a restatement, then dropped: no content made up", () => {
    // #41 writes back with no block when written (09 §5.7: first given by a deletion's
    // `restated/<k>`); a write-back is always restated with its content.
    const wb: Restatement = {
      item: ref(41),
      status: "applied",
      valid: iv("11-01", "11-03"),
      deps: [],
      content: { kind: "no_value" },
    };
    const once = overlay(given, [wb], new Set(), WRITTEN);
    expect(at(once, "41/f2", 0)?.content).toEqual({ kind: "no_value" });
    // Dropped where no index of it was ever given: none known, none made up.
    const fresh = overlay(
      given,
      [{ item: ref(41), status: "dropped", deps: [] }],
      new Set(),
      WRITTEN,
    );
    expect(at(fresh, "41/f2", 0)?.status).toBe("dropped");
    expect(at(fresh, "41/f2", 0)?.content).toBeUndefined();
    const back = overlay(fresh, [wb], new Set(), WRITTEN);
    expect(at(back, "41/f2", 0)?.content).toEqual({ kind: "no_value" });
  });
});
