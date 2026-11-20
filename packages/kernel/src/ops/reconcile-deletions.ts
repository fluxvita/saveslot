// Reconciling the deletion registry with the log in normal opening
// (docs/zh-CN/spec/03-data-model/03-deletion.md "删除登记：恢复备份不让删除复活", the first table):
// the log is the truth, the registry is corrected. Pure: the caller reads the registry's entries
// and what the log says of each deletion, and applies the actions returned, in the order of the
// spec's total rule — the registry never has less to delete than the committed log.
//
// "Impossible" rows are the registry having a state the log cannot have reached: the tenant's
// storage was replaced by an older one without the restore flow. They are not corrected here; the
// caller enters the restore flow (02-architecture §8).

import type { DeletionEntry, DeletionEntryState, DeletionId } from "../store/anchor.ts";

/** What the log says of one deletion. `none`: the log has no `deletion.confirmed` for it. */
export const LOG_DELETION_STATES = ["pending", "cancelled", "executed", "none"] as const;
export type LogDeletionState = (typeof LOG_DELETION_STATES)[number];

/** The registry's side: an entry's state, or no entry. */
export type RegistryState = DeletionEntryState | "absent";

/** The states an entry can be moved to or added in: the ones the log can be in, except none. */
export type SettledState = Exclude<LogDeletionState, "none">;

export type ReconcileStep =
  /** Nothing to do. */
  | { readonly kind: "none" }
  /** Set the existing entry's state. */
  | { readonly kind: "set_state"; readonly to: SettledState }
  /** The transaction never committed: remove the entry. */
  | { readonly kind: "remove" }
  /** No entry: add one in this state (the anchor was lost or is new). */
  | { readonly kind: "add"; readonly state: SettledState }
  /** A combination normal running cannot reach: the storage went back; enter the restore flow. */
  | { readonly kind: "impossible" };

/** One cell of the table: registry state × what the log says. */
export function reconcileStep(registry: RegistryState, log: LogDeletionState): ReconcileStep {
  switch (registry) {
    case "intent":
      if (log === "pending") return { kind: "set_state", to: "pending" };
      if (log === "none") return { kind: "remove" };
      return { kind: "set_state", to: log };
    case "pending":
      if (log === "pending") return { kind: "none" };
      if (log === "none") return { kind: "impossible" };
      return { kind: "set_state", to: log };
    case "cancelled":
      return log === "cancelled" ? { kind: "none" } : { kind: "impossible" };
    case "executed":
      return log === "executed" ? { kind: "none" } : { kind: "impossible" };
    case "absent":
      return log === "none" ? { kind: "none" } : { kind: "add", state: log };
  }
}

export interface LogDeletion {
  readonly deletion: DeletionId;
  readonly state: SettledState;
}

export interface ReconcileAction {
  readonly deletion: DeletionId;
  readonly step: Exclude<ReconcileStep, { readonly kind: "none" }>;
}

export interface ReconcilePlan {
  /** Corrections to apply, in `deletion` order; empty when the registry already agrees. */
  readonly actions: readonly ReconcileAction[];
  /** Some deletion is in a combination normal running cannot reach: enter the restore flow. */
  readonly needsRestore: boolean;
}

/**
 * The plan for the whole registry: every entry against the log, and every deletion the log has
 * against the registry. When any deletion is impossible the plan has no other action: the restore
 * flow decides everything from the registry, and a half-corrected registry would mislead it.
 */
export function reconcileDeletions(
  entries: readonly DeletionEntry[],
  log: readonly LogDeletion[],
): ReconcilePlan {
  const entryOf = new Map(entries.map((e) => [e.deletion, e]));
  const logOf = new Map(log.map((l) => [l.deletion, l.state]));
  const ids = [...new Set([...entryOf.keys(), ...logOf.keys()])].sort();
  const actions: ReconcileAction[] = [];
  for (const id of ids) {
    const step = reconcileStep(entryOf.get(id)?.state ?? "absent", logOf.get(id) ?? "none");
    if (step.kind === "impossible") return { actions: [], needsRestore: true };
    if (step.kind !== "none") actions.push({ deletion: id, step });
  }
  return { actions, needsRestore: false };
}
