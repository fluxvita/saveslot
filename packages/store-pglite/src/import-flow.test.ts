// Import into an empty tenant, the whole flow and its re-entry (02-architecture §8 «格式版本、导出、
// 导入与恢复» steps ①–⑥ and «重入», §4 `openTenant`, §11 "an import killed by force after each step
// and then opened again"; 04-contract §17 `import`). The file of a source tenant is replayed into a
// staging storage, the import's event appended there, then steps ④–⑥ run against an empty target
// tenant with the file anchor store. A variable plays the tenant directory: `swap` makes the
// staging storage the target's.
//
// The flow is stopped after each step and the tenant opened again, as the host does: the anchor
// and the log decide (`openTenantDecision`) and the host finishes or rolls back. After each stop the
// tenant is either still empty, and a new import of the same file succeeds, or the import is
// complete and the anchor agrees with the log (the restore count the import event's, the high water
// the log's end, no deletion entry). Runs on each backend. Fictional IDs and data.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AnchorStore,
  abortImportOnOpen,
  appendImportEvent,
  appendOperation,
  createOpsContext,
  createTenant,
  finishImport,
  ImportEventError,
  ImportInProgress,
  ImportLineTooLarge,
  ImportRejected,
  importContractError,
  importEventInLog,
  importIntoStaging,
  MAX_IMPORT_LINE_BYTES,
  newImportId,
  OpsError,
  openTenantDecision,
  readTail,
  restorePoint,
  runImport,
  type TenantStore,
  writeExport,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { EVENT } from "@fluxvita/saveslot-reference/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { bodyOf, exportFileOf, exportLinesOf } from "./testing/export-file.fixture.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";
import { TENANT as SOURCE, writeScenario } from "./testing/write-scenario.fixture.ts";

const TARGET = `tn_${"9".repeat(26)}` as `tn_${string}`;
const SECOND = `tn_${"6".repeat(26)}` as `tn_${string}`;
const IMPORTER = `u_${"7".repeat(26)}`;
const T = 120_000;

// The stores and directories a case made, closed and removed after it: each PGlite instance holds
// its memory until closed, and a file keeping every case's open until its end ran into gigabytes.
// The source, written once, is the file's.
let roots: string[] = [];
let stores = new Set<TenantStore>();
const fresh = (name: string) => {
  const root = mkdtempSync(join(tmpdir(), `saveslot-import-flow-${name}-`));
  roots.push(root);
  return root;
};
async function open(name: string): Promise<TenantStore> {
  const s = await testBackend().open(
    { kind: "pglite", dir: join(fresh(name), "tenant") },
    { create: true },
  );
  stores.add(s);
  return s;
}

/** Closes the stores and removes the directories made since the last call. */
async function closeAll(): Promise<void> {
  const [s, r] = [stores, roots];
  stores = new Set();
  roots = [];
  await Promise.allSettled([...s].map((x) => x.close()));
  for (const root of r) rmSync(root, { recursive: true, force: true });
}

let source: TenantStore;
let file: string[];
let sourceEnd: number;
let sourceRoot: string | undefined;

beforeAll(async () => {
  source = await open("source");
  // The source stays open for the file: it is not one of the cases' stores.
  stores.delete(source);
  sourceRoot = roots.pop();
  const steps = await writeScenario(
    source,
    EVENT,
    false,
    [
      { kind: "write", op: 20, event: 21, fields: { f2: { value: "1", sources: ["S20"] } } },
      { kind: "revoke", op: 30, event: 31, seen: 20 },
    ] as never,
    [],
  );
  if (steps === undefined) throw new Error("the scenario could not be written");
  file = await exportFileOf(source, SOURCE);
  sourceEnd = (await source.read(readTail))?.seq ?? 0;
}, T);

afterEach(closeAll, T);

afterAll(async () => {
  await closeAll();
  await source?.close();
  if (sourceRoot !== undefined) rmSync(sourceRoot, { recursive: true, force: true });
}, T);

/** A target tenant: its genesis, an anchor store of its own, and the tenant directory's pointer. */
async function target(tenant: string = TARGET) {
  const store = await open("target");
  await createTenant(
    store,
    createOpsContext({
      tenant,
      actor: IMPORTER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 86_400_000,
      now: "2026-11-11T00:00:00.000Z",
      confirmation: null,
    }),
  );
  const anchor: AnchorStore = openFileAnchorStore(join(fresh("anchor"), "anchor.json"));
  // The target's high water as a tenant that served: its genesis.
  await anchor.advanceHighWater(tenant, 1);
  return { dir: { current: store }, anchor };
}
type Target = Awaited<ReturnType<typeof target>>;

/** What step ③ returned for each staging storage: its import event's `seq` and `imported_upto`. */
const stepThree = new Map<TenantStore, { importSeq: number; importedUpto: number }>();
/** `runImport`'s staging arguments for `staging`, as step ③ left them. */
const stagedFor = (staging: TenantStore) => {
  const three = stepThree.get(staging);
  if (three === undefined) throw new Error("the staging storage was not staged");
  return {
    staging,
    importSeq: three.importSeq as never,
    importedUpto: three.importedUpto as never,
  };
};

/** Steps ① to ③ into `staging`: the file, then the import's event. */
async function stage(staging: TenantStore) {
  const s = await importIntoStaging({ staging, body: bodyOf(file, 999) });
  const ev = await appendImportEvent(staging, {
    user: IMPORTER as never,
    tenant: TARGET as never,
    manifest: s.manifest,
    now: "2026-11-11T01:00:00.000Z" as never,
  });
  const three = { importSeq: ev.seq, importedUpto: ev.importedUpto };
  stepThree.set(staging, three);
  return three;
}

/** Steps ① to ③: the file into a new staging storage, the import's event after it. */
async function staged() {
  const staging = await open("staging");
  await stage(staging);
  return staging;
}

/** Discards a staging storage; nothing when it is gone (as a host's directory removal). */
const discard = (t: Target, staging: TenantStore) => async () => {
  if (!stores.has(staging) || t.dir.current === staging) return;
  stores.delete(staging);
  await staging.close();
};

/**
 * The tenant opened again, as the host does: the anchor and the log decide, and the host finishes
 * or rolls back the import in progress. Returns the decision taken.
 */
async function reopen(t: Target, staging?: TenantStore) {
  const a = await t.anchor.read(TARGET);
  const store = t.dir.current;
  const tail = await store.read(readTail);
  const decision = openTenantDecision({
    importInProgress: a.importInProgress,
    importEventInLog:
      a.importInProgress === undefined ? undefined : await store.read(importEventInLog),
    restoreInProgress: a.restoreInProgress,
    logEnd: tail?.seq ?? 0,
    highWater: a.highWater,
  });
  if (decision.kind === "import_finish") {
    await finishImport({ store, anchor: t.anchor, tenant: TARGET, importId: decision.importId });
  } else if (decision.kind === "import_abort") {
    await abortImportOnOpen({
      anchor: t.anchor,
      tenant: TARGET,
      importId: decision.importId,
      discardStaging: staging === undefined ? async () => {} : discard(t, staging),
    });
  }
  return decision.kind;
}

/** The target as it is now: still empty, or the import complete. */
async function outcome(t: Target): Promise<"empty" | "complete"> {
  const a = await t.anchor.read(TARGET);
  const store = t.dir.current;
  const tail = await store.read(readTail);
  expect(a.importInProgress).toBeUndefined();
  expect(a.deletions).toEqual([]);
  if (tail?.seq === 1) {
    expect({ restoreCount: a.restoreCount, highWater: a.highWater }).toEqual({
      restoreCount: 0,
      highWater: 1,
    });
    return "empty";
  }
  // Complete: the anchor agrees with the log, and the log is the source's and its import.
  const latest = await store.read((tx) => restorePoint(tx));
  expect(await store.read(importEventInLog)).toBe(true);
  expect({ highWater: a.highWater, restoreCount: a.restoreCount }).toEqual({
    highWater: tail?.seq,
    restoreCount: latest.restoreCount,
  });
  expect(latest).toEqual({ restoreCount: 1, seq: sourceEnd + 1, point: sourceEnd });
  expect(await store.read((tx) => exportLinesOf(tx, { upto: sourceEnd }))).toEqual(
    await source.read((tx) => exportLinesOf(tx)),
  );
  return "complete";
}

/** Steps ④–⑥ as the import runs them, stopped after step `stop` (a kill), or run through. */
async function steps(t: Target, staging: TenantStore, importId: string, stop?: 4 | 5) {
  const before = await t.dir.current.read(readTail);
  expect(before?.seq).toBe(1);
  await t.anchor.beginImport(TARGET, importId);
  if (stop === 4) return;
  t.dir.current = staging;
  if (stop === 5) return;
  await finishImport({ store: staging, anchor: t.anchor, tenant: TARGET, importId });
}

/** A new import of the same file into `t`, run through: it must succeed. */
async function importAgain(t: Target) {
  const staging = await staged();
  await steps(t, staging, newImportId());
  expect(await reopen(t)).toBe("serve");
  expect(await outcome(t)).toBe("complete");
}

describe("each step stopped, the tenant opened again (§11)", () => {
  it(
    "after ③, before ④: no marker; the tenant serves, still empty; a new import succeeds",
    async () => {
      const t = await target();
      await staged(); // left behind: the host clears it when it opens the tenant
      expect(await reopen(t)).toBe("serve");
      expect(await outcome(t)).toBe("empty");
      await importAgain(t);
    },
    T,
  );

  it(
    "after ④, before ⑤: the import is rolled back, the staging storage discarded; a new import succeeds",
    async () => {
      const t = await target();
      const staging = await staged();
      await steps(t, staging, newImportId(), 4);
      expect(await reopen(t, staging)).toBe("import_abort");
      expect(stores.has(staging)).toBe(false);
      expect(await reopen(t)).toBe("serve");
      expect(await outcome(t)).toBe("empty");
      await importAgain(t);
    },
    T,
  );

  it(
    "after ⑤, before ⑥: the import is finished; the anchor agrees with the log",
    async () => {
      const t = await target();
      const staging = await staged();
      await steps(t, staging, newImportId(), 5);
      expect(await reopen(t, staging)).toBe("import_finish");
      expect(stores.has(staging)).toBe(true);
      expect(await reopen(t)).toBe("serve");
      expect(await outcome(t)).toBe("complete");
    },
    T,
  );

  it(
    "after ⑥: the tenant serves; finishing again changes nothing",
    async () => {
      const t = await target();
      const staging = await staged();
      const importId = newImportId();
      await steps(t, staging, importId);
      expect(await reopen(t)).toBe("serve");
      expect(await outcome(t)).toBe("complete");
      const anchor = await t.anchor.read(TARGET);
      expect(
        await finishImport({ store: staging, anchor: t.anchor, tenant: TARGET, importId }),
      ).toEqual({ finished: false, highWater: anchor.highWater, restoreCount: 1 });
      expect(await t.anchor.read(TARGET)).toEqual(anchor);
    },
    T,
  );

  it(
    "a roll back stopped after the staging storage is discarded, before the marker is cleared: it runs again",
    async () => {
      const t = await target();
      const staging = await staged();
      const importId = newImportId();
      await steps(t, staging, importId, 4);
      await discard(t, staging)(); // the host's first step, then the kill
      expect((await t.anchor.read(TARGET)).importInProgress).toBe(importId);
      expect(await reopen(t, staging)).toBe("import_abort");
      expect(await reopen(t)).toBe("serve");
      expect(await outcome(t)).toBe("empty");
      await importAgain(t);
    },
    T,
  );
});

/**
 * `runImport` into `t` expected to refuse: nothing swapped, the anchor as it was (no marker).
 * Returns the error's code and reason. `anchor` stands for the target's anchor store, as a seam.
 */
async function refused(t: Target, anchor: AnchorStore = t.anchor) {
  const before = await t.anchor.read(TARGET);
  const staging = await staged();
  let swapped = false;
  const e = await runImport({
    target: t.dir.current,
    anchor,
    tenant: TARGET as never,
    importId: newImportId(),
    ...stagedFor(staging),
    swap: async () => {
      swapped = true;
      return staging;
    },
  }).then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(swapped).toBe(false);
  expect(await t.anchor.read(TARGET)).toEqual(before);
  if (e instanceof OpsError) return { code: e.code, reason: e.detail.reason };
  return importContractError(e) ?? e;
}

/** `anchor` with `before` run ahead of its `beginImport`. Methods bound to the store itself. */
function beforeBegin(anchor: AnchorStore, before: () => Promise<void>): AnchorStore {
  return new Proxy(anchor, {
    get(target, p) {
      if (p === "beginImport") {
        return async (...a: Parameters<AnchorStore["beginImport"]>) => {
          await before();
          return target.beginImport(...a);
        };
      }
      const v = Reflect.get(target, p);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}

/** One event appended to `store`'s log after its genesis. */
const appendOne = (store: TenantStore) =>
  store.write((tx) =>
    appendOperation(tx, {
      actor: IMPORTER as never,
      now: "2026-11-11T00:31:00.000Z" as never,
      events: [
        {
          type: "principal.revoked",
          blocks: {
            ctx: { now: "2026-11-11T00:31:00.000Z", ruleset_version: 1 },
            principal: { principal: `ci_${"3".repeat(26)}` },
          },
        } as never,
      ],
    }),
  );

describe("killed after ④ and after ⑤, opened again from disk", () => {
  // Nothing open is carried over a kill: the target's storage, the staging storage and the anchor
  // store are closed, and opened again from their directories and file. A pointer file plays the
  // tenant directory; the swap writes it, the next opening reads it.
  const KILLED = "PROBE killed";
  async function killed(stop: 4 | 5) {
    const root = fresh("disk");
    const pointer = join(root, "tenant-directory");
    const anchorFile = join(root, "anchor.json");
    const targetDir = join(root, "target");
    const stagingDir = join(root, "staging");
    const openDir = (dir: string, create = false) =>
      testBackend().open({ kind: "pglite", dir }, { create });
    {
      const store = await openDir(targetDir, true);
      await createTenant(
        store,
        createOpsContext({
          tenant: TARGET,
          actor: IMPORTER,
          trigger: null,
          task: null,
          visibility: { kind: "all" },
          idempotency_key_window: 86_400_000,
          idempotency_window: 86_400_000,
          now: "2026-11-11T00:00:00.000Z",
          confirmation: null,
        }),
      );
      await store.close();
      await openFileAnchorStore(anchorFile).advanceHighWater(TARGET, 1);
      writeFileSync(pointer, targetDir);
    }
    // ①–③, then ④–⑥ killed: the swap throws after its durable step (⑤), or in place of it
    // (after ④). The staging storage stays open until the swap, which closes it.
    {
      const staging = await openDir(stagingDir, true);
      const three = await stage(staging);
      const target = await openDir(readFileSync(pointer, "utf8"));
      const e = await runImport({
        target,
        anchor: openFileAnchorStore(anchorFile),
        tenant: TARGET as never,
        importId: newImportId(),
        staging,
        importSeq: three.importSeq as never,
        importedUpto: three.importedUpto as never,
        swap: async () => {
          await staging.close();
          if (stop === 5) writeFileSync(pointer, stagingDir);
          throw new Error(KILLED);
        },
      }).then(
        () => undefined,
        (x: unknown) => x,
      );
      expect((e as Error).message).toBe(KILLED);
      await target.close();
    }
    let discarded = false;
    /** Opened from disk, as the host opens it: decided, the re-entry run, closed. */
    const openOnce = async () => {
      const anchor = openFileAnchorStore(anchorFile);
      const store = await openDir(readFileSync(pointer, "utf8"));
      try {
        const a = await anchor.read(TARGET);
        const decision = openTenantDecision({
          importInProgress: a.importInProgress,
          importEventInLog:
            a.importInProgress === undefined ? undefined : await store.read(importEventInLog),
          restoreInProgress: a.restoreInProgress,
          logEnd: (await store.read(readTail))?.seq ?? 0,
          highWater: a.highWater,
        });
        if (decision.kind === "import_finish") {
          await finishImport({ store, anchor, tenant: TARGET, importId: decision.importId });
        } else if (decision.kind === "import_abort") {
          await abortImportOnOpen({
            anchor,
            tenant: TARGET,
            importId: decision.importId,
            discardStaging: async () => {
              discarded = true;
            },
          });
        }
        return decision.kind;
      } finally {
        await store.close();
      }
    };
    const first = await openOnce();
    const second = await openOnce();
    const anchor = await openFileAnchorStore(anchorFile).read(TARGET);
    const store = await openDir(readFileSync(pointer, "utf8"));
    try {
      return {
        first,
        second,
        discarded,
        serving: readFileSync(pointer, "utf8") === stagingDir ? "staging" : "target",
        logEnd: (await store.read(readTail))?.seq,
        latest: await store.read((tx) => restorePoint(tx)),
        anchor: {
          marker: anchor.importInProgress,
          highWater: anchor.highWater,
          restoreCount: anchor.restoreCount,
        },
      };
    } finally {
      await store.close();
    }
  }

  it(
    "after ④: rolled back, the log the genesis event only, the marker cleared",
    async () => {
      expect(await killed(4)).toEqual({
        first: "import_abort",
        second: "serve",
        discarded: true,
        serving: "target",
        logEnd: 1,
        latest: { restoreCount: 0, seq: null, point: null },
        anchor: { marker: undefined, highWater: 1, restoreCount: 0 },
      });
    },
    T,
  );

  it(
    "after ⑤: finished, the high water the log's end, the restore count 1, the marker cleared",
    async () => {
      expect(await killed(5)).toEqual({
        first: "import_finish",
        second: "serve",
        discarded: false,
        serving: "staging",
        logEnd: sourceEnd + 1,
        latest: { restoreCount: 1, seq: sourceEnd + 1, point: sourceEnd },
        anchor: { marker: undefined, highWater: sourceEnd + 1, restoreCount: 1 },
      });
    },
    T,
  );
});

describe("runImport (④–⑥ in one call)", () => {
  it(
    "imports into an empty tenant; the anchor's high water becomes the log's end, above the genesis's",
    async () => {
      const t = await target();
      expect((await t.anchor.read(TARGET)).highWater).toBe(1);
      const staging = await staged();
      const r = await runImport({
        target: t.dir.current,
        anchor: t.anchor,
        tenant: TARGET as never,
        importId: newImportId(),
        ...stagedFor(staging),
        swap: async () => {
          t.dir.current = staging;
          return staging;
        },
      });
      expect(r).toEqual({ finished: true, highWater: sourceEnd + 1, restoreCount: 1 });
      expect(await outcome(t)).toBe("complete");
    },
    T,
  );

  it(
    "refuses a tenant that is not empty, by its log or by its anchor: tenant_not_empty, nothing changed",
    async () => {
      const refusal = (t: Target) => refused(t);
      // A log with more than the genesis event (appended only).
      const byLog = await target();
      await appendOne(byLog.dir.current);
      expect(await refusal(byLog)).toEqual({
        code: "invalid_argument",
        reason: "tenant_not_empty",
      });
      // An anchor with a restore count (a restore happened there).
      const byAnchor = await target();
      await byAnchor.anchor.beginRestore(TARGET, `rs_${"4".repeat(16)}`);
      await byAnchor.anchor.endRestore(TARGET, `rs_${"4".repeat(16)}`, 1);
      expect(await refusal(byAnchor)).toEqual({
        code: "invalid_argument",
        reason: "tenant_not_empty",
      });
    },
    T,
  );

  it(
    "a write committed before the marker is set: seen once it is (④), the marker cleared, the write kept",
    async () => {
      const t = await target();
      // The write lands after any look at the log before ④ and before the marker.
      const anchor = beforeBegin(t.anchor, () => appendOne(t.dir.current).then(() => {}));
      expect(await refused(t, anchor)).toEqual({
        code: "invalid_argument",
        reason: "tenant_not_empty",
      });
      expect((await t.dir.current.read(readTail))?.seq).toBe(2);
    },
    T,
  );

  it(
    "an anchor whose high water is above the staging log's end: refused before ④, no marker, the target as it was (internal)",
    async () => {
      const t = await target();
      await t.anchor.advanceHighWater(TARGET, 999);
      const opened = await reopen(t);
      expect(await refused(t)).toEqual({ code: "internal", reason: undefined });
      expect((await t.dir.current.read(readTail))?.seq).toBe(1);
      // Opened again, the tenant is as it was before the import, not one stuck in its re-entry.
      expect(await reopen(t)).toBe(opened);
      expect(opened).toBe("not_implemented");
    },
    T,
  );

  it(
    "another import holding the tenant (its marker set): unavailable (importing), its marker kept",
    async () => {
      const t = await target();
      await t.anchor.beginImport(TARGET, newImportId());
      expect(await refused(t)).toEqual({ code: "unavailable", reason: "importing" });
    },
    T,
  );
});

/** Where `store`'s log ends, as a manifest names it. */
async function logEndOf(store: TenantStore) {
  const tail = await store.read(readTail);
  return { upto: tail?.seq as never, upto_hash: tail?.hash as never };
}

/** `lines` (the file's, or a staging storage's) imported into the empty tenant `t`, run through. */
async function importInto(t: Target, tenant: string, lines: readonly string[]) {
  const staging = await open("staging");
  const s = await importIntoStaging({ staging, body: bodyOf(lines, 999) });
  const ev = await appendImportEvent(staging, {
    user: IMPORTER as never,
    tenant: tenant as never,
    manifest: s.manifest,
    now: "2026-11-11T01:00:00.000Z" as never,
  });
  const r = await runImport({
    target: t.dir.current,
    anchor: t.anchor,
    tenant: tenant as never,
    importId: newImportId(),
    staging,
    importSeq: ev.seq,
    importedUpto: ev.importedUpto,
    swap: async () => {
      t.dir.current = staging;
      return staging;
    },
  });
  return { staged: s, ev, result: r };
}

describe("the file's end is the manifest's (02-architecture §8 «格式版本、导出、导入与恢复»)", () => {
  it(
    "an export of an imported tenant, nothing written since, ends in its import's event; another empty tenant imports it",
    async () => {
      const first = await target();
      const a = await importInto(first, TARGET, file);
      expect(a.result).toEqual({ finished: true, highWater: sourceEnd + 1, restoreCount: 1 });
      // The export as the kernel writes it: the log's end is the first import's event.
      const again: string[] = [];
      await first.dir.current.read((tx) =>
        writeExport(tx, { exportedAt: "2026-11-11T02:00:00.000Z" as never }, async (l) => {
          again.push(l.replace(/\n$/, ""));
        }),
      );
      expect(JSON.parse(again.at(-1) as string).h).toMatchObject({
        type: "tenant.imported",
        seq: sourceEnd + 1,
      });
      const second = await target(SECOND);
      const b = await importInto(second, SECOND, again);
      expect(b.staged.manifest).toMatchObject({ upto: sourceEnd + 1, restore_count: 1 });
      expect(b.result).toEqual({ finished: true, highWater: sourceEnd + 2, restoreCount: 2 });
      expect(await second.anchor.read(SECOND)).toMatchObject({
        restoreCount: 2,
        highWater: sourceEnd + 2,
      });
      // The second tenant's log is the first's and its own import.
      expect(
        await second.dir.current.read((tx) => exportLinesOf(tx, { upto: sourceEnd + 1 })),
      ).toEqual(await first.dir.current.read((tx) => exportLinesOf(tx)));
    },
    T,
  );

  it(
    "a file cut in segments: the import's event follows the last segment's end",
    async () => {
      const t = await target();
      const r = await importInto(t, TARGET, await exportFileOf(source, SOURCE, [1, 4]));
      expect(r.staged).toMatchObject({ segments: 3, manifest: { upto: sourceEnd } });
      expect(r.ev).toMatchObject({ seq: sourceEnd + 1, importedUpto: sourceEnd });
      expect(await outcome(t)).toBe("complete");
    },
    T,
  );
});

/**
 * `runImport` into `t` from `staging` with step ③'s values as given: expected to refuse before ④,
 * nothing swapped and the anchor as it was (no marker). Returns the error's code.
 */
async function refusedBeforeFour(
  t: Target,
  staging: TenantStore,
  three: { importSeq: number; importedUpto: number },
  tenant: string = TARGET,
) {
  const before = await t.anchor.read(tenant);
  let swapped = false;
  const e = await runImport({
    target: t.dir.current,
    anchor: t.anchor,
    tenant: tenant as never,
    importId: newImportId(),
    staging,
    importSeq: three.importSeq as never,
    importedUpto: three.importedUpto as never,
    swap: async () => {
      swapped = true;
      t.dir.current = staging;
      return staging;
    },
  }).then(
    (r) => r,
    (x: unknown) => x,
  );
  expect(swapped).toBe(false);
  expect(await t.anchor.read(tenant)).toEqual(before);
  return e instanceof OpsError ? e.code : e;
}

/** A tombstone appended to `staging`'s log: by `trigger` for `reason` (09 §5.9). */
const appendTombstone = (staging: TenantStore, trigger: string, reason: string) =>
  staging.write((tx) =>
    appendOperation(tx, {
      actor: "system" as never,
      now: "2026-11-11T01:00:00.000Z" as never,
      events: [
        {
          type: "deletion.executed",
          trigger,
          slot: `sl_${"3".repeat(16)}`,
          blocks: {
            target: { deletion: `pi_${"5".repeat(16)}`, reason },
            positions: [],
          },
        } as never,
      ],
    }),
  );

describe("runImport checks before ④ that the staging log ends in what step ③ appended (§8)", () => {
  it(
    "③ skipped, the file an export of an imported tenant ending in its import's event: internal",
    async () => {
      const first = await target();
      await importInto(first, TARGET, file);
      const again: string[] = [];
      await first.dir.current.read((tx) =>
        writeExport(tx, { exportedAt: "2026-11-11T02:00:00.000Z" as never }, async (l) => {
          again.push(l.replace(/\n$/, ""));
        }),
      );
      const second = await target(SECOND);
      const staging = await open("staging");
      const s = await importIntoStaging({ staging, body: bodyOf(again, 999) });
      // The host goes on to ④ with the staged file's end, its last event the first import's.
      expect(
        await refusedBeforeFour(
          second,
          staging,
          { importSeq: s.importedUpto, importedUpto: s.importedUpto },
          SECOND,
        ),
      ).toBe("internal");
      // Still empty: its genesis only, no marker, the anchor as a tenant that served.
      expect((await second.dir.current.read(readTail))?.seq).toBe(1);
      expect(await second.anchor.read(SECOND)).toMatchObject({ highWater: 1, restoreCount: 0 });
      expect((await second.anchor.read(SECOND)).importInProgress).toBeUndefined();
    },
    T,
  );

  it(
    "a tombstone of a placeholder after ③'s event passes: ④ and the swap run, and ⑥ refuses it as it refuses any deletion event today",
    async () => {
      // ③ adds these after the import's event (09 §5.2); that step is not in this version, and
      // finishImport refuses a log with deletion events until their registry is built. Once both
      // are in, this import completes.
      const t = await target();
      const staging = await staged();
      const three = stepThree.get(staging);
      if (three === undefined) throw new Error("not staged");
      await appendTombstone(staging, "import", "import_placeholder");
      const importId = newImportId();
      let swapped = false;
      const e = await runImport({
        target: t.dir.current,
        anchor: t.anchor,
        tenant: TARGET as never,
        importId,
        ...stagedFor(staging),
        swap: async () => {
          swapped = true;
          t.dir.current = staging;
          return staging;
        },
      }).then(
        (r) => r,
        (x: unknown) => x,
      );
      expect(swapped).toBe(true);
      expect((await t.anchor.read(TARGET)).importInProgress).toBe(importId);
      expect(e).toBeInstanceOf(OpsError);
      expect((e as OpsError).message).toBe(
        "finishImport: the imported log holds deletion events; their registry is not built yet",
      );
    },
    T,
  );

  it.each([
    ["an event of another type", (s: TenantStore) => appendOne(s)],
    ["a tombstone of another reason", (s: TenantStore) => appendTombstone(s, "import", "expiry")],
    [
      "a tombstone of another trigger",
      (s: TenantStore) => appendTombstone(s, "deletion_expiry", "import_placeholder"),
    ],
  ])(
    "%s after ③'s event: internal",
    async (_, append) => {
      const t = await target();
      const staging = await staged();
      const three = stepThree.get(staging);
      if (three === undefined) throw new Error("not staged");
      await append(staging);
      expect(await refusedBeforeFour(t, staging, three)).toBe("internal");
    },
    T,
  );

  it(
    "an event after ③'s, the import event's seq given as the log's end: its latest import event is not there (internal)",
    async () => {
      const t = await target();
      const staging = await staged();
      const three = stepThree.get(staging);
      if (three === undefined) throw new Error("not staged");
      await appendOne(staging);
      expect(
        await refusedBeforeFour(t, staging, { ...three, importSeq: three.importSeq + 1 }),
      ).toBe("internal");
    },
    T,
  );

  it(
    "an import point other than ③'s: internal",
    async () => {
      const t = await target();
      const staging = await staged();
      const three = stepThree.get(staging);
      if (three === undefined) throw new Error("not staged");
      expect(
        await refusedBeforeFour(t, staging, { ...three, importedUpto: three.importedUpto - 1 }),
      ).toBe("internal");
    },
    T,
  );
});

describe("finishImport refuses, the marker kept and the anchor unchanged", () => {
  const refused = async (t: Target, store: TenantStore, importId: string) => {
    const before = await t.anchor.read(TARGET);
    const e = await finishImport({ store, anchor: t.anchor, tenant: TARGET, importId }).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(await t.anchor.read(TARGET)).toEqual(before);
    expect(before.importInProgress).toBe(importId);
    return e instanceof OpsError ? e.code : e;
  };

  it(
    "a log holding a deletion event: its registry is not built yet (internal)",
    async () => {
      const t = await target();
      const staging = await open("staging");
      const s = await importIntoStaging({ staging, body: bodyOf(file) });
      // Put in by hand: an import refuses a file holding one until apply knows deletions.
      await staging.write((tx) =>
        appendOperation(tx, {
          actor: IMPORTER as never,
          now: "2026-11-11T00:40:00.000Z" as never,
          events: [
            {
              type: "deletion.confirmed",
              slot: `sl_${"3".repeat(16)}`,
              blocks: {
                ctx: {
                  now: "2026-11-11T00:40:00.000Z",
                  today: "2026-11-11",
                  ruleset_version: 1,
                  policy_version: 1,
                  literal_checker: "literal@1",
                },
                target: {
                  deletion: `pi_${"5".repeat(16)}`,
                  sources: [],
                  due_at: "2026-11-12T00:00:00.000Z",
                },
                positions: [],
              },
            } as never,
          ],
        }),
      );
      await appendImportEvent(staging, {
        user: IMPORTER as never,
        tenant: TARGET as never,
        // The file as it would end with the event in it.
        manifest: { ...s.manifest, ...(await logEndOf(staging)) },
        now: "2026-11-11T01:00:00.000Z" as never,
      });
      const importId = newImportId();
      await steps(t, staging, importId, 5);
      expect(await refused(t, staging, importId)).toBe("internal");
    },
    T,
  );

  it(
    "a log that does not end in the import's event (internal)",
    async () => {
      const t = await target();
      const importId = newImportId();
      await t.anchor.beginImport(TARGET, importId);
      expect(await refused(t, t.dir.current, importId)).toBe("internal");
    },
    T,
  );

  it(
    "an anchor whose high water is above the log's end: writing would leave the log behind it (internal)",
    async () => {
      const t = await target();
      await t.anchor.advanceHighWater(TARGET, 999);
      const staging = await staged();
      const importId = newImportId();
      await steps(t, staging, importId, 5);
      expect(await refused(t, staging, importId)).toBe("internal");
    },
    T,
  );
});

describe("the contract's error of an import (04-contract §16, 04-contract-types §9)", () => {
  it("a refused file, a manifest that does not match its log, a line too long, another import", () => {
    expect(importContractError(new ImportRejected("chain_broken", "x", { seq: 7 }))).toEqual({
      code: "import_rejected",
      reason: "chain_broken",
      seq: 7,
    });
    expect(
      importContractError(new ImportRejected("checksum_mismatch", "x", { seq: 3, path: "ctx" })),
    ).toEqual({ code: "import_rejected", reason: "checksum_mismatch", seq: 3, path: "ctx" });
    expect(importContractError(new ImportEventError("manifest_restore_count", "x"))).toEqual({
      code: "import_rejected",
      reason: "incomplete",
    });
    expect(importContractError(new ImportLineTooLarge())).toEqual({
      code: "too_large",
      reason: "import_line",
      limit_bytes: MAX_IMPORT_LINE_BYTES,
    });
    expect(importContractError(new ImportInProgress())).toEqual({
      code: "unavailable",
      reason: "importing",
    });
    expect(importContractError(new OpsError("internal", "x"))).toBeUndefined();
  });
});
