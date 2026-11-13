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
  ConfirmInput,
  FieldStretch,
  JudgeInput,
  Judgement,
  KeepEffectiveInput,
  OpRecord,
  RejectInput,
  RowView,
  TableShape,
  WriteRecord,
} from "./model.ts";
import { EVERYTHING, effective, RowState, refKey, refOf, valueToken } from "./state.ts";
import { judgeRevoke, judgeWrite } from "./write.ts";

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
} as const;

/** Judges one operation on the state; returns the judgement and the state after it. */
export function judgeOp(
  state: RowState,
  input: JudgeInput,
): { readonly judgement: Judgement; readonly state: RowState } {
  checkVersion(input.ruleset);
  const base = { op: input.op, index: input.index, event: input.event, ruleset: input.ruleset };
  let judgement: Judgement;
  if (input.kind === "write" || input.kind === "revoke") {
    const out = input.kind === "write" ? judgeWrite(state, input) : judgeRevoke(state, input);
    const record: WriteRecord = {
      ...base,
      kind: input.kind,
      seen: input.seen,
      seenExplicit: input.seenExplicit,
      ...(input.valid !== undefined ? { valid: input.valid } : {}),
      now: input.now,
      ...(input.kind === "write" && input.acknowledge ? { acknowledge: true as const } : {}),
      explicit:
        input.kind === "write"
          ? (Object.keys(input.fields) as FieldId[]).filter((f) => input.fields[f]?.explicit).sort()
          : [],
      items: out.items,
      noop: out.noop,
      ack: out.acknowledged ? out.overwritten : [],
    };
    const { items: _, noop: __, ...rest } = out;
    judgement = {
      record,
      ...rest,
      created: input.kind === "write" && isFirstCreation(state, record),
    };
  } else if (input.kind === "confirm") {
    judgement = { record: confirm(state, input, base), ...quiet };
  } else if (input.kind === "reject") {
    awaitingOf(state, input);
    judgement = { record: { ...base, kind: "reject", target: input.target }, ...quiet };
  } else {
    keepEffective(state, input);
    judgement = {
      record: { ...base, kind: "keep_effective", unit: input.unit, candidates: input.candidates },
      ...quiet,
    };
  }
  return { judgement, state: new RowState(state.table, [...state.records, judgement.record]) };
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
  base: { op: number; index: number; event: Seq; ruleset: number },
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
    carried: [refOf(x)],
    deps: [refOf(x)],
  }));
  return { ...base, kind: "confirm", target: input.target, items };
}

function keepEffective(state: RowState, input: KeepEffectiveInput): void {
  for (const e of input.candidates) {
    const has = state.items.some(
      (x) =>
        x.event === e &&
        x.status === "candidate" &&
        (input.unit === "existence"
          ? x.target === "existence"
          : x.target !== "existence" && input.unit.fields.includes(x.target)),
    );
    if (
      !has ||
      state.closedCandidate(
        e,
        input.unit === "existence" ? "existence" : (input.unit.fields[0] as FieldId),
      )
    ) {
      throw new JudgeError("invalid", "no open candidate to keep out", { event: e });
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

/** The row or entity after its operations: values, gaps, existence, first creation. */
export function view(state: RowState): RowView {
  const fieldIds = [
    ...new Set<FieldId>([
      ...state.table.required,
      ...state.table.valued,
      ...state.items.flatMap((x) => (x.target === "existence" ? [] : [x.target])),
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
        const stretch: FieldStretch =
          st.kind === "value"
            ? { valid: [s], value: st.value, by: refOf(st.by) }
            : { valid: [s], value: null };
        const key =
          st.kind === "value" ? `${valueToken(st.value)}|${refKey(refOf(st.by))}` : "none";
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
        fields[f] = [
          st.kind === "value"
            ? { valid: [WHOLE], value: st.value, by: refOf(st.by) }
            : { valid: [WHOLE], value: null },
        ];
      }
    }
  }
  const created = state.records.find((r) => r.kind === "write" && givesAll(state, r.event))?.event;
  return { kind: state.table.kind, exists, gaps, fields, created };
}
