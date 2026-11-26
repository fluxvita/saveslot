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
// conflict there or not (deviation one), so the resolution's record still closes it; one the same
// as its seen version with no evidence pointed at leaves no item, its shadow counts in the
// resolution's K (`kOf`; 03-deletion «回掉的权威定义» step 2). Refused with
// `not_implemented`, naming the kind, never judged as an ordinary write: an undecided awaiting
// undo no longer of high impact (high impact ④ judged again), with a kind of its own when the row
// would still be revoked once it takes effect; a take_previous or take_candidate whose recorded
// candidate, not deleted, leaves neither an item nor a shadow in the replay; an operation judged
// after a deletion event (its conflict criterion reads that event's L);
// a write by external key (its sync baseline in a replay is the deletion phase's, with the key
// index's freezing); a write that added a key to a row (the key index's part of a deletion); an
// undecided revoke awaiting for its referrers (high impact ②, judged again by the deletion phase);
// on a table that may be referred to, a revoke whose conflict the deletion clears (the same).

import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { canonical, type IntervalSet, isNothing, meet } from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import { type ItemsGiven, type ItemsResult, itemsResult } from "./fates.ts";
import { ackOf, emptyState, judgeOp, withoutDeps } from "./judge.ts";
import {
  type ConfirmRecord,
  contributionKey,
  type ExternalChange,
  type FieldInput,
  type ItemRef,
  type OpRecord,
  type RejectRecord,
  type Restatement,
  type RevertRecord,
  type RevokeInput,
  seenOf,
  type TableShape,
  type TakeCandidateRecord,
  type Target,
  type WriteInput,
  type WriteRecord,
} from "./model.ts";
import { givenByRecords, type LatestGiven, renumber, restatements } from "./restate.ts";
import { ALL_TIME, type Outcome, outcomeOf, type RowResult, rowResult } from "./results.ts";
import { judgeRevertOf } from "./revert.ts";
import { type Item, RowState } from "./state.ts";
import { judgeTakeCandidate } from "./take.ts";
import { judgeRevoke, judgeWrite, type ReplayOptions, type Shadow } from "./write.ts";

export { contributionKey } from "./model.ts";

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
 * confirmation or `take_previous`, and «高影响» "已直接生效的回掉" … "按偏离二保持生效"). `seen`,
 * `acknowledge` and the skipped entries stay as recorded.
 */
function revertAgain(
  state: RowState,
  r: RevertRecord,
  deleted: (event: number, target: Target) => boolean,
  decided: boolean,
  candidateWhenWritten: (event: number, target: Target, valid: IntervalSet) => boolean,
  shadows: readonly Shadow[],
  records: readonly OpRecord[],
  latest: LatestGiven,
): RevertRecord {
  if (r.kind === "take_previous") {
    const unit = r.revert.unit;
    const mergeBase = r.revert.mergeBase;
    if (unit === undefined || mergeBase === undefined) {
      throw new JudgeError("invalid", "a take_previous record without its unit or merge base", {
        op: r.op,
      });
    }
    const k = kOf(state, r, deleted, candidateWhenWritten, shadows, records, latest);
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
  shadows: readonly Shadow[],
  records: readonly OpRecord[],
  latest: LatestGiven,
): Item[] {
  const recorded = new Set((r.decided ?? []).map((x) => contributionKey(x.event, x.target)));
  const k: Item[] = state.items.filter(
    (x) =>
      recorded.has(contributionKey(x.event, x.target)) &&
      (x.status === "candidate" ||
        (x.status === "corroborated" && candidateWhenWritten(x.event, x.target, x.valid))),
  );
  for (const d of r.decided ?? []) {
    if (deleted(d.event, d.target)) continue;
    if (k.some((x) => x.event === d.event && x.target === d.target)) continue;
    // The same as its seen version now with no evidence pointed at: no item, its shadow counts
    // (03-deletion «回掉的权威定义» step 2: 「c 在重放里成了同值（不再是改动）仍算在」).
    const sh = shadows.find((x) => x.event === d.event && x.target === d.target);
    const w = records.find((x) => x.event === d.event);
    // Its indices as the log last gave them, earlier deletions' renumbering included: those not
    // last given as dropped, which this deletion restates as dropped; with none left, those an
    // earlier deletion did (09 §5.7 `carried`: a take can carry an index restated as dropped).
    const given = latest.get(contributionKey(d.event, d.target)) ?? [];
    const open = given.filter((x) => x.status !== "dropped");
    const indices = (open.length > 0 ? open : given).map((x) => x.k).sort((a, b) => a - b);
    if (sh === undefined || w === undefined || indices.length === 0) {
      // No item and no shadow (a recorded candidate that is no contribution in the replay for
      // another reason than a same value, such as a revoke on a row revoked already): not in this
      // version.
      throw new JudgeError(
        "not_implemented",
        `a deletion's replay of a ${r.kind} whose candidate is no longer one`,
        { kind: `${r.kind} candidate`, op: r.op, event: d.event, target: d.target },
      );
    }
    for (const index of indices) {
      const item: Item = {
        event: sh.event,
        target: sh.target,
        k: index,
        op: w.op,
        index: w.index,
        status: "candidate",
        valid: sh.valid,
        content: { kind: "value", value: sh.value },
        deps: sh.deps,
        shadow: true,
        // A candidate: corroboration endpoints are read only on corroborated items.
        explicitEnds: [],
        defaultEnd: sh.defaultEnd,
      };
      k.push(item);
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
  shadows: readonly Shadow[],
  latest: LatestGiven,
): TakeCandidateRecord {
  const k = kOf(state, r, deleted, candidateWhenWritten, shadows, records, latest);
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
  external: readonly ExternalChange[],
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
    ...(external.length > 0 ? { external } : {}),
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
 * restatements (09 §5.9 `restated/<k>`, rules 1 and 2). `external`: the deletion and
 * cancellation events in the log as L of the conflict criterion (`ExternalChange`): a write or
 * revoke after one (in a grace period) is judged with those after its version seen among its L.
 * `latest`: the blocks the log last gave (see `LatestGiven`); by default the records as written.
 */
export function replayDeletion(
  table: TableShape,
  records: readonly OpRecord[],
  deleted: ReadonlySet<string>,
  external: readonly ExternalChange[] = [],
  latest: LatestGiven = givenByRecords(records),
  /** A cancellation's: the items whose last block came from the deletion cancelled (rule 3). */
  cancelled: ReadonlySet<string> = new Set(),
  /**
   * The (event, target) recorded as kept effective by cancellations in the log (09 §5.9
   * `kept_effective`), the caller's from the log: already in effect, as if so when written
   * (03-deletion «删除结果的定义» deviation two; «撤回与宽限期»: the protection lasts).
   */
  keptEffective: ReadonlySet<string> = new Set(),
  /** Blocks this deletion's own list of positions clears besides (`restatements`). */
  cleared?: Parameters<typeof restatements>[5],
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
  // Fields the same as their seen version with no evidence pointed at, a conflict resolution's K
  // still counts (`kOf`).
  const shadows: Shadow[] = [];
  const decisions = decisionsOf(records);
  const resolutions = resolvedOf(records);
  // Whether a stretch of a write's items on a target was a candidate when written: it meets one
  // of its candidate items as recorded (a stretch meeting a candidate and an effective item counts
  // as the candidate's, as the reference's write-time status of a stretch does). A stretch meeting
  // none of its items as recorded — the part a deletion extended (a default end whose blocking
  // point is gone) — takes the write's status on the target: an extension of a candidate still
  // belongs to its item (03-deletion «回掉的权威定义» step 2).
  // An item's interval as written is not to be trusted once a contribution it rests on (its
  // deps: what gives its ends) is in the deleted set, pending or carried out: it is read from the
  // last block that gave it an interval (protection-unit decision, item 6); its status is the
  // write's.
  const candidateWhenWritten = (event: number, target: Target, valid: IntervalSet): boolean => {
    const w = records.find((x) => x.event === event && (x.kind === "write" || x.kind === "revoke"));
    if (w === undefined || (w.kind !== "write" && w.kind !== "revoke")) return false;
    const given = latest.get(contributionKey(event, target)) ?? [];
    const own = w.items
      .filter((x) => x.target === target)
      .map((x) => {
        if (!x.deps.some((d) => deleted.has(contributionKey(d.event, d.target)))) return x;
        // The last block that gave it an interval: a restatement as dropped gives none.
        const last = given.find((b) => b.k === x.k);
        const valid =
          last?.landing ?? (last !== undefined && last.valid.length > 0 ? last.valid : x.valid);
        return { ...x, valid };
      });
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
    // A write that gave the row its key (its key field items): the key index's part of a deletion
    // (freezing, the holder recomputed) comes with the deletion phase.
    if (
      r.kind === "write" &&
      r.byKey !== true &&
      r.items.some((x) => (table.keyFields ?? []).includes(x.target as never))
    ) {
      throw new JudgeError("not_implemented", "a deletion's replay of a write adding a key", {
        kind: "write_adding_external_key",
        op: r.op,
      });
    }
    if (r.kind === "write" && r.byKey === true) {
      throw new JudgeError("not_implemented", "a deletion's replay of a write by external key", {
        kind: "write_by_external_key",
        op: r.op,
      });
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
        shadows,
        records,
        latest,
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
        shadows,
        latest,
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
    const decision = decisions.get(r.event);
    // A revoke that awaited confirmation when written (high impact ②, the only way a revoke
    // awaits): who referred to its target is other rows', which a replay does not see. Decided,
    // it awaits as written and its decision is executed as recorded (deviation one); undecided,
    // whether it is still of high impact is the deletion phase's to judge (03-deletion «高影响
    // （重算）»): refused, never judged as effective.
    const referenced = r.kind === "revoke" && r.items.some((x) => x.status === "awaiting");
    if (referenced && decision === undefined) {
      throw new JudgeError(
        "not_implemented",
        "a deletion's replay of an undecided revoke awaiting for its referrers",
        { kind: "referenced_revoke_awaiting", op: r.op },
      );
    }
    const given = inputOf(r, (t) => deleted.has(contributionKey(r.event, t)), external);
    if (given === undefined) continue;
    const input = referenced && given.kind === "revoke" ? { ...given, referenced: true } : given;
    const options: ReplayOptions = {
      shadows,
      noop: new Set(r.noop),
      protect: new Set([
        ...protectedTargets(r),
        // Kept in effect by a cancellation, unless a person's resolution recorded it as a
        // candidate: that decision stands as recorded (deviation one comes first).
        ...r.items
          .map((x) => x.target)
          .filter(
            (t) =>
              keptEffective.has(contributionKey(r.event, t)) &&
              resolutions.get(r.event)?.has(t) !== true,
          ),
      ]),
      decided: decision?.decided ?? new Set(),
      rejected: decision?.rejected ?? false,
      resolved: resolutions.get(r.event) ?? new Map(),
    };
    const judged =
      input.kind === "write"
        ? judgeWrite(state, input, options)
        : judgeRevoke(state, input, options);
    // A revoke that was a candidate when written, its conflict gone with the deletion: whether
    // it now awaits for its referrers (high impact ②, never judged when written: a stale write is a
    // candidate first) needs other rows', which a replay does not see. On a table that may be
    // referred to, refused; the deletion phase judges it again with them.
    if (
      r.kind === "revoke" &&
      r.items.some((x) => x.target === "existence" && x.status === "candidate") &&
      !judged.items.some((x) => x.target === "existence" && x.status === "candidate")
    ) {
      // Whether the table may be referred to must be given (`replayShape`): taken as no here, a
      // revoke awaiting for its referrers would be put into effect without them.
      if (table.referable === undefined) {
        throw new JudgeError(
          "invalid",
          "a deletion's replay needs to know whether the table may be referred to",
          {
            op: r.op,
          },
        );
      }
    }
    if (
      r.kind === "revoke" &&
      table.referable === true &&
      r.items.some((x) => x.target === "existence" && x.status === "candidate") &&
      !judged.items.some((x) => x.target === "existence" && x.status === "candidate")
    ) {
      throw new JudgeError(
        "not_implemented",
        "a deletion's replay of a revoke whose conflict the deletion clears, on a table referred to",
        { kind: "revoke_conflict_cleared", op: r.op },
      );
    }
    // A revoke that was a no-op when written (the row revoked already: no existence item), in effect
    // in the replay: as with a candidate whose conflict the deletion clears, whether it awaits for
    // its referrers (high impact ②) needs other rows', which a replay does not see (03-deletion
    // «高影响（重算）»). On a table that may be referred to, refused.
    if (
      r.kind === "revoke" &&
      !r.items.some((x) => x.target === "existence") &&
      judged.items.some((x) => x.target === "existence" && x.status === "applied")
    ) {
      if (table.referable === undefined) {
        throw new JudgeError(
          "invalid",
          "a deletion's replay needs to know whether the table may be referred to",
          { op: r.op },
        );
      }
      if (table.referable === true) {
        throw new JudgeError(
          "not_implemented",
          "a deletion's replay of a revoke that was a no-op when written and takes effect, on a table referred to",
          { kind: "revoke_noop_now_effective", op: r.op },
        );
      }
    }
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
    restated: restatements(out, latest, deleted, state.isState, cancelled, cleared),
  };
}

/**
 * The deletion and cancellation events as L for a replay whose deleted set is the one given
 * (`ExternalChange`): an event's unit counts as changed whole when its record is on the list of
 * positions of a deletion in that set (09-references «冲突判据», L's interval). The caller's, from
 * the log.
 */
export type ExternalFor = (deleted: ReadonlySet<string>) => readonly ExternalChange[];

/**
 * A deletion's replay with what its event says of the row or entity (09 §5.9): the replay
 * (`replayDeletion`), the row's `results` entry and outcome, and `recreated`. `deleted`: every
 * contribution deleted by this deletion and the ones still pending before it; `pendingBefore`:
 * those of the deletions still pending before it (the state before this deletion is their
 * replay; with none, the records as written). `items`: which item each (event, target) ever
 * pending is in and how each item stands, from the log's item events (fates.ts); the item layer
 * comes back as `items`. `latest`: as for `replayDeletion`.
 */
export function deletionResult(
  table: TableShape,
  records: readonly OpRecord[],
  deleted: ReadonlySet<string>,
  pendingBefore: ReadonlySet<string>,
  items: ItemsGiven,
  /**
   * The deletion and cancellation events in the log before this one, as L of the conflict
   * criterion for the writes after them (`ExternalChange`, the caller's from the log), for a
   * replay's deleted set: whether an event counts over a whole unit depends on it (its record on
   * the list of positions of a deletion in that set), so the replay before this deletion and the
   * one with it are each given theirs.
   */
  external: ExternalFor,
  latest: LatestGiven = givenByRecords(records),
  /** Kept effective by cancellations in the log (`replayDeletion`). */
  keptEffective: ReadonlySet<string> = new Set(),
  /** Blocks this deletion's own list of positions clears besides (`restatements`). */
  cleared?: Parameters<typeof restatements>[5],
): {
  readonly replay: ReturnType<typeof replayDeletion>;
  readonly before: RowState;
  readonly result: RowResult;
  readonly outcome?: Outcome;
  readonly items: ItemsResult;
} {
  // The state before it: the records as written, unless a pending deletion or a cancellation's
  // keeping in effect makes it otherwise.
  const before =
    pendingBefore.size > 0 || keptEffective.size > 0
      ? replayDeletion(
          table,
          records,
          pendingBefore,
          external(pendingBefore),
          latest,
          new Set(),
          keptEffective,
        ).state
      : new RowState(table, records);
  const replay = replayDeletion(
    table,
    records,
    deleted,
    external(deleted),
    latest,
    new Set(),
    keptEffective,
    cleared,
  );
  const changed = [...deleted].filter((k) => !pendingBefore.has(k));
  return resultOf(table, records, before, replay, changed, items, latest);
}

/**
 * What an event says of a row or entity, from the state before it and its replay: `results` and
 * the outcome, and the item layer. `changed`: the contributions this event deletes or puts back;
 * their existence items, with the existence items and write-backs that only register restated,
 * touch the row (09 §5.9 «列哪些»).
 */
function resultOf(
  table: TableShape,
  records: readonly OpRecord[],
  before: RowState,
  replay: ReturnType<typeof replayDeletion>,
  changed: readonly string[],
  items: ItemsGiven,
  latest: LatestGiven,
  /** Items put back that no contribution put back gives and the event does not restate. */
  back: readonly ItemRef[] = [],
) {
  // The intervals of existence items deleted, put back or restated, and of write-backs that only
  // register restated, before (as last given) and after.
  const touched: IntervalSet[] = [];
  const lastValid = (event: number, target: Target, k?: number) =>
    (latest.get(contributionKey(event, target)) ?? [])
      .filter((b) => k === undefined || b.k === k)
      .flatMap((b) => [...b.valid, ...(b.landing ?? [])]);
  for (const key of changed) {
    const [ev, target] = key.split("/") as [string, Target];
    if (target === "existence") touched.push(lastValid(Number(ev), "existence"));
  }
  for (const x of back) {
    const now = replay.state.items.find(
      (y) => y.event === x.event && y.target === x.target && y.k === x.k,
    );
    touched.push(lastValid(x.event, x.target, x.k), now?.valid ?? []);
  }
  for (const r of replay.restated) {
    const uncovered =
      r.content?.kind === "uncovered" ||
      (latest.get(contributionKey(r.item.event, r.item.target)) ?? []).some(
        (b) => b.k === r.item.k && b.content?.kind === "uncovered",
      );
    if (r.item.target !== "existence" && !uncovered) continue;
    touched.push(lastValid(r.item.event, r.item.target, r.item.k), r.valid ?? []);
  }
  const any = touched.length > 0;
  const existenceTouched = !any
    ? undefined
    : table.kind === "state"
      ? canonical(touched.flat())
      : ALL_TIME;
  const result = rowResult(before, replay.state, replay.restated, existenceTouched);
  return {
    replay,
    before,
    result,
    ...(result.listed ? { outcome: outcomeOf(result, before, replay.state) } : {}),
    items: itemsResult(before, replay.state, records, items),
  };
}

/** What a cancellation needs from the log besides the records (the caller's). */
export interface CancellationLog {
  /** The deletion cancelled's operation number. */
  readonly cancelledOp: number;
  /**
   * The operation from which this row or entity has been covered without a break by pending
   * deletions up to this cancellation: deletions whose pending stretches meet or overlap join into
   * one, a deletion cancelled since counting until its cancellation. Not after `cancelledOp`; when
   * in doubt, the earlier bound.
   */
  readonly coveredSince: number;
  /** Kept effective by earlier cancellations in the log (`replayDeletion`). */
  readonly keptEffective: ReadonlySet<string>;
  /**
   * For an (event, target), the operation from which every item of it has been in effect without
   * a break up to the cancellation: the operation of the event that last gave its blocks, all of
   * them in effect (the deletion cancelled's confirmation, a later restatement or a decision).
   */
  readonly effectiveSince: (key: string) => number;
}

/** One (event, target) a cancellation keeps in effect, and the grace-period write that saw it. */
export interface KeptEffective {
  readonly event: number;
  readonly target: Target;
  readonly byEvent: number;
}

/**
 * A cancellation of a deletion in its grace period, with what its event says of the row or entity
 * (03-deletion «撤回与宽限期»; 09 §5.9 `deletion.cancelled`): the deletion cancelled no longer
 * counts, the definition is worked out again (the replay without it), and the event gives the
 * row's `results`, the restatements (rules 1, 2 and 3), `recreated`, `kept_effective` and the item
 * layer.
 *
 * Kept effective: an (event, target) this deletion alone put in effect (not every item in effect
 * when written; every item in effect with it; not so without it) stays in effect when a write in
 * the grace period, in effect when written, saw a version not before the operation from which
 * every item of it has been in effect (`effectiveSince`); `byEvent` is the first such write.
 *
 * Kept superseded is not in this version: a cancellation, with an operation on this row or entity
 * while it was covered without a break by pending deletions (`coveredSince`), of a deletion that
 * took a candidate away (an (event, target)
 * pending without it and not with it, not kept in effect) is refused, `not_implemented`. Otherwise
 * nothing was taken away and nothing is kept superseded.
 *
 * `others`: the contributions the other pending deletions delete; `cancelled`: those the deletion
 * cancelled deletes (before: both; after: `others`). `latest`: the blocks the log last gave without
 * the deletion cancelled's (09 §5.7); `fromCancelled`: the items whose last interval block (not a
 * restatement as dropped, 09 §5.9 rule 3) came from it. Both the caller's, from the log, as
 * `items`. `external`: the deletion and cancellation events in the log, the deletion cancelled's
 * included (`ExternalChange`), for each replay's deleted set (`ExternalFor`).
 */
export function cancellationResult(
  table: TableShape,
  records: readonly OpRecord[],
  others: ReadonlySet<string>,
  cancelled: ReadonlySet<string>,
  items: ItemsGiven,
  latest: LatestGiven,
  fromCancelled: ReadonlySet<string>,
  external: ExternalFor,
  log: CancellationLog,
) {
  const pendingBefore = new Set([...others, ...cancelled]);
  const kept0 = log.keptEffective;
  const before = replayDeletion(
    table,
    records,
    pendingBefore,
    external(pendingBefore),
    latest,
    new Set(),
    kept0,
  ).state;
  const without = replayDeletion(
    table,
    records,
    others,
    external(others),
    latest,
    fromCancelled,
    kept0,
  );
  // The grace period of the deletion cancelled: its baseline writes (kept in effect).
  const grace = records.filter((r) => r.op > log.cancelledOp);
  // Operations while the row was taken out of the pending set by any pending deletion, this one
  // or another (03-deletion «撤回与宽限期», kept superseded ②): the refusal looks at these, so
  // the order of cancellations does not matter.
  const covered = records.filter((r) => r.op > log.coveredSince);
  // Pending: in an open item. A candidate a person's resolution closed, or an awaiting write a
  // confirmation or rejection decided, is not (its item is closed whatever its status).
  const pending = (st: RowState) =>
    new Set(
      st.items
        .filter(
          (x) =>
            (x.status === "candidate" && !st.closedCandidate(x.event, x.target)) ||
            (x.status === "awaiting" && !st.resolvedAwaiting(x.event)),
        )
        .map((x) => contributionKey(x.event, x.target)),
    );
  const keptEffective = keptBy(records, before, without.state, grace, log);
  // Kept superseded can only hold for what this deletion took out of the pending set and did not
  // keep in effect (03-deletion «撤回与宽限期»): with an operation after the deletion, refused.
  if (covered.length > 0) {
    const was = pending(before);
    const keptKeys = new Set(keptEffective.map((x) => contributionKey(x.event, x.target)));
    const tookAway = [...pending(without.state)].filter((k) => !was.has(k) && !keptKeys.has(k));
    if (tookAway.length > 0) {
      throw new JudgeError(
        "not_implemented",
        "a cancellation, with writes in the grace period, of a deletion that took candidates away",
        {
          kind: "cancellation_keeping_superseded",
          op: (covered[0] as OpRecord).op,
          took: tookAway,
        },
      );
    }
  }
  const replay =
    keptEffective.length === 0
      ? without
      : replayDeletion(
          table,
          records,
          others,
          external(others),
          latest,
          fromCancelled,
          new Set([...kept0, ...keptEffective.map((x) => contributionKey(x.event, x.target))]),
        );
  const changed = [...cancelled].filter((k) => !others.has(k));
  // Put back without a contribution put back: an existence item, or a write-back that only
  // registers, the deletion cancelled restated as dropped (its interval empty there). The
  // cancellation does not restate it (09 §5.9 rule 3 takes interval blocks, not a dropped one),
  // so it is not among the restatements either; it touches the row all the same (09 §5.9 «列哪些»).
  const had = new Set(before.items.map((x) => `${x.event}/${x.target}/${x.k}`));
  const restatedNow = new Set(
    replay.restated.map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`),
  );
  const back = replay.state.items
    .filter(
      (x) =>
        (x.target === "existence" || x.content.kind === "uncovered") &&
        !had.has(`${x.event}/${x.target}/${x.k}`) &&
        !restatedNow.has(`${x.event}/${x.target}/${x.k}`) &&
        !changed.includes(contributionKey(x.event, x.target)),
    )
    .map((x) => ({ event: x.event, target: x.target, k: x.k }));
  return {
    ...resultOf(table, records, before, replay, changed, items, latest, back),
    keptEffective,
  };
}

/** The version an operation saw: its own `seen`, or, without one, the state just before it. */
function seenOfRecord(y: OpRecord): number {
  if ((y.kind === "write" || y.kind === "revoke" || y.kind === "undo") && y.seen !== undefined) {
    return seenOf({ op: y.op, seen: y.seen, ...(y.seenCurrent ? { seenCurrent: true } : {}) });
  }
  return y.op - 1;
}

/** See `cancellationResult`: what the cancellation keeps in effect. */
function keptBy(
  records: readonly OpRecord[],
  before: RowState,
  without: RowState,
  grace: readonly OpRecord[],
  log: CancellationLog,
): KeptEffective[] {
  const allIn = (st: RowState, event: number, target: Target) => {
    const own = st.items.filter((x) => x.event === event && x.target === target);
    return own.length > 0 && own.every((x) => effective(x.status));
  };
  // A grace-period operation that took effect when written (some item in effect), with what it saw.
  const baselines = grace
    .filter((y) => "items" in y && y.items.some((x) => effective(x.status)))
    .map((y) => ({ op: y.op, event: y.event, seen: seenOfRecord(y) }));
  const out: KeptEffective[] = [];
  for (const r of records) {
    if (r.kind !== "write" && r.kind !== "revoke") continue;
    if (r.op > log.cancelledOp) continue;
    for (const target of [...new Set(r.items.map((x) => x.target))].sort()) {
      const key = contributionKey(r.event, target);
      if (log.keptEffective.has(key)) continue;
      const atWrite = r.items.filter((x) => x.target === target);
      const made =
        !atWrite.every((x) => effective(x.status)) &&
        allIn(before, r.event, target) &&
        !allIn(without, r.event, target);
      if (!made) continue;
      const since = log.effectiveSince(key);
      const by = baselines.find((y) => y.op > since && y.seen >= since);
      if (by !== undefined) out.push({ event: r.event, target, byEvent: by.event });
    }
  }
  return out;
}
