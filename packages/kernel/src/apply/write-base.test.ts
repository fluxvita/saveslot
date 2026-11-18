// The plan of a `write.base` on given inputs (09-event-format §5.7): the spec's example of an undo
// over two stretches, change by change; the same write awaiting confirmation (nothing registered,
// nothing in effect); an entry marked `later` registered only within what it supersedes. The
// comparison with judge and the reference evaluator on storage is store-pglite's.

import type { BizPoint, JsonValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { buildOperation, type NewEvent } from "../log/index.ts";
import { interval } from "../time/index.ts";
import { ApplyError, type ApplyEvent, eventsOf, planEvent } from "./apply.ts";
import type { SettleItem } from "./settle.ts";
import { SLOT } from "./slot.fixture.ts";
import type { OpenCell, WriteBaseInput } from "./write-base.ts";

const USER = `u_${"1".repeat(26)}` as const;
const ENTITY = `e_${"7".repeat(26)}`;
const HASH = "a".repeat(64);
const NOW = "2026-11-10T04:00:00.000Z";
const d = (md: string) => `2026-${md}` as BizPoint;
const iv = (from: string, to?: string) => interval(d(from), to === undefined ? null : d(to));

const TABLE = {
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

const stored = (event: number, value: string, valid: SettleItem["valid"]): SettleItem => ({
  event,
  target: "f2",
  k: 0,
  status: "applied",
  valid,
  content: { kind: "value", value },
  reverted: [],
});

/** #12 [10-01, ∞) 5000; #15 [11-10, ∞) 4000; #22 [11-02, 11-20) 3000 (09 §5.7). */
const ITEMS = [
  stored(12, "5000", iv("10-01")),
  stored(15, "4000", iv("11-10")),
  stored(22, "3000", iv("11-02", "11-20")),
];
const cell = (
  field: string,
  from: string,
  to: string | null,
  src: [number, number] | null,
  rec = 20,
): OpenCell => ({
  field,
  valid_from: d(from),
  valid_to: to === null ? null : d(to),
  src: src === null ? null : { event: src[0], target: "f2", k: src[1] },
  no_value: false,
  rec_from: rec,
});
const OPEN = [
  cell("f2", "10-01", "11-02", [12, 0], 10),
  cell("f2", "11-02", "11-20", [22, 0]),
  cell("f2", "11-20", null, [15, 0], 15),
  cell("f3", "10-01", null, null, 10),
];
const INPUT: WriteBaseInput = {
  table: TABLE as never,
  items: ITEMS,
  openCells: OPEN,
  count: 3,
  sv: 1,
  rowTable: "t2",
};

/** The undo's write.base (operation 30, event 31), its items with the given status. */
function undoBase(status: "applied" | "awaiting", revert: Record<string, JsonValue>): ApplyEvent {
  const ctx = {
    now: NOW,
    today: "2026-11-10",
    ruleset_version: 1,
    policy_version: 1,
    literal_checker: "literal@1",
  };
  const events: NewEvent[] = [
    {
      type: "write.head",
      slot: SLOT,
      blocks: {
        ctx,
        request: { sv: 1, sv_basis: "explicit", op_count: 1 },
        "ops/0/target": { table: "t2", entity: ENTITY, intent: "update" },
        "ops/0/revert": { undo_op: 20, include_later: false },
      },
    },
    {
      type: "write.base",
      slot: SLOT,
      blocks: {
        target: {
          table: "t2",
          entity: ENTITY,
          intent: "update",
          sv: 1,
          cause: "request",
          op_index: 0,
        },
        "fields/f2/0": { status, value: "5000" },
        "sources/f2/0": [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
        "span/f2/0": { valid: { from: d("11-02"), to: d("11-10") } },
        "fields/f2/1": { status, value: "4000" },
        "sources/f2/1": [{ kind: "value", carried: { event: 15, field: "f2", k: 0 } }],
        "span/f2/1": { valid: { from: d("11-10"), to: d("11-20") } },
        revert,
      },
    },
  ];
  return eventsOf(
    buildOperation({ seq: 29, hash: HASH, at: NOW }, { actor: USER, now: NOW as never, events }),
  )[1] as ApplyEvent;
}

describe("the plan of a write.base", () => {
  it("09 §5.7: an undo over two stretches, change by change", () => {
    const base = undoBase("applied", { before_op: 20, items: [{ event: 22, field: "f2" }] });
    const changes = planEvent(base, { writeBase: INPUT });
    expect(changes.map((c) => c.kind)).toEqual([
      "base_sources_reverted",
      "rows_insert",
      "rows_replace",
      "cells",
      "counts_add",
      "block_deps",
    ]);
    // #22 registered as reverted by operation 30 on its interval ∩ the write-backs.
    expect(changes[0]).toEqual({
      kind: "base_sources_reverted",
      row_id: ENTITY,
      event: 22,
      field: "f2",
      k: 0,
      reverted: '[{"op":30,"valid":[{"from":"2026-11-02","to":"2026-11-20"}]}]',
    });
    // The write-backs in the source table, from what they carry.
    expect(changes[1]).toMatchObject({
      kind: "rows_insert",
      rows: [
        [
          31,
          ENTITY,
          "f2",
          0,
          0,
          "value",
          null,
          12,
          "f2",
          0,
          null,
          "applied",
          d("11-02"),
          d("11-10"),
          false,
          "[]",
        ],
        [
          31,
          ENTITY,
          "f2",
          1,
          0,
          "value",
          null,
          15,
          "f2",
          0,
          null,
          "applied",
          d("11-10"),
          d("11-20"),
          false,
          "[]",
        ],
      ],
    });
    // 5000 back on [11-02, 11-10): the business rows merge by value.
    expect(changes[2]).toMatchObject({
      kind: "rows_replace",
      table: "t_t2_v1",
      key: "entity_id",
      id: ENTITY,
      rows: [
        [ENTITY, d("10-01"), d("11-10"), "5000", null],
        [ENTITY, d("11-10"), null, "4000", null],
      ],
    });
    // #22's cell ends at operation 30; the two write-backs' cells open at it.
    expect(changes[3]).toMatchObject({
      kind: "cells",
      table: "t_t2_v1__ver",
      op: 30,
      close: [{ field: "f2", valid_from: d("11-02"), rec_from: 20 }],
      rows: [
        // revoked, no_value: neither.
        [ENTITY, "f2", d("11-02"), d("11-10"), 30, "update", 31, "f2", 0, null, null, "5000", null],
        [ENTITY, "f2", d("11-10"), d("11-20"), 30, "update", 31, "f2", 1, null, null, "4000", null],
      ],
    });
    expect(changes[4]).toEqual({ kind: "counts_add", table_id: "t2", delta: -1 });
    // What the write-backs carry is what they depend on.
    expect(changes[5]).toEqual({
      kind: "block_deps",
      rows: [
        {
          seq: 31,
          path: "sources/f2/0",
          n: 0,
          dep_event: 12,
          dep_field: "f2",
          dep_k: 0,
          dep_kind: "carried",
        },
        {
          seq: 31,
          path: "sources/f2/1",
          n: 0,
          dep_event: 15,
          dep_field: "f2",
          dep_k: 0,
          dep_kind: "carried",
        },
      ],
    });
  });

  it("the same undo awaiting confirmation: nothing registered, nothing in effect, nothing changed", () => {
    const base = undoBase("awaiting", { before_op: 20, items: [{ event: 22, field: "f2" }] });
    const changes = planEvent(base, { writeBase: INPUT });
    expect(changes.map((c) => c.kind)).toEqual(["rows_replace", "cells", "block_deps"]);
    expect(changes[0]).toMatchObject({
      rows: [
        [ENTITY, d("10-01"), d("11-02"), "5000", null],
        [ENTITY, d("11-02"), d("11-20"), "3000", null],
        [ENTITY, d("11-20"), null, "4000", null],
      ],
    });
    expect(changes[1]).toMatchObject({ close: [], rows: [] });
  });

  it("an entry marked later is registered only within what it supersedes of the undone operation", () => {
    // #27, a later write over [11-15, 11-25), taken back with #22: registered on [11-15, 11-20),
    // where it superseded #22, not where it lies beyond it.
    const later = stored(27, "2000", iv("11-15", "11-25"));
    const base = undoBase("applied", {
      before_op: 20,
      items: [
        { event: 22, field: "f2" },
        { event: 27, field: "f2", later: true },
      ],
    });
    const blocks = new Map(base.blocks);
    blocks.set("span/f2/1", {
      state: "present",
      value: { valid: { from: d("11-10"), to: d("11-25") } },
    });
    const changes = planEvent(
      { ...base, blocks },
      { writeBase: { ...INPUT, items: [...ITEMS, later] } },
    );
    expect(changes.filter((c) => c.kind === "base_sources_reverted")).toEqual([
      expect.objectContaining({
        event: 22,
        reverted: '[{"op":30,"valid":[{"from":"2026-11-02","to":"2026-11-20"}]}]',
      }),
      expect.objectContaining({
        event: 27,
        reverted: '[{"op":30,"valid":[{"from":"2026-11-15","to":"2026-11-20"}]}]',
      }),
    ]);
  });

  it("an uncovered write-back exposes the item under the one it registers", () => {
    const base = undoBase("applied", { before_op: 20, items: [{ event: 22, field: "f2" }] });
    const blocks = new Map(base.blocks);
    for (const p of ["fields/f2/1", "sources/f2/1", "span/f2/1", "sources/f2/0"]) blocks.delete(p);
    blocks.set("fields/f2/0", { state: "present", value: { status: "applied", uncovered: true } });
    blocks.set("span/f2/0", {
      state: "present",
      value: { valid: { from: d("11-02"), to: d("11-20") } },
    });
    const changes = planEvent({ ...base, blocks }, { writeBase: INPUT });
    // #22 registered: 5000 on [11-02, 11-10) from #12, 4000 on [11-10, 11-20) from #15.
    expect(changes.find((c) => c.kind === "rows_replace")).toMatchObject({
      rows: [
        [ENTITY, d("10-01"), d("11-10"), "5000", null],
        [ENTITY, d("11-10"), null, "4000", null],
      ],
    });
  });

  it("a registration on an item registered before is added to the earlier one", () => {
    const earlier = {
      ...stored(22, "3000", iv("11-02", "11-20")),
      reverted: [{ op: 25, valid: iv("11-02", "11-05") }],
    };
    const base = undoBase("applied", { before_op: 20, items: [{ event: 22, field: "f2" }] });
    const changes = planEvent(base, {
      writeBase: { ...INPUT, items: [ITEMS[0] as SettleItem, ITEMS[1] as SettleItem, earlier] },
    });
    expect(changes.find((c) => c.kind === "base_sources_reverted")).toMatchObject({
      event: 22,
      reverted:
        '[{"op":25,"valid":[{"from":"2026-11-02","to":"2026-11-05"}]},{"op":30,"valid":[{"from":"2026-11-02","to":"2026-11-20"}]}]',
    });
  });
});

describe("the source table rows of a write.base", () => {
  it("one row per source (n = 0, 1, …); a corroborating item on an event table marked corroborated", () => {
    const ROW = `r_${"6".repeat(26)}`;
    const head = undoBase("applied", { before_op: 20, items: [] });
    const blocks = new Map<
      string,
      ApplyEvent["blocks"] extends ReadonlyMap<string, infer V> ? V : never
    >([
      [
        "target",
        {
          state: "present",
          value: { table: "t1", row: ROW, intent: "update", sv: 1, cause: "request", op_index: 0 },
        },
      ],
      ["fields/f2/0", { state: "present", value: { status: "applied", value: "a" } }],
      [
        "sources/f2/0",
        {
          state: "present",
          value: [
            { kind: "value", source: 7 },
            { kind: "value", source: 8 },
          ],
        },
      ],
      ["fields/f3/0", { state: "present", value: { status: "corroborated", value: "c" } }],
      ["sources/f3/0", { state: "present", value: [{ kind: "value", source: 9 }] }],
    ]);
    const table = { ...TABLE, id: "t1", time: { type: "none" }, physical: { table: "t_t1_v1" } };
    const changes = planEvent(
      { ...head, blocks },
      {
        writeBase: {
          table: table as never,
          items: [],
          openCells: [],
          count: 0,
          sv: 1,
          rowTable: "t1",
        },
      },
    );
    const rows = (changes.find((c) => c.kind === "rows_insert") as unknown as { rows: unknown[][] })
      .rows;
    // [event, row, field, k, n, kind, source, carried ×3, schema_const_sv, status, from, to, corroborated, reverted]
    expect(rows.map((r) => [r[2], r[4], r[6], r[11], r[14]])).toEqual([
      ["f2", 0, 7, "applied", false],
      ["f2", 1, 8, "applied", false],
      ["f3", 0, 9, "corroborated", true],
    ]);
  });
});

describe("a write.base that does not fit the row stops apply, decided in the plan", () => {
  const why = (ev: ApplyEvent, input: WriteBaseInput = INPUT) => {
    try {
      planEvent(ev, { writeBase: input });
    } catch (e) {
      if (e instanceof ApplyError)
        return `${e.reason}: ${e.message.replace(/^apply stopped at seq \d+: /, "")}`;
      throw e;
    }
    return "applied";
  };
  const base = undoBase("applied", { before_op: 20, items: [{ event: 22, field: "f2" }] });
  const edit = (
    f: (
      b: Map<string, ApplyEvent["blocks"] extends ReadonlyMap<string, infer V> ? V : never>,
    ) => void,
  ) => {
    const blocks = new Map(base.blocks);
    f(blocks);
    return { ...base, blocks };
  };
  const present = (value: JsonValue) => ({ state: "present" as const, value });
  const target = (base.blocks.get("target") as { value: Record<string, JsonValue> }).value;
  const ROW = `r_${"6".repeat(26)}`;
  const EVENT_TABLE = { ...TABLE, time: { type: "none" }, physical: { table: "t_t2_v1" } };

  it("as it is, applied", () => {
    expect(why(base)).toBe("applied");
  });

  it("a state table's item without its interval block", () => {
    expect(why(edit((b) => b.delete("span/f2/1")))).toBe(
      "inconsistent: fields/f2/1 has no span/f2/1",
    );
  });

  it("a row of another table", () => {
    expect(why(base, { ...INPUT, rowTable: "t4" })).toBe(
      `inconsistent: ${ENTITY} is a row of t4, not of t2`,
    );
  });

  it("a row on a state table, an entity on a table without time", () => {
    const { entity: _, ...rest } = target;
    expect(why(edit((b) => b.set("target", present({ ...rest, row: ROW }))))).toBe(
      "inconsistent: a state table's target is an entity",
    );
    expect(why(base, { ...INPUT, table: EVENT_TABLE as never })).toBe(
      "inconsistent: a timeless table's target is a row",
    );
  });

  it("an interval block or an interval revoke on a table without time", () => {
    const { entity: _, ...rest } = target;
    const onRow = (f: (b: Map<string, never>) => void) =>
      edit((b) => {
        b.set("target", present({ ...rest, row: ROW }));
        f(b as never);
      });
    const timeless = { ...INPUT, table: EVENT_TABLE as never };
    expect(
      why(
        onRow(() => {}),
        timeless,
      ),
    ).toBe("inconsistent: span/f2/0 on a table without time");
    const revoke = onRow((b: Map<string, unknown>) => {
      for (const p of [...b.keys()]) if (/^(fields|sources|span)\//.test(p)) b.delete(p);
      b.delete("revert");
      b.set("existence/0", present({ status: "applied", scope: "interval" }));
      b.set("span/existence/0", present({ valid: { from: d("11-02"), to: d("11-10") } }));
    });
    expect(why(revoke, timeless)).toBe(
      "inconsistent: existence/0: an interval revoke on a table without time",
    );
  });

  it("an item of a field the table does not have", () => {
    const ev = edit((b) => {
      b.set("fields/f9/0", present({ status: "applied", value: "x" }));
      b.set("sources/f9/0", present([{ kind: "value", source: 7 }]));
      b.set("span/f9/0", present({ valid: { from: d("11-02"), to: d("11-10") } }));
    });
    expect(why(ev)).toBe("inconsistent: fields/f9/0: the table has no field f9");
  });

  it("a target of another schema version", () => {
    expect(why(base, { ...INPUT, sv: 2 })).toBe(
      "inconsistent: target.sv 1 is not the current version 2",
    );
  });

  it("a corroboration on a state table is not applied yet", () => {
    const ev = edit((b) =>
      b.set("fields/f2/0", present({ status: "corroborated", value: "5000" })),
    );
    expect(why(ev)).toBe(
      "not_implemented: fields/f2/0: corroborations on a state table are not applied yet",
    );
  });
});
