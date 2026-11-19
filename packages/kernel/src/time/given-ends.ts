// A write's business time parameters as the caller gave them, and the ends they give
// (docs/zh-CN/spec/03-data-model/05-time.md «写状态：参数与默认»). Shared by the request that
// takes them, judge that resolves them and apply that records a corroboration's ends.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";

export type FromParam =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "now" };
export type ToParam =
  | { readonly mode: "given"; readonly value: BizPoint }
  | { readonly mode: "open" }
  | { readonly mode: "next_change" };
/** `corrected_span`: intent correct with neither end given. */
export type ValidParam = { readonly from: FromParam; readonly to: ToParam } | "corrected_span";

/** The start and the explicit end of raw parameters, as resolved with "now". */
export function givenEnds(valid: ValidParam | undefined, now: BizPoint): BizPoint[] {
  if (valid === undefined) return [now];
  if (valid === "corrected_span") return [];
  const from = valid.from.mode === "given" ? valid.from.value : now;
  return valid.to.mode === "given" ? [from, valid.to.value] : [from];
}
