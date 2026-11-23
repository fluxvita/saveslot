// Fixed cases for writes by source key: the three-way comparison against the field's sync baseline
// (04-write-and-read «按来源键写入», «三方比较»; 09-references-conflict-sync «冲突判据»), what each
// op comes to (`outcome`), and what the evaluator does not model. Fictional data.
//
// One row of a timeless table: f1 required, f2 the field the cases are about. A write by key is a
// connector's, citing no evidence unless a case says so (an API call source per op).
import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { evaluateLog } from "./evaluate.ts";
import type {
  Evaluation,
  LogEntry,
  LogEvaluation,
  LogStep,
  ResolveOp,
  TableSchema,
  WriteOp,
} from "./model.ts";

const TIMELESS: TableSchema = { kind: "timeless", required: ["f1"] };

/**
 * A write by source key at operation `op` (event `op + 1`): f1 "a" and f2 as given. `explicit`:
 * f2 points at evidence; `explicitAll`: both fields do.
 */
function sync(
  op: number,
  f2: string,
  o: { explicit?: boolean; explicitAll?: boolean; f1?: string } = {},
): WriteOp {
  const f1x = o.explicitAll ? { explicit: true as const } : {};
  const f2x = o.explicit || o.explicitAll ? { explicit: true as const } : {};
  return {
    kind: "write",
    op,
    event: op + 1,
    byKey: true,
    fields: {
      f1: { value: o.f1 ?? "a", sources: [`api${op}`], ...f1x },
      f2: { value: f2, sources: [`api${op}`], ...f2x },
    },
  };
}
/** Someone changes f2 in saveslot, having read the row as it is (an ordinary write). */
const local = (op: number, f2: string): WriteOp => ({
  kind: "write",
  op,
  event: op + 1,
  fields: { f2: { value: f2, sources: [`user${op}`] } },
});
const resolve = (op: number, decision: ResolveOp["decision"], candidate: number): ResolveOp => ({
  kind: "resolve",
  op,
  event: op + 1,
  decision,
  candidates: [candidate + 1],
  unit: "f2",
  ...(decision === "take_candidate" ? { take: candidate + 1 } : {}),
});

const f2 = (ev: Evaluation): FieldValue | undefined => ev.fields["f2" as FieldId]?.[0]?.value;
const run = (log: LogEntry[]): LogEvaluation => evaluateLog(TIMELESS, log);
const last = (r: LogEvaluation): LogStep => r.steps.at(-1) as LogStep;
const f2Of = (s: LogStep) => s.syncFields?.["f2" as FieldId];

/** Created by key at #10 with 600; the cases append to it. */
const created = sync(10, "600");

describe("three-way comparison (04-write-and-read «三方比较», one row per line of its table)", () => {
  it("600 in effect, 600 sent: a no-op; the op leaves nothing", () => {
    const r = run([created, sync(20, "600")]);
    expect(r.steps[0]?.outcome).toBe("created");
    expect(last(r)).toMatchObject({ outcome: "unchanged", refused: false });
    expect(f2Of(last(r))).toEqual({ status: "noop", baseline: { value: "600", position: 10 } });
    expect(last(r).state).toBe(r.steps[0]?.state);
    expect(r.final.items.filter((x) => x.event === 21)).toEqual([]);
  });

  it("600 in effect, 650 sent: in effect", () => {
    const r = run([created, sync(20, "650")]);
    expect(last(r).outcome).toBe("updated");
    expect(f2Of(last(r))?.status).toBe("applied");
    expect(f2(r.final)).toBe("650");
  });

  it("500 changed by a user, 600 sent: a no-op, the user's change stays", () => {
    const r = run([created, local(20, "500"), sync(30, "600")]);
    expect(last(r).outcome).toBe("unchanged");
    expect(f2(r.final)).toBe("500");
  });

  it("500 changed by a user, 600 sent pointing at evidence: still a no-op (not raised again)", () => {
    const r = run([created, local(20, "500"), sync(30, "600", { explicit: true })]);
    expect(last(r).outcome).toBe("unchanged");
    expect(f2Of(last(r))?.status).toBe("noop");
    expect(f2(r.final)).toBe("500");
  });

  it("600 in effect, 600 sent pointing at evidence: a corroboration, and the op is updated", () => {
    // Every field a corroboration: recorded, so not `unchanged` (design 11-22, 04-contract §5.4).
    const r = run([created, sync(20, "600", { explicitAll: true })]);
    expect(last(r).outcome).toBe("updated");
    expect(last(r).syncFields).toEqual({
      f1: { status: "corroborated", baseline: { value: "a", position: 10 } },
      f2: { status: "corroborated", baseline: { value: "600", position: 10 } },
    });
    expect(f2(r.final)).toBe("600");
  });

  it("500 changed by a user, 650 sent: a candidate, the op is pending", () => {
    const r = run([created, local(20, "500"), sync(30, "650")]);
    expect(last(r).outcome).toBe("pending");
    expect(f2Of(last(r))).toEqual({
      status: "candidate",
      baseline: { value: "600", position: 10 },
    });
    expect(f2(r.final)).toBe("500");
  });

  // #10 600 by key, #20 500 by a user, #30 650 by key: a candidate on f2.
  const conflict = [created, local(20, "500"), sync(30, "650")];

  it("500, the 650 candidate still open, 650 sent: a no-op (not merged in again)", () => {
    const r = run([...conflict, sync(40, "650")]);
    expect(last(r).outcome).toBe("unchanged");
    expect(f2Of(last(r))?.baseline).toEqual({ value: "650", position: 10 });
  });

  it("500, the 650 conflict resolved keeping the value in effect, 650 sent: a no-op", () => {
    const r = run([...conflict, resolve(40, "keep_effective", 30), sync(50, "650")]);
    expect(last(r).outcome).toBe("unchanged");
    expect(f2(r.final)).toBe("500");
  });

  it("650 taken from the candidate, 700 sent: in effect, the baseline position is the take", () => {
    const r = run([...conflict, resolve(40, "take_candidate", 30), sync(50, "700")]);
    expect(f2(r.steps[3]?.state as Evaluation)).toBe("650");
    expect(last(r).outcome).toBe("updated");
    expect(f2Of(last(r))?.baseline).toEqual({ value: "650", position: 40 });
    expect(f2(r.final)).toBe("700");
  });

  it("500, the 650 conflict resolved keeping the value in effect, 700 sent: a candidate", () => {
    const r = run([...conflict, resolve(40, "keep_effective", 30), sync(50, "700")]);
    expect(last(r).outcome).toBe("pending");
    expect(f2(r.final)).toBe("500");
  });

  it("the 650 conflict resolved by going back, 650 / 700 sent: a no-op / a candidate", () => {
    // The merge base is the version the candidate carries, its baseline position #10: going back
    // writes 600 back, the user's 500 in the revert record too, as for an ordinary write.
    const back = [...conflict, resolve(40, "take_previous", 30)];
    expect(f2(run(back).final)).toBe("600");
    const same = run([...back, sync(50, "650")]);
    expect(last(same).outcome).toBe("unchanged");
    // The write-back is not a sync contribution: the baseline stays 650 at #10.
    expect(f2Of(last(same))?.baseline).toEqual({ value: "650", position: 10 });
    expect(last(run([...back, sync(50, "700")])).outcome).toBe("pending");
  });

  it("a sync's 650 undone, 650 / 700 sent: a no-op / a candidate", () => {
    // The undone 650 still counts for the baseline value, no longer for the position: back to
    // #10, and the undo at #40 changed f2 after it.
    const undone: LogEntry[] = [
      created,
      sync(20, "650"),
      { kind: "undo", op: 40, event: 41, target: 20 },
    ];
    expect(f2(run(undone).final)).toBe("600");
    const same = run([...undone, sync(50, "650")]);
    expect(last(same).outcome).toBe("unchanged");
    expect(f2Of(last(same))?.baseline).toEqual({ value: "650", position: 10 });
    expect(last(run([...undone, sync(50, "700")])).outcome).toBe("pending");
  });
});

describe("the baseline is taken field by field (09-references-conflict-sync «冲突判据»)", () => {
  it("a sync contribution on f1 does not move f2's baseline position past a user's change to f2", () => {
    // #10 by key (f1 a, f2 600); #20 a user's 500 on f2; #30 by key (f1 b, f2 600): f1 in effect,
    // f2 a no-op (not a contribution); #40 by key (f1 b, f2 650): f2's baseline is still 600 at
    // #10, and #20 changed f2 after it, so 650 is a candidate. Taken by row, the position would
    // be #30 and 650 would wrongly overwrite the user's 500.
    const log: LogEntry[] = [created, local(20, "500"), sync(30, "600", { f1: "b" })];
    const third = run(log);
    expect(last(third).outcome).toBe("updated");
    expect(last(third).syncFields).toEqual({
      f1: { status: "applied", baseline: { value: "a", position: 10 } },
      f2: { status: "noop", baseline: { value: "600", position: 10 } },
    });
    const r = run([...log, sync(40, "650", { f1: "b" })]);
    expect(last(r).outcome).toBe("pending");
    expect(last(r).syncFields).toEqual({
      f1: { status: "noop", baseline: { value: "b", position: 30 } },
      f2: { status: "candidate", baseline: { value: "600", position: 10 } },
    });
    expect(f2(r.final)).toBe("500");
  });
});

describe("a key added to a row, and a revoked row", () => {
  it("a row written by hand, then given a key: the first sync compares with the value then", () => {
    // 04-write-and-read «例» without the transfer (not in the first version): no sync
    // contribution yet, so no baseline value; the version seen is the key added at #45.
    const log: LogEntry[] = [
      {
        kind: "write",
        op: 40,
        event: 41,
        fields: { f1: { value: "a", sources: ["m"] }, f2: { value: "600", sources: ["m"] } },
      },
      { kind: "write", op: 45, event: 46, keyAdded: true, fields: {} },
    ];
    const first = run([...log, sync(60, "650")]);
    expect(last(first).outcome).toBe("updated");
    expect(f2Of(last(first))).toEqual({ status: "applied", baseline: { position: 45 } });
    expect(last(run([...log, sync(60, "600")])).outcome).toBe("unchanged");
    const next = run([...log, sync(60, "650"), sync(70, "700")]);
    expect(f2Of(last(next))?.baseline).toEqual({ value: "650", position: 60 });
    expect(f2(next.final)).toBe("700");
  });

  it("a revoked row: skipped, nothing left, the baseline unchanged; undone, the next change is a candidate", () => {
    const revoked: LogEntry[] = [created, { kind: "revoke", op: 20, event: 21 }];
    const r = run([...revoked, sync(30, "650")]);
    expect(last(r)).toMatchObject({ outcome: "skipped", revokedBy: 20, refused: false });
    expect(last(r).state).toBe(r.steps[1]?.state);
    const restored: LogEntry[] = [
      ...revoked,
      sync(30, "650"),
      { kind: "undo", op: 40, event: 41, target: 20 },
    ];
    // The skipped 650 left nothing: the baseline is still 600 at #10.
    const same = run([...restored, sync(50, "600")]);
    expect(last(same).outcome).toBe("unchanged");
    // A revoke and its undo change existence, which meets every conflict unit.
    const changed = run([...restored, sync(50, "650")]);
    expect(last(changed).outcome).toBe("pending");
    expect(f2(changed.final)).toBe("600");
  });
});

describe("the merge base of a candidate by key (09 §5.8: the earliest baseline position over the unit, no-op fields left out)", () => {
  it("on existence: a field the candidate gave as a no-op does not take the merge base back to its earlier baseline (fixed case)", () => {
    // #20 changes f1 and sends f2 unchanged (a no-op, f2's baseline stays #10); revoked at #30,
    // put back at #40; #50 changes f1 again and is a candidate on existence (it met the revoke's
    // reach); #60 goes back. f2 is a no-op at #50 too, so its baseline position (#10) is no part
    // of the merge base: that is f1's, #20, and f1 goes back to b, not to a.
    const r = run([
      sync(10, "1", { f1: "a" }),
      sync(20, "1", { f1: "b" }),
      { kind: "revoke", op: 30, event: 31 },
      { kind: "undo", op: 40, event: 41, target: 30 },
      sync(50, "1", { f1: "c" }),
      {
        kind: "resolve",
        op: 60,
        event: 61,
        decision: "take_previous",
        candidates: [51],
        unit: "existence",
      },
    ]);
    expect(r.steps.map((x) => x.refused)).toEqual([false, false, false, false, false, false]);
    expect(r.steps[4]?.syncFields?.["f2" as FieldId]?.status).toBe("noop");
    expect(r.final.fields["f1" as FieldId]?.[0]?.value).toBe("b");
    expect(f2(r.final)).toBe("1");
  });
});

describe("not modelled: refused, never judged by guess", () => {
  it("a log with writes by key and a deletion", () => {
    expect(() =>
      run([created, { kind: "deletion", op: 20, id: "dl_1", sources: ["api10"] }]),
    ).toThrow(/^not modelled: writes by source key in a log with deletions$/);
  });

  it("a write by key on a row already there without a key (the kernel would create another row)", () => {
    const byHand: WriteOp = {
      kind: "write",
      op: 10,
      event: 11,
      fields: { f1: { value: "a", sources: ["m"] }, f2: { value: "500", sources: ["m"] } },
    };
    expect(run([byHand]).final.exists).toBe(true);
    expect(() => run([byHand, sync(20, "600")])).toThrow(
      /^not modelled: a write by source key on a row without a key$/,
    );
  });

  it("a write by key on a state table, or carrying a version seen", () => {
    expect(() => evaluateLog({ kind: "state", required: ["f1"] }, [created])).toThrow(
      /^not modelled: writes by source key on a state table$/,
    );
    expect(() => run([created, { ...sync(20, "650"), seen: 10 }])).toThrow(
      /^not modelled: a write by source key carries no version seen$/,
    );
  });
});
