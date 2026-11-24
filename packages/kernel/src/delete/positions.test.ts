// A deletion's positions (09 §5.9 `positions`, §3.5 rule 1) and what deleted sources take
// away (03-deletion «来源», «区间参数»), case by case. The dependency index is the one apply makes
// of the blocks (`blockDeps`), never written by hand.

import type { JsonValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { blockDeps } from "../apply/index.ts";
import type { Restatement, Target } from "../judge/index.ts";
import { type DepHit, type HeadBlocks, type PositionIndex, positionsOf } from "./positions.ts";
import { type BaseCitations, takenAway } from "./taken.ts";

const base = (x: Partial<BaseCitations> & { event: number; op: number }): BaseCitations => ({
  opIndex: 0,
  table: "t1",
  row: "r1",
  targets: [],
  values: new Map(),
  valid: null,
  opSources: [],
  ...x,
});

const emptyIndex: PositionIndex = {
  sourceBlocks: [],
  eventPaths: new Map(),
  operationSources: new Map(),
  requestEvidence: new Map(),
  apiCalls: new Map(),
  bases: [],
  heads: [],
  deps: [],
};

/** The dependency index apply makes of these events' blocks. */
const indexed = (events: Record<number, Record<string, JsonValue>>): DepHit[] =>
  Object.entries(events).flatMap(([seq, blocks]) =>
    blockDeps(Number(seq), blocks).map((r) => ({
      seq: r.seq,
      path: r.path,
      event: r.dep_event,
      target: r.dep_field,
      k: r.dep_k,
      kind: r.dep_kind,
    })),
  );
const ref = (event: number, field: string, k = 0) => ({ event, field, k });
const carry = (event: number, field: string, k = 0) => [
  { kind: "value", carried: ref(event, field, k) },
];
const span = (...deps: ReturnType<typeof ref>[]) => ({ valid: { from: "2026-11-01" }, deps });

const restated = (
  event: number,
  target: Target,
  k: number,
  status: Restatement["status"] = "applied",
): Restatement => ({ item: { event, target, k }, status, deps: [] });

const SELF = 100;
const paths = (xs: { seq: number; path: string }[]) => xs.map((x) => `${x.seq} ${x.path}`);

describe("what deleted sources take away", () => {
  it("a field goes when any of its value sources does («且»); another field of the write stays", () => {
    const b = base({
      event: 23,
      op: 21,
      targets: ["f2", "f3"],
      values: new Map([
        ["f2", [22]],
        ["f3", [22, 30]],
      ]),
    });
    expect([...takenAway([b], new Set([30]))]).toEqual(["23/f3"]);
    expect([...takenAway([b], new Set([22]))].sort()).toEqual(["23/f2", "23/f3"]);
  });

  it("every target goes with an interval source, existence too; an operation source takes nothing", () => {
    const write = base({
      event: 23,
      op: 21,
      targets: ["existence", "f2"],
      values: new Map([["f2", [22]]]),
      valid: [31],
    });
    const revoke = base({ event: 40, op: 39, targets: ["existence"], opSources: [31] });
    expect([...takenAway([write, revoke], new Set([31]))].sort()).toEqual([
      "23/existence",
      "23/f2",
    ]);
  });

  it("a carried value is not taken away here: the replay decides by what it carries", () => {
    const take = base({ event: 50, op: 49, opIndex: null, targets: ["f2"], opSources: [48] });
    expect(takenAway([take], new Set([22])).size).toBe(0);
  });
});

describe("a deletion's positions", () => {
  it("the source's blocks, the contribution's blocks, the summary; nothing else of the event", () => {
    const index: PositionIndex = {
      ...emptyIndex,
      sourceBlocks: [
        { seq: 22, path: "text" },
        { seq: 22, path: "stated_at" },
      ],
      eventPaths: new Map([
        [
          23,
          [
            "target",
            "fields/f2/0",
            "sources/f2/0",
            "literal/f2/0",
            "span/f2/0",
            "fields/f3/0",
            "sources/f3/0",
            "span/existence/0",
          ],
        ],
      ]),
    };
    const got = positionsOf({
      sources: [22],
      deleted: new Set(["23/f2"]),
      restated: [],
      index,
      self: SELF,
    });
    expect(paths(got)).toEqual([
      "22 stated_at",
      "22 text",
      "23 fields/f2/0",
      "23 literal/f2/0",
      "23 sources/f2/0",
      "23 span/f2/0",
      "100 summary",
    ]);
  });

  it("existence taken away: its interval block only (the item itself is metadata)", () => {
    const index = {
      ...emptyIndex,
      eventPaths: new Map([
        [40, ["target", "span/existence/0", "span/existence/1", "fields/f2/0"]],
      ]),
    };
    const got = positionsOf({
      sources: [31],
      deleted: new Set(["40/existence"]),
      restated: [],
      index,
      self: SELF,
    });
    expect(paths(got)).toEqual(["40 span/existence/0", "40 span/existence/1", "100 summary"]);
  });

  it("deps: by (event, target) for a deletion, whatever index; by item for a restatement", () => {
    const index = {
      ...emptyIndex,
      deps: indexed({
        30: { "span/f2/0": span(ref(23, "f2", 1)) },
        31: { "span/f2/0": span(ref(25, "f2", 0)) },
        32: { "span/f2/0": span(ref(25, "f2", 1)) },
        33: { "ack/0": { valid: { from: "2026-11-01" }, deps: [ref(26, "f3")] } },
      }),
    };
    const got = positionsOf({
      sources: [22],
      deleted: new Set(["23/f2"]),
      restated: [restated(25, "f2", 0, "corroborated")],
      index,
      self: SELF,
    });
    // 30: rests on 23/f2 (a different index: still taken away). 31: rests on the restated 25/f2/0.
    // 32: on 25/f2/1, not restated. 33: on nothing touched.
    expect(paths(got)).toEqual(["30 span/f2/0", "31 span/f2/0", "100 summary"]);
  });

  it("a switch's backfill: listed when a contribution it rests on is deleted, not when restated", () => {
    const index = {
      ...emptyIndex,
      deps: indexed({
        60: {
          "backfill/t1/f4/0": { valid: { from: "2026-11-01" }, deps: [ref(23, "f2")] },
          "backfill/t1/f4/1": { valid: { from: "2026-11-01" }, deps: [ref(25, "f2")] },
        },
      }),
    };
    const got = positionsOf({
      sources: [22],
      deleted: new Set(["23/f2"]),
      restated: [restated(25, "f2", 0)],
      index,
      self: SELF,
    });
    expect(paths(got)).toEqual(["60 backfill/t1/f4/0", "100 summary"]);
  });

  it("a carried source: listed with its field when what it carries is taken away or dropped", () => {
    const index = {
      ...emptyIndex,
      deps: indexed({
        50: { "sources/f2/0": carry(23, "f2") },
        51: { "sources/f2/0": carry(25, "f2") },
        52: { "sources/f2/0": carry(26, "f2") },
      }),
    };
    const got = positionsOf({
      sources: [22],
      deleted: new Set(["23/f2"]),
      // 25/f2/0 restated as dropped; 26/f2/0 restated, still a contribution: its carrier stands.
      restated: [restated(25, "f2", 0, "dropped"), restated(26, "f2", 0, "applied")],
      index,
      self: SELF,
    });
    expect(paths(got)).toEqual([
      "50 fields/f2/0",
      "50 sources/f2/0",
      "51 fields/f2/0",
      "51 sources/f2/0",
      "100 summary",
    ]);
  });

  it("a shadow restated as dropped and a take landing on it: both cascades", () => {
    // 70 is a take whose item k = 1 landed on the shadow 25/f2/1; its span rests on the shadow,
    // its sources carry it. The shadow is restated as dropped by this deletion.
    const index = {
      ...emptyIndex,
      deps: indexed({
        70: { "span/f2/1": span(ref(25, "f2", 1)), "sources/f2/1": carry(25, "f2", 1) },
      }),
    };
    const got = positionsOf({
      sources: [22],
      deleted: new Set(["23/f2"]),
      restated: [restated(25, "f2", 1, "dropped")],
      index,
      self: SELF,
    });
    expect(paths(got)).toEqual([
      "70 fields/f2/1",
      "70 sources/f2/1",
      "70 span/f2/1",
      "100 summary",
    ]);
  });

  describe("an earlier deletion's results and restatements (an event table's: no deps)", () => {
    // Deletion 80 restated 25/f2/0 (a carried item's new value) and gave the row's f2 from it.
    const earlier = {
      80: {
        "results/0/fields/f2/0": { value: "x", sources: carry(25, "f2") },
        "restated/0": {
          event: 25,
          field: "f2",
          k: 0,
          status: "applied",
          value: "x",
          sources: carry(12, "f2"),
          deps: [ref(12, "f2")],
        },
      },
    } as Record<number, Record<string, JsonValue>>;
    const index = { ...emptyIndex, deps: indexed(earlier) };
    it("the item they speak of taken away: both listed", () => {
      const got = positionsOf({
        sources: [22],
        deleted: new Set(["25/f2"]),
        restated: [],
        index,
        self: SELF,
      });
      expect(paths(got)).toEqual(["80 restated/0", "80 results/0/fields/f2/0", "100 summary"]);
    });
    it("the item restated again: both listed", () => {
      const got = positionsOf({
        sources: [22],
        deleted: new Set(),
        restated: [restated(25, "f2", 0, "applied")],
        index,
        self: SELF,
      });
      expect(paths(got)).toEqual(["80 restated/0", "80 results/0/fields/f2/0", "100 summary"]);
    });
    it("what the restatement carries taken away: the restatement listed", () => {
      const got = positionsOf({
        sources: [22],
        deleted: new Set(["12/f2"]),
        restated: [],
        index,
        self: SELF,
      });
      expect(paths(got)).toEqual(["80 restated/0", "100 summary"]);
    });
  });

  it("nothing of the event itself but its summary, though its own blocks rest on what it restates", () => {
    const index = {
      ...emptyIndex,
      deps: indexed({
        [SELF]: {
          "restated/1": { event: 26, field: "f2", k: 0, status: "applied", deps: [ref(25, "f2")] },
        },
      }),
    };
    const got = positionsOf({
      sources: [22],
      deleted: new Set(),
      restated: [restated(25, "f2", 0, "dropped")],
      index,
      self: SELF,
      invalidated: [{ seq: SELF, path: "results/0/fields/f2/0" }],
    });
    expect(paths(got)).toEqual(["100 summary"]);
  });

  it("the invalidated, as the caller gives them (§5.9 «随之失效的»: the rule is not set yet)", () => {
    const got = positionsOf({
      sources: [22],
      deleted: new Set(),
      restated: [],
      index: emptyIndex,
      self: SELF,
      invalidated: [{ seq: 45, path: "checksum" }],
    });
    expect(paths(got)).toEqual(["45 checksum", "100 summary"]);
  });

  describe("a write head's raw parameters and identifiers", () => {
    // Operation 21: op 0 writes f2 from 22 and f3 from 24, its interval from 24; op 1 writes f2
    // from 26. Its api_call for op 1 is 26.
    const head: HeadBlocks = {
      op: 21,
      paths: [
        "ctx",
        "request",
        "request_key",
        "task",
        "ops/0/target",
        "ops/0/set/f2",
        "ops/0/set/f3",
        "ops/0/valid",
        "ops/0/refs",
        "ops/0/premises/0",
        "ops/0/premise_valid/0",
        "ops/0/premises/1",
        "ops/0/premise_valid/1",
        "ops/0/premises/2",
        "ops/0/premise_valid/2",
        "ops/1/target",
        "ops/1/set/f2",
        "ops/1/refs",
      ],
      premiseRanges: new Map([
        ["0/0", "given"],
        ["0/1", "row_time"],
        ["0/2", "row_time"],
      ]),
      premiseDeps: new Set(["0/2"]),
      // A state table: op 0's own business time is its interval.
      timeBlock: new Map([
        [0, "ops/0/valid"],
        [1, "ops/1/valid"],
      ]),
    };
    const index: PositionIndex = {
      ...emptyIndex,
      operationSources: new Map([[21, [22, 24, 26, 29]]]),
      // 29: request-level evidence no field or interval maps to.
      requestEvidence: new Map([[21, [22, 24, 29]]]),
      apiCalls: new Map([["21/1", [26]]]),
      bases: [
        base({
          event: 27,
          op: 21,
          opIndex: 0,
          targets: ["f2", "f3"],
          values: new Map([
            ["f2", [22]],
            ["f3", [24]],
          ]),
          valid: [24],
        }),
        base({ event: 28, op: 21, opIndex: 1, targets: ["f2"], values: new Map([["f2", [26]]]) }),
      ],
      heads: [head],
    };
    const at = (sources: number[], deleted: string[]) =>
      paths(
        positionsOf({ sources, deleted: new Set(deleted), restated: [], index, self: SELF }),
      ).filter((p) => p.startsWith("21 "));

    it("a field's value source: that field's raw value, the ops' refs and given premise; the identifiers", () => {
      // The row_time premise rests on op 0's interval, which 22 does not give: it stays. 22 is
      // evidence of the request: op 1's refs go too.
      expect(at([22], ["27/f2"])).toEqual([
        "21 ops/0/premise_valid/0",
        "21 ops/0/refs",
        "21 ops/0/set/f2",
        "21 ops/1/refs",
        "21 request_key",
        "21 task",
      ]);
    });

    it("request-level evidence nothing maps to: every op's refs and given premises, the identifiers", () => {
      expect(at([29], [])).toEqual([
        "21 ops/0/premise_valid/0",
        "21 ops/0/refs",
        "21 ops/1/refs",
        "21 request_key",
        "21 task",
      ]);
    });

    it("an interval source: the interval, the field from it, the row_time premise resting on the interval; a premise with deps only by its deps", () => {
      expect(at([24], ["27/f2", "27/f3"])).toEqual([
        "21 ops/0/premise_valid/0",
        "21 ops/0/premise_valid/1",
        "21 ops/0/refs",
        "21 ops/0/set/f3",
        "21 ops/0/valid",
        "21 ops/1/refs",
        "21 request_key",
        "21 task",
      ]);
    });

    it("another op's source: only that op's blocks, and the operation's identifiers", () => {
      expect(at([26], ["28/f2"])).toEqual([
        "21 ops/1/refs",
        "21 ops/1/set/f2",
        "21 request_key",
        "21 task",
      ]);
    });
  });

  it("any head event's identifiers: a resolution's task and request key with its api_call", () => {
    const index: PositionIndex = {
      ...emptyIndex,
      operationSources: new Map([[40, [41]]]),
      heads: [
        {
          op: 40,
          paths: ["ctx", "task", "request_key", "target"],
          premiseRanges: new Map(),
          premiseDeps: new Set(),
          timeBlock: new Map(),
        },
      ],
    };
    const got = positionsOf({ sources: [41], deleted: new Set(), restated: [], index, self: SELF });
    expect(paths(got)).toEqual(["40 request_key", "40 task", "100 summary"]);
  });

  it("a source recorded in one operation, only another's operation source: that one's identifiers", () => {
    // 22 recorded in operation 21; operation 50's undo cites it as its operation source only.
    const index: PositionIndex = {
      ...emptyIndex,
      bases: [base({ event: 52, op: 50, targets: ["f2"], opSources: [22] })],
      heads: [
        {
          op: 50,
          paths: ["ctx", "task"],
          premiseRanges: new Map(),
          premiseDeps: new Set(),
          timeBlock: new Map(),
        },
      ],
    };
    const got = positionsOf({ sources: [22], deleted: new Set(), restated: [], index, self: SELF });
    expect(paths(got)).toEqual(["50 task", "100 summary"]);
  });
});
