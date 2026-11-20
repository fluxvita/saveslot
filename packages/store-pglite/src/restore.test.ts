// The restore flow on PGlite with the file anchor store (02-architecture §8; 03-deletion
// «恢复流程», «恢复后 seq 不复用»; 09 §5.2 `tenant.restored`): what it appends, where its `seq`
// falls, what the anchor holds afterwards, and re-entry at each point it can stop at.
// Fictional IDs and data.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  type DeletionEntry,
  type NewOperation,
  RestoreError,
  readEvents,
  restoreTenant,
  verifyLog,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const USER = `u_${"1".repeat(26)}` as const;
const CONN = `ci_${"2".repeat(26)}` as const;
const SLOT = `sl_${"3".repeat(16)}` as const;
const ROW = `r_${"6".repeat(26)}` as const;
const TENANT = `tn_${"8".repeat(26)}` as const;
const NOW = "2026-11-12T08:00:00.000Z" as NewOperation["now"];
const T = 120_000;

const genesis: NewOperation = {
  actor: USER,
  now: "2026-11-10T04:00:00.000Z" as NewOperation["now"],
  events: [
    {
      type: "tenant.genesis",
      node_id: `n_${"4".repeat(26)}`,
      blocks: {
        tenant: { tenant_id: TENANT, storage_format: 1, event_format: 1 },
        user: { principal: USER, kind: "user" },
        system: { principal: "system", kind: "system" },
      },
    },
  ],
};

const write = (value: string): NewOperation => ({
  actor: CONN,
  now: "2026-11-10T04:10:00.000Z" as NewOperation["now"],
  events: [
    {
      type: "write.head",
      slot: SLOT,
      blocks: {
        ctx: {
          now: "2026-11-10T04:10:00.000Z",
          today: "2026-11-10",
          ruleset_version: 1,
          policy_version: 1,
          literal_checker: "literal@1",
        },
        request: { ops: 1 },
        "ops/0/target": { table: "t1", row: ROW, intent: "create" },
        "ops/0/set/f2": value,
      },
    },
    {
      type: "source.recorded",
      slot: SLOT,
      blocks: { target: { kind: "api_call" }, request: { f2: value } },
    },
    {
      type: "write.base",
      slot: SLOT,
      blocks: {
        target: { table: "t1", row: ROW, intent: "create" },
        "fields/f2/0": { value, status: "applied" },
      },
    },
  ],
});

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, T);

let store: PgliteTenantStore;
let anchor: ReturnType<typeof openFileAnchorStore>;
const RESTORE = `rs_${"A".repeat(16)}` as const;
const NODE = `n_${"B".repeat(26)}` as const;

/** A fresh tenant whose log has 7 events (seq 1–7), as a restored backup would. */
beforeEach(async () => {
  await store?.close();
  const root = mkdtempSync(join(tmpdir(), "saveslot-restore-"));
  roots.push(root);
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
  anchor = openFileAnchorStore(join(root, "anchor.json"));
  await store.write((tx) => appendOperation(tx, genesis));
  await store.write((tx) => appendOperation(tx, write("45")));
  await store.write((tx) => appendOperation(tx, write("50")));
}, T);

afterAll(async () => {
  await store?.close();
}, T);

const input = (extra: Partial<Parameters<typeof restoreTenant>[0]> = {}) => ({
  store,
  anchor,
  tenant: TENANT,
  now: NOW,
  ids: { restore: RESTORE, node: NODE },
  ...extra,
});
const restoredEvents = async () =>
  (await store.read((tx) => readEvents(tx, 1, 1000)))
    .filter((e) => e.header["type"] === "tenant.restored")
    .map((e) => ({ seq: e.seq, ...e.header }));

describe("restoreTenant", () => {
  it(
    "from a backup older than the high water mark: appends one event after the high water, never reusing a seq",
    async () => {
      await anchor.advanceHighWater(TENANT, 12); // the live log had reached 12; the backup has 7
      const r = await restoreTenant(input());
      expect(r).toMatchObject({
        restore: RESTORE,
        restoreCount: 1,
        restoredSeq: 13,
        logEnd: 13,
        resumed: false,
        eventWasThere: false,
      });
      const [e] = await restoredEvents();
      expect(e).toMatchObject({
        seq: 13,
        type: "tenant.restored",
        actor: "system",
        trigger: "restore",
        node_id: NODE,
        restore_id: RESTORE,
        restore_count: 1,
        restored_to: 7,
        high_water: 12,
      });
      const a = await anchor.read(TENANT);
      expect(a.restoreInProgress).toBeUndefined();
      expect(a.restoreCount).toBe(1);
      expect(a.highWater).toBe(13);
      // The gap 8–12 is explained by the event; the chain is intact.
      expect(await store.read((tx) => verifyLog(tx))).toMatchObject({
        events: 8,
        chain: { intact: true },
        gaps: [{ after: 7, before: 13, restore: 13 }],
      });
    },
    T,
  );

  it(
    "from a log at or past the high water mark: the next seq follows the log's end",
    async () => {
      await anchor.advanceHighWater(TENANT, 5);
      const r = await restoreTenant(input());
      expect(r.restoredSeq).toBe(8);
      expect(await store.read((tx) => verifyLog(tx))).toMatchObject({ gaps: [] });
    },
    T,
  );

  it(
    "re-enters at a marker with no event yet: appends once, raises the count once",
    async () => {
      await anchor.advanceHighWater(TENANT, 9);
      await anchor.beginRestore(TENANT, RESTORE); // the crash: after step 1
      const r = await restoreTenant(input({ ids: {} }));
      expect(r).toMatchObject({
        restore: RESTORE,
        resumed: true,
        restoreCount: 1,
        restoredSeq: 10,
      });
      expect(await restoredEvents()).toHaveLength(1);
      expect((await anchor.read(TENANT)).restoreCount).toBe(1);
    },
    T,
  );

  it(
    "re-enters after the event, before the marker is cleared: does not append again",
    async () => {
      await anchor.advanceHighWater(TENANT, 9);
      await expect(
        restoreTenant(
          input({
            backfill: async () => {
              throw new Error("crash in step 3");
            },
          }),
        ),
      ).rejects.toThrow("crash in step 3");
      // Step 1 and 2 are done; the marker is still set.
      expect((await anchor.read(TENANT)).restoreInProgress).toBe(RESTORE);
      expect(await restoredEvents()).toHaveLength(1);

      const r = await restoreTenant(input({ ids: {} }));
      expect(r).toMatchObject({
        resumed: true,
        eventWasThere: true,
        restoreCount: 1,
        restoredSeq: 10,
      });
      expect(await restoredEvents()).toHaveLength(1);
      const a = await anchor.read(TENANT);
      expect(a.restoreInProgress).toBeUndefined();
      expect(a.restoreCount).toBe(1);
      expect(a.highWater).toBe(10);
    },
    T,
  );

  it(
    "a second, separate restore is a new restore: count 2, a new event",
    async () => {
      await restoreTenant(input());
      const r = await restoreTenant(
        input({ ids: { restore: `rs_${"C".repeat(16)}`, node: `n_${"D".repeat(26)}` } }),
      );
      expect(r).toMatchObject({ restoreCount: 2, restoredSeq: 9, resumed: false });
      expect(
        (await restoredEvents()).map(
          (e) => (e as unknown as { restore_count: number }).restore_count,
        ),
      ).toEqual([1, 2]);
    },
    T,
  );

  it(
    "a registry with entries and no way to make up their deletions: refused, nothing changed",
    async () => {
      const entry: DeletionEntry = {
        deletion: `pi_${"7".repeat(16)}`,
        kind: "privacy",
        state: "pending",
        dueAt: "2026-11-13T00:00:00.000Z",
        confirmedSeq: 6,
        sources: [5],
        positions: [{ seq: 6, path: "request" }],
      };
      await anchor.putDeletion(TENANT, entry);
      const before = await anchor.read(TENANT);
      await expect(restoreTenant(input())).rejects.toMatchObject({
        name: "RestoreError",
        code: "deletion_backfill_not_implemented",
      });
      expect(await anchor.read(TENANT)).toEqual(before);
      expect(await restoredEvents()).toEqual([]);

      // With the step given, it is called with the anchor, after the event is in the log.
      let seen: number | undefined;
      await restoreTenant(
        input({
          backfill: async (a) => {
            seen = (await restoredEvents()).length;
            expect(a.deletions).toHaveLength(1);
          },
        }),
      );
      expect(seen).toBe(1);
    },
    T,
  );

  it(
    "an import in progress: refused, it re-enters first",
    async () => {
      // `beginImport` needs an empty anchor, which this one is.
      await anchor.beginImport(TENANT, `im_${"1".repeat(16)}`);
      const e = await restoreTenant(input()).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RestoreError);
      expect((e as RestoreError).code).toBe("import_in_progress");
    },
    T,
  );

  it(
    "re-enters after the backfill, before the marker is cleared: the backfill runs again, nothing is appended again",
    async () => {
      await anchor.advanceHighWater(TENANT, 9);
      let backfills = 0;
      // The crash: step 3 done, then the process ends before step 4 (endRestore fails here).
      const failing = {
        ...anchor,
        read: anchor.read.bind(anchor),
        beginRestore: anchor.beginRestore.bind(anchor),
        endRestore: async () => {
          throw new Error("crash before step 4");
        },
      } as typeof anchor;
      await expect(
        restoreTenant(
          input({
            anchor: failing,
            backfill: async () => {
              backfills += 1;
            },
          }),
        ),
      ).rejects.toThrow("crash before step 4");
      expect(backfills).toBe(1);
      expect((await anchor.read(TENANT)).restoreInProgress).toBe(RESTORE);

      const r = await restoreTenant(
        input({
          ids: {},
          backfill: async () => {
            backfills += 1;
          },
        }),
      );
      expect(backfills).toBe(2);
      expect(r).toMatchObject({
        resumed: true,
        eventWasThere: true,
        restoreCount: 1,
        restoredSeq: 10,
      });
      expect(await restoredEvents()).toHaveLength(1);
      const a = await anchor.read(TENANT);
      expect([a.restoreInProgress, a.restoreCount, a.highWater]).toEqual([undefined, 1, 10]);
    },
    T,
  );

  it(
    "a restore that is done, asked again by its ID: answered as it is, the anchor untouched",
    async () => {
      const first = await restoreTenant(input());
      const before = await anchor.read(TENANT);
      const again = await restoreTenant(input());
      expect(again).toMatchObject({
        restore: RESTORE,
        restoreCount: first.restoreCount,
        restoredSeq: first.restoredSeq,
        resumed: false,
        eventWasThere: true,
      });
      expect(await anchor.read(TENANT)).toEqual(before);
      expect(await restoredEvents()).toHaveLength(1);
    },
    T,
  );
});
