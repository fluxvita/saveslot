// The records of judged logs go through their events and back (docs/zh-CN/spec/09-event-format.md
// §5.7, §5.8): every step of the comparison's scenarios is encoded into events, every event passes
// the strict parse, the events decode back into the same records, and the next op judged on the
// state rebuilt from the decoded records gets the same judgement as on the original state.
//
// The only records not kept are the writes that wrote nothing (every field a no-op, or a revoke
// of a revoked row): such an op has no `write.base` event (04-write-and-read «一次写入的事件
// 构成») and plays no part in later judgements.

import type {
  EntityId,
  FieldId,
  ItemId,
  RawFieldValue,
  RowId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { parseEvent } from "@fluxvita/saveslot-contract-core";
import type { Op, TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { JudgeError } from "../judge/errors.ts";
import { judgeOp, stateFromRecord } from "../judge/judge.ts";
import type { JudgeInput, Judgement, OpRecord, Unit } from "../judge/model.ts";
import { type Judged, judged, scenario, toInput } from "../judge/scenarios.fixture.ts";
import {
  decodeRecords,
  encodeOp,
  encodeResolution,
  type RowContext,
  type StoredEvent,
} from "./record.ts";

vi.setConfig({ testTimeout: 60_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 50_000, markInterruptAsFailure: true });

const RUNS = propRuns(1500);
const HASH = "a".repeat(64);
const CONN = `ci_${"2".repeat(26)}`;
const SLOT = `sl_${"4".repeat(16)}`;
const ROW = `r_${"6".repeat(26)}` as RowId;
const ENTITY = `e_${"7".repeat(26)}` as EntityId;
const AT = "2026-11-10T04:41:07.123Z";
/** Pending item events: seqs above every operation's, in log order. */
const ITEM_SEQ = 1_000_000;
/** The operation of the scenarios' first write: the insert that makes the row or entity. */
const FIRST_OP = 10;
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const itemId = (n: number): ItemId =>
  `pi_${n
    .toString(32)
    .toUpperCase()
    .padStart(16, "0")
    .replace(/[ILOU]/g, "Z")}` as ItemId;
void CROCKFORD;

const unitKey = (u: Unit) => (u === "existence" ? "existence" : [...u.fields].sort().join(","));
const dropsOut = (r: OpRecord) =>
  (r.kind === "write" || r.kind === "revoke") && r.items.length === 0;

/**
 * The ops as this phase writes them. No `evidence_by_field`: a same-valued write is a no-op, never a
 * corroboration, and the format has no place yet for "this field's evidence was pointed at" (a
 * later phase).
 */
function asInThisPhase(o: Op, i: number): Op {
  if (o.kind !== "write") return o;
  const fields = Object.fromEntries(
    Object.entries(o.fields).map(([f, x]) => {
      if (x === undefined) return [f, x];
      const { explicit: _, ...rest } = x;
      return [f, rest];
    }),
  );
  // The first write makes the row or entity: an insert sees the state just before it and has no
  // `ver` (09 §5.7).
  if (i === 0) {
    const { seen: _, ...rest } = o;
    return { ...rest, fields };
  }
  return { ...o, fields };
}

/** The raw values of a write: in these scenarios, as the caller would give them, the same text. */
function rawOf(input: JudgeInput): Partial<Record<FieldId, RawFieldValue>> {
  if (input.kind !== "write") return {};
  return Object.fromEntries(
    Object.entries(input.fields).map(([f, x]) => [f, (x?.value ?? null) as RawFieldValue]),
  );
}

/** An event as stored, from its type, numbers and blocks. */
function stored(
  type: string,
  seq: number,
  op: number | undefined,
  blocks: Record<string, unknown>,
): StoredEvent & { full: Record<string, unknown> } {
  const header = {
    type,
    v: 1,
    seq,
    at: AT,
    prev_hash: HASH,
    actor: CONN,
    slot: SLOT,
    ...(op !== undefined ? { op } : {}),
  };
  return { header: { type, seq, ...(op !== undefined ? { op } : {}) }, blocks, full: header };
}

/** The events of a judged log on one row or entity, step by step. */
function eventsOf(ctx: RowContext, steps: readonly Judged[]) {
  const open = new Map<
    string,
    { item: ItemId; candidates: number[]; mergeBase: number; version: number }
  >();
  const awaiting = new Map<number, { item: ItemId; version: number }>();
  let next = 1;
  const out: (StoredEvent & { full: Record<string, unknown> })[][] = [];
  for (const s of steps) {
    const j: Judgement = s.judgement;
    const r = j.record;
    const evs: (StoredEvent & { full: Record<string, unknown> })[] = [];
    const now = "now" in s.input ? (s.input.now as string) : "2026-11-05";
    const ctxBlock = {
      now: now.includes("T") ? now : `${now}T00:00:00.000Z`,
      today: now.slice(0, 10),
      ruleset_version: s.input.ruleset,
      policy_version: 1,
      literal_checker: "literal@1",
    };
    if (r.kind === "write" || r.kind === "revoke" || r.kind === "undo") {
      const seenOp = r.seen ?? r.op - 1;
      const conflictItems = j.conflicts.map((c) => {
        const key = unitKey(c.unit);
        const prior = open.get(key);
        if (prior !== undefined) {
          prior.candidates.push(r.event);
          prior.mergeBase = Math.min(prior.mergeBase, seenOp);
          prior.version = r.op;
          return {
            item: prior.item,
            merged: true as const,
            candidate: prior.candidates.length - 1,
            mergeBase: prior.mergeBase,
          };
        }
        const item = itemId(next++);
        open.set(key, { item, candidates: [r.event], mergeBase: seenOp, version: r.op });
        return { item, candidate: 0, mergeBase: seenOp };
      });
      const awaitingItem = r.items.some((x) => x.status === "awaiting")
        ? itemId(next++)
        : undefined;
      if (awaitingItem !== undefined) awaiting.set(r.event, { item: awaitingItem, version: r.op });
      const enc = encodeOp(ctx, s.input, j, {
        intent: r.kind === "revoke" ? "revoke" : r.op === FIRST_OP ? "insert" : "update",
        ...(j.created ? { created: true as const } : {}),
        sv: 1,
        sources: [r.op],
        raw: rawOf(s.input),
        restoreCount: 0,
        conflictItems,
        ...(awaitingItem !== undefined ? { awaitingItem } : {}),
        versions: { ruleset: 1, policy: 1 },
      });
      evs.push(
        stored("write.head", r.op, undefined, {
          ctx: ctxBlock,
          request: { sv: 1, sv_basis: "explicit", op_count: 1 },
          ...enc.head,
        }),
      );
      if (enc.base !== undefined) evs.push(stored("write.base", r.event, r.op, enc.base));
      enc.items.forEach((it, n) => {
        // Pending item events follow the write.base event; their seqs only order them.
        evs.push(stored(it.type, ITEM_SEQ + r.event * 10 + n, r.op, it.blocks));
      });
    } else {
      // A decision: on the item of its unit, or on the awaiting item of its target.
      const isAwaiting = r.kind === "confirm" || r.kind === "reject";
      let item: ItemId | undefined;
      let candidate: number | undefined;
      let version: number | undefined;
      if (isAwaiting) {
        item = awaiting.get(r.target)?.item;
        version = awaiting.get(r.target)?.version;
      } else {
        const unit =
          r.kind === "take_previous"
            ? r.revert.unit
            : r.kind === "keep_effective" || r.kind === "take_candidate"
              ? r.unit
              : undefined;
        const key = unit === undefined ? "" : unitKey(unit);
        const it = open.get(key);
        item = it?.item;
        version = it?.version;
        if (r.kind === "take_candidate") candidate = it?.candidates.indexOf(r.take);
        open.delete(key);
      }
      if (item === undefined || version === undefined)
        throw new Error("a decision without its item");
      const enc = encodeResolution(ctx, j, {
        item,
        ...(candidate !== undefined ? { candidate } : {}),
        intent: "update",
        sv: 1,
        // The item's version: the operation that last opened or joined it (09 §5.8 `item_op`).
        itemOp: version,
        restoreCount: 0,
      });
      evs.push(stored("item.resolved", r.op, undefined, { ctx: ctxBlock, target: enc.target }));
      if (enc.base !== undefined) evs.push(stored("write.base", r.event, r.op, enc.base));
    }
    out.push(evs);
  }
  return out;
}

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

describe.each(both)("%s table", (_, schema: TableSchema, isState) => {
  it("records go through their events and back; the next judgement is the same", () => {
    const ctx: RowContext = {
      table: "t1" as TableId,
      target: isState ? { entity: ENTITY } : { row: ROW },
      shape: {
        kind: schema.kind,
        fields: ["f2", "f3"],
        valued: schema.required,
        required: schema.required,
        groups: [],
      },
      granularity: "date",
    };
    const seen: Record<string, number> = { samples: 0 };
    fc.assert(
      fc.property(scenario(isState), ({ ops, decisions }) => {
        const { steps, refused } = judged(schema, ops.map(asInThisPhase), decisions);
        seen["samples"] = (seen["samples"] ?? 0) + 1;
        const events = eventsOf(ctx, steps);
        // Every event passes the strict parse of its type.
        for (const e of events.flat()) {
          const p = parseEvent(e.full, e.blocks);
          expect({ seq: e.header.seq, type: e.header.type, parse: p }).toEqual({
            seq: e.header.seq,
            type: e.header.type,
            parse: { ok: true, type: e.header.type },
          });
        }
        // Per sample: which kinds of record it reached.
        const reached = new Set<string>(
          steps.map((x) => {
            const r = x.judgement.record;
            return r.kind === "confirm" && r.revert !== undefined ? "confirmUndo" : r.kind;
          }),
        );
        if (reached.has("confirm") || reached.has("confirmUndo")) reached.add("confirmations");
        for (const k of reached) seen[k] = (seen[k] ?? 0) + 1;
        steps.forEach((s, i) => {
          // The records before this step, from their events, are the records judge kept.
          const decoded = decodeRecords(ctx, events.slice(0, i).flat());
          expect({ step: i, records: decoded }).toEqual({
            step: i,
            records: s.before.records.filter((x) => !dropsOut(x)),
          });
          // And the step judged on the state rebuilt from them gets the same judgement.
          const rebuilt = stateFromRecord(ctx.shape, decoded);
          expect({ step: i, judgement: judgeOp(rebuilt, s.input).judgement }).toEqual({
            step: i,
            judgement: s.judgement,
          });
        });
        // The whole log decodes back into the records of the last state.
        const last = steps[steps.length - 1];
        if (last !== undefined) {
          expect({ final: decodeRecords(ctx, events.flat()) }).toEqual({
            final: last.state.records.filter((x) => !dropsOut(x)),
          });
        }
        // A refused op is refused the same way on the state rebuilt from the decoded records.
        for (const r of refused) {
          const decoded = decodeRecords(ctx, events.slice(0, r.before.length).flat());
          const rebuilt = stateFromRecord(ctx.shape, decoded);
          let reason: string | undefined;
          try {
            judgeOp(rebuilt, toInput(r.op));
          } catch (e) {
            if (!(e instanceof JudgeError)) throw e;
            reason = e.reason;
          }
          expect({ op: r.op.op, reason }).toEqual({ op: r.op.op, reason: r.reason });
          seen["refused"] = (seen["refused"] ?? 0) + 1;
        }
      }),
      { numRuns: RUNS },
    );
    if (process.env["JUDGE_STATS"]) console.log(schema.kind, JSON.stringify(seen));
    // The round trip reaches every kind of record often enough to count.
    // Reverts, the three resolutions of a conflict and the confirmations of awaiting items (of a
    // write or of an undo; event tables have no ①, so theirs are all of undos) each at least 5
    // times; so are plain writes, revokes and rejections.
    // Shares of samples reaching each kind, at about half what the scenarios reach; keep and
    // reject come from the decisions inserted at random only, so taking those out fails here.
    const minimum: Record<string, number> = {
      write: 0.9,
      revoke: 0.15,
      undo: 0.15,
      keep_effective: 0.02,
      take_previous: 0.03,
      take_candidate: 0.04,
      confirmations: 0.04,
      reject: isState ? 0.02 : 0.01,
    };
    for (const [key, min] of Object.entries(minimum)) {
      const share = (seen[key] ?? 0) / (seen["samples"] ?? 1);
      expect({ key, enough: share >= min }).toEqual({ key, enough: true });
    }
  });
});
