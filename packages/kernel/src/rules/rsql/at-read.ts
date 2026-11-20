// The one test of whether a derived table is computed when read (06-derived «时间依赖»; 11-restricted-sql
// «何时求值»). Every entry that reads a derived table asks here, so that none of them reads the empty
// physical table such a table still has and quietly answers "no rows".

import type { TimeDependency } from "@fluxvita/saveslot-contract-core";

/**
 * Whether derived table `t` is computed when read: its rule depends on today, or reads a state
 * table with no time condition (the compiler gives both `time_dependency: "now"`). Such a table
 * has no derived writes and no versions; its physical table stays empty. Asked of a compiled
 * derived table, or of one as a schema document declares it.
 */
export function computedAtRead(t: {
  readonly rule: { readonly time_dependency: TimeDependency };
}): boolean {
  return t.rule.time_dependency === "now";
}
