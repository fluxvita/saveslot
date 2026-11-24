// The plan of a `deletion.confirmed` on given inputs (09-event-format §5.9 `apply`): the row
// settled from the source table as the deletion leaves it and held to the results; each way the
// results and the row can disagree stops apply as inconsistent; each form this version does not
// apply is refused as not implemented. The comparison with judge on storage is store-pglite's
// (apply-deletion.prop.test.ts).

import type { BizPoint, JsonValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { interval } from "../time/index.ts";
import {
  type DeletionInput,
  type DeletionRow,
  planDeletionCancelled,
  planDeletionConfirmed,
  type StoredItem,
} from "./deletion.ts";
import { ApplyError, type Change } from "./model.ts";
import type { OpenCell } from "./write-base.ts";

const ENTITY = `e_${"7".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const DELETION = `pi_${"7".repeat(16)}`;
const d = (md: string) => `2026-${md}` as BizPoint;
const iv = (from: string, to?: string) => interval(d(from), to === undefined ? null : d(to));
const SELF = 40;

const STATE_TABLE = {
  id: "t2",
  name: "budget",
  kind: "base",
  description: "a budget over time",
  time: { type: "state", granularity: "date" },
  physical: { table: "t_t2_v1" },
  fields: [
    { id: "f2", name: "amount", type: "text", required: true, description: "how much" },
    { id: "f3", name: "note", type: "text", description: "a note" },
  ],
} as const;

/** A write of f2 from `source`, on `[from, to)`. */
const write = (seq: number, value: string, source: number, from: string, to?: string) => ({
  seq,
  op: seq - 1,
  blocks: {
    target: { table: "t2", entity: ENTITY, intent: "update", sv: 1, cause: "request", op_index: 0 },
    "fields/f2/0": { status: "applied", value },
    "sources/f2/0": [{ kind: "value", source }],
    "span/f2/0": { valid: { from: d(from), ...(to !== undefined ? { to: d(to) } : {}) } },
  } as Record<string, JsonValue>,
});
const stored = (from: string, to?: string) => ({
  status: "applied" as const,
  valid: iv(from, to),
  corroborationEnds: null,
  schemaConst: false,
});
const cell = (from: string, to: string | null, event: number, rec: number): OpenCell => ({
  field: "f2",
  valid_from: d(from),
  valid_to: to === null ? null : d(to),
  src: { event, target: "f2", k: 0 },
  no_value: false,
  rec_from: rec,
});

/** #12 [10-01, ∞) 5000; #15 [11-10, ∞) 4000; #22 [11-02, 11-20) 3000 (09 §5.7's example). */
const ROW_IN: DeletionRow = {
  table: STATE_TABLE as never,
  rowId: ENTITY,
  events: [
    write(12, "5000", 9, "10-01"),
    write(15, "4000", 14, "11-10"),
    write(22, "3000", 21, "11-02", "11-20"),
  ],
  stored: new Map([
    ["12/f2/0", stored("10-01")],
    ["15/f2/0", stored("11-10")],
    ["22/f2/0", stored("11-02", "11-20")],
  ]),
  openCells: [
    cell("10-01", "11-02", 12, 12),
    cell("11-02", "11-20", 22, 22),
    cell("11-20", null, 15, 22),
    // f3, never written: empty where the entity has a value, no item giving it.
    {
      field: "f3",
      valid_from: d("10-01"),
      valid_to: null,
      src: null,
      no_value: false,
      rec_from: 12,
    },
  ],
  count: 3,
  origin: 12,
  written: new Map(),
  contentGiven: new Map(),
};
const INPUT: DeletionInput = { rows: [ROW_IN] };

/** The deletion of #22's source 21: 5000 back on [11-02, 11-10), 4000 on [11-10, 11-20). */
function event(over: Record<string, JsonValue> = {}): Record<string, JsonValue> {
  return {
    target: {
      deletion: DELETION,
      kind: "privacy",
      due_at: "2026-11-11T05:00:00.000Z",
      sources: [21],
      origin: "request",
    },
    positions: [
      { seq: 21, path: "text" },
      { seq: 22, path: "fields/f2/0" },
      { seq: 22, path: "sources/f2/0" },
      { seq: 22, path: "span/f2/0" },
      { seq: SELF, path: "summary" },
    ],
    summary: { hash: "c".repeat(64) },
    "results/0/target": { table: "t2", entity: ENTITY, outcome: "resegmented" },
    "results/0/fields/f2/0": {
      value: "5000",
      sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
      valid: { from: d("10-01"), to: d("11-10") },
      deps: [
        { event: 12, field: "f2", k: 0 },
        { event: 15, field: "f2", k: 0 },
      ],
    },
    "results/0/fields/f2/1": {
      value: "4000",
      sources: [{ kind: "value", carried: { event: 15, field: "f2", k: 0 } }],
      valid: { from: d("11-10") },
      deps: [{ event: 15, field: "f2", k: 0 }],
    },
    "results/0/existence": { gaps: [{ to: d("10-01") }], deps: [] },
    ...over,
  };
}
const kinds = (cs: Change[]) => cs.map((c) => c.kind);
const stops = (f: () => unknown, reason: string, text: RegExp) => {
  let thrown: unknown;
  try {
    f();
  } catch (e) {
    thrown = e;
  }
  expect(thrown).toBeInstanceOf(ApplyError);
  expect({
    reason: (thrown as ApplyError).reason,
    text: text.test((thrown as Error).message),
  }).toEqual({
    reason,
    text: true,
  });
};

describe("the plan of a deletion.confirmed", () => {
  it("the row settled from the source table as the deletion leaves it, as the results say", () => {
    const cs = planDeletionConfirmed(SELF, event(), INPUT);
    expect(kinds(cs)).toEqual([
      "base_sources_row",
      "rows_replace",
      "cells",
      "counts_add",
      "sources_state",
      "deletion_insert",
      "pending_blocks",
    ]);
    // #22 out of the source table; #12 and #15 as they were.
    const sources = cs[0] as Extract<Change, { kind: "base_sources_row" }>;
    expect(sources.rows.map((r) => [r[0], r[2], r[3], r[11], r[12], r[13]])).toEqual([
      [12, "f2", 0, "applied", d("10-01"), null],
      [15, "f2", 0, "applied", d("11-10"), null],
    ]);
    expect(cs[1]).toMatchObject({
      kind: "rows_replace",
      rows: [
        [ENTITY, d("10-01"), d("11-10"), "5000", null],
        [ENTITY, d("11-10"), null, "4000", null],
      ],
    });
    // The cells change at the deletion, intent `deletion`.
    expect(cs[2]).toMatchObject({
      kind: "cells",
      op: SELF,
      close: [
        { field: "f2", valid_from: d("10-01"), rec_from: 12 },
        { field: "f2", valid_from: d("11-02"), rec_from: 22 },
        { field: "f2", valid_from: d("11-20"), rec_from: 22 },
      ],
    });
    expect((cs[2] as Extract<Change, { kind: "cells" }>).rows.map((r) => r[5])).toEqual([
      "deletion",
      "deletion",
    ]);
    // The deleted source reads as pending deletion.
    expect(cs[4]).toEqual({ kind: "sources_state", seqs: [21], state: "pending_deletion" });
    expect(cs[5]).toEqual({
      kind: "deletion_insert",
      id: DELETION,
      deletion_kind: "privacy",
      due_at: "2026-11-11T05:00:00.000Z",
      confirmed_seq: SELF,
    });
    expect(cs[6]).toMatchObject({ kind: "pending_blocks", deletion_seq: SELF });
  });

  it("a restatement of the judgement only keeps naming the block that gave the content", () => {
    // #22's item was given 2500 by an earlier deletion (#30, `restated/0`); this deletion
    // restates it again, its interval only. Its content stays 2500, from #30's block.
    const earlier = { seq: 30, path: "restated/0" };
    const row: DeletionRow = {
      ...ROW_IN,
      events: [
        write(12, "5000", 9, "10-01"),
        write(15, "4000", 14, "11-10"),
        write(22, "3000", 21, "11-02", "11-20"),
      ],
      stored: new Map<string, StoredItem>([
        ["12/f2/0", stored("10-01")],
        ["15/f2/0", stored("11-10")],
        ["22/f2/0", stored("11-02", "11-20")],
      ]),
      contentGiven: new Map([
        [
          "22/f2/0",
          {
            ...earlier,
            block: {
              event: 22,
              field: "f2",
              k: 0,
              status: "applied",
              value: "2500",
              sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
              deps: [{ event: 12, field: "f2", k: 0 }],
            },
          },
        ],
      ]),
    };
    const e = event({
      positions: [
        { seq: 9, path: "text" },
        { seq: SELF, path: "summary" },
      ],
      "restated/0": {
        event: 22,
        field: "f2",
        k: 0,
        status: "applied",
        valid: { from: d("11-03"), to: d("11-20") },
        deps: [],
      },
    });
    const stretch = (value: string, by: number, from: string, to?: string) => ({
      value,
      sources: [{ kind: "value", carried: { event: by, field: "f2", k: 0 } }],
      valid: { from: d(from), ...(to !== undefined ? { to: d(to) } : {}) },
      deps: [{ event: by, field: "f2", k: 0 }],
    });
    e["results/0/fields/f2/0"] = stretch("5000", 12, "10-01", "11-03");
    e["results/0/fields/f2/1"] = stretch("2500", 22, "11-03", "11-20");
    e["results/0/fields/f2/2"] = stretch("4000", 15, "11-20");
    const cs = planDeletionConfirmed(SELF, e, { rows: [row] });
    const sources = cs[0] as Extract<Change, { kind: "base_sources_row" }>;
    const r22 = sources.rows.find((r) => r[0] === 22) as readonly unknown[];
    // given_seq, given_path: the last two columns.
    expect(r22.slice(-2)).toEqual([30, "restated/0"]);
    expect(r22[11]).toBe("applied");
    expect([r22[12], r22[13]]).toEqual([d("11-03"), d("11-20")]);
  });

  describe("the results and the row disagree: inconsistent", () => {
    it("a stretch's value", () => {
      const e = event();
      const changed = {
        ...(e["results/0/fields/f2/0"] as Record<string, JsonValue>),
        value: "3000",
      };
      stops(
        () => planDeletionConfirmed(SELF, event({ "results/0/fields/f2/0": changed }), INPUT),
        "inconsistent",
        /f2 on .*not what the row settles to/,
      );
    });
    it("a stretch's giver", () => {
      const e = event();
      const changed = {
        ...(e["results/0/fields/f2/1"] as Record<string, JsonValue>),
        sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
      };
      stops(
        () => planDeletionConfirmed(SELF, event({ "results/0/fields/f2/1": changed }), INPUT),
        "inconsistent",
        /not what the row settles to/,
      );
    });
    it("the gaps", () => {
      stops(
        () =>
          planDeletionConfirmed(
            SELF,
            event({ "results/0/existence": { gaps: [], deps: [] } }),
            INPUT,
          ),
        "inconsistent",
        /gaps are not the result's/,
      );
    });
    it("the outcome: deleted, yet the entity has a value", () => {
      stops(
        () =>
          planDeletionConfirmed(
            SELF,
            event({ "results/0/target": { table: "t2", entity: ENTITY, outcome: "deleted" } }),
            INPUT,
          ),
        "inconsistent",
        /outcome deleted but it exists/,
      );
    });
    it("a row the deletion touches and changes, not listed", () => {
      const e = event();
      for (const p of Object.keys(e)) if (p.startsWith("results/")) delete e[p];
      stops(
        () => planDeletionConfirmed(SELF, e, INPUT),
        "inconsistent",
        /changes but the deletion does not list it/,
      );
    });
  });

  describe("a row touched and not listed", () => {
    it("an event row whose only write is deleted, the results left out: inconsistent", () => {
      const row: DeletionRow = {
        ...ROW_IN,
        table: {
          ...STATE_TABLE,
          id: "t1",
          time: { type: "none" },
          physical: { table: "t_t1_v1" },
        } as never,
        rowId: ROW,
        events: [
          {
            seq: 22,
            op: 21,
            blocks: {
              target: {
                table: "t1",
                row: ROW,
                intent: "insert",
                sv: 1,
                cause: "request",
                op_index: 0,
              },
              "fields/f2/0": { status: "applied", value: "45" },
              "sources/f2/0": [{ kind: "value", source: 21 }],
            },
          },
        ],
        stored: new Map([["22/f2/0", stored("10-01")]]),
        openCells: [
          {
            field: "f2",
            valid_from: null,
            valid_to: null,
            src: { event: 22, target: "f2", k: 0 },
            no_value: false,
            rec_from: 22,
          },
        ],
        count: 1,
        origin: 22,
      };
      const e = event({
        positions: [
          { seq: 22, path: "fields/f2/0" },
          { seq: SELF, path: "summary" },
        ],
      });
      for (const p of Object.keys(e)) if (p.startsWith("results/")) delete e[p];
      stops(
        () => planDeletionConfirmed(SELF, e, { rows: [row] }),
        "inconsistent",
        /changes but the deletion does not list it/,
      );
    });

    it("a state entity whose only write is deleted, the results left out: inconsistent", () => {
      const row: DeletionRow = {
        ...ROW_IN,
        events: [write(22, "3000", 21, "11-02", "11-20")],
        stored: new Map([["22/f2/0", stored("11-02", "11-20")]]),
        openCells: [cell("11-02", "11-20", 22, 22)],
        count: 1,
        origin: 22,
      };
      const e = event();
      for (const p of Object.keys(e)) if (p.startsWith("results/")) delete e[p];
      stops(
        () => planDeletionConfirmed(SELF, e, { rows: [row] }),
        "inconsistent",
        /changes but the deletion does not list it/,
      );
    });
  });

  it("a listed entity with a stretch that changed left out: inconsistent", () => {
    // 4000 on [11-10, ∞) was 4000 on [11-20, ∞): its interval changed, and the result leaves it out.
    const e = event();
    delete e["results/0/fields/f2/1"];
    stops(
      () => planDeletionConfirmed(SELF, e, INPUT),
      "inconsistent",
      /changes .* but is not listed/,
    );
  });

  it("an item not restated keeps the content an earlier deletion gave it", () => {
    // #15's 4000 was given 4500 by an earlier deletion (#30); this deletion does not restate #15.
    const row: DeletionRow = {
      ...ROW_IN,
      contentGiven: new Map([
        [
          "15/f2/0",
          {
            seq: 30,
            path: "restated/0",
            block: {
              event: 15,
              field: "f2",
              k: 0,
              status: "applied",
              value: "4500",
              sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
              deps: [{ event: 12, field: "f2", k: 0 }],
            },
          },
        ],
      ]),
    };
    const e = event();
    const second = e["results/0/fields/f2/1"] as Record<string, JsonValue>;
    e["results/0/fields/f2/1"] = { ...second, value: "4500" };
    const cs = planDeletionConfirmed(SELF, e, { rows: [row] });
    const sources = cs[0] as Extract<Change, { kind: "base_sources_row" }>;
    const r15 = sources.rows.find((r) => r[0] === 15) as readonly unknown[];
    // Its rows still name #30's restatement; carried from #12, as #30 gave it.
    expect(r15.slice(-2)).toEqual([30, "restated/0"]);
    expect(r15[7]).toBe(12);
  });

  it("an item given a new value while a candidate, put back in effect later: that value, not its own block's", () => {
    // #22 was restated by #30 as a candidate with 2600 (out of the source table); this deletion
    // restates it as applied, its judgement only.
    const row: DeletionRow = {
      ...ROW_IN,
      stored: new Map([
        ["12/f2/0", stored("10-01")],
        ["15/f2/0", stored("11-10")],
      ]),
      openCells: [
        cell("10-01", "11-10", 12, 30),
        cell("11-10", null, 15, 30),
        {
          field: "f3",
          valid_from: d("10-01"),
          valid_to: null,
          src: null,
          no_value: false,
          rec_from: 12,
        },
      ],
      count: 2,
      contentGiven: new Map([
        [
          "22/f2/0",
          {
            seq: 30,
            path: "restated/0",
            block: {
              event: 22,
              field: "f2",
              k: 0,
              status: "candidate",
              seen_valid: { from: d("11-02"), to: d("11-20") },
              value: "2600",
              sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
              deps: [{ event: 12, field: "f2", k: 0 }],
            },
          },
        ],
      ]),
    };
    const stretch = (value: string, by: number, from: string, to?: string) => ({
      value,
      sources: [{ kind: "value", carried: { event: by, field: "f2", k: 0 } }],
      valid: { from: d(from), ...(to !== undefined ? { to: d(to) } : {}) },
      deps: [{ event: by, field: "f2", k: 0 }],
    });
    const e: Record<string, JsonValue> = {
      ...event(),
      positions: [
        { seq: 9, path: "text" },
        { seq: SELF, path: "summary" },
      ],
      "restated/0": {
        event: 22,
        field: "f2",
        k: 0,
        status: "applied",
        valid: { from: d("11-02"), to: d("11-20") },
        deps: [],
      },
      "results/0/fields/f2/0": stretch("5000", 12, "10-01", "11-02"),
      "results/0/fields/f2/1": stretch("2600", 22, "11-02", "11-20"),
      "results/0/fields/f2/2": stretch("4000", 15, "11-20"),
    };
    const cs = planDeletionConfirmed(SELF, e, { rows: [row] });
    const r22 = (cs[0] as Extract<Change, { kind: "base_sources_row" }>).rows.find(
      (r) => r[0] === 22,
    ) as readonly unknown[];
    expect(r22.slice(-2)).toEqual([30, "restated/0"]);
  });

  it("an item restated with a new value: its cell closes and opens anew, its interval and giver the same", () => {
    // Nothing of #22 deleted; #15 restated: 4100 now, still #15's item on [11-20, ∞).
    const e: Record<string, JsonValue> = {
      ...event(),
      positions: [
        { seq: 30, path: "text" },
        { seq: SELF, path: "summary" },
      ],
      "restated/0": {
        event: 15,
        field: "f2",
        k: 0,
        status: "applied",
        valid: { from: d("11-10") },
        value: "4100",
        sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
        deps: [{ event: 12, field: "f2", k: 0 }],
      },
      "results/0/fields/f2/0": {
        value: "4100",
        sources: [{ kind: "value", carried: { event: 15, field: "f2", k: 0 } }],
        valid: { from: d("11-20") },
        deps: [{ event: 15, field: "f2", k: 0 }],
      },
    };
    delete e["results/0/fields/f2/1"];
    const cs = planDeletionConfirmed(SELF, e, INPUT);
    const cells = cs.find((c) => c.kind === "cells") as Extract<Change, { kind: "cells" }>;
    expect(cells.close).toEqual([{ field: "f2", valid_from: d("11-20"), rec_from: 22 }]);
    expect(cells.rows.map((r) => [r[2], r[3], r[6], r[11]])).toEqual([
      [d("11-20"), null, 15, "4100"],
    ]);
  });

  describe("not applied in this version: refused, not worked out", () => {
    const withPosition = (path: string, seq = 22) => {
      const e = event();
      e["positions"] = [...(e["positions"] as JsonValue[]), { seq, path }];
      return e;
    };
    it("a premise declaration's business time listed", () => {
      stops(
        () => planDeletionConfirmed(SELF, withPosition("ops/0/premise_valid/0", 21), INPUT),
        "not_implemented",
        /premise declaration/,
      );
    });
    it("a schema constant's backfill listed", () => {
      stops(
        () => planDeletionConfirmed(SELF, withPosition("backfill/t2/f2/0", 5), INPUT),
        "not_implemented",
        /backfill/,
      );
    });
    it("a result on a schema constant", () => {
      const e = event();
      const changed = {
        ...(e["results/0/fields/f2/0"] as Record<string, JsonValue>),
        sources: [{ kind: "schema_const", sv: 1, field: "f2" }],
      };
      stops(
        () => planDeletionConfirmed(SELF, event({ "results/0/fields/f2/0": changed }), INPUT),
        "not_implemented",
        /schema constant/,
      );
    });
    it("a restatement numbering an item anew", () => {
      stops(
        () =>
          planDeletionConfirmed(
            SELF,
            event({
              "restated/0": {
                event: 12,
                field: "f2",
                k: 3,
                status: "applied",
                valid: { from: d("10-01") },
                deps: [],
              },
            }),
            INPUT,
          ),
        "not_implemented",
        /numbers anew/,
      );
    });
    it("a key field listed on a table with an external key", () => {
      const keyed = {
        ...STATE_TABLE,
        id: "t1",
        time: { type: "none" },
        physical: { table: "t_t1_v1" },
        external_key: ["f2"],
      };
      const row: DeletionRow = {
        ...ROW_IN,
        table: keyed as never,
        rowId: ROW,
        events: [{ seq: 22, op: 21, blocks: { "fields/f2/0": { status: "applied", value: "x" } } }],
        stored: new Map([["22/f2/0", stored("10-01")]]),
        openCells: [],
      };
      const e = event();
      for (const p of Object.keys(e)) if (p.startsWith("results/")) delete e[p];
      stops(() => planDeletionConfirmed(SELF, e, { rows: [row] }), "not_implemented", /key field/);
    });
  });

  describe("a deletion.cancelled", () => {
    // The deletion of #22's source cancelled: the row as #22 had it, every item as last given
    // without the deletion (the caller's `stored`); nothing else pending.
    const cancelRow: DeletionRow = {
      ...ROW_IN,
      // As the deletion left it: #22's cell gone.
      openCells: [
        cell("10-01", "11-10", 12, 40),
        cell("11-10", null, 15, 40),
        {
          field: "f3",
          valid_from: d("10-01"),
          valid_to: null,
          src: null,
          no_value: false,
          rec_from: 12,
        },
      ],
      count: 2,
    };
    const cancelled = (over: Record<string, JsonValue> = {}) => ({
      target: { deletion: DELETION, origin: "request" },
      "results/0/target": { table: "t2", entity: ENTITY, outcome: "resegmented" },
      "results/0/fields/f2/0": {
        value: "5000",
        sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
        valid: { from: d("10-01"), to: d("11-02") },
        deps: [{ event: 12, field: "f2", k: 0 }],
      },
      "results/0/fields/f2/1": {
        value: "3000",
        sources: [{ kind: "value", carried: { event: 22, field: "f2", k: 0 } }],
        valid: { from: d("11-02"), to: d("11-20") },
        deps: [{ event: 22, field: "f2", k: 0 }],
      },
      "results/0/fields/f2/2": {
        value: "4000",
        sources: [{ kind: "value", carried: { event: 15, field: "f2", k: 0 } }],
        valid: { from: d("11-20") },
        deps: [{ event: 15, field: "f2", k: 0 }],
      },
      "results/0/existence": { gaps: [{ to: d("10-01") }], deps: [] },
      ...over,
    });
    const FLAG = {
      table_id: "t2",
      row_id: ENTITY,
      flag: "disputed",
      item_id: `pi_${"5".repeat(16)}`,
      fields: '["f2"]',
      spans: null,
    };
    const input = {
      rows: [cancelRow],
      cancelled: SELF,
      sources: [21],
      listed: new Set<string>(),
      restored: [{ id: FLAG.item_id, flag: FLAG }],
    };

    it("the row back, the deletion cancelled, its blocks released, the item put back with its flag", () => {
      const cs = planDeletionCancelled(50, cancelled(), input);
      expect(kinds(cs)).toEqual([
        "base_sources_row",
        "rows_replace",
        "cells",
        "counts_add",
        "deletion_cancel",
        "pending_release",
        "sources_state",
        "item_update",
        "flag_insert",
      ]);
      expect((cs[2] as Extract<Change, { kind: "cells" }>).rows.map((r) => r[5])).toEqual([
        "deletion_cancelled",
        "deletion_cancelled",
        "deletion_cancelled",
      ]);
      expect(cs.slice(4)).toEqual([
        { kind: "deletion_cancel", id: DELETION },
        { kind: "pending_release", deletion_seq: SELF },
        { kind: "sources_state", seqs: [21], state: "present" },
        { kind: "item_update", id: FLAG.item_id, state: "open", version_op: 50 },
        { kind: "flag_insert", row: FLAG },
      ]);
    });

    it("an item's own block still pending under another deletion: out of the row, and the results then disagree", () => {
      stops(
        () =>
          planDeletionCancelled(50, cancelled(), {
            ...input,
            listed: new Set(["22 fields/f2/0"]),
          }),
        "inconsistent",
        /not what the row settles to/,
      );
    });
  });
});
