// The judged steps' versions over a log, for the tests and scenarios (the rule: ./versions.ts).

import type { Op } from "@fluxvita/saveslot-reference";
import type { Judgement } from "./model.ts";
import type { RowState } from "./state.ts";
import { givesVersion } from "./versions.ts";

export { cellsOf, givesVersion } from "./versions.ts";

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
