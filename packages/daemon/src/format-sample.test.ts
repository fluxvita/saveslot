// Samples of a storage format (docs/zh-CN/process/decisions/data-compatibility.md §4.5): a local
// home written through the service, packed, and read again; and every sample kept in the
// repository opened by this version. `scripts/make-format-sample.ts` runs this file with
// SAVESLOT_FORMAT_SAMPLE_OUT to leave the packed sample there.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  initLocalHome,
  localReconcileScratch,
  sessionFile,
  TenantReconciler,
} from "@fluxvita/saveslot-service";
import { osFileLock, PgliteBackend } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import {
  CURRENT_FORMAT,
  expectedOf,
  packLocalSample,
  REPO,
  SAMPLE_SWITCHED,
  SAMPLES_DIR,
  type SampleExpected,
  sampledFormats,
  unpackLocalSample,
  writeSampleHistory,
} from "./format-sample.fixture.ts";
import { type RunningService, runService } from "./service.ts";

const T = 300_000;
/** Where the script wants the sample left; a temporary directory otherwise. */
const OUT = process.env["SAVESLOT_FORMAT_SAMPLE_OUT"];
const root = mkdtempSync(join(tmpdir(), "saveslot-format-sample-"));
const running: RunningService[] = [];

const serve = async (home: string): Promise<RunningService> => {
  const s = await runService({ home, version: "sample", signals: false, log: () => {} });
  running.push(s);
  return s;
};
const stop = async (s: RunningService) => {
  await s.stop();
  running.splice(running.indexOf(s), 1);
};

afterAll(async () => {
  for (const s of [...running]) await s.stop();
  rmSync(root, { recursive: true, force: true });
}, T);

/** Opens an unpacked sample with this version and checks it against what it must hold. */
async function readSample(home: string, expected: SampleExpected): Promise<void> {
  const s = await serve(home);
  try {
    const session = readFileSync(sessionFile(home), "utf8").trim();
    const now = await expectedOf(home, session, { switched: expected.switched === true });
    // Reads made since the sample was packed are more reads, and nothing else.
    expect({ ...now, reads_at_least: expected.reads_at_least }).toEqual(expected);
    expect(now.reads_at_least).toBeGreaterThanOrEqual(expected.reads_at_least);
    // K12: the log replayed into an empty storage gives the tables the sample holds.
    const t = s.tenant;
    if (t === undefined) throw new Error("the sample's tenant is not open");
    const r = await new TenantReconciler({
      scratch: localReconcileScratch({ home, backend: testBackend() }),
    }).reconcile(t.tenant, (fn) => fn(t.store));
    expect(r.mismatches).toEqual([]);
    expect(r.compared_to).toBe(expected.log_end);
    expect(r.tables.length).toBeGreaterThan(10);
  } finally {
    await stop(s);
  }
}

describe("a sample of the current storage format, local mode", () => {
  const home = join(root, "home");
  const out = OUT ?? join(root, "sample");
  let expected: SampleExpected;

  beforeAll(async () => {
    await initLocalHome({
      home,
      // Left for the repository: made as `saveslot init` makes a home, not from the tests' template.
      backend: OUT === undefined ? testBackend() : new PgliteBackend(),
      lock: osFileLock,
      now: new Date().toISOString(),
    });
    const s = await serve(home);
    expected = await writeSampleHistory(home, readFileSync(sessionFile(home), "utf8").trim(), {
      switched: SAMPLE_SWITCHED,
    });
    await stop(s);
    packLocalSample(home, out, expected);
  }, T);

  it("holds what the history wrote", () => {
    expect(expected).toMatchObject({
      storage_format: CURRENT_FORMAT,
      expenses: {
        lunch: { date: "2026-11-02", amount: 54 },
        taxi: { date: "2026-11-02", amount: 32 },
        snack: { date: "2026-11-04", amount: 9 },
      },
      budget: { "2026-10-05": 5000, "2026-11-15": 4000 },
      rides: SAMPLE_SWITCHED ? {} : { "k-1": 12, "k-2": 21 },
      open_items: { conflict: 1, awaiting_confirmation: 1 },
    });
    expect(expected.switched).toBe(SAMPLE_SWITCHED ? true : undefined);
    expect(expected.expenses["coffee"]).toBeUndefined();
    expect(expected.reads_at_least).toBeGreaterThanOrEqual(6);
  });

  it(
    "packed and unpacked elsewhere, opens with the same values, and replays to the same tables",
    async () => {
      const copy = join(root, "unpacked");
      await readSample(copy, unpackLocalSample(out, copy));
    },
    T,
  );
});

// None is kept until the first release's sample is added; then every format's is read.
const KEPT = sampledFormats("local");
describe.skipIf(KEPT.length === 0)("the samples kept in the repository, local mode", () => {
  it.each(KEPT)(
    "$name: opens with this version, with the values it was packed with",
    async ({ format, name }) => {
      const copy = join(root, `kept-${name.replace("/", "-")}`);
      const expected = unpackLocalSample(join(REPO, SAMPLES_DIR, name), copy);
      expect(expected.storage_format).toBe(format);
      await readSample(copy, expected);
    },
    T,
  );
});
