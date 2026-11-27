// What a pending item holds and when a write reaches it (docs/zh-CN/spec/03-data-model/01-objects.md
// «待处理事项», «不过期：合并、取代与刷新»; 09-event-format.md §5.8): pure functions over a row's
// state. `write` puts them into the item events; `pending` keeps the items.
//
// - `unitEntries`: a unit's state on the item's interval at a position in the log, stretch by
//   stretch: the value of each field of the unit (`current/<k>`, `previous/<k>`), or, on the unit
//   "existence", the revoked stretches and the stretches with a value.
// - `conflictImpact`, `awaitingImpact`, `proposalImpact`: what carrying the item out would change
//   (`impact/<k>`).
// - `reaches`: whether an operation changed what is in effect on an item's unit within its
//   interval: the conflict criterion's "改到" (candidates and awaiting parts change nothing).

import type { FieldId, FieldValue, OpNumber } from "@fluxvita/saveslot-contract-core";
import { sameValue } from "../delta/index.ts";
import { canonical, type Interval, type IntervalSet, WHOLE } from "../time/index.ts";
import type { ItemRef, Judgement, Unit } from "./model.ts";
import { changedResults } from "./result.ts";
import { undoResult } from "./revert.ts";
import { effective, type Limit, type RowState, refKey, refOf } from "./state.ts";
import { overwrittenBy } from "./write.ts";

/** One stretch of a unit on the item's interval (09 §5.8 `current/<k>`, `previous/<k>`). */
export type UnitEntry =
  | {
      readonly field: FieldId;
      readonly value: FieldValue;
      /** State tables only. */
      readonly valid?: Interval;
      /** The operation that wrote the value; none where no write ever gave the field a state. */
      readonly op?: OpNumber;
      readonly deps: readonly ItemRef[];
    }
  | {
      readonly field: "existence";
      readonly revoked: true;
      readonly valid?: Interval;
      /** The revoke. */
      readonly op: OpNumber;
      readonly deps: readonly ItemRef[];
    }
  | {
      /** A stretch with a value: `deps` the contributions giving it one. */
      readonly field: "existence";
      readonly revoked?: never;
      readonly valid?: Interval;
      readonly deps: readonly ItemRef[];
    };

/** An entry of `impact/<k>` (09 §5.8). */
export type ImpactEntry =
  | {
      readonly kind: "overwritten_segment";
      readonly field: FieldId;
      readonly valid?: Interval;
      readonly value: FieldValue;
      /**
       * A stretch without a value: a gap the write fills. A value cleared to null is a value, not a
       * gap (09 §5.8).
       */
      readonly gap?: true;
      /** The write that gave the stretch; on a gap, the revoke that left it, if one did. */
      readonly op?: OpNumber;
      readonly deps: readonly ItemRef[];
    }
  | { readonly kind: "reverted_write"; readonly op: OpNumber; readonly deps: readonly ItemRef[] };

const uniq = (xs: readonly ItemRef[]): ItemRef[] => {
  const seen = new Map<string, ItemRef>();
  for (const x of xs) seen.set(refKey(x), x);
  return [...seen.values()].sort(
    (a, b) => a.event - b.event || a.target.localeCompare(b.target) || a.k - b.k,
  );
};

/** The contributions that cut a stretch where it is: those giving a blocking point at its ends. */
function cutters(state: RowState, f: FieldId | "any", v: Interval, at: Limit): ItemRef[] {
  if (!state.isState) return [];
  return [v.from, v.to].flatMap((p) => (p === null ? [] : state.givers(p, f, at)));
}

/**
 * The unit's stretches on `scope` (WHOLE on event and timeless tables) as of `at`, each with the
 * contributions its value and ends come from. `scopeDeps`: what gives the scope's own ends (the
 * candidates or proposal), counted where a stretch ends at the scope's edge.
 */
export function unitEntries(
  state: RowState,
  unit: Unit,
  scope: IntervalSet,
  at: Limit,
  scopeDeps: readonly ItemRef[] = [],
): UnitEntry[] {
  const area = state.isState ? scope : [WHOLE];
  const pieces = state.isState ? state.piecesIn(area) : [WHOLE];
  const atEdge = (v: Interval) =>
    state.isState && area.some((a) => a.from === v.from || a.to === v.to) ? [...scopeDeps] : [];
  const out: UnitEntry[] = [];
  if (unit === "existence") {
    // A revoked stretch: a revoke is what a field defining "has a value" takes its state from (on
    // event and timeless tables, the row's revoke). A stretch with a value: the defining fields'
    // values give it. A stretch neither has no value, and not from a revoke: no entry.
    type Run = { valid: Interval; key: string; op?: OpNumber; by: ItemRef[] };
    const runs: Run[] = [];
    const defining = state.table.valued.length > 0 ? state.table.valued : state.table.fields;
    for (const seg of pieces) {
      const states = defining.map((f) => state.fieldState(f, seg, at));
      const h = states.find((x) => x.kind === "hole");
      let run: Run | undefined;
      if (h !== undefined && h.kind === "hole") {
        run = { valid: seg, key: `r:${refKey(refOf(h.by))}`, op: h.by.op, by: [refOf(h.by)] };
      } else if (state.isState ? state.hasValue(seg, at) : !state.revoked(at)) {
        const by = uniq(states.flatMap((x) => (x.kind === "value" ? [refOf(x.by)] : [])));
        run = { valid: seg, key: `v:${by.map(refKey).join(",")}`, by };
      }
      if (run === undefined) continue;
      const last = runs.at(-1);
      if (last !== undefined && last.valid.to === seg.from && last.key === run.key) {
        last.valid = { from: last.valid.from, to: seg.to };
      } else runs.push(run);
    }
    for (const r of runs) {
      const deps = uniq([...r.by, ...cutters(state, "any", r.valid, at), ...atEdge(r.valid)]);
      const valid = state.isState ? { valid: r.valid } : {};
      out.push(
        r.op !== undefined
          ? { field: "existence", revoked: true, ...valid, op: r.op, deps }
          : { field: "existence", ...valid, deps },
      );
    }
    return out;
  }
  for (const f of [...unit.fields].sort()) {
    type Run = { valid: Interval; value: FieldValue; op?: OpNumber; by?: ItemRef };
    const runs: Run[] = [];
    for (const seg of pieces) {
      // Where a state table's entity has no value, no field has one (as reads show it).
      const raw = state.fieldState(f, seg, at);
      const s =
        state.isState && raw.kind === "value" && !state.hasValue(seg, at)
          ? { kind: "none" as const }
          : raw;
      const run: Run =
        s.kind === "value"
          ? { valid: seg, value: s.value, op: s.by.op, by: refOf(s.by) }
          : s.kind === "hole"
            ? { valid: seg, value: null, op: s.by.op, by: refOf(s.by) }
            : { valid: seg, value: null };
      const last = runs.at(-1);
      if (
        last !== undefined &&
        last.valid.to === seg.from &&
        sameValue(last.value, run.value) &&
        (last.by === undefined
          ? run.by === undefined
          : run.by !== undefined && refKey(last.by) === refKey(run.by))
      ) {
        last.valid = { from: last.valid.from, to: seg.to };
      } else runs.push(run);
    }
    for (const r of runs) {
      out.push({
        field: f,
        value: r.value,
        ...(state.isState ? { valid: r.valid } : {}),
        ...(r.op !== undefined ? { op: r.op } : {}),
        deps: uniq([
          ...(r.by !== undefined ? [r.by] : []),
          ...cutters(state, f, r.valid, at),
          ...atEdge(r.valid),
        ]),
      });
    }
  }
  return out;
}

/** The item's interval on a state table: the union of its candidates' (or proposal's) items. */
export function scopeOf(state: RowState, refs: readonly ItemRef[]): IntervalSet {
  const keys = new Set(refs.map(refKey));
  return canonical(state.items.filter((x) => keys.has(refKey(refOf(x)))).flatMap((x) => x.valid));
}

/**
 * What confirming a revert proposal would do, from the judgement of that confirmation on the state
 * now (09 §5.8 `scope_valid`): the union of its write-backs' intervals; the contributions that come
 * from, the proposal's items and those of every entry it takes back (the interval depends on what
 * they are now). Empty when it would write nothing.
 */
export function revertScope(
  state: RowState,
  j: Judgement,
  proposal: readonly ItemRef[],
): { readonly valid: IntervalSet; readonly deps: ItemRef[] } {
  const r = j.record;
  const entries = r.kind === "confirm" ? (r.revert?.entries ?? []) : [];
  const items = r.kind === "confirm" ? r.items : [];
  const taken = state.items
    .filter((x) => entries.some((e) => e.event === x.event && e.target === x.target))
    .map(refOf);
  return {
    valid: canonical(items.flatMap((x) => x.valid)),
    deps: uniq([...proposal, ...taken]),
  };
}

/**
 * A conflict item's impact (09 §5.8): the stretches a candidate would overwrite (what is in effect
 * where its items lie), and the later writes whose result a reader would see change if the item
 * went back to its merge base (`take_previous`; 03-data-model/04-write-and-read «撤回某次写入
 * （undo）», the impact by what a reader sees): the row with that take_previous judged now, `after`,
 * against the row now, the writes after the merge base, in its unit or not. No `after` (the
 * take_previous cannot be judged now): none listed.
 */
export function conflictImpact(
  state: RowState,
  mergeBase: OpNumber,
  candidateRefs: readonly ItemRef[],
  at: Limit,
  after?: { readonly state: RowState; readonly at: Limit; readonly afterAt: Limit },
): ImpactEntry[] {
  const reverted: ImpactEntry[] =
    after === undefined
      ? []
      : [...changedResults(state, after.at, after.state, after.afterAt, mergeBase)]
          .sort(([a], [b]) => a - b)
          .map(([op, deps]) => ({ kind: "reverted_write", op, deps: uniq(deps) }));
  return [...candidateImpact(state, candidateRefs, at), ...reverted];
}

/** A stretch a write would overwrite, as an impact entry (a stretch without a value: a gap filled). */
function segmentsOf(state: RowState, x: Parameters<typeof overwrittenBy>[1], at: Limit) {
  return overwrittenBy(state, x, at).flatMap((o): ImpactEntry[] => {
    if (o.was.kind !== "value" && o.was.kind !== "no_value") return [];
    const was = o.was;
    return (state.isState ? o.valid : [WHOLE]).map((v) => ({
      kind: "overwritten_segment",
      field: o.field,
      ...(state.isState ? { valid: v } : {}),
      value: was.kind === "value" ? was.value : null,
      // A stretch without a value is a gap filled; a value cleared to null is a value.
      ...(was.kind === "no_value" ? { gap: true as const } : {}),
      ...(was.op !== undefined ? { op: was.op } : {}),
      deps: uniq(o.deps),
    }));
  });
}

/**
 * What taking a candidate would overwrite, when that would be high impact (01-objects «影响»:
 * 候选若生效会属高影响时): its items put into effect after `at` would erase a change point of the
 * state as of `at` (05-time «高影响写入» ①, the same test the judge makes of a write). Only state
 * tables have change points.
 */
export function candidateImpact(
  state: RowState,
  refs: readonly ItemRef[],
  at: Limit,
): ImpactEntry[] {
  if (!state.isState) return [];
  const keys = new Set(refs.map(refKey));
  const all = state.items.filter(
    (x) => keys.has(refKey(refOf(x))) && x.target !== "existence" && x.content.kind === "value",
  );
  // Candidate by candidate: one write's items in the item.
  const byCandidate = new Map<number, typeof all>();
  for (const x of all) byCandidate.set(x.event, [...(byCandidate.get(x.event) ?? []), x]);
  const after = (at.upTo + 1) as OpNumber;
  return [...byCandidate.values()].flatMap((items) => {
    const taken = state.with(items.map((x) => ({ ...x, op: after, status: "applied" as const })));
    const erases = state.table.fields.some(
      (f) => state.erasedOf(f, state.impactPoints(f, at), at, taken, { upTo: after }).length > 0,
    );
    if (!erases) return [];
    // Each stretch names the candidate item that would overwrite it among its deps, so a reader
    // tells which candidate's impact it is (04-contract-types `candidate_impact`).
    return items.flatMap((x) =>
      segmentsOf(state, x, at).map((e) => ({ ...e, deps: uniq([...e.deps, refOf(x)]) })),
    );
  });
}

/**
 * An awaiting item's impact recomputed as of `at` (01-objects «影响不会悄悄过期»): the stretches
 * its proposal would overwrite now, and of the writes it would take back (`reverted`, as given
 * before) those with something still in effect on the row.
 */
export function proposalImpact(
  state: RowState,
  refs: readonly ItemRef[],
  reverted: readonly { readonly op: OpNumber; readonly deps: readonly ItemRef[] }[],
  at: Limit,
): ImpactEntry[] {
  const keys = new Set(refs.map(refKey));
  const proposal = state.items.filter(
    (x) => keys.has(refKey(refOf(x))) && x.target !== "existence",
  );
  const segments = proposal.flatMap((x) => segmentsOf(state, { ...x, status: "applied" }, at));
  const live = reverted.flatMap((r): ImpactEntry[] => {
    const own = state.items
      .filter((x) => x.op === r.op && effective(x.status) && state.sees(x, at))
      .map(refOf);
    return own.length === 0
      ? []
      : [{ kind: "reverted_write", op: r.op, deps: uniq([...r.deps, ...own]) }];
  });
  return [...segments, ...live];
}

/**
 * An awaiting item's impact (09 §5.8): the stretches the write would overwrite (high impact ①)
 * and the later writes an `undo` would take back or hide (④).
 */
export function awaitingImpact(state: RowState, j: Judgement): ImpactEntry[] {
  const out: ImpactEntry[] = [];
  for (const o of j.overwritten) {
    // A stretch without a value is a gap the write fills (04-contract-types `filled_gaps`); a
    // value cleared to null is overwritten like any other.
    if (o.was.kind !== "value" && o.was.kind !== "no_value") continue;
    const was = o.was;
    for (const v of o.valid) {
      out.push({
        kind: "overwritten_segment",
        field: o.field,
        ...(state.isState ? { valid: v } : {}),
        value: was.kind === "value" ? was.value : null,
        ...(was.kind === "no_value" ? { gap: true as const } : {}),
        ...(was.op !== undefined ? { op: was.op } : {}),
        deps: uniq(o.deps),
      });
    }
  }
  // The later writes whose result a reader would see change once the revert takes effect, in the
  // undo's record or not (04-write-and-read «撤回某次写入（undo）»): taken back, hidden, or given
  // up as the write-backs cover them. A write whose contribution is taken back while the result
  // stays the same is not listed; its items are the ones whose result changes.
  // What confirming does is the undo's own write-backs: an item refreshed judges the undo again
  // now (`awaitingImpactNow`), and that lists the revert as the confirmation would, with the same
  // write-backs (both list it as of the state now, numbered after every event of the row).
  const rec = j.record;
  if (rec.kind !== "undo" || rec.revert.before === undefined) return out;
  const r = undoResult(state, rec, { entries: rec.revert.entries, before: rec.revert.before });
  const later = changedResults(state, r.at, r.after, r.afterAt, rec.revert.before);
  for (const [op, deps] of [...later].sort(([a], [b]) => a - b)) {
    out.push({ kind: "reverted_write", op, deps: uniq(deps) });
  }
  return out;
}

/**
 * Whether what is in effect on `unit` within `scope` differs between two positions of the log
 * (01-objects «不过期»: "改到" by the conflict criterion, on the item's unit only): an op of a
 * request, from just before it to just after it. On a unit of fields, a field's state on some
 * stretch; on the unit "existence", whether some stretch went between having a value and not
 * (event and timeless tables: whether the row became revoked or not).
 */
export function reaches(
  state: RowState,
  before: Limit,
  after: Limit,
  unit: Unit,
  scope: IntervalSet,
): boolean {
  const area = state.isState ? scope : [WHOLE];
  if (unit === "existence") {
    if (!state.isState) return state.revoked(before) !== state.revoked(after);
    return state
      .piecesIn(area)
      .some((seg) => state.hasValue(seg, before) !== state.hasValue(seg, after));
  }
  const pieces = state.isState ? state.piecesIn(area) : [WHOLE];
  return unit.fields.some((f) =>
    pieces.some((seg) => state.token(f, seg, before) !== state.token(f, seg, after)),
  );
}
