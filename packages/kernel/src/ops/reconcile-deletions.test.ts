// The reconciliation table of 03-deletion.md, written out cell by cell (not derived from the
// function's own structure): 5 registry states × 4 log states = 20 cells.

import { describe, expect, it } from "vitest";
import type { DeletionEntry, DeletionEntryState } from "../store/anchor.ts";
import {
  type LogDeletionState,
  type ReconcileStep,
  reconcileDeletions,
  reconcileStep,
} from "./reconcile-deletions.ts";

const none: ReconcileStep = { kind: "none" };
const set = (to: "pending" | "cancelled" | "executed"): ReconcileStep => ({
  kind: "set_state",
  to,
});
const add = (state: "pending" | "cancelled" | "executed"): ReconcileStep => ({
  kind: "add",
  state,
});
const remove: ReconcileStep = { kind: "remove" };
const impossible: ReconcileStep = { kind: "impossible" };

// Columns: log pending, cancelled, executed, none.
const TABLE: Record<string, [ReconcileStep, ReconcileStep, ReconcileStep, ReconcileStep]> = {
  intent: [set("pending"), set("cancelled"), set("executed"), remove],
  pending: [none, set("cancelled"), set("executed"), impossible],
  cancelled: [impossible, none, impossible, impossible],
  executed: [impossible, impossible, none, impossible],
  absent: [add("pending"), add("cancelled"), add("executed"), none],
};
const LOG: LogDeletionState[] = ["pending", "cancelled", "executed", "none"];

describe("reconcileStep: the table of the spec", () => {
  for (const [registry, row] of Object.entries(TABLE)) {
    LOG.forEach((log, i) => {
      it(`${registry} × log ${log}`, () => {
        expect(reconcileStep(registry as never, log)).toEqual(row[i]);
      });
    });
  }

  it("never leaves a cancelled deletion to be added as pending (the user's cancel is kept)", () => {
    expect(reconcileStep("absent", "cancelled")).toEqual(add("cancelled"));
  });
});

const entry = (n: number, state: DeletionEntryState): DeletionEntry => ({
  deletion: `pi_${String(n).padStart(26, "0")}`,
  kind: "privacy",
  state,
  dueAt: "2026-11-21T00:00:00.000Z",
  confirmedSeq: n,
  sources: [],
  positions: [],
});
const id = (n: number) => entry(n, "pending").deletion;

describe("reconcileDeletions", () => {
  it("agreeing registry and log: nothing to do", () => {
    const p = reconcileDeletions(
      [entry(1, "pending"), entry(2, "cancelled"), entry(3, "executed")],
      [
        { deletion: id(1), state: "pending" },
        { deletion: id(2), state: "cancelled" },
        { deletion: id(3), state: "executed" },
      ],
    );
    expect(p).toEqual({ actions: [], needsRestore: false });
  });

  it("corrects each deletion on its own, in deletion order", () => {
    const p = reconcileDeletions(
      [entry(3, "intent"), entry(1, "intent"), entry(2, "pending")],
      [
        { deletion: id(2), state: "executed" },
        { deletion: id(1), state: "pending" },
        { deletion: id(4), state: "cancelled" },
      ],
    );
    expect(p.needsRestore).toBe(false);
    expect(p.actions).toEqual([
      { deletion: id(1), step: set("pending") },
      { deletion: id(2), step: set("executed") },
      { deletion: id(3), step: remove },
      { deletion: id(4), step: add("cancelled") },
    ]);
  });

  it("an impossible combination anywhere: restore, with no other action", () => {
    const p = reconcileDeletions(
      [entry(1, "intent"), entry(2, "pending")],
      [{ deletion: id(1), state: "pending" }],
    );
    expect(p).toEqual({ actions: [], needsRestore: true });
  });

  it("an empty registry and an empty log: nothing", () => {
    expect(reconcileDeletions([], [])).toEqual({ actions: [], needsRestore: false });
  });
});
