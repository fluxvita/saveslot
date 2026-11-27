// Indices only cancelled deletions gave (09 §5.7 分项与编号, §5.9 «哪些项要重述» item 4, §3.5 rule 1;
// 03-deletion «回掉的权威定义» step 6): the four fixed cases of the decision record on them. Each
// says what is compared on either side: the kernel's numbering against the reference evaluator's
// where no list of positions is approximated, the kernel's alone where the reference's list
// (approximated by ends) differs.

import type { Op } from "@fluxvita/saveslot-reference";
import { evaluateLog, type LogEntry } from "@fluxvita/saveslot-reference";
import { STATE as STATE_SCHEMA } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { blockDeps } from "../apply/index.ts";
import type { OpRecord, Restatement } from "../judge/model.ts";
import { restatements } from "../judge/restate.ts";
import { type Decision, deletedContributions, judged } from "../judge/scenarios.fixture.ts";
import { type DepHit, type PositionIndex, positionsOf } from "./positions.ts";
import { DeletionSessionForTests } from "./replay.fixture.ts";

const show = (rs: readonly Restatement[]) =>
  rs.map(
    (r) =>
      `${r.item.event}/${r.item.target}/${r.item.k} ${r.status}${r.valid !== undefined ? ` ${JSON.stringify(r.valid)}` : ""}`,
  );
/** The items of event `event` in a replay's records: `target/k status valid`. */
const itemsOf = (records: readonly OpRecord[], event: number) =>
  records
    .filter((r) => r.event === event)
    .flatMap((r) =>
      "items" in r
        ? r.items.map((x) => `${x.target}/${x.k} ${x.status} ${JSON.stringify(x.valid)}`)
        : [],
    )
    .sort();
/** The reference's items of event `event` (dropped ones included): `target/k status valid`. */
const refItemsOf = (
  items: readonly { event: number; target: string; k: number; status: string; valid: unknown }[],
  event: number,
  withIndex = true,
) =>
  items
    .filter((x) => x.event === event)
    .map((x) => `${x.target}${withIndex ? `/${x.k}` : ""} ${x.status} ${JSON.stringify(x.valid)}`)
    .sort();
const del = (id: string, op: number, src: string): LogEntry => ({
  kind: "deletion",
  op,
  id,
  sources: [src],
});
const iv = (from: string, to: string) => [{ from: `2026-${from}`, to: `2026-${to}` }];

// State table: #51 writes "9" on [11-01, 11-05); deleting S1 cuts its item in two, the second
// piece (#51/f2/1, on [11-03, 11-05)) numbered by the deletion.
const SPLIT_OPS = [
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

// A take, then an undo of #70 on group {f2, f3} (event 74); deleting S1 gives the undo's write-back
// on f2 two indices, deleting S4 one; neither written with the undo.
const UNDO_OPS: Op[] = [
  {
    kind: "write",
    op: 10,
    event: 11,
    seen: 0,
    valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
    fields: { f2: { value: "1", sources: ["S10"] } },
    acknowledge: ["overwrite"],
  },
  {
    kind: "write",
    op: 20,
    event: 21,
    seen: 10,
    valid: {
      from: { mode: "given", value: "2026-11-01" },
      to: { mode: "given", value: "2026-11-03" },
    },
    fields: { f2: { value: "2", sources: ["S20"] } },
    acknowledge: ["overwrite"],
  },
  {
    kind: "write",
    op: 30,
    event: 31,
    seen: 20,
    valid: {
      from: { mode: "given", value: "2026-11-07" },
      to: { mode: "given", value: "2026-11-09" },
    },
    fields: { f2: { value: "2", sources: ["S30"] } },
    acknowledge: ["overwrite"],
  },
  {
    kind: "write",
    op: 40,
    event: 41,
    seen: 10,
    valid: {
      from: { mode: "given", value: "2026-11-01" },
      to: { mode: "given", value: "2026-11-09" },
    },
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
  {
    kind: "write",
    op: 60,
    event: 61,
    seen: 50,
    valid: {
      from: { mode: "given", value: "2026-11-01" },
      to: { mode: "given", value: "2026-11-03" },
    },
    fields: { f2: { value: "3", sources: ["S1"], explicit: false } },
  },
  {
    kind: "write",
    op: 70,
    event: 71,
    seen: 60,
    valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
    fields: { f2: { value: "1", sources: ["S4", "S5"], explicit: false } },
    acknowledge: ["overwrite"],
  },
  {
    kind: "write",
    op: 80,
    event: 81,
    seen: 70,
    valid: {
      from: { mode: "given", value: "2026-11-01" },
      to: { mode: "given", value: "2026-11-03" },
    },
    fields: { f2: { value: "1", sources: ["S4", "S6"], explicit: true } },
    acknowledge: ["overwrite"],
  },
] as Op[];
const UNDO_DECISIONS: Decision[] = [
  { after: 52038118, pick: 0, kind: "undo", flag: 0, focus: true },
];
const UNDO_SCHEMA = { ...STATE_SCHEMA, groups: [["f2", "f3"]] } as typeof STATE_SCHEMA;

function setup(schema: typeof STATE_SCHEMA, ops: readonly Op[], decisions: readonly Decision[]) {
  const { table, steps } = judged(schema, ops, decisions);
  const kept = steps.map((x) => x.op);
  const records = steps.map((x) => x.judgement.record);
  const taken = (src: string) => deletedContributions(kept, new Set([src]), true);
  const last = Math.max(...kept.map((o) => o.op));
  const reference = (log: LogEntry[]) => evaluateLog(schema, [...kept, ...log]).final;
  return { table, records, taken, last, reference };
}

describe("an index only a cancelled deletion gave (fixed cases)", () => {
  it("1. one deletion numbers an index, is cancelled, and another splits the item again: a new number", () => {
    // One deletion pending at a time: no list of positions approximated. Kernel and reference
    // compared with indices: the cancellation restates #51/f2/1 as dropped, the later deletion
    // numbers the piece #2, not #1.
    const { table, records, taken, last, reference } = setup(STATE_SCHEMA, SPLIT_OPS, []);
    const s = new DeletionSessionForTests(table);
    const first = s.confirm(records, "pi_a", taken("S1"));
    expect(show(first.replay.restated)).toContain(
      `51/f2/1 candidate ${JSON.stringify(iv("11-03", "11-05"))}`,
    );
    const cancel = s.cancel(records, "pi_a");
    const said = cancel.replay.restated.find((r) => r.item.event === 51 && r.item.k === 1);
    // Restated as dropped, with no deps, interval, value or sources (§5.9 item 4).
    expect(said).toEqual({ item: { event: 51, target: "f2", k: 1 }, status: "dropped", deps: [] });
    const again = s.confirm(records, "pi_c", taken("S1"));
    expect(itemsOf(again.replay.records, 51)).toEqual([
      `f2/0 corroborated ${JSON.stringify(iv("11-01", "11-03"))}`,
      `f2/2 candidate ${JSON.stringify(iv("11-03", "11-05"))}`,
    ]);
    const ref = reference([
      del("pi_a", last + 1, "S1"),
      { kind: "cancel", op: last + 2, id: "pi_a" },
      del("pi_c", last + 3, "S1"),
    ]);
    expect(refItemsOf(ref.items, 51)).toEqual([
      `f2/0 corroborated ${JSON.stringify(iv("11-01", "11-03"))}`,
      "f2/1 dropped []",
      `f2/2 candidate ${JSON.stringify(iv("11-03", "11-05"))}`,
    ]);
  });

  it("2. two deletions, the first cancelled, both indices given by the first alone: the write-back left takes a new number", () => {
    // Kernel: #74/f2/0 and #74/f2/1 restated as dropped, the write-back left numbered #2. The
    // reference's list of positions differs here (it keeps #1): compared by status, interval and
    // value only (the property comparison in replay-deletion.prop.test.ts does the same).
    const { table, records, taken, last, reference } = setup(UNDO_SCHEMA, UNDO_OPS, UNDO_DECISIONS);
    const s = new DeletionSessionForTests(table);
    const first = s.confirm(records, "pi_a", taken("S1"));
    expect(show(first.replay.restated)).toEqual(
      expect.arrayContaining([
        `74/f2/0 applied ${JSON.stringify(iv("11-01", "11-03"))}`,
        `74/f2/1 applied ${JSON.stringify(iv("11-07", "11-09"))}`,
      ]),
    );
    s.confirm(records, "pi_b", taken("S4"));
    const cancel = s.cancel(records, "pi_a");
    expect(show(cancel.replay.restated)).toEqual([
      "74/f2/0 dropped",
      "74/f2/1 dropped",
      `74/f2/2 applied ${JSON.stringify(iv("11-07", "11-09"))}`,
    ]);
    expect(itemsOf(cancel.replay.records, 74)).toEqual([
      `f2/2 applied ${JSON.stringify(iv("11-07", "11-09"))}`,
    ]);
    const ref = reference([
      del("pi_a", last + 1, "S1"),
      del("pi_b", last + 2, "S4"),
      { kind: "cancel", op: last + 3, id: "pi_a" },
    ]);
    expect(refItemsOf(ref.items, 74, false).filter((x) => !x.includes(" dropped "))).toEqual([
      `f2 applied ${JSON.stringify(iv("11-07", "11-09"))}`,
    ]);
  });

  it("3. the second deletion gives the first's index again; the first cancelled, then the second", () => {
    // S4 deleted (#74/f2/0 on [11-07, 11-09), numbered by it), then S1 (giving #74/f2/0 again, and
    // #74/f2/1). Cancelling the first: #74/f2/0 is the second's, kept, the same there: not
    // restated. Cancelling the second too: every block that gave either index came from a
    // cancelled deletion, both restated as dropped. The reference's list agrees here: compared
    // with indices.
    const { table, records, taken, last, reference } = setup(UNDO_SCHEMA, UNDO_OPS, UNDO_DECISIONS);
    const s = new DeletionSessionForTests(table);
    const first = s.confirm(records, "pi_a", taken("S4"));
    expect(show(first.replay.restated)).toEqual([
      `74/f2/0 applied ${JSON.stringify(iv("11-07", "11-09"))}`,
    ]);
    const second = s.confirm(records, "pi_b", taken("S1"));
    expect(show(second.replay.restated)).toEqual(
      expect.arrayContaining([
        `74/f2/0 applied ${JSON.stringify(iv("11-07", "11-09"))}`,
        `74/f2/1 applied ${JSON.stringify(iv("11-01", "11-03"))}`,
      ]),
    );
    const cancelA = s.cancel(records, "pi_a");
    expect(cancelA.replay.restated.filter((r) => r.item.event === 74)).toEqual([]);
    const live = [
      `f2/0 applied ${JSON.stringify(iv("11-07", "11-09"))}`,
      `f2/1 applied ${JSON.stringify(iv("11-01", "11-03"))}`,
    ];
    expect(itemsOf(cancelA.replay.records, 74)).toEqual(live);
    const log: LogEntry[] = [
      del("pi_a", last + 1, "S4"),
      del("pi_b", last + 2, "S1"),
      { kind: "cancel", op: last + 3, id: "pi_a" },
    ];
    expect(refItemsOf(reference(log).items, 74)).toEqual(live);
    const cancelB = s.cancel(records, "pi_b");
    expect(show(cancelB.replay.restated.filter((r) => r.item.event === 74))).toEqual([
      "74/f2/0 dropped",
      "74/f2/1 dropped",
    ]);
    expect(itemsOf(cancelB.replay.records, 74)).toEqual([]);
    expect(
      refItemsOf(reference([...log, { kind: "cancel", op: last + 4, id: "pi_b" }]).items, 74),
    ).toEqual(["f2/0 dropped []", "f2/1 dropped []"]);
  });

  describe("4. a block resting on such an index, listed by a later deletion (kernel only)", () => {
    // 09 §3.5 rule 1, the example of the decision record: m (#20) writes a stretch of f2; C covers
    // it; W (#40) undoes m, all covered, no write-back. D1 (#50) takes C's source away: W has a
    // write-back W/f2#0, first given by D1's restated/0, resting on m's item. G (#60), in the grace
    // period, has its default end at W/f2#0's end: its span rests on W/f2#0. D1 is cancelled (#70):
    // W/f2#0 restated as dropped. Then D3 (this deletion) takes m's source away: W has no item before
    // or after, nothing is restated; D1's block rests on m and is listed, and G's old span with it.
    const ref = (event: number, k = 0) => ({ event, field: "f2", k });
    const blocks: Record<number, Record<string, unknown>> = {
      20: {
        "fields/f2/0": { status: "applied" },
        "span/f2/0": { valid: { from: "2026-11-01" }, deps: [] },
      },
      50: {
        "restated/0": {
          ...ref(40),
          status: "applied",
          valid: { from: "2026-11-01", to: "2026-11-03" },
          deps: [ref(20)],
        },
      },
      60: { "span/f2/0": { valid: { from: "2026-11-02", to: "2026-11-03" }, deps: [ref(40)] } },
      70: { "restated/0": { ...ref(40), status: "dropped" } },
    };
    const deps: DepHit[] = Object.entries(blocks).flatMap(([seq, b]) =>
      blockDeps(Number(seq), b as never).map((r) => ({
        seq: r.seq,
        path: r.path,
        event: r.dep_event,
        target: r.dep_field,
        k: r.dep_k,
        kind: r.dep_kind,
      })),
    );
    const index: PositionIndex = {
      sourceBlocks: [],
      eventPaths: new Map([[20, ["fields/f2/0", "span/f2/0"]]]),
      operationSources: new Map(),
      requestEvidence: new Map(),
      apiCalls: new Map(),
      bases: [],
      heads: [],
      deps,
      onlyCancelled: new Map([
        ["40/f2/0", { givers: ["50 restated/0"], restating: ["50 restated/0", "70 restated/0"] }],
      ]),
    };
    const listed = (i: PositionIndex) =>
      positionsOf({
        sources: [],
        deleted: new Set(["20/f2"]),
        restated: [],
        index: i,
        self: 100,
      }).map((p) => `${p.seq} ${p.path}`);

    it("G's old span is listed with D1's block; the cancellation's dropped is not", () => {
      expect(listed(index)).toEqual([
        "20 fields/f2/0",
        "20 span/f2/0",
        "50 restated/0",
        "60 span/f2/0",
        "100 summary",
      ]);
      // Without the index known as one only a cancelled deletion gave, G's span is not reached.
      const { onlyCancelled: _, ...without } = index;
      expect(listed(without)).not.toContain("60 span/f2/0");
    });

    it("the deletion restates nothing of W/f2#0: the cancellation's dropped is still the last given", () => {
      const latest = new Map([
        [
          "40/f2",
          [{ k: 0, status: "dropped" as const, valid: [], deps: [], restatement: true as const }],
        ],
      ]);
      expect(restatements([], latest, new Set(["20/f2"]), true)).toEqual([]);
    });
  });
});
