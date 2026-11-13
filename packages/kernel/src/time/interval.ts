// Business time intervals and their basic operations (docs/zh-CN/spec/02-architecture.md §4,
// module `time`; docs/zh-CN/spec/03-data-model/05-time.md «三种表»).
//
// An interval is left-closed and right-open. A point is an ISO date or an ISO instant; one table
// uses one of the two, and within one kind the string order is the time order. `from: null` is
// "from the earliest", `to: null` is "continues". Event and timeless tables have no business
// time: an item there covers the one indivisible interval `WHOLE`.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";

export interface Interval {
  readonly from: BizPoint | null;
  readonly to: BizPoint | null;
}

/** Disjoint, non-adjacent, non-empty intervals sorted by start: the canonical form of a set. */
export type IntervalSet = readonly Interval[];

export const WHOLE: Interval = { from: null, to: null };
export const NOTHING: IntervalSet = [];

/** `a` starts no later than `b` (null is the earliest). */
function startsBy(a: BizPoint | null, b: BizPoint | null): boolean {
  if (a === null) return true;
  return b !== null && a <= b;
}

/** `a` ends no later than `b` (null is never). */
function endsBy(a: BizPoint | null, b: BizPoint | null): boolean {
  if (b === null) return true;
  return a !== null && a <= b;
}

function hasPoints(x: Interval): boolean {
  return x.from === null || x.to === null || x.from < x.to;
}

export function interval(from: BizPoint | null, to: BizPoint | null = null): IntervalSet {
  return canonical([{ from, to }]);
}

/** The canonical form: empty intervals dropped, overlapping or adjacent ones joined. */
export function canonical(xs: readonly Interval[]): IntervalSet {
  const sorted = xs.filter(hasPoints).sort((a, b) => {
    if (a.from === b.from) return 0;
    return startsBy(a.from, b.from) ? -1 : 1;
  });
  const out: Interval[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && (last.to === null || x.from === null || x.from <= last.to)) {
      out[out.length - 1] = { from: last.from, to: endsBy(last.to, x.to) ? x.to : last.to };
    } else {
      out.push(x);
    }
  }
  return out;
}

export function unionOf(...sets: readonly IntervalSet[]): IntervalSet {
  return canonical(sets.flat());
}

export function meet(a: IntervalSet, b: IntervalSet): IntervalSet {
  const out: Interval[] = [];
  for (const x of a) {
    for (const y of b) {
      const z = {
        from: startsBy(x.from, y.from) ? y.from : x.from,
        to: endsBy(x.to, y.to) ? x.to : y.to,
      };
      if (hasPoints(z)) out.push(z);
    }
  }
  return canonical(out);
}

export function minus(a: IntervalSet, b: IntervalSet): IntervalSet {
  const rest: Interval[] = [];
  let cursor: BizPoint | null = null;
  let open = true;
  for (const y of canonical(b)) {
    if (y.from !== null) rest.push({ from: cursor, to: y.from });
    if (y.to === null) {
      open = false;
      break;
    }
    cursor = y.to;
  }
  if (open) rest.push({ from: cursor, to: null });
  return meet(a, canonical(rest));
}

export function isNothing(a: IntervalSet): boolean {
  return canonical(a).length === 0;
}

export function sameSet(a: IntervalSet, b: IntervalSet): boolean {
  const x = canonical(a);
  const y = canonical(b);
  return x.length === y.length && x.every((v, i) => v.from === y[i]?.from && v.to === y[i]?.to);
}

/** Whether `seg` lies inside one interval of the set. */
export function within(seg: Interval, a: IntervalSet): boolean {
  return a.some((x) => startsBy(x.from, seg.from) && endsBy(seg.to, x.to));
}

/** Whether point `p` lies inside the set. */
export function holds(a: IntervalSet, p: BizPoint): boolean {
  return a.some((x) => startsBy(x.from, p) && (x.to === null || p < x.to));
}

/** Whether `p` is a finite endpoint (start or end) of one interval of the set. */
export function bounds(a: IntervalSet, p: BizPoint): boolean {
  return a.some((x) => x.from === p || x.to === p);
}

/** The finite endpoints of the sets, sorted, without repeats. */
export function cutPoints(sets: readonly IntervalSet[]): BizPoint[] {
  const ps = new Set<BizPoint>();
  for (const s of sets) {
    for (const x of s) {
      if (x.from !== null) ps.add(x.from);
      if (x.to !== null) ps.add(x.to);
    }
  }
  return [...ps].sort();
}

/** The pieces the points cut the whole timeline into, in order. */
export function cut(points: readonly BizPoint[]): Interval[] {
  const out: Interval[] = [];
  let prev: BizPoint | null = null;
  for (const p of points) {
    out.push({ from: prev, to: p });
    prev = p;
  }
  out.push({ from: prev, to: null });
  return out;
}

/** The maximal intervals of a set, each as a set of its own. */
export function parts(a: IntervalSet): IntervalSet[] {
  return canonical(a).map((x) => [x]);
}

export function startOf(a: IntervalSet): BizPoint | null {
  return canonical(a)[0]?.from ?? null;
}
