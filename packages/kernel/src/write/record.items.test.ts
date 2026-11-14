// The pending item events and the resolution events the record mapping writes, block by block
// (09-event-format §5.8), and what the comparison's scenarios do not reach: candidate indices from 2,
// a revoke over the whole entity, a candidate's deps, a take written one item per stretch.

import type {
  BizPoint,
  EntityId,
  FieldId,
  ItemId,
  RowId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { parseEvent } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { replay } from "../judge/judge.ts";
import type { JudgeInput, Judgement, TableShape } from "../judge/model.ts";
import {
  decodeRecords,
  encodeOp,
  encodeResolution,
  type RowContext,
  type StoredEvent,
} from "./record.ts";

const HASH = "a".repeat(64);
const CONN = `ci_${"2".repeat(26)}`;
const SLOT = `sl_${"4".repeat(16)}`;
const ROW = `r_${"6".repeat(26)}` as RowId;
const ENTITY = `e_${"7".repeat(26)}` as EntityId;
const ITEM = `pi_${"8".repeat(16)}` as ItemId;
const AT = "2026-11-10T04:41:07.123Z";
const d = (md: string) => `2026-${md}` as BizPoint;
const versions = { ruleset_version: 1, policy_version: 1 };

const shape = (kind: "state" | "event"): TableShape => ({
  kind,
  fields: ["f2", "f3"],
  valued: ["f2"],
  required: ["f2"],
  groups: [],
});
const ctxOf = (kind: "state" | "event"): RowContext => ({
  table: "t1" as TableId,
  target: kind === "state" ? { entity: ENTITY } : { row: ROW },
  shape: shape(kind),
  granularity: "date",
});

type Valid = { from: { mode: "given"; value: BizPoint }; to: { mode: string; value?: BizPoint } };
const given = (from: string, to?: string): Valid => ({
  from: { mode: "given", value: d(from) },
  to:
    to === undefined
      ? { mode: "open" }
      : to === "next"
        ? { mode: "next_change" }
        : { mode: "given", value: d(to) },
});

function write(
  op: number,
  fields: Record<string, string>,
  o: { seen?: number; valid?: Valid; ack?: boolean; explicit?: boolean } = {},
): JudgeInput {
  return {
    kind: "write",
    op,
    index: 0,
    event: op + 1,
    ruleset: 1,
    seen: o.seen ?? op - 1,
    seenExplicit: o.seen !== undefined,
    ...(o.valid !== undefined ? { valid: o.valid as never } : {}),
    now: d("11-05"),
    fields: Object.fromEntries(
      Object.entries(fields).map(([f, v]) => [
        f,
        { value: v, ...(o.explicit ? { explicit: true } : {}) },
      ]),
    ) as Partial<Record<FieldId, { value: string }>>,
    ...(o.ack ? { acknowledge: true } : {}),
  };
}
const revoke = (op: number, seen: number, valid?: Valid): JudgeInput => ({
  kind: "revoke",
  op,
  index: 0,
  event: op + 1,
  ruleset: 1,
  seen,
  seenExplicit: true,
  ...(valid !== undefined ? { valid: valid as never } : {}),
  now: d("11-05"),
});

const opEnc = (input: JudgeInput, j: Judgement, extra: Record<string, unknown> = {}) => ({
  intent:
    input.kind === "revoke"
      ? ("revoke" as const)
      : j.created
        ? ("insert" as const)
        : ("update" as const),
  ...(j.created ? { created: true as const } : {}),
  sv: 1,
  sources: [input.op],
  raw:
    input.kind === "write"
      ? Object.fromEntries(Object.entries(input.fields).map(([f, x]) => [f, x?.value ?? null]))
      : {},
  restoreCount: 0,
  versions: { ruleset: 1, policy: 1 },
  ...extra,
});

const parses = (
  type: string,
  seq: number,
  op: number | undefined,
  blocks: Record<string, unknown>,
) =>
  parseEvent(
    {
      type,
      v: 1,
      seq,
      at: AT,
      prev_hash: HASH,
      actor: CONN,
      slot: SLOT,
      ...(op !== undefined ? { op } : {}),
    },
    blocks,
  );

describe("pending item events", () => {
  it("a conflict item opened, then joined twice: indices 0, 1, 2; the merge base recomputed", () => {
    const ctx = ctxOf("event");
    const inputs = [
      write(10, { f2: "1" }),
      write(20, { f2: "2" }, { seen: 10, ack: true }),
      write(25, { f2: "5" }, { seen: 20, ack: true }),
      write(30, { f2: "3" }, { seen: 10 }),
      write(40, { f2: "4" }, { seen: 20 }),
      write(50, { f2: "6" }, { seen: 9 }),
    ];
    const { judgements } = replay(ctx.shape, inputs);
    const at = (n: number, item: Record<string, unknown>) =>
      encodeOp(
        ctx,
        inputs[n] as JudgeInput,
        judgements[n] as Judgement,
        opEnc(inputs[n] as JudgeInput, judgements[n] as Judgement, { conflictItems: [item] }),
      );
    const opened = at(3, { item: ITEM, candidate: 0, mergeBase: 10 });
    const joined = at(4, { item: ITEM, merged: true, candidate: 1, mergeBase: 10 });
    const again = at(5, { item: ITEM, merged: true, candidate: 2, mergeBase: 9 });
    expect(opened.items).toEqual([
      {
        type: "item.created",
        blocks: {
          target: {
            item: ITEM,
            type: "conflict",
            reason: "stale_write",
            table: "t1",
            row: ROW,
            unit: ["f2"],
            merge_base_op: 10,
            origin_event: 31,
            ...versions,
          },
          "candidates/0": {
            event: 31,
            intent: "update",
            seen: { op: 10, restore_count: 0 },
            cause: "stale_write",
            items: [{ field: "f2", k: 0, value: "3" }],
            deps: [{ event: 31, field: "f2", k: 0 }],
          },
        },
      },
    ]);
    expect(joined.items).toEqual([
      {
        type: "item.merged",
        blocks: {
          target: { item: ITEM, merge_base_op: 10, origin_event: 41, ...versions },
          "candidates/1": {
            event: 41,
            intent: "update",
            seen: { op: 20, restore_count: 0 },
            cause: "stale_write",
            items: [{ field: "f2", k: 0, value: "4" }],
            deps: [{ event: 41, field: "f2", k: 0 }],
          },
        },
      },
    ]);
    expect(again.items[0]?.blocks).toMatchObject({
      target: { merge_base_op: 9 },
      "candidates/2": { event: 51, seen: { op: 9, restore_count: 0 } },
    });
    for (const [n, e] of [opened, joined, again].entries()) {
      for (const it of e.items) expect(parses(it.type, 100 + n, 30, it.blocks).ok).toBe(true);
    }
  });

  it("a revoke candidate on a state table: unit existence, its existence item with its interval", () => {
    const ctx = ctxOf("state");
    const inputs = [
      write(10, { f2: "1" }, { valid: given("10-01") }),
      write(20, { f2: "2" }, { seen: 10, valid: given("11-01", "11-05"), ack: true }),
      revoke(30, 10, given("11-01", "11-07")),
    ];
    const { judgements } = replay(ctx.shape, inputs);
    const j = judgements[2] as Judgement;
    const e = encodeOp(
      ctx,
      inputs[2] as JudgeInput,
      j,
      opEnc(inputs[2] as JudgeInput, j, {
        conflictItems: [{ item: ITEM, candidate: 0, mergeBase: 10 }],
      }),
    );
    expect(e.base).toMatchObject({
      "existence/0": { status: "candidate", scope: "interval" },
      "span/existence/0": { valid: { from: d("11-01"), to: d("11-07") } },
    });
    expect(e.items[0]?.blocks).toEqual({
      target: {
        item: ITEM,
        type: "conflict",
        reason: "stale_write",
        table: "t1",
        entity: ENTITY,
        unit: ["existence"],
        merge_base_op: 10,
        origin_event: 31,
        ...versions,
      },
      "candidates/0": {
        event: 31,
        intent: "revoke",
        seen: { op: 10, restore_count: 0 },
        cause: "stale_write",
        items: [{ existence: 0, valid: { from: d("11-01"), to: d("11-07") } }],
        deps: [{ event: 31, existence: 0 }],
      },
    });
  });

  it("a revoke of the whole entity on a state table: scope whole, no span, as an item and a candidate", () => {
    const ctx = ctxOf("state");
    const inputs = [
      write(10, { f2: "1" }, { valid: given("10-01") }),
      write(20, { f2: "2" }, { seen: 10, valid: given("11-01", "11-05"), ack: true }),
      revoke(30, 10),
      revoke(40, 39),
    ];
    const { judgements, state } = replay(ctx.shape, inputs);
    const cand = judgements[2] as Judgement;
    const e = encodeOp(
      ctx,
      inputs[2] as JudgeInput,
      cand,
      opEnc(inputs[2] as JudgeInput, cand, {
        conflictItems: [{ item: ITEM, candidate: 0, mergeBase: 10 }],
      }),
    );
    expect(e.base?.["existence/0"]).toEqual({ status: "candidate", scope: "whole" });
    expect(e.base?.["span/existence/0"]).toBeUndefined();
    expect(e.items[0]?.blocks["candidates/0"]).toMatchObject({ items: [{ existence: 0 }] });
    const applied = judgements[3] as Judgement;
    const a = encodeOp(
      ctx,
      inputs[3] as JudgeInput,
      applied,
      opEnc(inputs[3] as JudgeInput, applied),
    );
    expect(a.base?.["existence/0"]).toEqual({ status: "applied", scope: "whole" });
    expect(parses("write.base", 41, 40, a.base ?? {}).ok).toBe(true);
    // And back.
    const evs: StoredEvent[] = [];
    inputs.forEach((input, n) => {
      const j = judgements[n] as Judgement;
      const enc = encodeOp(
        ctx,
        input,
        j,
        opEnc(input, j, {
          conflictItems: j.conflicts.map(() => ({ item: ITEM, candidate: 0, mergeBase: 10 })),
        }),
      );
      evs.push({
        header: { type: "write.head", seq: input.op },
        blocks: { ctx: { now: AT, today: "2026-11-05", ruleset_version: 1 }, ...enc.head },
      });
      if (enc.base !== undefined)
        evs.push({
          header: { type: "write.base", seq: input.event, op: input.op },
          blocks: enc.base,
        });
      enc.items.forEach((it, k) => {
        evs.push({
          header: { type: it.type, seq: 1000 + input.event * 10 + k, op: input.op },
          blocks: it.blocks,
        });
      });
    });
    expect(decodeRecords(ctx, evs)).toEqual(state.records);
  });

  it("a candidate's deps include what cut its interval (09 §5.8)", () => {
    const ctx = ctxOf("state");
    const inputs = [
      write(10, { f2: "1" }, { valid: given("10-01") }),
      write(15, { f2: "5" }, { valid: given("11-05"), ack: true }),
      write(20, { f2: "2" }, { seen: 15, valid: given("11-01", "11-03"), ack: true }),
      // From 11-01 to the next change as of ver 15: stops at #16's 11-05.
      write(30, { f2: "3" }, { seen: 15, valid: given("11-01", "next") }),
    ];
    const { judgements } = replay(ctx.shape, inputs);
    const j = judgements[3] as Judgement;
    const e = encodeOp(
      ctx,
      inputs[3] as JudgeInput,
      j,
      opEnc(inputs[3] as JudgeInput, j, {
        conflictItems: [{ item: ITEM, candidate: 0, mergeBase: 15 }],
      }),
    );
    expect(e.items[0]?.blocks["candidates/0"]).toMatchObject({
      items: [{ field: "f2", k: 0, value: "3", valid: { from: d("11-01"), to: d("11-05") } }],
      deps: [
        { event: 16, field: "f2", k: 0 },
        { event: 31, field: "f2", k: 0 },
      ],
    });
  });
});

/** Encodes a judged log into events, opening one item per conflict unit, joining it after. */
function logEvents(
  ctx: RowContext,
  inputs: readonly JudgeInput[],
  judgements: readonly Judgement[],
) {
  const evs: StoredEvent[] = [];
  const open = new Map<string, { item: ItemId; n: number; base: number; version: number }>();
  const awaiting = new Map<number, { item: ItemId; version: number }>();
  let next = 1;
  const id = () => `pi_${String(next++).padStart(16, "0")}` as ItemId;
  inputs.forEach((input, n) => {
    const j = judgements[n] as Judgement;
    const r = j.record;
    const ctxBlock = { now: AT, today: "2026-11-05", ruleset_version: 1 };
    if (r.kind === "write" || r.kind === "revoke" || r.kind === "undo") {
      const seen = r.seen ?? r.op - 1;
      const conflictItems = j.conflicts.map((c) => {
        const key = c.unit === "existence" ? "existence" : c.unit.fields.join(",");
        const o = open.get(key);
        if (o !== undefined) {
          o.n += 1;
          o.base = Math.min(o.base, seen);
          o.version = r.op;
          return { item: o.item, merged: true as const, candidate: o.n, mergeBase: o.base };
        }
        const item = id();
        open.set(key, { item, n: 0, base: seen, version: r.op });
        return { item, candidate: 0, mergeBase: seen };
      });
      const awaitingItem = r.items.some((x) => x.status === "awaiting") ? id() : undefined;
      if (awaitingItem !== undefined) awaiting.set(r.event, { item: awaitingItem, version: r.op });
      const enc = encodeOp(
        ctx,
        input,
        j,
        opEnc(input, j, {
          intent: input.kind === "revoke" ? "revoke" : n === 0 ? "insert" : "update",
          conflictItems,
          ...(awaitingItem !== undefined ? { awaitingItem } : {}),
        }),
      );
      evs.push({
        header: { type: "write.head", seq: r.op },
        blocks: { ctx: ctxBlock, ...enc.head },
      });
      if (enc.base !== undefined)
        evs.push({ header: { type: "write.base", seq: r.event, op: r.op }, blocks: enc.base });
      enc.items.forEach((it, k) => {
        evs.push({
          header: { type: it.type, seq: 1000 + r.event * 10 + k, op: r.op },
          blocks: it.blocks,
        });
      });
      return;
    }
    const unit =
      r.kind === "take_previous"
        ? r.revert.unit
        : r.kind === "keep_effective" || r.kind === "take_candidate"
          ? r.unit
          : undefined;
    const key =
      unit === undefined ? "" : unit === "existence" ? "existence" : unit.fields.join(",");
    const o = r.kind === "confirm" || r.kind === "reject" ? awaiting.get(r.target) : open.get(key);
    if (o === undefined) throw new Error("no item");
    const candidate = r.kind === "take_candidate" ? r.candidates.indexOf(r.take) : undefined;
    const enc = encodeResolution(ctx, j, {
      item: o.item,
      ...(candidate !== undefined ? { candidate } : {}),
      intent: "update",
      sv: 1,
      itemOp: o.version,
      restoreCount: 0,
    });
    evs.push({
      header: { type: "item.resolved", seq: r.op },
      blocks: { ctx: ctxBlock, target: enc.target },
    });
    if (enc.base !== undefined)
      evs.push({ header: { type: "write.base", seq: r.event, op: r.op }, blocks: enc.base });
  });
  return evs;
}

const take = (
  op: number,
  candidates: number[],
  taken: number,
  unit: { fields: FieldId[] } | "existence",
): JudgeInput => ({
  kind: "take_candidate",
  op,
  index: 0,
  event: op + 1,
  ruleset: 1,
  unit,
  candidates,
  take: taken,
});

describe("resolutions and what the scenarios do not reach", () => {
  it("a take written one item per stretch, with its item.resolved, through the events and back", () => {
    // #41 is cut around a corroboration (evidence pointed at per field, a later phase) into two
    // candidate stretches; #51 takes the second candidate of the item, #61 joined after #41.
    const ctx = ctxOf("state");
    const inputs = [
      write(10, { f2: "1" }, { valid: given("10-01") }),
      write(20, { f2: "2" }, { seen: 10, valid: given("11-01", "11-03"), ack: true }),
      write(30, { f2: "2" }, { seen: 20, valid: given("11-07", "11-09"), ack: true }),
      write(35, { f2: "9" }, { seen: 10, valid: given("11-01", "11-02") }),
      write(40, { f2: "1" }, { seen: 10, valid: given("11-01", "11-09"), explicit: true }),
      take(50, [36, 41], 41, { fields: ["f2"] }),
    ];
    const { judgements, state } = replay(ctx.shape, inputs);
    const evs = logEvents(ctx, inputs, judgements);
    const resolved = evs.find((e) => e.header.type === "item.resolved");
    expect(resolved?.blocks["target"]).toEqual({
      item: `pi_${"1".padStart(16, "0")}`,
      decision: "take_candidate",
      candidate: 1,
      item_op: 40,
      restore_count: 0,
      via: "call",
    });
    const base =
      evs.find((e) => e.header.type === "write.base" && e.header.seq === 51)?.blocks ?? {};
    expect(Object.keys(base).filter((p) => p.startsWith("fields/"))).toEqual([
      "fields/f2/0",
      "fields/f2/1",
    ]);
    expect(base["span/f2/0"]).toMatchObject({ valid: { from: d("11-01"), to: d("11-03") } });
    expect(base["span/f2/1"]).toMatchObject({ valid: { from: d("11-07"), to: d("11-09") } });
    expect(base["take"]).toMatchObject({ candidate: 1, merge_base_op: 10 });
    for (const e of evs) {
      if (e.header.type === "write.head" || e.header.type === "item.resolved") continue;
      expect({
        seq: e.header.seq,
        ok: parses(e.header.type, e.header.seq, e.header.op, e.blocks).ok,
      }).toEqual({ seq: e.header.seq, ok: true });
    }
    // Back: every record the same, but for the per-field evidence the format does not keep yet.
    const decoded = decodeRecords(ctx, evs);
    expect(decoded.map((r) => (r.kind === "write" ? { ...r, explicit: [] } : r))).toEqual(
      state.records.map((r) => (r.kind === "write" ? { ...r, explicit: [] } : r)),
    );
  });

  it("awaiting items: the cause and the unit, by what the proposal is and touches", () => {
    const ctx = ctxOf("state");
    // ① on a field: overwrites_change_point, unit the fields touched.
    const one = [
      write(10, { f2: "1", f3: "a" }, { valid: given("10-01") }),
      write(20, { f2: "2", f3: "b" }, { seen: 10, valid: given("11-01", "11-05"), ack: true }),
      write(30, { f3: "c", f2: "3" }, { seen: 20, valid: given("10-20") }),
    ];
    const r1 = replay(ctx.shape, one);
    const e1 = logEvents(ctx, one, r1.judgements);
    expect(e1.find((e) => e.header.type === "item.created")?.blocks["target"]).toMatchObject({
      type: "awaiting_confirmation",
      reason: "overwrites_change_point",
      unit: ["f2", "f3"],
    });
    // An undo whose write-back revoke hides a later write: undo_hides_later, unit existence.
    const undo = (op: number, target: number, o: { later?: boolean } = {}): JudgeInput => ({
      kind: "undo",
      op,
      index: 0,
      event: op + 1,
      ruleset: 1,
      target,
      seen: op - 1,
      seenExplicit: false,
      ...(o.later ? { includeLater: true } : {}),
    });
    const hides = [
      write(10, { f2: "1" }, { valid: given("10-01") }),
      revoke(20, 10, given("11-01", "11-07")),
      undo(30, 20),
      write(40, { f2: "6" }, { seen: 30, valid: given("11-02", "11-04"), ack: true }),
      undo(50, 30),
    ];
    const r2 = replay(ctx.shape, hides);
    expect(r2.judgements[4]?.hides.length).toBeGreaterThan(0);
    const e2 = logEvents(ctx, hides, r2.judgements);
    expect(e2.find((e) => e.header.type === "item.created")?.blocks["target"]).toMatchObject({
      type: "awaiting_confirmation",
      reason: "undo_hides_later",
      unit: ["existence"],
    });
    // Taking later writes back: undo_includes_later (also when it hides some).
    const later = [
      write(10, { f2: "1" }, { valid: given("10-01") }),
      write(20, { f2: "2" }, { seen: 10, valid: given("11-01", "11-05"), ack: true }),
      write(30, { f2: "3" }, { seen: 20, valid: given("11-03", "11-09"), ack: true }),
      undo(40, 20, { later: true }),
    ];
    const r3 = replay(ctx.shape, later);
    const e3 = logEvents(ctx, later, r3.judgements);
    expect(e3.find((e) => e.header.type === "item.created")?.blocks["target"]).toMatchObject({
      reason: "undo_includes_later",
      unit: ["f2"],
    });
    // Both: undoing the restore takes the later revoke #45 back and hides #40's write.
    const both = [
      write(10, { f2: "1" }, { valid: given("10-01") }),
      revoke(20, 10, given("11-01", "11-07")),
      undo(30, 20),
      write(40, { f2: "6" }, { seen: 30, valid: given("11-02", "11-04"), ack: true }),
      revoke(45, 40, given("11-05", "11-06")),
      undo(50, 30, { later: true }),
    ];
    const r4 = replay(ctx.shape, both);
    expect(r4.judgements[5]?.takesBack).toEqual([45]);
    expect(r4.judgements[5]?.hides).toEqual([{ event: 41, target: "f2", k: 0 }]);
    const e4 = logEvents(ctx, both, r4.judgements);
    expect(e4.find((e) => e.header.type === "item.created")?.blocks["target"]).toMatchObject({
      reason: "undo_includes_later",
      unit: ["existence"],
    });
  });

  it("what the caller gives is written as given; an insert with a ver, or a set without its raw value, is refused", () => {
    const ctx = ctxOf("event");
    const inputs = [
      write(10, { f2: "1" }),
      write(20, { f2: "2" }, { seen: 10, ack: true }),
      write(30, { f2: "3" }, { seen: 10 }),
      {
        kind: "keep_effective",
        op: 40,
        index: 0,
        event: 41,
        ruleset: 1,
        unit: { fields: ["f2"] },
        candidates: [31],
      } as JudgeInput,
    ];
    const { judgements } = replay(ctx.shape, inputs);
    const at = (n: number, extra: Record<string, unknown> = {}) =>
      encodeOp(
        ctx,
        inputs[n] as JudgeInput,
        judgements[n] as Judgement,
        opEnc(inputs[n] as JudgeInput, judgements[n] as Judgement, extra),
      );
    // The first creation: `created` on the op's target and its write.base target.
    const first = at(0);
    expect(first.head["ops/0/target"]).toMatchObject({ intent: "insert", created: true });
    expect(first.head["ops/0/target"]).not.toHaveProperty("ver");
    expect(first.base?.["target"]).toMatchObject({ intent: "insert", created: true });
    // The restore_count of the version seen: in `ver` and in the candidate's `seen`.
    const stale = at(2, {
      restoreCount: 2,
      conflictItems: [{ item: ITEM, candidate: 0, mergeBase: 10 }],
    });
    expect(stale.head["ops/0/target"]).toMatchObject({
      ver: { op: 10, restore_count: 2, basis: "explicit" },
    });
    expect(stale.items[0]?.blocks["candidates/0"]).toMatchObject({
      seen: { op: 10, restore_count: 2 },
    });
    // The item version a decision was made on.
    expect(
      encodeResolution(ctx, judgements[3] as Judgement, {
        item: ITEM,
        intent: "update",
        sv: 1,
        itemOp: 30,
        restoreCount: 3,
      }).target,
    ).toEqual({
      item: ITEM,
      decision: "keep_effective",
      item_op: 30,
      restore_count: 3,
      via: "call",
    });
    // Refused: an insert that saw anything but the state just before it, explicitly or not.
    for (const seen of [9, 5]) {
      const lone = write(10, { f2: "1" }, { seen });
      const j = replay(ctx.shape, [lone]).judgements[0] as Judgement;
      expect(() => encodeOp(ctx, lone, j, opEnc(lone, j, { intent: "insert" }))).toThrow(
        "an insert has no ver",
      );
    }
    // Refused: a field set without the raw value the caller gave.
    expect(() => at(1, { raw: {} })).toThrow("the raw value of f2 is needed");
  });

  it("an op of a request on a row an earlier op created: ver basis same_request", () => {
    const ctx = ctxOf("event");
    const first: JudgeInput = { ...write(10, { f2: "1" }), index: 0, event: 11 };
    const second: JudgeInput = {
      ...write(10, { f3: "x" }),
      index: 1,
      event: 12,
      seen: 10,
      seenExplicit: false,
    } as JudgeInput;
    const inputs = [first, second];
    const { judgements, state } = replay(ctx.shape, inputs);
    const enc = encodeOp(
      ctx,
      second,
      judgements[1] as Judgement,
      opEnc(second, judgements[1] as Judgement, { intent: "update" }),
    );
    expect(enc.head["ops/1/target"]).toMatchObject({
      ver: { op: 10, restore_count: 0, basis: "same_request" },
    });
    const firstEnc = encodeOp(
      ctx,
      first,
      judgements[0] as Judgement,
      opEnc(first, judgements[0] as Judgement, { intent: "insert" }),
    );
    const evs: StoredEvent[] = [
      {
        header: { type: "write.head", seq: 10 },
        blocks: {
          ctx: { now: AT, today: "2026-11-05", ruleset_version: 1 },
          ...firstEnc.head,
          ...enc.head,
        },
      },
      { header: { type: "write.base", seq: 11, op: 10 }, blocks: firstEnc.base ?? {} },
      { header: { type: "write.base", seq: 12, op: 10 }, blocks: enc.base ?? {} },
    ];
    expect(decodeRecords(ctx, evs)).toEqual(state.records);
  });

  it("a decision on a field group's item, at instant granularity, with valid and op sources", () => {
    const grouped: RowContext = {
      table: "t1" as TableId,
      target: { entity: ENTITY },
      shape: {
        kind: "state",
        fields: ["f4", "f5"],
        valued: ["f4"],
        required: ["f4"],
        groups: [["f4", "f5"]],
      },
      granularity: "instant",
    };
    const t = (h: string) => `2026-11-0${h}T00:00:00.000Z` as BizPoint;
    const at = (from: string, to?: string): Valid => ({
      from: { mode: "given", value: t(from) },
      to: to === undefined ? { mode: "open" } : { mode: "given", value: t(to) },
    });
    const inputs = [
      write(10, { f4: "1", f5: "a" }, { valid: at("1") }),
      write(20, { f4: "2" }, { seen: 10, valid: at("3"), ack: true }),
      write(30, { f4: "3", f5: "b" }, { seen: 10, valid: at("4", "6") }),
      take(40, [31], 31, { fields: ["f4", "f5"] }),
    ].map((x) => ("now" in x ? { ...x, now: AT as BizPoint } : x)) as JudgeInput[];
    const { judgements, state } = replay(grouped.shape, inputs);
    const evs = logEvents(grouped, inputs, judgements);
    const withSources = evs.map((e) =>
      e.header.type === "write.base" && e.header.seq === 31
        ? { ...e, blocks: { ...e.blocks, valid_sources: [30], op_sources: [30] } }
        : e,
    );
    for (const e of withSources.filter((x) => x.header.type === "write.base")) {
      expect(parses("write.base", e.header.seq, e.header.op, e.blocks).ok).toBe(true);
    }
    const resolvedBase =
      evs.find((e) => e.header.type === "write.base" && e.header.seq === 41)?.blocks ?? {};
    expect(Object.keys(resolvedBase).filter((p) => p.startsWith("fields/"))).toEqual([
      "fields/f4/0",
      "fields/f5/0",
    ]);
    const decoded = decodeRecords(
      { ...grouped },
      withSources.map((e) =>
        e.header.type === "write.head"
          ? {
              ...e,
              blocks: { ...e.blocks, ctx: { now: AT, today: "2026-11-10", ruleset_version: 1 } },
            }
          : e,
      ),
    );
    expect(decoded).toEqual(state.records);
  });

  it("the decoder refuses what this phase does not decode", () => {
    const ctx = ctxOf("event");
    expect(() =>
      decodeRecords(ctx, [{ header: { type: "item.superseded", seq: 5, op: 4 }, blocks: {} }]),
    ).toThrow("does not handle item.superseded");
    expect(() =>
      decodeRecords(ctx, [{ header: { type: "item.refreshed", seq: 5, op: 4 }, blocks: {} }]),
    ).toThrow("does not handle item.refreshed");
    // A decision this phase does not decode, on an item it knows.
    const inputs = [
      write(10, { f2: "1" }),
      write(20, { f2: "2" }, { seen: 10, ack: true }),
      write(30, { f2: "3" }, { seen: 10 }),
    ];
    const evs = logEvents(ctx, inputs, replay(ctx.shape, inputs).judgements);
    const created = evs.find((e) => e.header.type === "item.created");
    const item = (created?.blocks["target"] as { item: ItemId } | undefined)?.item;
    expect(item).toBeDefined();
    const resolved = (decision: string): StoredEvent => ({
      header: { type: "item.resolved", seq: 40 },
      blocks: {
        ctx: { now: AT, today: "2026-11-05", ruleset_version: 1 },
        target: { item, decision, item_op: 30, restore_count: 0, via: "call" },
      },
    });
    expect(() => decodeRecords(ctx, [...evs, resolved("cancel")])).toThrow(
      "decision cancel is not decoded here",
    );
    expect(decodeRecords(ctx, [...evs, resolved("keep_effective")]).at(-1)).toMatchObject({
      kind: "keep_effective",
      candidates: [31],
    });
  });
});
