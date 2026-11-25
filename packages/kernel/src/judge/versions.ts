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
// each piece of business time and each field, `fieldState`: a value and the item giving it, or a
// gap and the revoke giving it. On event tables and tables without time, the view lists the values
// and the items giving them; their "existence" cell is a rule read from 02-architecture §8 rather
// than computed from the judged state: a revoke adds an existence cell, and so does a restore
// ("恢复也加一格（出处是那条恢复项）"), so a step with a revoke or restore item in effect gives a new
// version.

import { view } from "./judge.ts";
import type { Judgement } from "./model.ts";
import { EVERYTHING, type RowState } from "./state.ts";

type Piece = ReturnType<RowState["pieces"]>[number];

const covers = (valid: readonly Piece[], s: Piece) =>
  valid.some(
    (v) =>
      (v.from === null || (s.from !== null && v.from <= s.from)) &&
      (v.to === null || (s.to !== null && s.to <= v.to)),
  );

/**
 * A state table's cells as the judged state gives them: per field, its stretches with a value or
 * a gap, each with the item giving it. A gap counts only on a piece some field item lies under
 * (02-architecture §8: a revoke's existence cells fall only where field items are; a revoke over
 * a time nothing was ever written changes no cell).
 */
function stateCells(state: RowState): string {
  const ref = (x: { event: number; target: string; k: number }) => `${x.event}/${x.target}/${x.k}`;
  const out: Record<string, [string | null, string | null, string][]> = {};
  for (const f of state.table.fields) {
    const stretches: [string | null, string | null, string][] = [];
    for (const s of state.pieces()) {
      const st = state.fieldState(f, s, EVERYTHING);
      let token: string;
      if (st.kind === "value") token = `value ${JSON.stringify(st.value)} ${ref(st.by)}`;
      else if (st.kind === "hole") {
        const under = state.items.some(
          (x) =>
            x.status === "applied" &&
            x.target !== "existence" &&
            (x.content.kind === "value" || x.content.kind === "no_value") &&
            covers(x.valid, s),
        );
        token = under ? `gap ${ref(st.by)}` : "none";
      } else token = "none";
      const last = stretches.at(-1);
      if (last !== undefined && last[2] === token && last[1] === s.from) last[1] = s.to;
      else stretches.push([s.from, s.to, token]);
    }
    out[f] = stretches.filter((x) => x[2] !== "none");
  }
  return JSON.stringify(out);
}

/** The cells of a row or entity, as far as the judged state gives them. */
export function cellsOf(state: RowState): string {
  if (state.isState) return stateCells(state);
  return JSON.stringify(view(state).fields);
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
    )
  );
}
