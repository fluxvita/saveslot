// Shadows in a deletion's replay beyond the state table's field unit: an event table, the unit
// existence, a field group, a shadow beside a same-valued real candidate, what lands on a shadow
// resting on what cuts it, and the index a shadow is carried by (03-deletion «回掉的权威定义»
// step 2, «搬运的值»; 09 §3.5 rule 1, §5.7 `carried`). Each against the reference evaluator.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { evaluateLog, type Op, type TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT as EVENT_SCHEMA, STATE as STATE_SCHEMA } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import { view } from "./judge.ts";
import type { OpRecord } from "./model.ts";
import { contributionKey, replayDeletion } from "./replay-deletion.ts";
import { givenByRecords } from "./restate.ts";
import { deletedContributions, judged } from "./scenarios.fixture.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const GROUP: TableSchema = { kind: "state", required: ["f2"], groups: [["f2", "f3"]] };
type Decision = "take_previous" | "take_candidate";
const DECISIONS = ["take_previous", "take_candidate"] as const;

function w(
  op: number,
  seen: number,
  fields: Record<string, string>,
  o: { from?: string; to?: string | null; ack?: true; event?: true } = {},
): Op {
  return {
    kind: "write",
    op,
    event: op + 1,
    seen,
    ...(o.event
      ? {}
      : {
          valid: {
            from: { mode: "given", value: d(o.from ?? "10-01") },
            to:
              o.to === undefined || o.to === null
                ? { mode: "open" }
                : o.to === "next"
                  ? { mode: "next_change" }
                  : { mode: "given", value: d(o.to) },
          },
        }),
    fields: Object.fromEntries(
      Object.entries(fields).map(([f, value]) => [f, { value, sources: [`S${op}`] }]),
    ),
    ...(o.ack ? { acknowledge: ["overwrite"] as const } : {}),
  } as Op;
}
const revoke = (op: number, seen: number, from?: string, to?: string): Op =>
  ({
    kind: "revoke",
    op,
    event: op + 1,
    seen,
    ...(from !== undefined
      ? {
          valid: {
            from: { mode: "given", value: d(from) },
            to: to === undefined ? { mode: "open" } : { mode: "given", value: d(to) },
          },
        }
      : {}),
  }) as Op;
const resolve = (
  op: number,
  decision: Decision,
  candidates: number[],
  unit: string | string[],
  take: number,
): Op =>
  ({
    kind: "resolve",
    op,
    event: op + 1,
    decision,
    candidates,
    unit,
    ...(decision === "take_candidate" ? { take } : {}),
  }) as Op;

type Seg = [string | null, string | null, unknown];
/** A field's values as stretches, adjacent stretches of one value merged. */
function norm(
  segs: readonly { valid: readonly { from: string | null; to: string | null }[]; value: unknown }[],
) {
  const flat: Seg[] = [];
  for (const s of segs) for (const v of s.valid) flat.push([v.from, v.to, s.value]);
  flat.sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  const out: Seg[] = [];
  for (const x of flat) {
    if (x[2] === null) continue;
    const p = out.at(-1);
    if (p !== undefined && p[1] === x[0] && JSON.stringify(p[2]) === JSON.stringify(x[2])) {
      p[1] = x[1];
    } else out.push([...x]);
  }
  return out;
}

/** The kernel's replay and the reference evaluator, one deletion of `sources`. */
function both(schema: TableSchema, ops: Op[], sources: string[]) {
  const { table, steps } = judged(schema, ops, []);
  expect(steps).toHaveLength(ops.length);
  const records = steps.map((x) => x.judgement.record);
  const kept = steps.map((x) => x.op);
  const contributions = deletedContributions(kept, new Set(sources), schema.kind === "state");
  const after = replayDeletion(table, records, contributions);
  const last = Math.max(...kept.map((o) => Math.max(o.op, o.event)));
  const ref = evaluateLog(schema, [
    ...kept,
    { kind: "deletion", op: last + 1, id: "pi_x", sources: [...sources] },
  ]).final;
  const kv = view(after.state);
  const fields = (f: Record<string, unknown>) =>
    Object.fromEntries(
      ["f2", "f3"].map((k) => [k, norm((f[k] ?? []) as Parameters<typeof norm>[0])]),
    );
  return {
    table,
    records,
    after,
    kernel: { exists: kv.exists, fields: fields(kv.fields as Record<string, unknown>) },
    reference: { exists: ref.exists, fields: fields(ref.fields as Record<string, unknown>) },
  };
}

const itemsOf = (recs: readonly OpRecord[], event: number) => {
  const r = recs.find((x) => x.event === event);
  return r !== undefined && "items" in r ? r.items : [];
};

/** The blocks as the log has them after a first deletion: its restatements over the records. */
function latestAfter(
  records: readonly OpRecord[],
  restated: ReturnType<typeof replayDeletion>["restated"],
) {
  const latest = new Map(givenByRecords(records));
  for (const r of restated) {
    const et = `${r.item.event}/${r.item.target}`;
    const was = latest.get(et) ?? [];
    latest.set(et, [
      ...was.filter((x) => x.k !== r.item.k),
      {
        k: r.item.k,
        status: r.status,
        valid: r.valid ?? [],
        deps: r.deps,
        content: r.content ?? was[0]?.content ?? { kind: "value", value: null },
      },
    ]);
  }
  return latest;
}

describe("shadows beyond the state table's field unit, against the reference", () => {
  // #5 2; #10 (seen #5) 0; #20 (seen #10) 1; #30 (seen #10) 2, a candidate against #20. S10
  // deleted: #30 is the same as its seen version (#5's 2) with no evidence pointed at: a shadow.
  it.each(DECISIONS)("an event table: %s", (dec) => {
    const ops = [
      w(5, 0, { f2: "2" }, { event: true }),
      w(10, 5, { f2: "0" }, { event: true }),
      w(20, 10, { f2: "1" }, { event: true }),
      w(30, 10, { f2: "2" }, { event: true }),
      resolve(40, dec, [31], "f2", 31),
    ];
    const b = both(EVENT_SCHEMA, ops, ["S10"]);
    expect(itemsOf(b.after.records, 31)).toEqual([]);
    expect(b.kernel).toEqual(b.reference);
    // Taken: #30's 2. Taken back: the merge base as recorded (#10), which is #5's 2 in the replay.
    expect(b.kernel.fields["f2"]).toEqual([[null, null, "2"]]);
  });

  // The unit existence: #30 met #20's revoke on [11-01, 11-05) when written.
  it.each(DECISIONS)("a state table, the unit existence: %s", (dec) => {
    const ops = [
      w(5, 0, { f2: "2" }),
      w(10, 5, { f2: "0" }, { ack: true }),
      revoke(20, 10, "11-01", "11-05"),
      w(30, 10, { f2: "2" }, { from: "11-01" }),
      resolve(40, dec, [31], "existence", 31),
    ];
    const b = both(STATE_SCHEMA, ops, ["S10"]);
    expect(b.kernel).toEqual(b.reference);
  });

  it.each(DECISIONS)("an event table, the unit existence: %s", (dec) => {
    const ops = [
      w(5, 0, { f2: "2" }, { event: true }),
      w(10, 5, { f2: "0" }, { event: true }),
      revoke(20, 10),
      w(30, 10, { f2: "2" }, { event: true }),
      resolve(40, dec, [31], "existence", 31),
    ];
    const b = both(EVENT_SCHEMA, ops, ["S10"]);
    expect(b.kernel).toEqual(b.reference);
  });

  // A field group: on f2 #30 is a shadow, on f3 a real candidate; the take writes both.
  it.each(DECISIONS)("a field group, a shadow on f2 and a candidate on f3: %s", (dec) => {
    const ops = [
      w(5, 0, { f2: "2", f3: "a" }),
      w(10, 5, { f2: "0" }, { ack: true }),
      w(20, 10, { f2: "1", f3: "b" }),
      w(30, 10, { f2: "2", f3: "c" }),
      resolve(40, dec, [31], ["f2", "f3"], 31),
    ];
    const b = both(GROUP, ops, ["S10"]);
    expect(itemsOf(b.after.records, 31).map((x) => x.target)).toEqual(["f3"]);
    expect(b.kernel).toEqual(b.reference);
    if (dec === "take_candidate") {
      expect(b.kernel.fields).toEqual({
        f2: [["2026-10-01", null, "2"]],
        f3: [["2026-10-01", null, "c"]],
      });
    }
  });

  // #35, having seen nothing, writes 2 on [10-01, 10-20): a real candidate of the same value in
  // the item. Taking #30 lands on both, the "or" of 03 «搬运的值»; carried holds both.
  it("a shadow beside a same-valued real candidate: the take lands on both", () => {
    const ops = [
      w(5, 0, { f2: "2" }),
      w(10, 5, { f2: "0" }, { ack: true }),
      w(20, 10, { f2: "1" }),
      w(30, 10, { f2: "2" }),
      w(35, 0, { f2: "2" }, { from: "10-01", to: "10-20" }),
      resolve(40, "take_candidate", [31, 36], "f2", 31),
    ];
    const b = both(STATE_SCHEMA, ops, ["S10"]);
    expect(b.kernel).toEqual(b.reference);
    const take = itemsOf(b.after.records, 41);
    expect(take.length).toBeGreaterThan(0);
    for (const x of take) {
      expect(x.carried).toContainEqual({ event: 31, target: "f2", k: 0 });
      expect(x.carried).toContainEqual({ event: 36, target: "f2", k: 0 });
    }
  });
});

describe("what lands on a shadow rests on what cuts it", () => {
  // #5 2; #10 0; #15 a change from 11-10; #20 (seen #15) 1 on [10-01, 11-10); #25 5 on
  // [11-05, 11-20); #30 (seen #15) 2 from 10-01 to the next change, a candidate against #20; #35
  // (seen #10) 8 on [10-01, 10-20), a candidate in the same item. S10 deleted: #30's shadow on
  // [10-01, 11-10), its end #15's start (#16 cuts it). What the resolution gives over the shadow
  // rests on #16 (09 §3.5 rule 1), so deleting S15 later finds the block.
  const ops = (dec: Decision): Op[] => [
    w(5, 0, { f2: "2" }),
    w(10, 5, { f2: "0" }, { ack: true }),
    w(15, 10, { f2: "7" }, { from: "11-10", ack: true }),
    w(20, 15, { f2: "1" }, { from: "10-01", to: "11-10", ack: true }),
    w(25, 20, { f2: "5" }, { from: "11-05", to: "11-20", ack: true }),
    w(30, 15, { f2: "2" }, { from: "10-01", to: "next" }),
    w(35, 10, { f2: "8" }, { from: "10-01", to: "10-20" }),
    resolve(50, dec, [31, 36], "f2", 31),
  ];

  it.each(DECISIONS)("%s: its deps hold #16; a later deletion of S15 restates it", (dec) => {
    const b = both(STATE_SCHEMA, ops(dec), ["S10"]);
    expect(b.kernel).toEqual(b.reference);
    expect(itemsOf(b.after.records, 31)).toEqual([]);
    const items = itemsOf(b.after.records, 51);
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((x) => x.deps.some((y) => y.event === 16))).toBe(true);
    const second = replayDeletion(
      b.table,
      b.records,
      new Set([contributionKey(11, "f2"), contributionKey(16, "f2")]),
      [],
      latestAfter(b.records, b.after.restated),
    );
    expect(second.restated.map((r) => r.item.event)).toContain(51);
  });
});

describe("the index a shadow is carried by", () => {
  // A write with no evidence pointed at gives one item on a target (one interval, 09 §5.7 one
  // item per stretch), so the index is the one the log last gave (`LatestGiven`), as an earlier
  // deletion left it. Here S10 is deleted first: #30 becomes a shadow, its index 0 restated as
  // dropped. Then S20 with S10 still pending: #30 is still a shadow, its index last given as
  // dropped; the take still carries index 0, as one deletion of both does.
  const ops: Op[] = [
    w(5, 0, { f2: "2" }),
    w(10, 5, { f2: "0" }, { ack: true }),
    w(20, 10, { f2: "1" }),
    w(25, 0, { f2: "9" }, { from: "12-01" }),
    w(30, 10, { f2: "2" }),
    resolve(40, "take_candidate", [31], "f2", 31),
  ];

  it("the index as the log last gave it: dropped by an earlier deletion, still carried", () => {
    const first = both(STATE_SCHEMA, ops, ["S10"]);
    expect(first.after.restated.filter((r) => r.item.event === 31)).toEqual([
      { item: { event: 31, target: "f2", k: 0 }, status: "dropped", deps: [] },
    ]);
    const later = replayDeletion(
      first.table,
      first.records,
      new Set([contributionKey(11, "f2"), contributionKey(26, "f2")]),
      [],
      latestAfter(first.records, first.after.restated),
    );
    const once = both(STATE_SCHEMA, ops, ["S10", "S25"]);
    expect(once.kernel).toEqual(once.reference);
    expect(later.records).toEqual(once.after.records);
    const take = itemsOf(later.records, 41);
    expect(take.length).toBeGreaterThan(0);
    for (const x of take) expect(x.carried).toEqual([{ event: 31, target: "f2" as FieldId, k: 0 }]);
    // Index 0 was last given as dropped: the later deletion says nothing new of it.
    expect(later.restated.filter((r) => r.item.event === 31)).toEqual([]);
  });
});
