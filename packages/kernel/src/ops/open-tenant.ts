// The first steps of opening a tenant (docs/zh-CN/spec/02-architecture.md §4 `openTenant`, §8
// «格式版本、导出、导入与恢复»): before the tenant serves, in this order,
//
// 1. an import in progress (the anchor's import marker): the import's re-entry protocol comes first;
// 2. a restore in progress (the anchor's restore marker): the restore flow re-enters;
// 3. the log's end below the anchor's high water: the log went back, a restore is needed;
// 4. reconciling deletion entries with the log, 5. running tasks that fell due: later, with the
//    deletion flows; the caller keeps their place.
//
// The decision is pure: the caller reads the anchor and the log's end and passes them in. The
// import, restore and catch-up flows are not compiled yet: each of the first three cases stops as
// not implemented, naming which, and the tenant does not serve.

import type { Seq } from "@fluxvita/saveslot-contract-core";
import type { ImportId, RestoreId } from "../store/anchor.ts";

export interface OpenTenantFacts {
  readonly importInProgress?: ImportId | undefined;
  readonly restoreInProgress?: RestoreId | undefined;
  /** The `seq` of the log's last event. */
  readonly logEnd: Seq;
  /** The anchor's high water mark. */
  readonly highWater: Seq | 0;
}

/** Why a tenant cannot serve yet: the flow it needs is not compiled in this version. */
export type OpenTenantStop = "import_in_progress" | "restore_in_progress" | "log_behind_high_water";

export type OpenTenantDecision =
  | { readonly kind: "serve" }
  | { readonly kind: "not_implemented"; readonly what: OpenTenantStop };

/** Steps 1–3 of `openTenant`, in the spec's order. */
export function openTenantDecision(f: OpenTenantFacts): OpenTenantDecision {
  if (f.importInProgress !== undefined)
    return { kind: "not_implemented", what: "import_in_progress" };
  if (f.restoreInProgress !== undefined) {
    return { kind: "not_implemented", what: "restore_in_progress" };
  }
  // The high water never passes the committed log end (§8): below it, the log went back.
  if (f.logEnd < f.highWater) return { kind: "not_implemented", what: "log_behind_high_water" };
  return { kind: "serve" };
}
