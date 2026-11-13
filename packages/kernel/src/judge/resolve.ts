// Resolving interval parameters against a state (docs/zh-CN/spec/03-data-model/05-time.md
// «写状态：参数与默认»; 09-event-format §3.5, §5.7 `span/…` `deps`).

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import { type IntervalSet, interval, WHOLE } from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import type { ItemRef, ValidParam } from "./model.ts";
import { type Limit, NO_VALUE, type RowState, refKey } from "./state.ts";

export interface Resolved {
  readonly valid: IntervalSet;
  /** Resolved by a default end (`next_change`). */
  readonly defaultEnd: boolean;
  readonly from: BizPoint | null;
  /** The givers of the blocking points the resolution stopped at, both sides. */
  readonly deps: readonly ItemRef[];
}

export function uniqueRefs(refs: readonly ItemRef[]): ItemRef[] {
  const seen = new Map<string, ItemRef>();
  for (const r of refs) if (!seen.has(refKey(r))) seen.set(refKey(r), r);
  return [...seen.values()].sort(
    (a, b) => a.event - b.event || a.target.localeCompare(b.target) || a.k - b.k,
  );
}

/**
 * Resolves the parameters for field `f` (or for any field: a revoke) as of `at`. A default end is
 * the first blocking point strictly after the start; `corrected_span` is the stretch around "now"
 * between blocking points. Null where `corrected_span` finds the field without a value at "now".
 */
export function resolve(
  state: RowState,
  param: ValidParam | undefined,
  f: FieldId | "any",
  at: Limit,
  now: BizPoint,
): Resolved | null {
  if (!state.isState) return { valid: [WHOLE], defaultEnd: false, from: null, deps: [] };
  const p = param ?? { from: { mode: "now" as const }, to: { mode: "next_change" as const } };
  const stops = state.blockingPoints(f, at);
  const giversAt = (x: BizPoint | null) => (x === null ? [] : state.givers(x, f, at));
  if (p === "corrected_span") {
    const here = state.pieces([interval(now)]).find((s) => s.from === now);
    const fs = f === "any" ? state.table.fields : [f];
    if (here === undefined || fs.every((g) => state.token(g, here, at) === NO_VALUE)) return null;
    const from = stops.filter((b) => b <= now).pop() ?? null;
    const to = stops.find((b) => b > now) ?? null;
    return {
      valid: interval(from, to),
      defaultEnd: false,
      from,
      deps: uniqueRefs([...giversAt(from), ...giversAt(to)]),
    };
  }
  const from = p.from.mode === "given" ? p.from.value : now;
  if (p.to.mode === "given") {
    if (p.to.value <= from) {
      throw new JudgeError("validation_failed", "the end of the interval is not after its start", {
        from,
        to: p.to.value,
      });
    }
    return { valid: interval(from, p.to.value), defaultEnd: false, from, deps: [] };
  }
  if (p.to.mode === "open") return { valid: interval(from), defaultEnd: false, from, deps: [] };
  const to = stops.find((b) => b > from) ?? null;
  return { valid: interval(from, to), defaultEnd: true, from, deps: uniqueRefs(giversAt(to)) };
}
