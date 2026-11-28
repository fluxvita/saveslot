// Which ends of a state entity's stretches, read by record time, came from content a deletion
// still pending removed, and so are not given (03-data-model/03-deletion «版本表»; the decision on
// interval ends of deleted content, §1, §2). Worked out on the stretches as merged, from the cells
// in effect at the point read and where each cell's ends came from (`cellEnds`).
//
// - A stretch's end P is given by an item's interval: the cell's own item when its interval has an
//   end at P; else the neighbouring cell's item (the next one's start, the previous one's end), or
//   a revoke leaving a gap there; the cell's own wins when both have an end at P.
// - An end the write head stated (`given`, a start `now`, an end `open`) is withheld when the
//   item's contribution was taken away; any other end (resolved: `next_change`, `corrected_span`,
//   or no head interval at all) when the block holding the interval is listed.
// - A row's end at P is withheld only when every field (and existence) with an end at P has it
//   withheld; a field whose cells do not change at P, or whose end there no item gives (a cell no
//   contribution gave), does not count. With none counting, P is given.

import type { CompiledBaseTable } from "@fluxvita/saveslot-contract-core";

/** Where a cell's ends came from (store/readable-content.ts `cellEnds`); null: no item gave it. */
export interface CellEnds {
  readonly from?: string | null;
  readonly to?: string | null;
  readonly from_mode?: string | null;
  readonly to_mode?: string | null;
  readonly taken: boolean;
  readonly listed: boolean;
}

/** A cell as the ends are worked out from: its field, its business interval, where its ends came from. */
export interface EndCell {
  readonly field_id: string;
  readonly vf: string | null;
  readonly vt: string | null;
  readonly revoked: boolean | null;
  readonly ends: CellEnds | null | undefined;
}

/**
 * Whether an end of the item behind `c` is withheld: `side` is which end of its interval. An end
 * stated open (`open`) counts as stated, as the decision says; untested apart from a resolved one:
 * a contribution taken away has its interval block listed too, and an item whose end was stated
 * open with its block listed only through `deps` has not been constructed here.
 */
function withheld(c: EndCell, side: "from" | "to"): boolean {
  const e = c.ends as CellEnds;
  const mode = side === "from" ? e.from_mode : e.to_mode;
  const stated =
    side === "from" ? mode === "given" || mode === "now" : mode === "given" || mode === "open";
  return stated ? e.taken : e.listed;
}

/** Whether the item behind `c` has an end at P on `side` of its interval (null P: open end). */
function endsAt(c: EndCell, side: "from" | "to", p: string | null): boolean {
  const e = c.ends;
  if (e === null || e === undefined) return false;
  if (side === "to") return p === null ? (e.to ?? null) === null : e.to === p;
  return p !== null && e.from === p;
}

/**
 * The vote of one target (a field, or existence) on an end at P: undefined when its cells do not
 * change at P or no item gives its end there; else whether its end there is withheld. `start`: P
 * is a stretch's start (the cell after P is the stretch's own), else its end.
 */
function vote(
  cells: readonly EndCell[],
  revokes: readonly EndCell[],
  p: string | null,
  start: boolean,
): boolean | undefined {
  const before = p === null ? undefined : cells.find((c) => c.vt === p);
  const after = p === null ? undefined : cells.find((c) => c.vf === p);
  if (p === null) {
    // An open end: the cell running on, its own item's.
    const open = cells.find((c) => c.vt === null);
    if (open === undefined || !endsAt(open, "to", null)) return undefined;
    return withheld(open, "to");
  }
  if (before === undefined && after === undefined) return undefined;
  const own = start ? after : before;
  const other = start ? before : after;
  if (own !== undefined && endsAt(own, start ? "from" : "to", p))
    return withheld(own, start ? "from" : "to");
  if (other !== undefined && endsAt(other, start ? "to" : "from", p))
    return withheld(other, start ? "to" : "from");
  // A gap a revoke leaves: its interval gives the end.
  const gap = revokes.find((c) => (start ? c.vt === p : c.vf === p));
  if (gap !== undefined && endsAt(gap, start ? "to" : "from", p))
    return withheld(gap, start ? "to" : "from");
  return undefined;
}

/** Whether a row's end at P is withheld: every target with an end there has it withheld. */
function rowEndWithheld(
  t: CompiledBaseTable,
  cells: readonly EndCell[],
  p: string | null,
  start: boolean,
): boolean {
  const revokes = cells.filter((c) => c.field_id === "existence" && c.revoked === true);
  const votes: boolean[] = [];
  for (const f of t.fields) {
    const mine = cells.filter((c) => c.field_id === f.id);
    const v = vote(mine, revokes, p, start);
    if (v !== undefined) votes.push(v);
  }
  // Existence: a revoke's own end, where the stretch meets its gap.
  if (p !== null) {
    const gap = revokes.find((c) => (start ? c.vt === p : c.vf === p));
    if (gap !== undefined && endsAt(gap, start ? "to" : "from", p))
      votes.push(withheld(gap, start ? "to" : "from"));
  }
  return votes.length > 0 && votes.every((x) => x);
}

/**
 * Whether one target's end at P is withheld in a change (`changes`: the state after an operation
 * and before it, in that order): the side after decides where it has an end of `target` at P, as
 * the stretch is what the operation wrote there; else the side before (a deletion or a revoke took
 * the value away, and the end was the removed one's). With neither, P is given. `target` is a
 * field ID or `existence`; a revoke's gap is counted as in `vote`.
 */
export function targetEndWithheld(
  sides: readonly (readonly EndCell[])[],
  target: string,
  p: string | null,
  start: boolean,
): boolean {
  for (const cells of sides) {
    const revokes = cells.filter((c) => c.field_id === "existence" && c.revoked === true);
    const mine = target === "existence" ? revokes : cells.filter((c) => c.field_id === target);
    const v = vote(mine, revokes, p, start);
    if (v !== undefined) return v;
  }
  return false;
}

/** For each stretch, whether its start and its end are withheld. */
export function stretchEnds(
  t: CompiledBaseTable,
  cells: readonly EndCell[],
  stretches: readonly { readonly from: string; readonly to: string | null }[],
): { fromWithheld: boolean; toWithheld: boolean }[] {
  return stretches.map((s) => ({
    fromWithheld: rowEndWithheld(t, cells, s.from, true),
    toWithheld: rowEndWithheld(t, cells, s.to, false),
  }));
}
