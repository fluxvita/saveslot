// Business time intervals for the reference evaluator.
//
// Intervals are left-closed, right-open (05-time «三种表»). A point is an ISO date or instant
// string; both compare correctly as strings. `from: null` is "from the earliest", `to: null` is
// "continues" (09 §1.2). Event and timeless tables have no business time: every item there has
// the single indivisible interval ALL (03-deletion «回掉的权威定义», "⊤").

import type { BizPoint } from "@fluxvita/saveslot-contract-core";

export type Point = BizPoint;

export interface Iv {
  readonly from: Point | null;
  readonly to: Point | null;
}

/** A set of disjoint, non-adjacent intervals sorted by start. */
export type IvSet = readonly Iv[];

export const ALL: Iv = { from: null, to: null };
export const EMPTY: IvSet = [];

export function iv(from: Point | null, to: Point | null = null): Iv {
  return { from, to };
}

function fromLe(a: Point | null, b: Point | null): boolean {
  return a === null || (b !== null && a <= b);
}

function toLe(a: Point | null, b: Point | null): boolean {
  return b === null || (a !== null && a <= b);
}

function nonEmpty(x: Iv): boolean {
  return x.from === null || x.to === null || x.from < x.to;
}

/** Sorts, drops empty intervals and merges overlapping or adjacent ones. */
export function normalize(xs: readonly Iv[]): IvSet {
  const sorted = xs.filter(nonEmpty).sort((a, b) => {
    if (a.from === b.from) return 0;
    return fromLe(a.from, b.from) ? -1 : 1;
  });
  const out: Iv[] = [];
  for (const x of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && (last.to === null || x.from === null || x.from <= last.to)) {
      out[out.length - 1] = { from: last.from, to: toLe(last.to, x.to) ? x.to : last.to };
    } else {
      out.push(x);
    }
  }
  return out;
}

export function union(...sets: readonly IvSet[]): IvSet {
  return normalize(sets.flat());
}

export function intersect(a: IvSet, b: IvSet): IvSet {
  const out: Iv[] = [];
  for (const x of a) {
    for (const y of b) {
      const from = fromLe(x.from, y.from) ? y.from : x.from;
      const to = toLe(x.to, y.to) ? x.to : y.to;
      const z = { from, to };
      if (nonEmpty(z)) out.push(z);
    }
  }
  return normalize(out);
}

export function complement(a: IvSet): IvSet {
  const s = normalize(a);
  const out: Iv[] = [];
  // End of the previous interval; null while nothing has been passed ("from the earliest").
  let cursor: Point | null = null;
  for (const x of s) {
    if (x.from !== null) out.push({ from: cursor, to: x.from });
    if (x.to === null) return normalize(out);
    cursor = x.to;
  }
  out.push({ from: cursor, to: null });
  return normalize(out);
}

export function subtract(a: IvSet, b: IvSet): IvSet {
  return intersect(a, complement(b));
}

export function isEmpty(a: IvSet): boolean {
  return normalize(a).length === 0;
}

export function equalSets(a: IvSet, b: IvSet): boolean {
  const x = normalize(a);
  const y = normalize(b);
  return x.length === y.length && x.every((v, i) => v.from === y[i]?.from && v.to === y[i]?.to);
}

/** Whether interval `seg` lies inside the set. */
export function covers(a: IvSet, seg: Iv): boolean {
  return a.some((x) => fromLe(x.from, seg.from) && toLe(seg.to, x.to));
}

/** Whether point `p` lies inside the set (left-closed, right-open). */
export function containsPoint(a: IvSet, p: Point): boolean {
  return a.some((x) => fromLe(x.from, p) && (x.to === null || p < x.to));
}

/** Every finite endpoint of the given sets, sorted and deduplicated. */
export function endpoints(sets: readonly IvSet[]): Point[] {
  const ps = new Set<Point>();
  for (const s of sets) {
    for (const x of s) {
      if (x.from !== null) ps.add(x.from);
      if (x.to !== null) ps.add(x.to);
    }
  }
  return [...ps].sort();
}

/**
 * The elementary segments the breakpoints cut the whole timeline into. Any state built only from
 * intervals whose endpoints are among the breakpoints is constant on each segment.
 */
export function elementarySegments(breakpoints: readonly Point[]): Iv[] {
  const out: Iv[] = [];
  let prev: Point | null = null;
  for (const p of breakpoints) {
    out.push({ from: prev, to: p });
    prev = p;
  }
  out.push({ from: prev, to: null });
  return out;
}

/** The maximal intervals of the set, one by one (for items that must be contiguous). */
export function pieces(a: IvSet): IvSet[] {
  return normalize(a).map((x) => [x]);
}

export function show(a: IvSet): string {
  return normalize(a)
    .map((x) => `[${x.from ?? "-inf"}, ${x.to ?? "inf"})`)
    .join(" ∪ ");
}
