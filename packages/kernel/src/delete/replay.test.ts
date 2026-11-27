// A deletion's replay with other deletions pending, as the test fixture runs it in turn
// (`DeletionSessionForTests`): rule 2 of the restatements by the deletion's own list of positions
// (09 §5.9 rule 2, "本次清掉"; 03-deletion «多项删除各自列全位置»).

import type { Op, TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT as EVENT_SCHEMA, STATE as STATE_SCHEMA } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { advance } from "../judge/fates.fixture.ts";
import { itemsByRecords } from "../judge/fates.ts";
import type { ItemRef, Restatement } from "../judge/model.ts";
import { cancellationResult, deletionResult, replayDeletion } from "../judge/replay-deletion.ts";
import { type GivenBlock, givenByRecords, onlyCancelledGave, overlay } from "../judge/restate.ts";
import { deletedContributions, judged } from "../judge/scenarios.fixture.ts";
import { RowState } from "../judge/state.ts";
import { DeletionSessionForTests, deletionReplayForTests } from "./replay.fixture.ts";

const w = (op: number, seen: number, value: string, source: string, ack = false) =>
  ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    fields: { f2: { value, sources: [source] } },
    ...(ack ? { acknowledge: ["overwrite"] } : {}),
  }) as Op;
/** An event table's row with two takes: #43 takes #41's candidate, #73 #61's. */
const TAKES = [
  w(10, 0, "1", "S10", true),
  w(20, 10, "2", "S20", true),
  w(30, 20, "3", "S30", true),
  w(40, 10, "4", "S40"),
  {
    kind: "resolve",
    op: 43,
    event: 44,
    decision: "take_candidate",
    candidates: [41],
    take: 41,
    unit: "f2",
  } as Op,
  w(50, 20, "5", "S50"),
  {
    kind: "write",
    op: 60,
    event: 61,
    seen: 20,
    fields: { f2: { value: "1", sources: ["S6"], explicit: false } },
  } as Op,
  {
    kind: "resolve",
    op: 73,
    event: 74,
    decision: "take_candidate",
    candidates: [51, 61],
    take: 61,
    unit: "f2",
  } as Op,
];

describe("a deletion worked out with another one pending: rule 2 by its own list of positions", () => {
  const ref = (d: { event: number; target: string; k: number }) => `${d.event}/${d.target}/${d.k}`;
  const restated = (rs: readonly { item: ItemRef; status: string }[]) =>
    rs.map((r) => `${ref(r.item)} ${r.status}`);
  /**
   * A deletes `a`'s words and is pending; B deletes `b`'s. B's own list of positions is worked out
   * from its replay alone (09 §3.5 rule 1): a block is cleared by a dep, or (a block without an
   * interval, which has no deps) by a carried item, deleted or restated alone. B's event, with A
   * pending: restated without that (`none`), by deps only (`deps`), and by both (`both`).
   */
  function confirmB(schema: TableSchema, ops: Op[], a: string[], b: string[]) {
    const isState = schema.kind === "state";
    const j = judged(schema, ops, []);
    expect(j.steps).toHaveLength(ops.length);
    const kept = j.steps.map((x) => x.op);
    const records = j.steps.map((x) => x.judgement.record);
    const da = deletedContributions(kept, new Set(a), isState);
    const db = deletedContributions(kept, new Set(b), isState);
    const alone = deletionReplayForTests(j.table, records, db);
    const own = new Map(alone.replay.restated.map((r) => [ref(r.item), r]));
    const here = (d: ItemRef) => db.has(`${d.event}/${d.target}`);
    const dep = (d: ItemRef) => here(d) || own.has(ref(d));
    const carried = (d: ItemRef) => here(d) || own.get(ref(d))?.status === "dropped";
    const confirm = (cleared?: { dep: typeof dep; carried: typeof carried }) => {
      const session = new DeletionSessionForTests(j.table);
      session.confirm(records, "A", da);
      return restated(session.confirm(records, "B", db, undefined, cleared).replay.restated);
    };
    return {
      first: restated(
        new DeletionSessionForTests(j.table).confirm(records, "A", da).replay.restated,
      ),
      alone: restated(alone.replay.restated),
      none: confirm(),
      deps: confirm({ dep, carried: () => false }),
      both: confirm({ dep, carried }),
    };
  }

  it("state table: a block its own list clears by a dep is restated as it is", () => {
    // B alone drops the take #50 made (its items carry #41's candidate, which B leaves
    // corroborating): its own list clears #50's blocks. With A pending, #50 is in effect as it
    // was: rule 1 has nothing to say of it, rule 2 restates it as it is (09 §5.9 rule 2: "本次清掉"
    // by its own list). Found by the delete operation's property (seed -227213934).
    const g = (from: string, to: string | null) => ({
      valid: {
        from: { mode: "given", value: from },
        to: to === null ? { mode: "open" } : { mode: "given", value: to },
      },
    });
    const ops = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        ...g("2026-10-01", null),
        fields: { f2: { value: "1", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        ...g("2026-11-01", "2026-11-03"),
        fields: { f2: { value: "2", sources: ["S20"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        ...g("2026-11-07", "2026-11-09"),
        fields: { f2: { value: "2", sources: ["S30"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 10,
        ...g("2026-11-01", "2026-11-09"),
        fields: { f2: { value: "1", sources: ["S40"], explicit: true } },
      },
      {
        kind: "resolve",
        op: 50,
        event: 51,
        decision: "take_candidate",
        candidates: [41],
        take: 41,
        unit: "f2",
      },
    ] as unknown as Op[];
    const r = confirmB(STATE_SCHEMA, ops, ["S10"], ["S20", "S30"]);
    expect(r.alone).toContain("51/f2/0 dropped");
    expect(r.none).toEqual([]);
    expect(r.first).toEqual([
      "41/f2/0 candidate",
      "41/f2/1 dropped",
      "41/f2/2 dropped",
      "51/f2/0 applied",
      "51/f2/1 dropped",
    ]);
    // #50's item, by its dep on #41's restated alone; #41's, its last block being A's restatement
    // of it, which B's list clears since B alone restates #41; and the three indices A gave as
    // dropped, which B alone restates too: their dropped blocks cleared, given as dropped again
    // (09 §5.9 rule 2), or a replay from an empty store brings them back.
    expect(r.both).toEqual([
      "41/f2/0 candidate",
      "41/f2/1 dropped",
      "41/f2/2 dropped",
      "51/f2/0 applied",
      "51/f2/1 dropped",
    ]);
  });

  it("state table: a block that is no restatement, cleared by its dep, is restated as it is", () => {
    // #43 confirms #40's write. A deletes #10's words and is pending; B deletes #20's and #30's.
    // B alone restates an item #43's block rests on, so its own list clears that block, which no
    // earlier deletion restated: only its deps tell rule 2 it is cleared. Found by a search over
    // generated logs with a pending deletion (1 in about 6,000).
    const g = (from: string, to: string | null) => ({
      valid: {
        from: { mode: "given", value: from },
        to: to === null ? { mode: "open" } : { mode: "given", value: to },
      },
    });
    const ops = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        ...g("2026-10-01", null),
        fields: { f2: { value: "1", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        ...g("2026-11-01", "2026-11-03"),
        fields: { f2: { value: "2", sources: ["S20"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        ...g("2026-11-07", "2026-11-09"),
        fields: { f2: { value: "2", sources: ["S30"] } },
        acknowledge: ["overwrite"],
        seenCurrent: true,
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        ...g("2026-11-01", "2026-11-09"),
        fields: { f2: { value: "1", sources: ["S40"], explicit: true } },
      },
      { kind: "confirm", op: 43, event: 44, target: 41 },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        ...g("2026-11-07", null),
        fields: { f2: { value: "2", sources: ["S1"], explicit: false } },
      },
    ] as unknown as Op[];
    const r = confirmB(STATE_SCHEMA, ops, ["S10"], ["S20", "S30"]);
    expect(r.first.some((x) => x.startsWith("44/"))).toBe(false);
    expect(r.none).toEqual([]);
    expect(r.both).toEqual(["44/f2/0 applied"]);
  });

  it("event table: a block its own list clears by a carried item is restated as it is", () => {
    // #73 takes #61's candidate; on an event table the take's blocks have no interval and no deps,
    // its value's source names #61 as carried. B alone drops #61: its own list clears #73's blocks
    // by the carried item (09 §3.5 rule 1, `sources/<f>/<k>`). With A pending, #61 and #73 are as
    // they were: only the carried item tells rule 2 the block is cleared. Found by a search over
    // generated logs with a pending deletion.
    const r = confirmB(EVENT_SCHEMA, TAKES, ["S10"], ["S40", "S20"]);
    expect(r.alone).toEqual(["44/f2/0 dropped", "61/f2/0 dropped", "74/f2/0 applied"]);
    expect(r.none).toEqual(["44/f2/0 dropped"]);
    expect(r.deps).toEqual(["44/f2/0 dropped"]);
    expect(r.both).toEqual(["44/f2/0 dropped", "74/f2/0 applied"]);
  });

  it("a block restating an item this deletion restates alone is cleared by it: the item restated", () => {
    // A deletes #20's words and is pending: its event restates #60 as applied (a candidate when
    // written). B deletes S1, the words of #40: alone it restates #60 as applied too, so its own
    // list clears A's block restating #60 (a restatement's block rests on the item it restates,
    // 09 §3.5 rule 1). With A pending #60 is as A gave it: rule 1 restates nothing, and only the
    // block being a restatement of an item B restates alone tells rule 2 it is cleared.
    const ops = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        fields: { f2: { value: "5", sources: ["S20"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        fields: { f2: { value: "1", sources: ["S30"] }, f3: { value: "b", sources: ["S30f3"] } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        fields: {},
        noop: ["f2"],
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 20,
        fields: { f2: { value: "3", sources: ["S5"], explicit: false } },
      },
    ] as unknown as Op[];
    const r = confirmB(EVENT_SCHEMA, ops, ["S20"], ["S1"]);
    expect(r.alone).toContain("61/f2/0 applied");
    expect(r.both).toContain("61/f2/0 applied");
  });

  it("an item an earlier deletion restated with its carried items, unchanged: not restated again", () => {
    // A deletes #20's words: #60 is dropped and #73's take restated, carrying #61 (its block lists
    // #61 in its deps, as the event writes it). B deletes #30's words, which touch neither: nothing
    // of #73 changes, so rule 1 restates nothing (an event table's item has no deps of its own; the
    // carried items in the block's deps are the event's way of writing them).
    const r = confirmB(EVENT_SCHEMA, TAKES, ["S20"], ["S30"]);
    expect(r.none).toEqual([]);
    expect(r.both).toEqual([]);
  });

  it("a timeless table: as an event table's, by a carried item and nothing unchanged restated", () => {
    // A timeless table's items have no interval and no deps of their own, as an event table's.
    const TIMELESS = { kind: "timeless", required: ["f2"] } as TableSchema;
    const byCarried = confirmB(TIMELESS, TAKES, ["S10"], ["S40", "S20"]);
    expect(byCarried.deps).toEqual(["44/f2/0 dropped"]);
    expect(byCarried.both).toEqual(["44/f2/0 dropped", "74/f2/0 applied"]);
    const unrelated = confirmB(TIMELESS, TAKES, ["S20"], ["S30"]);
    expect(unrelated.none).toEqual([]);
    expect(unrelated.both).toEqual([]);
  });
});

describe("a cancellation laid over the blocks: an index a deletion numbered anew and dropped", () => {
  // State table: #50 writes "9" on [11-01, 11-05), one index; the replays number its item anew,
  // a second index on [11-03, 11-05). With S1 and S6 deleted, the second deletion restates that
  // index as dropped; the first deletion is then cancelled, and the cancellation restates it in
  // effect with no value (#50's own item, not a carried one: 09 §5.9 `restated/<k>`). Laid over
  // the blocks without the cancelled deletion's, its content is #50's "9", as the cancellation's
  // replay gives it; it was the dropped block's placeholder (null). Found by the soak run of the
  // deletion replay property (seed -652076658), both orders failing.
  const OPS = [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
      fields: { f2: { value: "9", sources: ["S4"] } },
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      valid: { from: { mode: "given", value: "2026-11-03" }, to: { mode: "open" } },
      fields: { f2: { value: "1", sources: ["S6"], explicit: false } },
      acknowledge: ["overwrite"],
      seenCurrent: true,
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 20,
      valid: {
        from: { mode: "given", value: "2026-11-01" },
        to: { mode: "given", value: "2026-11-03" },
      },
      fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      seenCurrent: true,
    },
    { kind: "confirm", op: 33, event: 34, target: 31 },
    {
      kind: "write",
      op: 40,
      event: 41,
      seen: 0,
      valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
      fields: { f2: { value: "9", sources: ["S5"], explicit: false } },
    },
    {
      kind: "write",
      op: 50,
      event: 51,
      seen: 10,
      valid: {
        from: { mode: "given", value: "2026-11-01" },
        to: { mode: "given", value: "2026-11-05" },
      },
      fields: { f2: { value: "9", sources: ["S4"], explicit: true } },
    },
    {
      kind: "write",
      op: 60,
      event: 61,
      seen: 50,
      valid: {
        from: { mode: "given", value: "2026-11-01" },
        to: { mode: "given", value: "2026-11-05" },
      },
      fields: { f2: { value: "9", sources: ["S1"], explicit: false } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 70,
      event: 71,
      seen: 60,
      valid: {
        from: { mode: "given", value: "2026-11-01" },
        to: { mode: "given", value: "2026-11-05" },
      },
      fields: { f2: { value: "9", sources: ["S3"], explicit: false } },
      acknowledge: ["overwrite"],
      seenCurrent: true,
    },
  ] as unknown as Op[];
  const NO_GRACE = {
    cancelledOp: Number.MAX_SAFE_INTEGER,
    coveredSince: Number.MAX_SAFE_INTEGER,
    keptEffective: new Set<string>(),
    effectiveSince: () => 0,
  };
  /** The blocks not last given as dropped, without the mark of a restatement's block. */
  const live = (bs: readonly GivenBlock[] = []) =>
    bs.filter((b) => b.status !== "dropped").map(({ restatement: _, ...b }) => b);

  /** `a` deleted, then `b`, then the deletion of `a` cancelled: what is laid over and replayed. */
  function cancelFirst(a: string, b: string) {
    const { table, steps } = judged(STATE_SCHEMA, OPS, []);
    expect(steps).toHaveLength(OPS.length);
    const kept = steps.map((x) => x.op);
    const records = steps.map((x) => x.judgement.record);
    const first = deletedContributions(kept, new Set([a]), true);
    const second = deletedContributions(kept, new Set([b]), true);
    const both = deletedContributions(kept, new Set([a, b]), true);
    const once = replayDeletion(table, records, first);
    const afterFirst = overlay(givenByRecords(records), once.restated, first, records);
    const then = replayDeletion(table, records, both, [], afterFirst);
    const given = itemsByRecords(new RowState(table, records));
    const one = deletionResult(table, records, first, new Set(), given, () => []);
    const two = deletionResult(table, records, both, first, advance(given, one.items), () => []);
    const before = advance(advance(given, one.items), two.items);
    // The blocks without the cancelled deletion's (09 §5.7), the second's restatements laid over.
    const withoutFirst = overlay(givenByRecords(records), then.restated, second, records);
    const bySecond = new Set(
      then.restated.map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`),
    );
    const fromFirst = new Set(
      once.restated
        .filter((r: Restatement) => r.status !== "dropped")
        .map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`)
        .filter((k) => !bySecond.has(k)),
    );
    const c = cancellationResult(
      table,
      records,
      second,
      first,
      before,
      onlyCancelledGave(withoutFirst, once.restated),
      fromFirst,
      () => [],
      NO_GRACE,
    );
    return {
      dropped: then.restated.some(
        (r) => r.item.event === 51 && r.item.k === 1 && r.status === "dropped",
      ),
      droppedAgain: c.replay.restated.some(
        (r) => r.item.event === 51 && r.item.k === 1 && r.status === "dropped",
      ),
      laid: live(overlay(withoutFirst, c.replay.restated, second, records).get("51/f2")),
      replayed: live(givenByRecords(c.replay.records).get("51/f2")),
    };
  }

  for (const [a, b] of [
    ["S1", "S6"],
    ["S6", "S1"],
  ]) {
    it(`${a} deleted, then ${b}, then the first cancelled: #50's index gives "9" again`, () => {
      const r = cancelFirst(a as string, b as string);
      expect(r.dropped).toBe(true);
      expect(r.laid).toEqual(r.replayed);
      // Index 1 only the cancelled deletion gave an interval; the second deletion's restatement
      // as dropped keeps its number, so the cancellation does not say it again, and the stretch
      // takes a new number (09 §5.7).
      expect(r.droppedAgain).toBe(false);
      expect(r.laid.find((x) => x.k === 1)).toBeUndefined();
      expect(r.laid.find((x) => x.k === 2)?.content).toEqual({ kind: "value", value: "9" });
    });
  }
});
