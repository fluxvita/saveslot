// Which judged steps give a row a new version, for tests that bring a `ver` back to the pipeline and
// for the scenarios, which mark a `ver` current by it (scenarios.fixture.ts) as the pipeline does by
// the version table.
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

import type { Op } from "@fluxvita/saveslot-reference";
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

type JudgedStep = {
  readonly op: Op;
  readonly state: RowState;
  readonly judgement: Judgement;
};

/** The operations of the judged steps that give a new version. */
export function versionsOf(steps: readonly JudgedStep[]): number[] {
  return steps
    .filter((x, k) => givesVersion(k === 0 ? undefined : (steps[k - 1] as JudgedStep).state, x))
    .map((x) => x.op.op);
}

/**
 * The ops with each `seen` (after the first op) made the latest version at or before it, as a
 * `ver` must name a version (04-contract §2 `ver`). Step by step: the versions before an op are
 * those of the log as sent so far, its earlier `seen`s already mapped, since judge's result can
 * depend on the exact operation seen, and with it which later steps give versions. `judge` judges
 * a whole log; only its steps before the op count. Undefined when some `seen` comes before every
 * version.
 */
export function seenAsVersions(
  sent: readonly Op[],
  judge: (ops: readonly Op[]) => readonly JudgedStep[],
): Op[] | undefined {
  const ops = [...sent];
  for (const [i, o] of sent.entries()) {
    if (i === 0 || !("seen" in o) || o.seen === undefined) continue;
    const seen = o.seen;
    const version = versionsOf(judge(ops).filter((x) => x.op.op < o.op))
      .filter((v) => v <= seen)
      .at(-1);
    if (version === undefined) return undefined;
    ops[i] = { ...o, seen: version } as Op;
  }
  return ops;
}
