// The deletion replay (docs/zh-CN/spec/03-data-model/03-deletion.md «删除结果的定义», «重放规则»):
// the state of a row or entity as if the deleted contributions had never been, the operations
// of its log judged again in order, with two deliberate deviations — people's decisions are
// executed as recorded (deviation one), and a write that was in effect stays in effect (deviation
// two, by the write on a target).
//
// Pure: the caller works out which (event, target) the deleted source data take away (from
// `base_sources`, by position) and passes them in, and the blocks the log last gave (restate.ts,
// `LatestGiven`); nothing here reads the store. Each replayed operation's items are numbered
// against those blocks (03-deletion «回掉的权威定义» step 6), and the replay returns what it
// restates (09 §5.9 `restated/<k>`, rules 1 and 2; rule 3 is a cancellation's).
//
// Covered: writes, revokes, people's confirmations and rejections of awaiting writes and undos,
// reverts (`undo`, `take_previous`, the confirmation of an awaiting undo): their record R and
// value position as recorded, their ranges and write-backs worked out again on the replay's state
// (03-deletion «回掉的权威定义»); `keep_effective` as recorded; `take_candidate` with its merge
// base, cover set and filled revokes as recorded, where it lands worked out again (03-deletion
// «搬运的值»). A candidate a conflict resolution decided stays that candidate in every replay, the
// conflict there or not (deviation one), so the resolution's record still closes it. Refused with
// `not_implemented`, naming the kind, never judged as an ordinary write: an undecided awaiting
// undo no longer of high impact (high impact ④ judged again), with a kind of its own when the row
// would still be revoked once it takes effect; a take_previous or take_candidate whose recorded
// candidate, not deleted, leaves no item in the replay (a same value without evidence pointed
// at); an operation judged after a deletion event (its conflict criterion reads that event's L).

import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { type IntervalSet, isNothing, meet } from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import { ackOf, emptyState, judgeOp, withoutDeps } from "./judge.ts";
import type {
  ConfirmRecord,
  FieldInput,
  OpRecord,
  RejectRecord,
  Restatement,
  RevertRecord,
  RevokeInput,
  TableShape,
  TakeCandidateRecord,
  Target,
  WriteInput,
  WriteRecord,
} from "./model.ts";
import { givenByRecords, type LatestGiven, renumber, restatements } from "./restate.ts";
import { judgeRevertOf } from "./revert.ts";
import { type Item, RowState } from "./state.ts";
import { judgeTakeCandidate } from "./take.ts";
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
 * The candidates people's conflict resolutions decided, by the write: the targets each resolution
 * recorded (`decided`, by (event, target)), each with whether it was a candidate in an item on
 * existence when written (it met a revoke).
 */
function resolvedOf(records: readonly OpRecord[]): Map<number, Map<Target, boolean>> {
  const out = new Map<number, Map<Target, boolean>>();
  for (const r of records) {
    if (r.kind !== "keep_effective" && r.kind !== "take_candidate" && r.kind !== "take_previous") {
      continue;
    }
    for (const d of r.decided ?? []) {
      const w = records.find((x) => x.event === d.event);
      const onExistence =
        d.target === "existence" ||
        (w !== undefined &&
          "items" in w &&
          w.items.some((x) => x.target === d.target && x.onExistence === true));
      const m = out.get(d.event) ?? new Map<Target, boolean>();
      m.set(d.target, onExistence);
      out.set(d.event, m);
    }
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
 * A revert executed on the replay's state (03-deletion «回掉的权威定义»: R and the value position
 * as recorded, never listed again; ranges, write-backs and registrations worked out again; the
 * write-backs are applied, not judged again for high impact: deviation one for a person's undo,
 * confirmation or `take_previous`, and «高影响» «已直接生效的回掉…按偏离二保持生效»). `seen`,
 * `acknowledge` and the skipped entries stay as recorded.
 */
function revertAgain(
  state: RowState,
  r: RevertRecord,
  deleted: (event: number, target: Target) => boolean,
  decided: boolean,
  candidateWhenWritten: (event: number, target: Target, valid: IntervalSet) => boolean,
): RevertRecord {
  if (r.kind === "take_previous") {
    const unit = r.revert.unit;
    const mergeBase = r.revert.mergeBase;
    if (unit === undefined || mergeBase === undefined) {
      throw new JudgeError("invalid", "a take_previous record without its unit or merge base", {
        op: r.op,
      });
    }
    const k = kOf(state, r, deleted, candidateWhenWritten);
    const out = judgeRevertOf(state, r, r.revert.entries, { asOf: mergeBase }, k, false);
    return { ...r, items: out.items };
  }
  const before = r.revert.before;
  if (before === undefined) {
    throw new JudgeError("invalid", "an undo record without the operation it takes back", {
      op: r.op,
    });
  }
  const out = judgeRevertOf(state, r, r.revert.entries, { before }, null, false);
  if (r.status === "applied") return { ...r, items: out.items };
  // Awaiting: the proposal, for a person's decision recorded after it. Undecided, it awaits only
  // while of high impact in the replay; one no longer is (④, 03-deletion «高影响») would take
  // effect at its own number, and at that moment the row is checked as when written: still
  // revoked once it is written, it does not take effect (03-deletion «回掉的权威定义» step 4).
  // Neither is opened here; the second has a kind of its own.
  if (!decided) {
    const again = (refuseRevoked: boolean) =>
      judgeRevertOf(
        state,
        { ...r, acknowledge: r.acknowledge === true },
        r.revert.entries,
        { before },
        null,
        true,
        refuseRevoked,
      );
    if (again(false).status === "applied") {
      try {
        again(true);
      } catch (e) {
        if (e instanceof JudgeError && e.reason === "revoked") {
          throw new JudgeError(
            "not_implemented",
            "a deletion's replay of an awaiting undo that would take effect on a revoked row",
            { kind: "undo on a revoked row", op: r.op },
          );
        }
        throw e;
      }
      throw new JudgeError(
        "not_implemented",
        "a deletion's replay of an awaiting undo no longer of high impact",
        { kind: "undo no longer of high impact", op: r.op },
      );
    }
  }
  return { ...r, items: out.items.map((x) => ({ ...x, status: "awaiting" as const })) };
}

/**
 * K of a conflict resolution in the replay (03-deletion «回掉的权威定义» step 2): of the
 * (event, target)s it recorded (`decided`), the items that are candidates in the replay, or that
 * were candidates when written and are the same as the value before them now (a corroboration):
 * only being deleted takes one out. A recorded one stays a candidate whether or not its conflict
 * is still there (`resolved`, judgeWrite); one not deleted with no such item is a same value
 * without evidence pointed at, which leaves no item: not opened here.
 */
function kOf(
  state: RowState,
  r: RevertRecord | TakeCandidateRecord,
  deleted: (event: number, target: Target) => boolean,
  candidateWhenWritten: (event: number, target: Target, valid: IntervalSet) => boolean,
): Item[] {
  const recorded = new Set((r.decided ?? []).map((x) => contributionKey(x.event, x.target)));
  const k = state.items.filter(
    (x) =>
      recorded.has(contributionKey(x.event, x.target)) &&
      (x.status === "candidate" ||
        (x.status === "corroborated" && candidateWhenWritten(x.event, x.target, x.valid))),
  );
  for (const d of r.decided ?? []) {
    if (deleted(d.event, d.target)) continue;
    if (!k.some((x) => x.event === d.event && x.target === d.target)) {
      throw new JudgeError(
        "not_implemented",
        `a deletion's replay of a ${r.kind} whose candidate is no longer one`,
        { kind: `${r.kind} candidate`, op: r.op, event: d.event, target: d.target },
      );
    }
  }
  return k;
}

/**
 * A take_candidate executed as recorded on the replay's state (03-deletion «搬运的值»,
 * «重放规则 · 人的决定»): K as the replay has it; the merge base, the cover set O and the filled
 * revokes as recorded; where it lands worked out again, less what writes outside O cover; the
 * checks on the current state made when it was judged not made again.
 */
function takeAgain(
  state: RowState,
  r: TakeCandidateRecord,
  records: readonly OpRecord[],
  deleted: (event: number, target: Target) => boolean,
  candidateWhenWritten: (event: number, target: Target, valid: IntervalSet) => boolean,
): TakeCandidateRecord {
  const k = kOf(state, r, deleted, candidateWhenWritten);
  // The taken write's value on each field it gave in the item, as written: the fields the
  // resolution recorded as decided for the taken write (from the record, not from the replay's
  // state, where a deleted contribution has no item to say which item it was in).
  const values = new Map<FieldId, FieldValue>();
  const w = records.find((x) => x.event === r.take);
  if (w !== undefined && (w.kind === "write" || w.kind === "revoke")) {
    for (const x of w.items) {
      if (x.target === "existence" || x.content.kind !== "value" || values.has(x.target)) continue;
      if (!(r.decided ?? []).some((d) => d.event === w.event && d.target === x.target)) continue;
      values.set(x.target, x.content.value);
    }
  }
  const out = judgeTakeCandidate(
    state,
    {
      kind: "take_candidate",
      op: r.op,
      index: r.index,
      event: r.event,
      ruleset: r.ruleset,
      ...(r.policy !== undefined ? { policy: r.policy } : {}),
      unit: r.unit,
      candidates: r.candidates,
      take: r.take,
    },
    { k, mergeBase: r.mergeBase, cover: r.cover, filled: r.filled, values },
  );
  return { ...r, items: out.items };
}

/**
 * A confirmation of an awaiting undo, executed as recorded: the revert as listed at the
 * confirmation (its own R), the confirmation's operation the n (03-deletion «回掉的权威定义» step
 * 4), its write-backs worked out again on the replay's state.
 */
function confirmUndoAgain(state: RowState, r: ConfirmRecord): ConfirmRecord {
  const revert = r.revert;
  if (revert?.before === undefined) {
    throw new JudgeError("invalid", "an undo's confirmation without the operation it takes back", {
      op: r.op,
    });
  }
  const out = judgeRevertOf(state, r, revert.entries, { before: revert.before }, null, false);
  return { ...r, items: out.items };
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
 * `deleted` (by `contributionKey`) had never been. Returns the state after the replay, each
 * operation's record as judged in it (an operation nothing of which is left has no record), its
 * items numbered against the blocks the log last gave (03-deletion «回掉的权威定义» step 6), and the
 * restatements (09 §5.9 `restated/<k>`, rules 1 and 2). `deletionsBefore`: the operation numbers
 * of the deletion and cancellation events in the log; an operation after one is not replayed in
 * this version. `latest`: the blocks the log last gave (see `LatestGiven`); by default the
 * records as written.
 */
export function replayDeletion(
  table: TableShape,
  records: readonly OpRecord[],
  deleted: ReadonlySet<string>,
  deletionsBefore: readonly number[] = [],
  latest: LatestGiven = givenByRecords(records),
): {
  readonly state: RowState;
  readonly records: readonly OpRecord[];
  readonly restated: readonly Restatement[];
} {
  let state = emptyState(table);
  const out: OpRecord[] = [];
  // Each record the replay produces, its items numbered against the blocks last given, into the
  // state: later operations refer to them by those indices.
  const commit = (record: OpRecord) => {
    let numberedRecord = record;
    if ("items" in record && record.items.length > 0) {
      const own = records.find((x) => x.event === record.event);
      const writeTime = own !== undefined && "items" in own ? own.items : [];
      const targets = [...new Set(record.items.map((x) => x.target))].sort();
      const items = targets.flatMap((t) =>
        renumber(
          record.items.filter((x) => x.target === t),
          latest.get(contributionKey(record.event, t)) ?? [],
          writeTime.filter((x) => x.target === t),
        ),
      );
      numberedRecord = { ...record, items } as OpRecord;
    }
    out.push(numberedRecord);
    state = new RowState(table, [...state.records, numberedRecord]);
  };
  const firstDeletion = Math.min(Number.POSITIVE_INFINITY, ...deletionsBefore);
  const decisions = decisionsOf(records);
  const resolutions = resolvedOf(records);
  // Whether a stretch of a write's items on a target was a candidate when written: it meets one
  // of its candidate items as recorded (a stretch meeting a candidate and an effective item counts
  // as the candidate's, as the reference's write-time status of a stretch does). A stretch meeting
  // none of its items as recorded — the part a deletion extended (a default end whose blocking
  // point is gone) — takes the write's status on the target: an extension of a candidate still
  // belongs to its item (03-deletion «回掉的权威定义» step 2).
  const candidateWhenWritten = (event: number, target: Target, valid: IntervalSet): boolean => {
    const w = records.find((x) => x.event === event && (x.kind === "write" || x.kind === "revoke"));
    if (w === undefined || (w.kind !== "write" && w.kind !== "revoke")) return false;
    const own = w.items.filter((x) => x.target === target);
    const hit = own.filter((x) => !isNothing(meet(x.valid, valid)));
    return (hit.length > 0 ? hit : own).some((x) => x.status === "candidate");
  };
  for (const r of records) {
    if (
      r.kind !== "write" &&
      r.kind !== "revoke" &&
      r.kind !== "confirm" &&
      r.kind !== "reject" &&
      r.kind !== "undo" &&
      r.kind !== "take_previous" &&
      r.kind !== "keep_effective" &&
      r.kind !== "take_candidate"
    ) {
      throw new JudgeError("not_implemented", `a deletion's replay of a ${r.kind}`, {
        kind: r.kind,
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
    if (r.kind === "undo" || r.kind === "take_previous") {
      const decided = records.some(
        (x) => (x.kind === "confirm" || x.kind === "reject") && x.target === r.event,
      );
      const again = revertAgain(
        state,
        r,
        (e, t) => deleted.has(contributionKey(e, t)),
        decided,
        candidateWhenWritten,
      );
      // Event and timeless tables keep no deps, as every judged record (judge.ts).
      const record = state.isState ? again : withoutDeps(again);
      commit(record);
      continue;
    }
    if (r.kind === "take_candidate") {
      const again = takeAgain(
        state,
        r,
        records,
        (e, t) => deleted.has(contributionKey(e, t)),
        candidateWhenWritten,
      );
      const record = state.isState ? again : withoutDeps(again);
      commit(record);
      continue;
    }
    // keep_effective: "these candidates do not take effect", as recorded; it writes nothing, and
    // its record closes them (RowState.closedCandidate).
    if (r.kind === "keep_effective") {
      commit(r);
      continue;
    }
    if (r.kind === "confirm" && r.revert !== undefined) {
      const again = confirmUndoAgain(state, r);
      const record = state.isState ? again : withoutDeps(again);
      commit(record);
      continue;
    }
    if (r.kind === "confirm" || r.kind === "reject") {
      const judged = decide(state, r);
      if (judged === undefined) continue;
      commit(judged.judgement.record);
      continue;
    }
    // Narrowed for the compiler: a revert's kind is a union, so the branch above does not drop it.
    if (r.kind !== "write" && r.kind !== "revoke") continue;
    const input = inputOf(r, (t) => deleted.has(contributionKey(r.event, t)));
    if (input === undefined) continue;
    const decision = decisions.get(r.event);
    const options: ReplayOptions = {
      noop: new Set(r.noop),
      protect: protectedTargets(r),
      decided: decision?.decided ?? new Set(),
      rejected: decision?.rejected ?? false,
      resolved: resolutions.get(r.event) ?? new Map(),
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
    commit(record);
  }
  return {
    state,
    records: out,
    restated: restatements(out, latest, deleted, state.isState),
  };
}
