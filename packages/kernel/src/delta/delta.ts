// Which fields of a target differ between two states, and how (docs/zh-CN/spec/03-data-model/
// 02-integrity-and-records.md «写入的前提 · 检测», the same-value criterion).

import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { sameValue } from "./same-value.ts";
import type {
  BizTime,
  Change,
  ComparedDelta,
  EntitySegment,
  FieldDelta,
  Presence,
  Range,
  SourceKey,
  Stretch,
  TargetState,
} from "./types.ts";

/** A side's value of a field: undefined when that side has no value there (not an empty value). */
type Side = { value: FieldValue; source: SourceKey } | undefined;

/**
 * How one field differs. Two sides with a value compare by value, then by source. A side with no
 * value against one with: a `value` change, except that an empty value (`null`) against no value is
 * nothing a field can show, since a revoke or a creation says it by `existence` or by the field's
 * own value. Neither side has a value: no change.
 */
function judge(b: Side, a: Side): Change {
  if (b === undefined && a === undefined) return "none";
  if (b === undefined || a === undefined) {
    const there = (b ?? a) as { value: FieldValue };
    return there.value === null ? "none" : "value";
  }
  return !sameValue(b.value, a.value) ? "value" : b.source !== a.source ? "source_only" : "none";
}

/** Whether two sides of a stretch hold the same: both without a value, or both with the same one. */
const sameSide = (x: FieldValue | undefined, y: FieldValue | undefined): boolean =>
  x === undefined || y === undefined ? x === y : sameValue(x, y);

/** The members of `v` that are there: `{ before }` is not given for a side with no value. */
const given = (before: Side, after: Side) => ({
  ...(before === undefined ? {} : { before: before.value }),
  ...(after === undefined ? {} : { after: after.value }),
});

/** IDs in numeric order: `f2` before `f10`. */
const byName = (x: string, y: string): number =>
  x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);

const within = (xs: readonly Range[], p: BizTime): boolean =>
  xs.some((x) => x.from <= p && (x.to === null || p < x.to));

/** The business time points where a segment or a revoke of either side may start or end. */
const pointsOf = (...lists: readonly (readonly Range[])[]): BizTime[] =>
  [
    ...new Set(lists.flatMap((l) => l.flatMap((s) => (s.to === null ? [s.from] : [s.from, s.to])))),
  ].sort();

const segmentAt = (segs: readonly EntitySegment[], p: BizTime): EntitySegment | undefined =>
  segs.find((s) => s.from <= p && (s.to === null || p < s.to));

/** The stretches of one field of an entity where the sides differ: cut small, then run together. */
function stretchesOf(
  field: FieldId,
  before: readonly EntitySegment[],
  after: readonly EntitySegment[],
  points: readonly BizTime[],
): Stretch[] {
  const side = (segs: readonly EntitySegment[], p: BizTime): Side => {
    const s = segmentAt(segs, p);
    return s === undefined
      ? undefined
      : { value: s.values[field] as FieldValue, source: s.source[field] ?? "" };
  };
  const out: Stretch[] = [];
  for (const [i, from] of points.entries()) {
    const [b, a] = [side(before, from), side(after, from)];
    const change = judge(b, a);
    if (change === "none") continue;
    const to = points[i + 1] ?? null;
    const last = out.at(-1);
    // Re-cutting alone is not a change: the pieces with one conclusion and the same values on
    // both sides are one stretch.
    if (
      last !== undefined &&
      last.to === from &&
      last.change === change &&
      sameSide(last.before, b?.value) &&
      sameSide(last.after, a?.value)
    )
      out[out.length - 1] = { ...last, to };
    else out.push({ from, to, change: change as Stretch["change"], ...given(b, a) });
  }
  return out;
}

type EntityState = Extract<TargetState, { kind: "entity" }>;

/** A stretch's presence: a segment is `live`, a revoke in effect is `revoked`, else `absent`. */
const presenceAt = (e: EntityState, p: BizTime): Presence =>
  segmentAt(e.segments, p) !== undefined ? "live" : within(e.revoked, p) ? "revoked" : "absent";

/** `existence` for a presence: not given for `absent`; true for `live`, false for `revoked`. */
const there = (p: Presence) => (p === "absent" ? {} : { value: p === "live" });

/** The stretches where the presence of the two sides differs, runs of one change together. */
function existenceStretches(
  before: EntityState,
  after: EntityState,
  points: readonly BizTime[],
): Stretch[] {
  const out: Stretch[] = [];
  let last: { bp: Presence; ap: Presence } | undefined;
  for (const [i, from] of points.entries()) {
    const [bp, ap] = [presenceAt(before, from), presenceAt(after, from)];
    if (bp === ap) continue;
    const to = points[i + 1] ?? null;
    const tail = out.at(-1);
    const [b, a] = [there(bp).value, there(ap).value];
    if (tail !== undefined && tail.to === from && last?.bp === bp && last?.ap === ap)
      out[out.length - 1] = { ...tail, to };
    else
      out.push({
        from,
        to,
        change: "value",
        ...(b === undefined ? {} : { before: b }),
        ...(a === undefined ? {} : { after: a }),
      });
    last = { bp, ap };
  }
  return out;
}

/**
 * The fields, and `existence`, that differ between two states of one target, `existence` first and
 * then the fields in the order of their IDs; only those with a change (`none` is not listed).
 * `before` and `after` are the applied values of the version table: a candidate or an awaiting item
 * is not in it, so it is not a change; after its resolution the change belongs to the resolving
 * operation. A side with no value is not an empty one: where a side has none, its member is not
 * given.
 *
 * - `value`: the two values are not the same value (`sameValue`); empty and non-empty differ.
 * - `source_only`: the same value, with other origin items (`SourceKey`). It serves only what a
 *   read shows; a premise is judged by `value` alone. States that carry it cost one more query,
 *   against the sources table (`stateAt` with `sources`); without it every source is empty and none
 *   is given.
 * - Presence. Every position is `absent` (never had a value), `live` (has a value, its fields may
 *   be null) or `revoked` (no value, because of a revoke). A difference in presence is an
 *   `existence` entry; its `before` and `after` are booleans (true: `live`, false: `revoked`),
 *   and a side that is `absent` has none, so a creation is `existence` with an `after` only.
 *   `existence` is counted apart from the fields. A row has one presence; an entity one for each
 *   small stretch.
 * - Fields. A field is compared where both sides have a value, by value and then by source. Where
 *   one side has none, only the side with a value is listed, and a null is not listed (a field
 *   holding null against no value is nothing a field can show; `existence` says it). A row's
 *   fields compare the values the version table records whether or not the row is revoked now (a
 *   revoke does not clear them), so a revoke and a write in one operation give both.
 * - A row, by presence. Same presence: the fields. `absent` to `live` or `revoked`: `existence`
 *   and the fields, without a `before`. `live` to `revoked` and back: `existence` and the fields
 *   that differ. `live` or `revoked` to `absent` cannot happen in the version table and throws.
 * - An entity. Both sides are cut at all the points where either has a segment or a revoke
 *   boundary, each small stretch is judged, and adjacent stretches with one conclusion and the same
 *   values run together: where the segments are cut is not a change. A stretch is `live` where a
 *   segment is, `revoked` where a revoke is in effect, else `absent`. A stretch that lost its
 *   value is `absent` or `revoked` by the cause the version table records: a revoke records an
 *   `existence` cell with `revoked`; an undo of a fill records a cell with `no_value` and no revoke,
 *   so that stretch is `absent` afterwards. Unlike a row, an entity does go from `live` to `absent`
 *   in that case (the undo of a fill), so it is given as `existence` with a `before` and no
 *   `after`, not refused.
 *
 * `comparable: false` is for a position whose content is deleted or pending deletion (P3); this
 * version never gives it.
 */
export function targetDelta(before: TargetState, after: TargetState): FieldDelta[] {
  if (before.kind === "row" && after.kind === "row") {
    const [bp, ap] = [before.presence, after.presence];
    if (ap === "absent" && bp !== "absent")
      throw new RangeError(`a row cannot go from ${bp} to absent in the version table`);
    const out: ComparedDelta[] = [];
    if (bp !== ap) {
      const [b, a] = [there(bp).value, there(ap).value];
      out.push({
        comparable: true,
        field: "existence",
        change: "value",
        ...(b === undefined ? {} : { before: b }),
        ...(a === undefined ? {} : { after: a }),
      });
    }
    const side = (s: typeof before, f: FieldId): Side =>
      s.presence === "absent" ? undefined : (s.fields[f] ?? { value: null, source: "" });
    const ids = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])].sort(
      byName,
    ) as FieldId[];
    for (const f of ids) {
      const [b, a] = [side(before, f), side(after, f)];
      const change = judge(b, a);
      if (change === "none") continue;
      out.push({
        comparable: true,
        field: f,
        change: change as ComparedDelta["change"],
        ...given(b, a),
      });
    }
    return out;
  }
  if (before.kind === "entity" && after.kind === "entity") {
    const points = pointsOf(before.segments, after.segments, before.revoked, after.revoked);
    const out: ComparedDelta[] = [];
    const gone = existenceStretches(before, after, points);
    if (gone.length > 0)
      out.push({ comparable: true, field: "existence", change: "value", stretches: gone });
    const ids = [
      ...new Set([...before.segments, ...after.segments].flatMap((s) => Object.keys(s.values))),
    ].sort(byName) as FieldId[];
    for (const f of ids) {
      const stretches = stretchesOf(f, before.segments, after.segments, points);
      if (stretches.length === 0) continue;
      out.push({
        comparable: true,
        field: f,
        change: stretches.some((s) => s.change === "value") ? "value" : "source_only",
        stretches,
      });
    }
    return out;
  }
  throw new TypeError("targetDelta compares two states of one kind of target");
}
