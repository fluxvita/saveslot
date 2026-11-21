// The deletion replay (docs/zh-CN/spec/03-data-model/03-deletion.md «删除结果的定义», «重放规则»):
// the state of a row or entity as if the deleted contributions had never been, the operations
// of its log judged again in order, with two deliberate deviations — people's decisions are
// executed as recorded (deviation one), and a write that was in effect stays in effect (deviation
// two, by the write on a target).
//
// Pure: the caller works out which (event, target) the deleted source data take away (from
// `base_sources`, by position) and passes them in; nothing here reads the store.
//
// Covered: writes, revokes, and people's confirmations and rejections of awaiting writes. Every
// other kind of operation in the log (a revert, a conflict resolution, and the writes they
// trigger, a confirmation of an awaiting undo) is refused with `not_implemented`, naming the kind,
// never judged as an ordinary write; so is an operation judged after a deletion event (its
// conflict criterion reads that event's L).

import type { FieldId } from "@fluxvita/saveslot-contract-core";
import { JudgeError } from "./errors.ts";
import { ackOf, emptyState, judgeOp, withoutDeps } from "./judge.ts";
import type {
  ConfirmRecord,
  FieldInput,
  OpRecord,
  RejectRecord,
  RevokeInput,
  TableShape,
  Target,
  WriteInput,
  WriteRecord,
} from "./model.ts";
import { RowState } from "./state.ts";
import { judgeRevoke, judgeWrite, type ReplayOptions } from "./write.ts";

/** The (event, target) of a contribution, as the caller lists the deleted ones. */
export const contributionKey = (event: number, target: Target): string => `${event}/${target}`;

const effective = (s: string) => s === "applied" || s === "corroborated";

/**
 * Deviation two by the write on a target (03-deletion «删除结果的定义»): the targets on which every
 * item of the write was in effect when written. Read from the write's own record: its status
 * blocks go only with its own sources, so this is the same before and after any tombstone.
 */
function protectedTargets(r: WriteRecord): Set<Target> {
  const byTarget = new Map<Target, string[]>();
  for (const x of r.items) byTarget.set(x.target, [...(byTarget.get(x.target) ?? []), x.status]);
  return new Set([...byTarget].filter(([, statuses]) => statuses.every(effective)).map(([t]) => t));
}

/**
 * People's confirmations and rejections, by the write they decided (deviation one): the targets
 * each decided, as recorded — a confirmation's, those it carried from the awaiting items; a
 * rejection's, the write's targets awaiting when written (nothing else in the log closes an
 * awaiting item before it in this version) — and whether the write was rejected.
 */
function decisionsOf(
  records: readonly OpRecord[],
): Map<number, { decided: Set<Target>; rejected: boolean }> {
  const out = new Map<number, { decided: Set<Target>; rejected: boolean }>();
  for (const r of records) {
    if (r.kind !== "confirm" && r.kind !== "reject") continue;
    const d = out.get(r.target) ?? { decided: new Set<Target>(), rejected: false };
    if (r.kind === "reject") {
      d.rejected = true;
      const w = records.find((x) => x.event === r.target);
      if (w?.kind === "write") {
        for (const x of w.items) if (x.status === "awaiting") d.decided.add(x.target);
      }
    } else {
      for (const x of r.items) {
        for (const c of x.carried ?? []) if (c.event === r.target) d.decided.add(c.target);
      }
    }
    out.set(r.target, d);
  }
  return out;
}

/**
 * A confirmation or rejection executed as recorded on the replay's state: the write's items
 * awaiting there (05-time «高影响写入»; 03-deletion «重放规则 · 冲突消失之后»: a confirmation is of
 * the write's high impact, it puts in effect, at its own operation, whatever of the write awaits
 * now). Nothing awaiting any more: the decision leaves nothing.
 */
function decide(state: RowState, r: ConfirmRecord | RejectRecord) {
  if (!state.items.some((x) => x.event === r.target && x.status === "awaiting")) return undefined;
  return judgeOp(state, {
    kind: r.kind,
    op: r.op,
    index: r.index,
    event: r.event,
    ruleset: r.ruleset,
    ...(r.policy !== undefined ? { policy: r.policy } : {}),
    target: r.target,
  });
}

/**
 * The input a write or revoke was judged on, rebuilt from its record without the targets the
 * deletion takes away; `undefined` when nothing of it is left. A field's value is its items' (one
 * value a field); a field judged a no-op keeps no value and stays a no-op (`ReplayOptions.noop`).
 */
function inputOf(
  r: WriteRecord,
  gone: (t: Target) => boolean,
): WriteInput | RevokeInput | undefined {
  const base = {
    op: r.op,
    index: r.index,
    event: r.event,
    ruleset: r.ruleset,
    ...(r.policy !== undefined ? { policy: r.policy } : {}),
    seen: r.seen,
    seenExplicit: r.seenExplicit,
    ...(r.seenCurrent ? { seenCurrent: true as const } : {}),
    now: r.now,
  };
  if (r.kind === "revoke") {
    if (gone("existence")) return undefined;
    return {
      ...base,
      kind: "revoke",
      ...(r.valid !== undefined && r.valid !== "corrected_span" ? { valid: r.valid } : {}),
    } as RevokeInput;
  }
  const fields: Partial<Record<FieldId, FieldInput>> = {};
  for (const x of r.items) {
    if (x.target === "existence" || gone(x.target) || fields[x.target] !== undefined) continue;
    if (x.content.kind !== "value") {
      throw new JudgeError("not_implemented", "a deletion's replay of a write-back item", {
        kind: x.content.kind,
      });
    }
    fields[x.target] = {
      value: x.content.value,
      ...(r.explicit.includes(x.target) ? { explicit: true } : {}),
    };
  }
  if (Object.keys(fields).length === 0) return undefined;
  // Its interval's sources were deleted, so every target of it goes; one left reads the log
  // after a deletion's execution, not opened in this version.
  if (r.validGone) {
    throw new JudgeError(
      "not_implemented",
      "a deletion's replay of a write whose interval is gone",
      {
        op: r.op,
      },
    );
  }
  for (const f of r.noop) fields[f] = { value: null };
  return {
    ...base,
    kind: "write",
    ...(r.valid !== undefined ? { valid: r.valid } : {}),
    fields,
    ...(r.acknowledge ? { acknowledge: true } : {}),
  } as WriteInput;
}

/**
 * The records of a row's or entity's operations, judged again as if the contributions in
 * `deleted` (by `contributionKey`) had never been. Returns the state after the replay and each
 * operation's record as judged in it (an operation nothing of which is left has no record).
 * `deletionsBefore`: the operation numbers of the deletion and cancellation events in the log; an
 * operation after one is not replayed in this version.
 */
export function replayDeletion(
  table: TableShape,
  records: readonly OpRecord[],
  deleted: ReadonlySet<string>,
  deletionsBefore: readonly number[] = [],
): { readonly state: RowState; readonly records: readonly OpRecord[] } {
  let state = emptyState(table);
  const out: OpRecord[] = [];
  const firstDeletion = Math.min(Number.POSITIVE_INFINITY, ...deletionsBefore);
  const decisions = decisionsOf(records);
  for (const r of records) {
    const undoConfirmed = r.kind === "confirm" && r.revert !== undefined;
    if (
      (r.kind !== "write" && r.kind !== "revoke" && r.kind !== "confirm" && r.kind !== "reject") ||
      undoConfirmed
    ) {
      throw new JudgeError("not_implemented", `a deletion's replay of a ${r.kind}`, {
        kind: undoConfirmed ? "confirm of an undo" : r.kind,
        op: r.op,
      });
    }
    if (r.op > firstDeletion) {
      throw new JudgeError(
        "not_implemented",
        "a deletion's replay of an operation after a deletion event",
        {
          op: r.op,
        },
      );
    }
    if (r.kind === "confirm" || r.kind === "reject") {
      const judged = decide(state, r);
      if (judged === undefined) continue;
      out.push(judged.judgement.record);
      state = judged.state;
      continue;
    }
    const input = inputOf(r, (t) => deleted.has(contributionKey(r.event, t)));
    if (input === undefined) continue;
    const decision = decisions.get(r.event);
    const options: ReplayOptions = {
      noop: new Set(r.noop),
      protect: protectedTargets(r),
      decided: decision?.decided ?? new Set(),
      rejected: decision?.rejected ?? false,
    };
    const judged =
      input.kind === "write"
        ? judgeWrite(state, input, options)
        : judgeRevoke(state, input, options);
    let record: OpRecord = {
      op: r.op,
      index: r.index,
      event: r.event,
      ruleset: r.ruleset,
      ...(r.policy !== undefined ? { policy: r.policy } : {}),
      kind: r.kind,
      seen: r.seen,
      seenExplicit: r.seenExplicit,
      ...(r.seenCurrent ? { seenCurrent: true as const } : {}),
      ...(r.valid !== undefined ? { valid: r.valid } : {}),
      now: r.now,
      ...(r.acknowledge ? { acknowledge: true as const } : {}),
      explicit: r.explicit,
      items: judged.items,
      noop: judged.noop,
      ack: judged.acknowledged ? judged.overwritten.map(ackOf) : [],
    };
    if (!state.isState) record = withoutDeps(record);
    out.push(record);
    state = new RowState(table, [...state.records, record]);
  }
  return { state, records: out };
}
