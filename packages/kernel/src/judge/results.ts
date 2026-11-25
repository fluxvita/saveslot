// What a deletion event says of one row or entity (docs/zh-CN/spec/09-event-format.md §5.9
// `results/<k>/…`, «列哪些»; `recreated/<k>`): the stretches of its fields after the replay that
// changed or rest on restated items, the gaps on a state table, and the first-creation marker.
//
// Pure: the states before and after the replay, and the replay's restatements. The outcome is
// worked out separately (`outcomeOf`).

import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import {
  canonical,
  type Interval,
  type IntervalSet,
  isNothing,
  meet,
  WHOLE,
} from "../time/index.ts";
import { view } from "./judge.ts";
import type { ItemRef, Restatement } from "./model.ts";
import { uniqueRefs } from "./resolve.ts";
import { EVERYTHING, type RowState, refKey, refOf } from "./state.ts";

/** One stretch of a field after the replay (`results/<k>/fields/<f>/<j>`), without the row. */
export interface Stretch {
  readonly field: FieldId;
  readonly j: number;
  /** `null`: nothing gives it, or an explicit clearing (then `carried` names the clearing). */
  readonly value: FieldValue | null;
  readonly carried: readonly ItemRef[];
  /** State tables only. */
  readonly valid?: IntervalSet;
  readonly deps: readonly ItemRef[];
}

export interface RowResult {
  /** Whether the row or entity is listed at all. */
  readonly listed: boolean;
  readonly existedBefore: boolean;
  readonly existsAfter: boolean;
  readonly stretches: readonly Stretch[];
  /** State tables, when listed: every gap after the replay and what it rests on. */
  readonly gaps?: { readonly gaps: IntervalSet; readonly deps: readonly ItemRef[] };
  /** `recreated/<k>`: the first-creation marker, where it changed. */
  readonly recreated: readonly { readonly event: number; readonly created: boolean }[];
}

/** On a state table: a field's state piece by piece, as (value token, giver). */
function pieceState(state: RowState, f: FieldId, s: Interval): string {
  if (!state.hasValue(s, EVERYTHING)) return "gap";
  const st = state.fieldState(f, s, EVERYTHING);
  const nv = state.noValueBy(f, s, EVERYTHING);
  return st.kind === "value"
    ? `v:${JSON.stringify(st.value)}|${refKey(refOf(st.by))}`
    : st.kind === "hole"
      ? `hole|${refKey(refOf(st.by))}`
      : nv !== undefined
        ? `none|${refKey(refOf(nv))}`
        : "none";
}

/** What gives a field its state on a piece, a no_value write-back included; none: nothing. */
function giverOn(state: RowState, f: FieldId, s: Interval): ItemRef | undefined {
  const st = state.fieldState(f, s, EVERYTHING);
  if (st.kind === "value" || st.kind === "hole") return refOf(st.by);
  const nv = state.noValueBy(f, s, EVERYTHING);
  return nv === undefined ? undefined : refOf(nv);
}

/**
 * What cuts a stretch where it is (09 §5.9 «段的定义», §3.5 the contributions giving a blocking
 * point): at each end, every contribution in effect with an end of its interval there, on the same
 * field or on existence, on both sides, covered ones included; where the end is a boundary between
 * a value and none (a required field without a value on one side), also those on the fields that
 * decide "has a value". With them, the givers of the neighbouring stretches there (a no_value
 * write-back, the revoke leaving a hole).
 */
function endGivers(state: RowState, f: FieldId, valid: IntervalSet): ItemRef[] {
  const out: ItemRef[] = [];
  const segs = state.pieces([valid]);
  const valued = state.table.valued.length > 0 ? state.table.valued : state.table.fields;
  const endingAt = (p: string, targets: readonly string[]) =>
    state.items
      .filter(
        (x) =>
          (x.status === "applied" || x.status === "corroborated") &&
          targets.includes(x.target) &&
          x.valid.some((v) => v.from === p || v.to === p),
      )
      .map(refOf);
  for (const v of valid) {
    for (const [p, side] of [
      [v.from, -1],
      [v.to, 0],
    ] as const) {
      if (p === null) continue;
      const n = segs.find((s) => (side === 0 ? s.from === p : s.to === p));
      const inner = segs.find((s) => (side === 0 ? s.to === p : s.from === p));
      const boundary =
        n !== undefined &&
        inner !== undefined &&
        state.hasValue(inner, EVERYTHING) !== state.hasValue(n, EVERYTHING);
      out.push(...endingAt(p, [f, "existence", ...(boundary ? valued : [])]));
      for (const r of boundary ? [f, ...valued] : [f]) {
        for (const s of [inner, n]) {
          const g = s === undefined ? undefined : giverOn(state, r, s);
          if (g !== undefined && (r === f ? s === n : true)) out.push(g);
        }
      }
    }
  }
  return out;
}

/**
 * The result of one row or entity (09 §5.9 «列哪些»). `before`: the state before this deletion
 * (with the deletions still pending before it); `after`: the replay's. `restated`: the replay's
 * restatements. `existenceTouched`: the intervals of existence items deleted or restated and of
 * write-backs that only register restated, before and after (their union); with any, the row is
 * listed and, on a state table, every stretch meeting them.
 */
export function rowResult(
  before: RowState,
  after: RowState,
  restated: readonly Restatement[],
  existenceTouched: IntervalSet | undefined,
): RowResult {
  const vb = view(before, [], true);
  // Every field the row had before, also one no item gives any more (empty after).
  const va = view(after, Object.keys(vb.fields) as FieldId[], true);
  const restatedRefs = new Set(
    restated.filter((r) => r.status !== "dropped").map((r) => refKey(r.item)),
  );
  // The giver of existence changed: the creating contribution gone, the row kept by others.
  const creatorChanged = vb.created !== va.created && va.exists;
  const recreated =
    vb.created === va.created
      ? []
      : [
          ...(vb.created !== undefined ? [{ event: vb.created, created: false }] : []),
          ...(va.created !== undefined ? [{ event: va.created, created: true }] : []),
        ];
  const fields = [
    ...new Set([...Object.keys(vb.fields), ...Object.keys(va.fields)]),
  ].sort() as FieldId[];
  const stretches: Stretch[] = [];
  if (va.exists) {
    for (const f of fields) {
      const now = va.fields[f] ?? [];
      now.forEach((x, j) => {
        const changed = after.isState
          ? after
              // Cut where either state changes, so that a boundary only one has is seen.
              .pieces([x.valid, ...before.items.map((i) => i.valid)])
              .filter((s) => x.valid.some((v) => meet([v], [s]).length > 0))
              .some((s) => pieceState(after, f, s) !== pieceState(before, f, s))
          : JSON.stringify(x) !== JSON.stringify((vb.fields[f] ?? [])[j]);
        // The giver: a value's, or a no_value write-back's (listed with `value` null, no sources,
        // and named in its deps: 09 §5.9 «列哪些»).
        const giver = x.by ?? x.noValueBy;
        const fromRestated = giver !== undefined && restatedRefs.has(refKey(giver));
        const touched =
          existenceTouched !== undefined &&
          (!after.isState || !isNothing(meet(x.valid, existenceTouched)));
        if (!(changed || fromRestated || touched || creatorChanged)) return;
        const carried = x.by !== undefined ? [x.by] : [];
        stretches.push({
          field: f,
          j: after.isState ? j : 0,
          value: x.value,
          carried,
          ...(after.isState
            ? {
                valid: x.valid,
                deps: uniqueRefs([
                  ...carried,
                  ...(x.noValueBy !== undefined ? [x.noValueBy] : []),
                  ...endGivers(after, f, x.valid),
                ]),
              }
            : { deps: [] }),
        });
      });
    }
  }
  // State tables: a stretch that became a gap, or a gap that got a value, has no stretch of its
  // own on one side to be seen changed above; the entity differs all the same, and the gaps are
  // given with `existence` (09 §5.9 «列哪些»).
  const gapsChanged =
    after.isState && JSON.stringify(canonical(vb.gaps)) !== JSON.stringify(canonical(va.gaps));
  // A piece given before (a value, a revoke leaving a hole, or a no_value write-back, in a gap as
  // well) that nothing gives after, or that another gives: no stretch after to be seen changed
  // above, the field's giver changed all the same (09 §5.9 «列哪些»: a field whose value or giver
  // differs). Listed, with no stretch of its own: apply's «没列到的段保持原样» check looks only
  // outside the stretches listed and the result's gaps, and outside a gap a piece given no value
  // reads as one given nothing (apply/deletion.ts, `planRows`, the check "the other way").
  // State tables only: on an event or timeless table the view gives after every field the row had
  // before, one stretch each, and the loop above compares it with the one before already.
  // Also where the entity exists neither before nor after: apply settles its cells all the same
  // (09 §5.9 «列哪些»; the exemption for a row there neither before nor after is an event or
  // timeless table's only).
  const givenBeforeChanged =
    before.isState &&
    fields.some((f) =>
      before
        .pieces([...before.items.map((i) => i.valid), ...after.items.map((i) => i.valid)])
        .some((s) => {
          const b = giverOn(before, f, s);
          const a = giverOn(after, f, s);
          return b !== undefined && (a === undefined || refKey(a) !== refKey(b));
        }),
    );
  const listed =
    stretches.length > 0 ||
    givenBeforeChanged ||
    vb.exists !== va.exists ||
    existenceTouched !== undefined ||
    recreated.length > 0 ||
    gapsChanged;
  const gaps =
    listed && after.isState
      ? {
          gaps: va.gaps,
          deps: uniqueRefs(
            va.gaps.flatMap((g) => [
              ...after.piecesIn([g]).flatMap((s) =>
                after.table.required.flatMap((r) => {
                  const h = after.fieldState(r, s, EVERYTHING);
                  return h.kind === "hole" ? [refOf(h.by)] : [];
                }),
              ),
              ...after.table.required.flatMap((r) => endGivers(after, r, [g])),
            ]),
          ),
        }
      : undefined;
  return {
    listed,
    existedBefore: vb.exists,
    existsAfter: va.exists,
    stretches,
    ...(gaps !== undefined ? { gaps } : {}),
    recreated,
  };
}

/** The whole time, for an event or timeless table's existence touched. */
export const ALL_TIME: IntervalSet = canonical([WHOLE]);

export type Outcome =
  | "deleted"
  | "kept_fields_cleared"
  | "fields_reverted"
  | "resegmented"
  | "sources_changed";

/** A field's values along the row, givers left out: what a reader sees of it. */
function valuesOf(state: RowState, f: FieldId): string {
  const v = view(state);
  if (!v.exists) return "absent";
  const out: { valid: Interval[]; value: string }[] = [];
  for (const x of v.fields[f] ?? []) {
    const value = JSON.stringify(x.value);
    const last = out[out.length - 1];
    const first = x.valid[0];
    if (
      last !== undefined &&
      last.value === value &&
      first !== undefined &&
      last.valid[last.valid.length - 1]?.to === first.from
    ) {
      last.valid.push(...x.valid);
    } else {
      out.push({ valid: [...x.valid], value });
    }
  }
  return JSON.stringify(out.map((x) => [canonical(x.valid), x.value]));
}

/**
 * The outcome of a listed row (09 §5.9 `outcome`), the first that holds: `deleted` (it existed
 * before, not after); `kept_fields_cleared` (a field with a value before has none anywhere after);
 * `fields_reverted` (an event or timeless table whose values changed, or a row that exists only
 * after); `resegmented` (a state table whose values or their stretches changed, gaps included);
 * `sources_changed` (values the same: listed for its givers or restatements).
 */
export function outcomeOf(r: RowResult, before: RowState, after: RowState): Outcome {
  if (r.existedBefore && !r.existsAfter) return "deleted";
  if (!r.existedBefore && r.existsAfter) return "fields_reverted";
  const vb = view(before);
  const va = view(after);
  const fields = [...new Set([...Object.keys(vb.fields), ...Object.keys(va.fields)])] as FieldId[];
  const hasValue = (v: typeof vb, f: FieldId) => (v.fields[f] ?? []).some((x) => x.value !== null);
  if (fields.some((f) => hasValue(vb, f) && !hasValue(va, f))) return "kept_fields_cleared";
  const valuesChanged =
    fields.some((f) => valuesOf(before, f) !== valuesOf(after, f)) ||
    JSON.stringify(vb.gaps) !== JSON.stringify(va.gaps);
  if (!after.isState && valuesChanged) return "fields_reverted";
  if (after.isState && valuesChanged) return "resegmented";
  return "sources_changed";
}
