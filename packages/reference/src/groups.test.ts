// Conflict groups (09-references-conflict-sync «冲突单元», «组值»; conflict criterion ⑤): the
// fields of a group are judged together for conflicts; the same-value step stays field by field.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateLog } from "./evaluate.ts";
import type { Op, TableSchema, WriteOp } from "./model.ts";
import {
  GROUP_LOGS,
  GROUP_TAKE_INTO_HOLE,
  GROUP_TAKE_NOOP_FIELD,
  GROUP_TAKE_NOOP_FIELD_EVENT,
} from "./testing/groups.fixture.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const GROUP: TableSchema = { kind: "state", required: ["f2"], groups: [["f2", "f3"]] };
const EVENT_GROUP: TableSchema = { kind: "event", required: ["f2"], groups: [["f2", "f3"]] };

function w(
  op: number,
  seen: number,
  fields: Record<string, string>,
  o: { from?: string; to?: string; explicit?: string[]; ack?: true; state?: boolean } = {},
): WriteOp {
  return {
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
        { value, sources: [`S${op}${f}`], ...(o.explicit?.includes(f) ? { explicit: true } : {}) },
      ]),
    ) as WriteOp["fields"],
    ...(o.ack ? { acknowledge: ["overwrite"] as const } : {}),
  };
}

const statusOf = (ops: Op[], schema: TableSchema, event: number) =>
  evaluate(schema, ops)
    .items.filter((x) => x.event === event)
    .map((x) => [x.target, x.status])
    .sort();

describe.each([
  ["state", GROUP, true],
  ["event", EVENT_GROUP, false],
] as const)("%s table, group {f2, f3}", (_, schema, state) => {
  it("L changed f2, W gives f2 and f3: both of W's fields are candidates (⑤, the unit as a whole)", () => {
    const ops: Op[] = [
      w(5, 0, { f2: "0", f3: "a" }, { state }),
      w(10, 5, { f2: "1" }, { state }),
      w(20, 5, { f2: "2", f3: "c" }, { state }),
    ];
    expect(statusOf(ops, schema, 21)).toEqual([
      ["f2", "candidate"],
      ["f3", "candidate"],
    ]);
  });

  it("L changed f3 only, W gives f2 only: W's group value differs from the current one, a candidate", () => {
    const ops: Op[] = [
      w(5, 0, { f2: "0", f3: "a" }, { state }),
      w(10, 5, { f3: "b" }, { state }),
      w(20, 5, { f2: "2" }, { state }),
    ];
    expect(statusOf(ops, schema, 21)).toEqual([["f2", "candidate"]]);
  });

  it("W and L both write f2 to the same value: on a state table no conflict (the group value is the same); on an event table the unit changed after V is enough", () => {
    const ops: Op[] = [
      w(5, 0, { f2: "0", f3: "a" }, { state }),
      w(10, 5, { f2: "1" }, { state }),
      w(20, 5, { f2: "1" }, { state }),
    ];
    expect(statusOf(ops, schema, 21)).toEqual([["f2", state ? "applied" : "candidate"]]);
  });

  it("without the group the same log makes only the field L changed a candidate", () => {
    const ops: Op[] = [
      w(5, 0, { f2: "0", f3: "a" }, { state }),
      w(10, 5, { f2: "1" }, { state }),
      w(20, 5, { f2: "2", f3: "c" }, { state }),
    ];
    const plain: TableSchema = { kind: schema.kind, required: ["f2"] };
    expect(statusOf(ops, plain, 21)).toEqual([
      ["f2", "candidate"],
      ["f3", "applied"],
    ]);
  });
});

describe("group judgements needing more than one field", () => {
  it.each(Object.entries(GROUP_LOGS))("%s", (_, { schema, ops, event, want }) => {
    expect(statusOf(ops, schema, event)).toEqual(want);
  });
});

describe("a take on a group, checked on what it writes", () => {
  it("a field the taken write gave as a no-op is not written: into a hole without it, refused", () => {
    const { schema, ops, take } = GROUP_TAKE_INTO_HOLE;
    const steps = evaluateLog(schema, [...ops, take]).steps;
    expect(steps.at(-1)).toMatchObject({ refused: true, rejected: "missing_required" });
  });
});

describe("a take on a group of a write with a field it gave as a no-op", () => {
  it.each([
    ["state table", GROUP_TAKE_NOOP_FIELD],
    ["event table", GROUP_TAKE_NOOP_FIELD_EVENT],
  ] as const)(
    "%s: writes only the fields the candidate has items on; no same-valued candidate stands in",
    (_, { schema, ops, take }) => {
      const final = evaluateLog(schema, [...ops, take]).final;
      const f = final.fields as unknown as Record<
        string,
        { value: unknown; by?: { event: number } }[]
      >;
      expect(f["f2"]?.map((x) => [x.value, x.by?.event])).toEqual([["5", 21]]);
      expect(f["f3"]?.map((x) => [x.value, x.by?.event])).toEqual([["b", 44]]);
    },
  );
});
