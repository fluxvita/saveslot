// An empty value written where there is none is the same value (10-types-and-units «清空字段»:
// 新增时显式写 null 与"原来没有值"同值; the same-value table «空与空相同»; 04-write-and-read /
// 05-time: the same value with no evidence pointed at is a no-op, with evidence a corroboration).
// What is compared is what is read: no contribution and an empty one both read empty. Each case
// against the reference evaluator.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { evaluateLog, type Op, type TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, STATE } from "@fluxvita/saveslot-reference/testing";
import { describe, expect, it } from "vitest";
import type { OpRecord } from "./model.ts";
import { contributionKey, replayDeletion } from "./replay-deletion.ts";
import { deletedContributions, judged } from "./scenarios.fixture.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const put = (
  state: boolean,
  op: number,
  seen: number,
  fields: Record<string, string | null>,
  o: { explicit?: boolean; ack?: boolean } = {},
): Op =>
  ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    ...(state
      ? { valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } } }
      : {}),
    fields: Object.fromEntries(
      Object.entries(fields).map(([f, value]) => [
        f,
        { value, sources: [`S${op}${f}`], ...(o.explicit ? { explicit: true } : {}) },
      ]),
    ),
    ...(o.ack ? { acknowledge: ["overwrite"] as const } : {}),
  }) as Op;

/** The record's items and no-ops on `f` for event `event`. */
const on = (records: readonly OpRecord[], event: number, f: string) => {
  const r = records.find((x) => x.event === event);
  if (r === undefined || !("items" in r)) return { items: [], noop: false };
  return {
    items: r.items.filter((x) => x.target === f).map((x) => x.status),
    noop: r.kind === "write" && r.noop.includes(f as FieldId),
  };
};
const refOn = (schema: TableSchema, ops: Op[], event: number, f: string) =>
  evaluateLog(schema, ops)
    .final.items.filter((x) => x.event === event && x.target === f)
    .map((x) => x.status);

const tables = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

describe.each(tables)("%s table", (_, schema, state) => {
  // Created: on an event table the row has no contribution on f3 before; on a state table this
  // write makes the entity begin to exist, where f3 written empty is as f3 not given.
  const created = it;
  created("created with f3 null, no evidence pointed at: a no-op on f3", () => {
    const ops = [put(state, 10, 0, { f2: "1", f3: null })];
    const { steps } = judged(schema, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 11, "f3")).toEqual({ items: [], noop: true });
    expect(refOn(schema, ops, 11, "f3")).toEqual([]);
  });

  created("created with f3 null, evidence pointed at: a corroboration", () => {
    const ops = [put(state, 10, 0, { f2: "1", f3: null }, { explicit: true })];
    const { steps } = judged(schema, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 11, "f3").items).toEqual(["corroborated"]);
    expect(refOn(schema, ops, 11, "f3")).toEqual(["corroborated"]);
  });

  it("f3 never written, then written null with no evidence: a no-op, no new version", () => {
    const ops = [put(state, 10, 0, { f2: "1" }, { ack: true }), put(state, 20, 10, { f3: null })];
    const { steps } = judged(schema, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 21, "f3")).toEqual({ items: [], noop: true });
    expect(refOn(schema, ops, 21, "f3")).toEqual([]);
  });

  it("f3 never written, then written null with evidence: a corroboration", () => {
    const ops = [
      put(state, 10, 0, { f2: "1" }, { ack: true }),
      put(state, 20, 10, { f3: null }, { explicit: true }),
    ];
    const { steps } = judged(schema, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 21, "f3").items).toEqual(["corroborated"]);
    expect(refOn(schema, ops, 21, "f3")).toEqual(["corroborated"]);
  });

  it("f3 written, then cleared: an empty contribution in effect (not the same value)", () => {
    const ops = [
      put(state, 10, 0, { f2: "1", f3: "x" }, { ack: true }),
      put(state, 20, 10, { f3: null }, { ack: true }),
    ];
    const { steps } = judged(schema, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 21, "f3").items).toEqual(["applied"]);
    expect(refOn(schema, ops, 21, "f3")).toEqual(["applied"]);
  });

  it("a deletion takes the value cleared away: the clearing write is a no-op in the replay", () => {
    // #10 f2=1; #15 f3=x; #20 clears f3. Deleting #15's source: #20 writes empty where there is
    // no contribution: the same value, no item (an empty contribution no longer).
    const ops = [
      put(state, 10, 0, { f2: "1" }, { ack: true }),
      put(state, 15, 10, { f3: "x" }, { ack: true }),
      put(state, 20, 15, { f3: null }, { ack: true }),
    ];
    const { table, steps } = judged(schema, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 21, "f3").items).toEqual(["applied"]);
    const after = replayDeletion(table, records, new Set([contributionKey(16, "f3")]));
    expect(after.state.items.filter((x) => x.event === 21 && x.target === "f3")).toEqual([]);
    const ref = evaluateLog(schema, [
      ...ops,
      { kind: "deletion", op: 30, id: "pi_d", sources: ["S15f3"] },
    ]).final;
    // The reference's view lists items restated as dropped too: no contribution.
    expect(
      ref.items.filter((x) => x.event === 21 && x.target === "f3" && x.status !== "dropped"),
    ).toEqual([]);
  });
});

describe("state table: an empty value across where the write makes the entity exist and where it exists", () => {
  // #10 f2=1, f3=x from 11-01 (the entity from 11-01). #20 (seen #10) writes f2=1, f3 empty from
  // 10-01, pointing at its evidence. On [10-01, 11-01) it makes the entity begin to exist: f3
  // empty is as not given, the same, a corroboration. From 11-01 f3 had x: written empty, a
  // change (cleared), applied there.
  const at = (
    op: number,
    seen: number,
    from: string,
    fields: Record<string, string | null>,
    explicit = false,
  ): Op =>
    ({
      kind: "write",
      op,
      event: op + 1,
      seen,
      valid: { from: { mode: "given", value: d(from) }, to: { mode: "open" } },
      fields: Object.fromEntries(
        Object.entries(fields).map(([f, value]) => [
          f,
          { value, sources: [`S${op}${f}`], ...(explicit ? { explicit: true } : {}) },
        ]),
      ),
      acknowledge: ["overwrite"],
    }) as Op;
  it("not the same as its version where f3 had a value: an ordinary write over the whole, as the reference", () => {
    const ops = [
      at(10, 0, "11-01", { f2: "1", f3: "x" }),
      at(20, 10, "10-01", { f2: "1", f3: null }, true),
    ];
    const { steps } = judged(STATE, ops, []);
    const r = steps[1]?.judgement.record;
    const f3 =
      r !== undefined && "items" in r
        ? r.items.filter((x) => x.target === "f3").map((x) => [x.status, x.valid])
        : [];
    // Not the same as its version on [11-01, ∞) (x there): an ordinary write over its whole
    // interval (05-time «用同样的值写»: only a write the same as its version is split, against the
    // current value), as before; on [10-01, 11-01) that makes its empty f3 a contribution too.
    expect(f3).toEqual([["applied", [{ from: d("10-01"), to: null }]]]);
    const ref = evaluateLog(STATE, ops)
      .final.items.filter((x) => x.event === 21 && x.target === "f3")
      .map((x) => [x.status, x.valid]);
    expect(ref).toEqual(f3);
  });
});

describe("state table: where the write makes the entity begin to exist, decided by every required field", () => {
  const TWO: TableSchema = { kind: "state", required: ["f1", "f2"] as FieldId[] };
  const statusOn = (
    items: readonly { event: number; target: string; status: string }[],
    f: string,
  ) =>
    items
      .filter((x) => x.event === 21 && x.target === f && x.status !== "dropped")
      .map((x) => x.status);

  it("a required field with a value there already and one given: f3 empty is as not given, in a deletion's replay", () => {
    // #10 f1=a, f2=b; #15 (seen #10) f1=d; #20 (seen #15) f2=c, f3 empty, pointing at its
    // evidence: f3 has no contribution where the entity exists, a corroboration. The deletion of
    // S10f2 takes #10 away whole (its evidence is not mapped to intervals): f1 still has #15's
    // value, f2 none, so the entity has no value there. In the replay #20 makes it begin to exist
    // (f1 there already, f2 given): its empty f3 is as not given, the same, still a corroboration.
    // Were only the fields #20 gives counted, f3 would read "no value" there and take effect.
    const ops = [
      put(true, 10, 0, { f1: "a", f2: "b" }, { ack: true }),
      put(true, 15, 10, { f1: "d" }, { ack: true }),
      put(true, 20, 15, { f2: "c", f3: null }, { ack: true, explicit: true }),
    ];
    const { table, steps } = judged(TWO, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 21, "f3").items).toEqual(["corroborated"]);
    const gone = deletedContributions(ops, new Set(["S10f2"]), true);
    const after = replayDeletion(table, records, gone);
    expect(statusOn(after.state.items, "f2")).toEqual(["applied"]);
    expect(statusOn(after.state.items, "f3")).toEqual(["corroborated"]);
    const ref = evaluateLog(TWO, [
      ...ops,
      { kind: "deletion", op: 30, id: "pi_d", sources: ["S10f2"] },
    ]).final;
    expect(statusOn(ref.items, "f2")).toEqual(["applied"]);
    expect(statusOn(ref.items, "f3")).toEqual(["corroborated"]);
  });

  it("optional fields alone, over what a deletion leaves without a value: f3 empty is not the same there", () => {
    // #10 f2=1; #20 (seen #10) f3 empty, pointing at its evidence: a corroboration (the entity
    // exists, f3 has no contribution). The deletion of S10f2 leaves the entity without a value:
    // #20 gives no required field, so it does not make the entity exist, and its empty f3 reads
    // "no value" there, not empty: not the same value, judged as an ordinary write.
    const ops = [
      put(true, 10, 0, { f2: "1" }, { ack: true }),
      put(true, 20, 10, { f3: null }, { explicit: true }),
    ];
    const { table, steps } = judged(STATE, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 21, "f3").items).toEqual(["corroborated"]);
    const after = replayDeletion(
      table,
      records,
      deletedContributions(ops, new Set(["S10f2"]), true),
    );
    const ref = evaluateLog(STATE, [
      ...ops,
      { kind: "deletion", op: 30, id: "pi_d", sources: ["S10f2"] },
    ]).final;
    expect(statusOn(after.state.items, "f3")).toEqual(["applied"]);
    expect(statusOn(after.state.items, "f3")).toEqual(statusOn(ref.items, "f3"));
  });
});

describe("state table: the same value now, where the entity was revoked after the version seen", () => {
  // #10 f2=1; #15 (seen #10) revokes from 10-01; #20 (seen #10) writes f3 empty, pointing at its
  // evidence. As seen, f3 had no contribution where the entity existed: the same value. Now the
  // entity has no value there and #20 does not make it exist (no required field given, none with
  // a value now): the value was changed since the version seen, so the part is an ordinary write
  // and meets the revoke (05-time «用同样的值写»), as a non-empty value written the same would.
  const revoke: Op = {
    kind: "revoke",
    op: 15,
    event: 16,
    seen: 10,
    valid: { from: { mode: "given", value: d("10-01") }, to: { mode: "open" } },
    validSources: ["R15"],
  } as Op;
  it("written empty: a candidate, not a corroboration", () => {
    const ops = [
      put(true, 10, 0, { f2: "1" }, { ack: true }),
      revoke,
      put(true, 20, 10, { f3: null }, { explicit: true }),
    ];
    const { steps } = judged(STATE, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 21, "f3").items).toEqual(["candidate"]);
    expect(refOn(STATE, ops, 21, "f3")).toEqual(["candidate"]);
  });
  it("the same with a value: a candidate too", () => {
    const ops = [
      put(true, 10, 0, { f2: "1", f3: "x" }, { ack: true }),
      revoke,
      put(true, 20, 10, { f3: "x" }, { explicit: true }),
    ];
    const { steps } = judged(STATE, ops, []);
    const records = steps.map((x) => x.judgement.record);
    expect(on(records, 21, "f3").items).toEqual(["candidate"]);
    expect(refOn(STATE, ops, 21, "f3")).toEqual(["candidate"]);
  });
});
