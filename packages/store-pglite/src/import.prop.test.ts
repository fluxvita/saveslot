// Import into an empty tenant against the reference evaluator (02-architecture §8 «格式版本、导出、
// 导入与恢复» steps ① and ②, §11 «测试矩阵»; 03-data-model/03-deletion.md: replay compared with
// the reference evaluator). A judged scenario is written into a stored log, the log written out as
// an export file (09-event-format §8), and the file imported into an empty storage. Then:
//   ① the staging storage's log is the source's, byte for byte (headers, hashes, index columns,
//      every content block);
//   ② its materialized state and physical tables are the source's;
//   ③ the row or entity in its version table's open cells is what the reference evaluator gives
//      for the scenario's operations.
// The body comes cut at a random byte size, the log in random segments, and the staging storage
// is written in random batches: none of these may change what lands. Deletions are not in these
// samples: apply has no deletion events in this version.

import { importIntoStaging, readTail } from "@fluxvita/saveslot-kernel";
import { type Decision, scenario } from "@fluxvita/saveslot-kernel/testing";
import { evaluateLog, type Op, type TableSchema } from "@fluxvita/saveslot-reference";
import { EVENT, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bodyOf, exportFileOf, replicated } from "./testing/export-file.fixture.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import {
  genesisInto,
  openView,
  referenceView,
  TENANT,
  writeScenario,
} from "./testing/write-scenario.fixture.ts";

vi.setConfig({ testTimeout: 600_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 550_000, markInterruptAsFailure: true });

const RUNS = propRuns(20);
/** `PROP_SEED` fixes the seed (and `PROP_PATH` with it replays one counterexample). */
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);

/** How the file comes: body chunk size, where the log is cut into segments, events per batch. */
const delivery = fc.record({
  size: fc.integer({ min: 1, max: 5000 }),
  cuts: fc.array(fc.nat(), { maxLength: 3 }),
  batch: fc.integer({ min: 1, max: 50 }),
});
type Delivery = { size: number; cuts: number[]; batch: number };

let source: ReusableStore;
let staging: ReusableStore;
beforeAll(async () => {
  source = await openReusable("saveslot-import-source-");
  staging = await openReusable("saveslot-import-staging-");
}, 120_000);
afterAll(async () => {
  await source?.close();
  await staging?.close();
}, 120_000);

/** Exports the source and imports it with `d`; the source's last `seq`. */
async function roundTrip(d: Delivery): Promise<number> {
  const end = (await source.store.read(readTail))?.seq ?? 0;
  const cuts = [...new Set(d.cuts.map((c) => (end > 1 ? 1 + (c % (end - 1)) : 1)))]
    .filter((c) => c < end)
    .sort((a, b) => a - b);
  const file = await exportFileOf(source.store, TENANT, cuts);
  await staging.reset();
  const staged = await importIntoStaging({
    staging: staging.store,
    body: bodyOf(file, d.size),
    batch: d.batch,
  });
  expect({ upto: staged.importedUpto, events: staged.events, segments: staged.segments }).toEqual({
    upto: end,
    events: end,
    segments: cuts.length + 1,
  });
  const [from, to] = [await source.store.read(replicated), await staging.store.read(replicated)];
  // ① the log, byte for byte.
  expect({ events: to["events"], content: to["content"] }).toEqual({
    events: from["events"],
    content: from["content"],
  });
  // ② the materialized state and the physical tables.
  expect(to).toEqual(from);
  return end;
}

it("a log of the genesis event alone", async () => {
  await source.reset();
  await genesisInto(source.store);
  expect(await roundTrip({ size: 3, cuts: [], batch: 1 })).toBe(1);
});

describe.each([
  ["state", STATE, true],
  ["event", EVENT, false],
] as const)("%s table", (_, schema: TableSchema, isState) => {
  const seen = { samples: 0, skipped: 0 };
  const hits: Record<string, number> = {};

  const checkSample = async (ops: readonly Op[], decisions: readonly Decision[], d: Delivery) => {
    await source.reset();
    const steps = await writeScenario(source.store, schema, isState, ops, decisions);
    if (steps === undefined) {
      seen.skipped++;
      return;
    }
    seen.samples++;
    await roundTrip(d);
    // ③ the imported row or entity is the reference evaluator's.
    const ref = referenceView(
      evaluateLog(
        schema,
        steps.map((s) => s.op),
      ).final,
      isState,
    );
    const got = await staging.store.read((tx) => openView(tx, isState, Object.keys(ref.fields)));
    expect(got).toEqual(ref);
    for (const s of steps) {
      const r = s.judgement.record;
      const k = r.kind === "undo" ? `undo ${r.status}` : r.kind;
      hits[k] = (hits[k] ?? 0) + 1;
    }
  };

  it("an imported log is the source's, and its state the reference evaluator's", async () => {
    await fc.assert(
      fc.asyncProperty(scenario(isState), delivery, ({ ops, decisions }, d) =>
        checkSample(ops, decisions, d),
      ),
      {
        numRuns: RUNS,
        ...(SEED !== undefined ? { seed: SEED } : {}),
        ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
      },
    );
    // What must be reached is built in below; this only guards against a generator gone
    // degenerate as a whole.
    expect(seen.samples).toBeGreaterThan(RUNS / 2);
  });

  // A revoke, an undo of it, and an undo of that undo; one-byte chunks, a segment per event, a
  // batch per event: every boundary falls everywhere it can.
  it("a revoke, its undo and the undo of the undo, delivered a byte and an event at a time", async () => {
    const valid = isState
      ? { valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } } }
      : {};
    const ops = [
      {
        kind: "write",
        op: 20,
        event: 21,
        ...valid,
        fields: { f2: { value: "1", sources: ["S20"] } },
      },
      { kind: "revoke", op: 30, event: 31, seen: 20, ...valid },
      { kind: "undo", op: 40, event: 41, target: 30, seen: 30 },
      { kind: "undo", op: 50, event: 51, target: 40, seen: 40 },
    ] as Op[];
    const before = { ...hits };
    await checkSample(ops, [], {
      size: 1,
      cuts: Array.from({ length: 60 }, (_, i) => i),
      batch: 1,
    });
    expect(seen.samples).toBeGreaterThan(0);
    expect({
      revoke: (hits["revoke"] ?? 0) > (before["revoke"] ?? 0),
      undo: (hits["undo applied"] ?? 0) > (before["undo applied"] ?? 0),
    }).toEqual({ revoke: true, undo: true });
  });
});
