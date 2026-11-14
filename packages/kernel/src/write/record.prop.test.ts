// The records of judged logs go through their events and back (docs/zh-CN/spec/09-event-format.md
// §5.7, §5.8): every step of the comparison's scenarios is encoded into events, every event passes
// the strict parse, the events decode back into the same records, and the next op judged on the
// state rebuilt from the decoded records gets the same judgement as on the original state.
//
// The only records not kept are the writes that wrote nothing (every field a no-op, or a revoke
// of a revoked row): such an op has no `write.base` event (04-write-and-read «一次写入的事件
// 构成») and plays no part in later judgements.

import type { EntityId, RowId, TableId } from "@fluxvita/saveslot-contract-core";
import { parseEvent } from "@fluxvita/saveslot-contract-core";
import type { TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { JudgeError } from "../judge/errors.ts";
import { judgeOp, stateFromRecord } from "../judge/judge.ts";
import type { OpRecord } from "../judge/model.ts";
import { type Judged, judged, scenario, toInput } from "../judge/scenarios.fixture.ts";
import { asInThisPhase, eventsOfSteps } from "./log.fixture.ts";
import { decodeRecords, type RowContext, type StoredEvent } from "./record.ts";

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
const dropsOut = (r: OpRecord) =>
  (r.kind === "write" || r.kind === "revoke") && r.items.length === 0;

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
  // Pending item events: seqs above every operation's, in log order.
  return eventsOfSteps(ctx, steps, (after, n) => ITEM_SEQ + after * 10 + n).map((evs) =>
    evs.map((e) => stored(e.type, e.seq, e.op, e.blocks)),
  );
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
