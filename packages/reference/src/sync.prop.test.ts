// Property tests on writes by source key in the reference evaluator alone (04-write-and-read
// «按来源键写入»; 09-references-conflict-sync «冲突判据»): no kernel. One row of a timeless table,
// created by key; then syncs, a user's changes, revokes, undos and the three ways of resolving a
// conflict, in any order. Deletions are not generated: a log with both is not modelled.

import type { FieldId } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { evaluateLog } from "./evaluate.ts";
import type {
  Evaluation,
  FieldInput,
  LogEntry,
  LogEvaluation,
  ResolveOp,
  TableSchema,
  WriteOp,
} from "./model.ts";
import { Hits, propRuns } from "./testing/prop-coverage.fixture.ts";

vi.setConfig({ testTimeout: 30_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 25_000, markInterruptAsFailure: true });

const TIMELESS: TableSchema = { kind: "timeless", required: ["f1"] };
const RUNS = propRuns(300);
const VALUES = ["1", "2", "3"];

type Step =
  | { t: "sync"; v: string; explicit: boolean; f1: string }
  | { t: "local"; v: string; lag: number }
  | { t: "revoke" }
  | { t: "undo"; back: number }
  | { t: "resolve"; decision: ResolveOp["decision"] };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 5,
    arbitrary: fc.record({
      t: fc.constant("sync" as const),
      v: fc.constantFrom(...VALUES),
      explicit: fc.boolean(),
      // f1 changes too, so that a baseline taken by row and not by field shows.
      f1: fc.constantFrom("a", "a", "b"),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("local" as const),
      v: fc.constantFrom(...VALUES),
      lag: fc.constantFrom(0, 0, 1),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant("revoke" as const) }) },
  {
    weight: 2,
    arbitrary: fc.record({ t: fc.constant("undo" as const), back: fc.nat({ max: 2 }) }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant("resolve" as const),
      decision: fc.constantFrom<ResolveOp["decision"]>(
        "take_candidate",
        "keep_effective",
        "take_previous",
      ),
    }),
  },
);

const field = (value: string, source: string, explicit = false): FieldInput => ({
  value,
  sources: [source],
  ...(explicit ? { explicit: true } : {}),
});
const sync = (op: number, v: string, explicit = false, f1 = "a"): WriteOp => ({
  kind: "write",
  op,
  event: op + 1,
  byKey: true,
  fields: { f1: field(f1, `api${op}`), f2: field(v, `api${op}`, explicit) },
});
/** A write by source key giving f2 only. */
const syncF2 = (op: number, v: string, explicit = false): WriteOp => ({
  kind: "write",
  op,
  event: op + 1,
  byKey: true,
  fields: { f2: field(v, `api${op}`, explicit) },
});

/**
 * The log the steps make, built one entry at a time: a resolution lists the open candidates on f2
 * as the log stands, and is left out when there are none; an undo takes a recorded write.
 */
function build(first: string, steps: readonly Step[]): LogEntry[] {
  const log: LogEntry[] = [sync(10, first)];
  steps.forEach((s, i) => {
    const op = 20 + 10 * i;
    const event = op + 1;
    if (s.t === "sync") log.push(sync(op, s.v, s.explicit, s.f1));
    else if (s.t === "local") {
      const seen = op - 10 * (1 + s.lag);
      log.push({ kind: "write", op, event, seen, fields: { f2: field(s.v, `user${op}`) } });
    } else if (s.t === "revoke") log.push({ kind: "revoke", op, event });
    else if (s.t === "undo") {
      const r = evaluateLog(TIMELESS, log);
      const recorded = r.steps
        .filter((x) => !x.refused && x.outcome !== "unchanged" && x.outcome !== "skipped")
        .map((x) => x.entry)
        .filter((e) => (e.kind === "write" || e.kind === "revoke") && e.op !== 10);
      const target = recorded[recorded.length - 1 - s.back]?.op;
      if (target !== undefined) log.push({ kind: "undo", op, event, target });
    } else {
      const open = evaluateLog(TIMELESS, log).final.items.filter(
        (x) => x.status === "candidate" && !x.closed && x.target === "f2",
      );
      const events = [...new Set(open.map((x) => x.event))].sort((a, b) => a - b);
      const take = events.at(-1);
      if (take === undefined) return;
      log.push({
        kind: "resolve",
        op,
        event,
        decision: s.decision,
        candidates: events,
        unit: "f2",
        ...(s.decision === "take_candidate" ? { take } : {}),
      });
    }
  });
  return log;
}

const scenario = fc.record({
  first: fc.constantFrom(...VALUES),
  steps: fc.array(step, { minLength: 1, maxLength: 7 }),
});

const nextOp = (log: readonly LogEntry[]) => Math.max(...log.map((e) => e.op)) + 10;
const f2Segments = (ev: Evaluation) => ev.fields["f2" as FieldId];

/**
 * The baseline value of field `f` as the definition gives it (09-references-conflict-sync «冲突判据»),
 * from the final state: the latest item, by operation, that a write by key gave or that a
 * take_candidate carried out of one. Undo and take_previous write-backs are not sync contributions.
 */
function baselineValue(
  log: readonly LogEntry[],
  ev: Evaluation,
  f: "f1" | "f2",
): string | undefined {
  const byKey = new Set(
    log.filter((e) => e.kind === "write" && e.byKey === true).map((e) => (e as WriteOp).event),
  );
  const takes = new Set(
    log
      .filter((e) => e.kind === "resolve" && e.decision === "take_candidate")
      .map((e) => (e as ResolveOp).event),
  );
  const sync = ev.items.filter(
    (x) =>
      x.target === f &&
      x.content.kind === "value" &&
      (byKey.has(x.event) ||
        (takes.has(x.event) && (x.carried ?? []).some((c) => byKey.has(c.event)))),
  );
  const last = sync.sort((a, b) => a.op - b.op).at(-1);
  return last?.content.kind === "value" ? (last.content.value as string) : undefined;
}

describe("writes by source key (reference evaluator)", () => {
  it("every write by key gets an outcome; unchanged and skipped ones leave the state as it was", () => {
    // Hit: a write by key that left nothing, beyond the one creating the row.
    const hits = new Hits(0.2);
    fc.assert(
      fc.property(
        scenario,
        hits.track(({ first, steps }) => {
          const r: LogEvaluation = evaluateLog(TIMELESS, build(first, steps));
          r.steps.forEach((s, i) => {
            const byKey = s.entry.kind === "write" && s.entry.byKey === true;
            expect(s.outcome !== undefined).toBe(byKey);
            if (i > 0 && (s.outcome === "unchanged" || s.outcome === "skipped")) {
              hits.hit();
              expect(s.state).toBe(r.steps[i - 1]?.state);
            }
          });
          expect(r.steps[0]?.outcome).toBe("created");
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("the baseline value sent again, citing no evidence, is unchanged (or skipped on a revoked row)", () => {
    // 04-write-and-read «三方比较»: the source did not change. The user's own changes stay, and
    // a candidate open or turned down is not raised again.
    // Hit: the value in effect is not the baseline value (a user's change, or a candidate open or
    // turned down), where sending the baseline value again could wrongly overwrite it.
    const hits = new Hits(0.3);
    fc.assert(
      fc.property(
        scenario,
        hits.track(({ first, steps }) => {
          const log = build(first, steps);
          const before = evaluateLog(TIMELESS, log);
          // Each field's baseline value: f1 varies too, and is sent as its own baseline.
          const v = baselineValue(log, before.final, "f2");
          const v1 = baselineValue(log, before.final, "f1");
          if (v === undefined || v1 === undefined) return;
          if (f2Segments(before.final)?.[0]?.value !== v) hits.hit();
          const r = evaluateLog(TIMELESS, [...log, sync(nextOp(log), v, false, v1)]);
          const s = r.steps.at(-1);
          expect(["unchanged", "skipped"]).toContain(s?.outcome);
          expect(f2Segments(r.final)).toEqual(f2Segments(before.final));
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("with the latest sync contribution in effect and nothing after it, a write by key is the ordinary write on the current version", () => {
    // Hit: the case is reached and compared.
    const hits = new Hits(0.2);
    fc.assert(
      fc.property(
        scenario,
        fc.constantFrom(...VALUES),
        fc.boolean(),
        hits.track(({ first, steps }, v, explicit) => {
          const log = build(first, steps);
          const before = evaluateLog(TIMELESS, log);
          const lastEntry = log.at(-1);
          const lastStep = before.steps.at(-1);
          // The last entry is a write by key that entered the log with f2 in effect.
          if (lastEntry?.kind !== "write" || lastEntry.byKey !== true) return;
          if (lastStep?.outcome !== "updated" && lastStep?.outcome !== "created") return;
          const st = lastStep.syncFields?.["f2" as FieldId]?.status;
          if (st !== "applied" && st !== "corroborated") return;
          const n = nextOp(log);
          // f2 only: the premise is about f2's baseline (f1's, once undone, is not its value).
          const byKey = evaluateLog(TIMELESS, [...log, syncF2(n, v, explicit)]);
          const { byKey: _, ...plain } = syncF2(n, v, explicit);
          const ordinary = evaluateLog(TIMELESS, [...log, plain]);
          const mine = (ev: Evaluation) =>
            ev.items
              .filter((x) => x.event === n + 1)
              .map((x) => `${x.target}:${x.status}`)
              .sort();
          hits.hit();
          expect(mine(byKey.final)).toEqual(mine(ordinary.final));
          expect(f2Segments(byKey.final)).toEqual(f2Segments(ordinary.final));
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });
});
