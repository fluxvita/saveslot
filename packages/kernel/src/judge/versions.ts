// Which judged steps give a row a new version: the pipeline ranks an entity a request wrote by it
// (similar keys: the latest written are those with the latest version), and the tests that bring a
// `ver` back to the pipeline and the scenarios (scenarios.fixture.ts) mark a `ver` current by it,
// as the pipeline does by the version table.
//
// A step gives a new version exactly when the row's cells in the version table change: a value,
// or where a value comes from (04-contract §2 `ver`; 02-architecture §8 版本表). Whether the
// step's record has an item in effect does not decide it: an undo writing back what an earlier
// undo already wrote back has one, and leaves every cell as it was.
//
// The judged state gives what the cells hold through its public methods: on a state table, for
// each piece of business time, `hasValue`, `fieldState`, and `noValueBy` give the same cells as
// `settleState` in apply/settle.ts. On event tables and tables without time, the view with
// `noValueGivers` lists the values and the items giving them (including `no_value` write-backs);
// their "existence" cell is a rule read from 02-architecture §8 rather than computed from the
// judged state: a revoke adds an existence cell, and so does a restore ("恢复也加一格（出处是那条
// 恢复项）"), so a step with a revoke or restore item in effect gives a new version, unless the row
// is in the version table neither before nor after it: a row that neither exists (its required
// fields are not all given) nor is revoked has no cells at all, so a restore on it gives none.

import { view } from "./judge.ts";
import type { Judgement } from "./model.ts";
import { EVERYTHING, effective, type Item, later, type RowState } from "./state.ts";

type Piece = ReturnType<RowState["pieces"]>[number];

const covers = (valid: readonly Piece[], s: Piece) =>
  valid.some(
    (v) =>
      (v.from === null || (s.from !== null && v.from <= s.from)) &&
      (v.to === null || (s.to !== null && s.to <= v.to)),
  );

/**
 * A state table's cells as the version table settles them (02-architecture §8 版本表; matching
 * apply/settle.ts): where the entity has a value, every field has a cell (its value and giver, or
 * empty with its no-value giver or none); where it has none, only the fields defining "has a value"
 * count — a no-value item emptying one gives that field a no-value cell, and the latest revoke
 * emptying one gives an `existence` cell where some field item lies under it.
 */
function stateCells(state: RowState): string {
  const ref = (x: { event: number; target: string; k: number }) => `${x.event}/${x.target}/${x.k}`;
  const defining = state.table.valued.length > 0 ? state.table.valued : state.table.fields;
  const out: Record<string, [string | null, string | null, string][]> = {};
  for (const f of state.table.fields) out[f] = [];
  out["existence"] = [];
  const push = (field: string, s: Piece, token: string) => {
    const list = out[field] as [string | null, string | null, string][];
    const last = list.at(-1);
    if (last !== undefined && last[2] === token && last[1] === s.from) last[1] = s.to;
    else list.push([s.from, s.to, token]);
  };
  for (const s of state.pieces()) {
    if (!state.hasValue(s, EVERYTHING)) {
      let revoke: Item | undefined;
      for (const f of defining) {
        const nv = state.noValueBy(f, s, EVERYTHING);
        if (nv !== undefined) push(f, s, `no_value ${ref(nv)}`);
        const st = state.fieldState(f, s, EVERYTHING);
        if (st.kind === "hole" && (revoke === undefined || later(st.by, revoke))) revoke = st.by;
      }
      const under = state.items.some(
        (x) => effective(x.status) && x.target !== "existence" && covers(x.valid, s),
      );
      if (revoke !== undefined && under) push("existence", s, `gap ${ref(revoke)}`);
      continue;
    }
    for (const f of state.table.fields) {
      const st = state.fieldState(f, s, EVERYTHING);
      if (st.kind === "value") {
        push(f, s, `value ${JSON.stringify(st.value)} ${ref(st.by)}`);
      } else {
        const nv = state.noValueBy(f, s, EVERYTHING);
        push(f, s, nv !== undefined ? `empty ${ref(nv)}` : "empty");
      }
    }
  }
  return JSON.stringify(out);
}

/** The cells of a row or entity, as far as the judged state gives them. */
export function cellsOf(state: RowState): string {
  if (state.isState) return stateCells(state);
  return JSON.stringify(view(state, state.table.fields, true).fields);
}

/** Whether a judged step gives the row a new version, after the state `before` (none: the first). */
export function givesVersion(
  before: RowState | undefined,
  step: { readonly state: RowState; readonly judgement: Judgement },
): boolean {
  if (before === undefined) return true;
  if (cellsOf(before) !== cellsOf(step.state)) return true;
  if (step.state.isState) return false;
  const r = step.judgement.record;
  return (
    "items" in r &&
    r.items.some(
      (x) =>
        x.status === "applied" && (x.content.kind === "revoke" || x.content.kind === "restore"),
    ) &&
    (present(before) || present(step.state))
  );
}

/** Whether an event or timeless table's row has cells in the version table: it exists or is revoked. */
const present = (state: RowState): boolean => state.revoked(EVERYTHING) || view(state).exists;
