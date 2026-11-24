// The entry points of `judge` (docs/zh-CN/spec/02-architecture.md §4): judge one operation on a
// row's or entity's state, replay operations from nothing, rebuild the state from records, and
// read the row or entity after them.
//
// `write` reads the records of the row and judges only the new operation: old writes keep the
// judgement the log recorded, under the ruleset version each recorded (04-write-and-read
// «规则版本与策略版本»). Re-judging from the raw parameters is what a privacy deletion's replay does,
// later.

import type { FieldId, Seq } from "@fluxvita/saveslot-contract-core";
import { canonical, type Interval, type IntervalSet, WHOLE } from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import type {
  AckStretch,
  ConfirmInput,
  DecidedItem,
  FieldStretch,
  JudgeInput,
  Judgement,
  OpRecord,
  Overwritten,
  RejectInput,
  RevertRecord,
  RowView,
  TableShape,
  Unit,
  WriteRecord,
} from "./model.ts";
import {
  candidatesOf,
  judgeRevertOf,
  judgeTakePrevious,
  judgeUndo,
  type RevertOutcome,
  undoEntries,
} from "./revert.ts";
import { EVERYTHING, effective, RowState, refKey, refOf, valueToken } from "./state.ts";
import { judgeTakeCandidate } from "./take.ts";
import { judgeRevoke, judgeWrite } from "./write.ts";

/** A resolution's K as (event, target)s, in order (see `DecidedItem`). */
function decidedOf(state: RowState, unit: Unit, candidates: readonly Seq[]): DecidedItem[] {
  const seen = new Map<string, DecidedItem>();
  for (const x of candidatesOf(state, unit, candidates)) {
    seen.set(`${x.event}/${x.target}`, { event: x.event, target: x.target });
  }
  return [...seen.values()].sort((a, b) => a.event - b.event || a.target.localeCompare(b.target));
}

/** The ruleset versions this `judge` judges by (02-architecture §3 «判定的版本»). */
export const JUDGE_RULESET_VERSIONS: ReadonlySet<number> = new Set([1]);

function checkVersion(v: number): void {
  if (!JUDGE_RULESET_VERSIONS.has(v)) {
    throw new JudgeError("unknown_version", `unknown ruleset version ${v}`, { ruleset: v });
  }
}

/** The state of a row or entity from the records of its operations, in log order. */
export function stateFromRecord(table: TableShape, records: readonly OpRecord[]): RowState {
  for (const r of records) checkVersion(r.ruleset);
  return new RowState(table, records);
}

export const emptyState = (table: TableShape): RowState => new RowState(table, []);

const quiet = {
  conflicts: [],
  erased: [],
  overwritten: [],
  acknowledged: false,
  warnings: [],
  created: false,
  takesBack: [],
  hides: [],
} as const;

/** Judges one operation on the state; returns the judgement and the state after it. */
export function judgeOp(
  state: RowState,
  input: JudgeInput,
): { readonly judgement: Judgement; readonly state: RowState } {
  checkVersion(input.ruleset);
  const base = {
    op: input.op,
    index: input.index,
    event: input.event,
    ruleset: input.ruleset,
    ...(input.policy !== undefined ? { policy: input.policy } : {}),
  };
  let judgement: Judgement;
  if (input.kind === "write" || input.kind === "revoke") {
    const out = input.kind === "write" ? judgeWrite(state, input) : judgeRevoke(state, input);
    // A write by key: its seen is the earliest of its fields' baseline positions (09 §5.7
    // `ver.basis: external_key`), never given; creating its row, it is the operation before.
    const byKey = input.kind === "write" ? input.sync : undefined;
    const positions = Object.values(out.baseline ?? {}) as number[];
    const seen =
      byKey === undefined
        ? input.seen
        : ((positions.length > 0 ? Math.min(...positions) : input.op - 1) as typeof input.seen);
    const record: WriteRecord = {
      ...base,
      kind: input.kind,
      seen,
      seenExplicit: byKey === undefined ? input.seenExplicit : false,
      ...(input.seenCurrent && byKey === undefined ? { seenCurrent: true as const } : {}),
      ...(byKey !== undefined ? { byKey: true as const } : {}),
      ...(out.baseline !== undefined && positions.length > 0 ? { baseline: out.baseline } : {}),
      ...(input.valid !== undefined ? { valid: input.valid } : {}),
      now: input.now,
      ...(input.kind === "write" && input.acknowledge ? { acknowledge: true as const } : {}),
      explicit:
        input.kind === "write"
          ? (Object.keys(input.fields) as FieldId[]).filter((f) => input.fields[f]?.explicit).sort()
          : [],
      items: out.items,
      // Hitting a row by its key, the key fields are no-ops too, not judged (09 §5.7 ops/<i>/noop).
      noop:
        byKey !== undefined && byKey.creates !== true
          ? [...new Set([...out.noop, ...byKey.keyFields])].sort()
          : out.noop,
      ack: out.acknowledged ? out.overwritten.map(ackOf) : [],
    };
    const { items: _, noop: __, baseline: ___, ...rest } = out;
    judgement = {
      record,
      ...rest,
      created: input.kind === "write" && isFirstCreation(state, record),
      takesBack: [],
      hides: [],
    };
  } else if (input.kind === "undo") {
    const out = judgeUndo(state, input);
    const record: RevertRecord = {
      ...base,
      kind: "undo",
      status: out.status,
      revert: { entries: out.entries, before: out.before, skipped: out.skipped },
      items: out.items,
      seen: input.seen,
      seenExplicit: input.seenExplicit,
      ...(input.seenCurrent ? { seenCurrent: true as const } : {}),
      ...(input.acknowledge ? { acknowledge: true as const } : {}),
      ...(input.includeLater ? { includeLater: true as const } : {}),
      ack: out.acknowledged ? out.overwritten.map(ackOf) : [],
    };
    judgement = { ...quiet, ...revertJudgement(out), record };
  } else if (input.kind === "take_previous") {
    openCandidates(state, input.unit, input.candidates);
    const decided = decidedOf(state, input.unit, input.candidates);
    const out = judgeTakePrevious(state, input);
    const record: RevertRecord = {
      ...base,
      kind: "take_previous",
      status: "applied",
      decided,
      revert: {
        entries: out.entries,
        mergeBase: out.mergeBase,
        candidates: input.candidates,
        unit: input.unit,
        skipped: [],
      },
      items: out.items,
      ack: [],
    };
    judgement = { ...quiet, ...revertJudgement(out), record };
  } else if (input.kind === "take_candidate") {
    openCandidates(state, input.unit, input.candidates);
    const decided = decidedOf(state, input.unit, input.candidates);
    const out = judgeTakeCandidate(state, input);
    judgement = {
      ...quiet,
      record: {
        ...base,
        kind: "take_candidate",
        unit: input.unit,
        candidates: input.candidates,
        take: input.take,
        mergeBase: out.mergeBase,
        cover: out.cover,
        filled: out.filled,
        items: out.items,
        decided,
      },
    };
  } else if (input.kind === "confirm" && awaitingUndo(state, input.target) !== undefined) {
    // Confirming an awaiting undo: the record is listed again as of the confirmation, written by
    // the confirmation (04-write-and-read «撤回某次写入（undo）»; 03-deletion «回掉的权威定义»
    // step 4; 09 §5.8).
    const u = awaitingUndo(state, input.target) as RevertRecord;
    const before = u.revert.before as number;
    const entries = undoEntries(state, before, u.includeLater === true, input.op, input.index);
    const out = judgeRevertOf(state, input, entries, { before }, null, false);
    judgement = {
      ...quiet,
      ...revertJudgement(out),
      record: {
        ...base,
        kind: "confirm",
        target: input.target,
        items: out.items,
        revert: { entries: out.entries, before, skipped: out.skipped },
      },
    };
  } else if (input.kind === "confirm") {
    judgement = { record: confirm(state, input, base), ...quiet };
  } else if (input.kind === "reject") {
    awaitingOf(state, input);
    judgement = { record: { ...base, kind: "reject", target: input.target }, ...quiet };
  } else {
    openCandidates(state, input.unit, input.candidates);
    judgement = {
      record: {
        ...base,
        kind: "keep_effective",
        unit: input.unit,
        candidates: input.candidates,
        decided: decidedOf(state, input.unit, input.candidates),
      },
      ...quiet,
    };
  }
  // Event and timeless tables have no business time: no item there comes from other contributions'
  // dates, so none has `deps` (09 §3.5: only an item with an interval carries them).
  if (!state.isState) judgement = { ...judgement, record: withoutDeps(judgement.record) };
  return { judgement, state: new RowState(state.table, [...state.records, judgement.record]) };
}

/** An overwritten stretch as the log keeps it (09 §5.7 `ack/<j>`). */
export function ackOf(o: Overwritten): AckStretch {
  const base = { field: o.field, valid: o.valid, deps: o.deps };
  return o.was.kind === "value"
    ? { ...base, value: o.was.value, op: o.was.op }
    : { ...base, noValue: true };
}

export function withoutDeps(r: OpRecord): OpRecord {
  if (r.kind === "reject" || r.kind === "keep_effective") return r;
  return { ...r, items: r.items.map((x) => ({ ...x, deps: [] })) } as OpRecord;
}

function revertJudgement(out: RevertOutcome) {
  return {
    erased: out.erased as Judgement["erased"],
    overwritten: out.overwritten,
    acknowledged: out.acknowledged,
    warnings: out.warnings,
    takesBack: out.takesBack,
    hides: out.hides,
  };
}

/** The awaiting undo written by event `target`, not yet confirmed or rejected. */
function awaitingUndo(state: RowState, target: Seq): RevertRecord | undefined {
  const r = state.records.find((x) => x.event === target);
  if (r?.kind !== "undo" || r.status !== "awaiting" || state.resolvedAwaiting(target))
    return undefined;
  return r;
}

/** Judges the operations in order from nothing. */
export function replay(
  table: TableShape,
  inputs: readonly JudgeInput[],
): { readonly state: RowState; readonly judgements: readonly Judgement[] } {
  let state = emptyState(table);
  const judgements: Judgement[] = [];
  for (const input of inputs) {
    const r = judgeOp(state, input);
    judgements.push(r.judgement);
    state = r.state;
  }
  return { state, judgements };
}

function awaitingOf(state: RowState, input: ConfirmInput | RejectInput) {
  const xs = state.items.filter((x) => x.event === input.target && x.status === "awaiting");
  if (xs.length === 0 || state.resolvedAwaiting(input.target)) {
    throw new JudgeError("invalid", "no awaiting write to resolve", { target: input.target });
  }
  return xs;
}

/** Executes the proposal as recorded in the pending item (05-time «高影响写入»). */
function confirm(
  state: RowState,
  input: ConfirmInput,
  base: { op: number; index: number; event: Seq; ruleset: number; policy?: number },
): OpRecord {
  // The awaiting items keep their order (by start) per target; indices start from 0 again.
  const awaiting = [...awaitingOf(state, input)].sort(
    (a, b) => a.target.localeCompare(b.target) || a.k - b.k,
  );
  const items = awaiting.map((x) => ({
    target: x.target,
    k: awaiting.filter((y) => y.target === x.target && y.k < x.k).length,
    status: "applied" as const,
    valid: x.valid,
    content: x.content,
    // A value carries the proposed one (09 §5.7 `sources/…` `carried`); existence has no sources
    // (a revoke awaiting for its referrers, high impact ②): only its deps name the proposal.
    ...(x.target !== "existence" ? { carried: [refOf(x)] } : {}),
    deps: [refOf(x)],
  }));
  return { ...base, kind: "confirm", target: input.target, items };
}

/** A conflict resolution needs open candidates of the item on its unit. */
export function openCandidates(state: RowState, unit: Unit, candidates: readonly Seq[]): void {
  for (const e of candidates) {
    const mine = state.items.filter(
      (x) => x.event === e && x.status === "candidate" && state.inUnit(x, unit),
    );
    if (mine.length === 0 || mine.some((x) => state.closedCandidate(e, x.target))) {
      throw new JudgeError("invalid", "no open candidate in the item", { event: e });
    }
  }
}

/** The fields a first creation must give: the required ones, or else any field. */
function givesAll(state: RowState, event: Seq): boolean {
  const req = state.table.required;
  const gives = (f: FieldId) =>
    state.items.some((x) => x.event === event && x.target === f && effective(x.status));
  return req.length > 0 ? req.every(gives) : state.table.fields.some(gives);
}

/** The first write giving every required field in effect (03-deletion «首次创建标记»). */
function isFirstCreation(before: RowState, record: WriteRecord): boolean {
  const after = new RowState(before.table, [...before.records, record]);
  const earlier = before.records.some((r) => r.kind === "write" && givesAll(after, r.event));
  return !earlier && givesAll(after, record.event);
}

/**
 * The row or entity after its operations: values, gaps, existence, first creation. `also`: more
 * fields to give stretches for (a field no item gives any more, empty where the row exists).
 */
export function view(
  state: RowState,
  also: readonly FieldId[] = [],
  /** Stretches a no_value write-back leaves without a value name it (`noValueBy`), cut by it. */
  noValueGivers = false,
): RowView {
  const fieldIds = [
    ...new Set<FieldId>([
      ...state.table.required,
      ...state.table.valued,
      ...state.items.flatMap((x) => (x.target === "existence" ? [] : [x.target])),
      ...also,
    ]),
  ].sort();
  const fields: Partial<Record<FieldId, FieldStretch[]>> = {};
  let gaps: IntervalSet = [];
  let exists: boolean;
  const at = EVERYTHING;
  if (state.isState) {
    const segs = state.pieces();
    gaps = canonical(segs.filter((s) => !state.hasValue(s, at)));
    exists = segs.some((s) => state.hasValue(s, at));
    for (const f of fieldIds) {
      const out: FieldStretch[] = [];
      let last: { key: string; to: Interval["to"] } | undefined;
      for (const s of segs) {
        if (!state.hasValue(s, at)) {
          last = undefined;
          continue;
        }
        const st = state.fieldState(f, s, at);
        const nv = noValueGivers ? state.noValueBy(f, s, at) : undefined;
        const stretch: FieldStretch =
          st.kind === "value"
            ? { valid: [s], value: st.value, by: refOf(st.by) }
            : nv !== undefined
              ? { valid: [s], value: null, noValueBy: refOf(nv) }
              : { valid: [s], value: null };
        const key =
          st.kind === "value"
            ? `${valueToken(st.value)}|${refKey(refOf(st.by))}`
            : nv !== undefined
              ? `none|${refKey(refOf(nv))}`
              : "none";
        const prev = out[out.length - 1];
        if (prev !== undefined && last !== undefined && last.key === key && last.to === s.from) {
          out[out.length - 1] = { ...prev, valid: canonical([...prev.valid, s]) };
        } else {
          out.push(stretch);
        }
        last = { key, to: s.to };
      }
      fields[f] = out;
    }
  } else {
    const contributes = (f: FieldId, nonNull: boolean) =>
      state.items.some(
        (x) =>
          x.target === f &&
          effective(x.status) &&
          x.content.kind === "value" &&
          (!nonNull || x.content.value !== null),
      );
    exists =
      !state.revoked(at) &&
      state.table.valued.every((f) => contributes(f, false)) &&
      fieldIds.some((f) => contributes(f, true));
    if (exists) {
      for (const f of fieldIds) {
        const st = state.fieldState(f, WHOLE, at);
        const nv = noValueGivers ? state.noValueBy(f, WHOLE, at) : undefined;
        fields[f] = [
          st.kind === "value"
            ? { valid: [WHOLE], value: st.value, by: refOf(st.by) }
            : nv !== undefined
              ? { valid: [WHOLE], value: null, noValueBy: refOf(nv) }
              : { valid: [WHOLE], value: null },
        ];
      }
    }
  }
  const created = state.records.find((r) => r.kind === "write" && givesAll(state, r.event))?.event;
  return { kind: state.table.kind, exists, gaps, fields, created };
}
