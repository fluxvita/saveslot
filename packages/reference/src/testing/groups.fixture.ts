// Logs on a field group whose conflict judgement needs more than one field at a time
// (09-references-conflict-sync «冲突单元», «组值»; conflict criterion ⑤), each with the statuses
// of one write's items. The reference evaluator's tests and the kernel's both judge them.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import type { Op, TableSchema, WriteOp } from "../model.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const GROUP: TableSchema = { kind: "state", required: ["f2"], groups: [["f2", "f3"]] };

const w = (
  op: number,
  seen: number,
  fields: Record<string, string>,
  from = "10-01",
  to: "open" | "next_change" = "open",
  ack = false,
): WriteOp => ({
  kind: "write",
  op,
  event: op + 1,
  seen,
  valid: { from: { mode: "given", value: d(from) }, to: { mode: to } },
  fields: Object.fromEntries(
    Object.entries(fields).map(([f, value]) => [f, { value, sources: [`S${op}${f}`] }]),
  ) as WriteOp["fields"],
  ...(ack ? { acknowledge: ["overwrite"] as const } : {}),
});

/**
 * #11, #21 (in V, a change of `short` over [11-01, 11-05)), #31 (after V, f2 = 3 and f3 = m over
 * [11-03, 11-09)), #61 (seen #20: f2 = 3, f3 = m from 11-01 to the next change).
 */
export function groupInstantOps(short: "f2" | "f3"): Op[] {
  const span = (from: string, to?: string) => ({
    from: { mode: "given" as const, value: d(from) },
    to: to === undefined ? { mode: "open" as const } : { mode: "given" as const, value: d(to) },
  });
  return [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      valid: span("10-01"),
      fields: {
        f2: { value: "1", sources: ["S10"] },
        ...(short === "f3" ? { f3: { value: "1", sources: ["S10f3"] } } : {}),
      },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      valid: span("11-01", "11-05"),
      fields: { [short]: { value: "2", sources: ["S20"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 20,
      valid: span("11-03", "11-09"),
      fields: { f2: { value: "3", sources: ["S30"] }, f3: { value: "m", sources: ["M30"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 60,
      event: 61,
      seen: 20,
      valid: { from: { mode: "given", value: d("11-01") }, to: { mode: "next_change" } },
      fields: {
        f2: { value: "3", sources: ["S6"], explicit: false },
        f3: { value: "m", sources: ["M60"] },
      },
      acknowledge: ["overwrite"],
    },
  ] as Op[];
}

export const GROUP_LOGS: Record<
  string,
  { schema: TableSchema; ops: Op[]; event: number; want: string[][] }
> = {
  // #10: f2 = 1, f3 = a. #20 sets f2 to 2 from 11-01 (a change point of f2 in V). #25, after V,
  // sets f3 to b from 11-05. #30 (seen #20) writes f2 and f3 from 10-01 to the next change: f2's
  // interval ends at f2's change point in V (11-01) and does not meet #25's change; f3's runs on
  // and does. Conflict criterion ⑤: the conflict on the group makes both of #30's fields
  // candidates.
  "⑤: one field's interval meets L, the other's does not": {
    schema: GROUP,
    ops: [
      w(10, 0, { f2: "1", f3: "a" }),
      w(20, 10, { f2: "2" }, "11-01", "open", true),
      w(25, 20, { f3: "b" }, "11-05", "open", true),
      w(30, 20, { f2: "5", f3: "c" }, "10-01", "next_change"),
    ],
    event: 31,
    want: [
      ["f2", "candidate"],
      ["f3", "candidate"],
    ],
  },
  // #20 sets f2 to 1 (it was 0 in V); #25 changes f3. #30 (seen #5) writes f2 = 1: the same as now
  // on f2, but its group value (f2 = 1, f3 = a from V) differs from the current one (1, b).
  "the group value: W's field the same as now, another field of the group changed": {
    schema: GROUP,
    ops: [
      w(5, 0, { f2: "0", f3: "a" }),
      w(20, 5, { f2: "1" }, "10-01", "open", true),
      w(25, 20, { f3: "b" }, "10-01", "open", true),
      w(30, 5, { f2: "1" }),
    ],
    event: 31,
    want: [["f2", "candidate"]],
  },
  // The group value instant by instant: #61 (seen #20) writes f2 = 3 and f3 = m from 11-01 to the
  // next change. Each field's seen interval is its own: f2's stops at f2's change point in V
  // (11-05), f3's runs on. #31, after V, wrote f2 and f3 over [11-03, 11-09). On [11-05, 11-09) only
  // f3's interval reaches: W's group value takes f2 from V (1), not W's 3, and differs from the
  // current (3, m): a conflict, both of #61's fields candidates.
  "the group value: a field W wrote whose seen interval does not hold the instant takes V's value":
    {
      schema: GROUP,
      ops: groupInstantOps("f2"),
      event: 61,
      want: [
        ["f2", "candidate"],
        ["f3", "candidate"],
      ],
    },
  // The same, the other way round: f3's seen interval is the short one (#21 changed f3 in V), f2's
  // runs on; on [11-05, 11-09) W's group value takes f3 from V (1).
  "the group value: the same with f3's seen interval the short one": {
    schema: GROUP,
    ops: groupInstantOps("f3"),
    event: 61,
    want: [
      ["f2", "candidate"],
      ["f3", "candidate"],
    ],
  },
  // Without the group, field by field: neither field's seen interval meets #31 where its value
  // differs, both take effect (up to #31's change point, 11-03).
  "without the group the same log takes effect": {
    schema: { kind: "state", required: ["f2"] },
    ops: groupInstantOps("f2"),
    event: 61,
    want: [
      ["f2", "applied"],
      ["f3", "applied"],
    ],
  },
};

/**
 * A take on a group into a hole (a property counterexample): #30, having seen #10, writes f2 = 1
 * (the same as in V: a no-op, no item) and f3 = b (a candidate against #20's f2 on the group); #40
 * revokes [11-01, 11-03). Taking #30's candidate writes f3 only, over [11-01, ∞): into the hole
 * without the required f2, so the take is refused (04-write-and-read «判定顺序» step 5, on what
 * takes effect). The take is the resolution at #43.
 */
export const GROUP_TAKE_INTO_HOLE: { schema: TableSchema; ops: Op[]; take: Op } = {
  schema: GROUP,
  ops: [
    w(10, 0, { f2: "1", f3: "a" }, "11-01", "open", true),
    w(20, 10, { f2: "5" }, "11-01", "open", true),
    {
      ...w(30, 10, { f2: "1", f3: "b" }, "11-01"),
      fields: { f2: { value: "1", sources: ["S30"] }, f3: { value: "b", sources: ["S30f3"] } },
    },
    {
      kind: "revoke",
      op: 40,
      event: 41,
      seen: 30,
      valid: {
        from: { mode: "given", value: d("11-01") },
        to: { mode: "given", value: d("11-03") },
      },
      validSources: ["S1"],
    } as Op,
  ],
  take: {
    kind: "resolve",
    op: 43,
    event: 44,
    decision: "take_candidate",
    candidates: [31],
    unit: ["f2", "f3"],
    take: 31,
  } as unknown as Op,
};

/**
 * A take on a group of a write that gave one field as a no-op (a property counterexample): #30,
 * having seen #10, writes f2 = 1 (the same as in V: a no-op, no item) and f3 = b (a candidate on
 * the group, against #20's f2); #40, having seen nothing, writes f2 = 1: a candidate in the same
 * item. Taking #30's candidate writes f3 only: #30 has nothing on f2 to take, and #40's same value
 * does not stand in for it. f2 stays #20's 5.
 */
export const GROUP_TAKE_NOOP_FIELD: { schema: TableSchema; ops: Op[]; take: Op } = {
  schema: GROUP,
  ops: [
    w(10, 0, { f2: "1", f3: "a" }, "11-01", "open", true),
    w(20, 10, { f2: "5" }, "11-01", "open", true),
    {
      ...w(30, 10, { f2: "1", f3: "b" }, "11-01"),
      fields: { f2: { value: "1", sources: ["S30"] }, f3: { value: "b", sources: ["S30f3"] } },
    },
    w(40, 0, { f2: "1" }, "11-01", "open", true),
  ],
  take: {
    kind: "resolve",
    op: 43,
    event: 44,
    decision: "take_candidate",
    candidates: [31, 41],
    unit: ["f2", "f3"],
    take: 31,
  } as unknown as Op,
};

/** The same on an event table (a second counterexample): no interval, the same take. */
export const GROUP_TAKE_NOOP_FIELD_EVENT: { schema: TableSchema; ops: Op[]; take: Op } = {
  schema: { kind: "event", required: ["f2"], groups: [["f2", "f3"]] },
  ops: GROUP_TAKE_NOOP_FIELD.ops.map((o) => {
    const { valid: _, ...rest } = o as WriteOp;
    return rest as Op;
  }),
  take: GROUP_TAKE_NOOP_FIELD.take,
};
