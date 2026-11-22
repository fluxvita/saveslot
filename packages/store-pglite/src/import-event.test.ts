// The import's event on storage (02-architecture §8 «格式版本、导出、导入与恢复» step ③;
// 09-event-format §5.2 `tenant.imported`; 03-data-model/03-deletion.md «恢复次数»): appended after
// the imported log's last event, it links to it; it disables every principal registered before it
// and still active (`system` aside; a revoked one stays revoked), registers the importing user as
// active, also one the imported log registered, and makes the target's ID the current tenant ID
// and the export's restore count plus one the current restore count. Runs on each backend.
// Fictional IDs.
//
// One store for the whole file, emptied before each case (`reusable`): a store per case kept a
// dozen PGlite instances open until the end, near 3 GB in one worker.

import {
  actorsAsOf,
  appendImportEvent,
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  ImportEventError,
  issueConnection,
  MAX_MANIFEST_RESTORE_COUNT,
  OpsError,
  type ReadTx,
  readEvents,
  readTail,
  restorePoint,
  revokeConnection,
  STORAGE_FORMAT_VERSION,
  type TenantStore,
  verifyLog,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const SOURCE = `tn_${"8".repeat(26)}`;
const TARGET = `tn_${"9".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const IMPORTER = `u_${"7".repeat(26)}`;
const NODE = `n_${"5".repeat(26)}`;
const T = 60_000;

const ctx = (minute: number) =>
  createOpsContext({
    tenant: SOURCE,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 86_400_000,
    now: `2026-11-10T04:${String(minute).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });

const manifest = (upto: number, upto_hash = "0".repeat(64)) => ({
  saveslot_export: 1 as const,
  tenant_id: SOURCE,
  event_format: 1 as const,
  restore_count: 0,
  upto,
  upto_hash,
  events: upto,
  exported_at: "2026-11-10T08:00:00.000Z",
  pending_deletions: "placeholder" as const,
});

// The one store of the file.
let reusableStore: ReusableStore | undefined;

beforeAll(async () => {
  reusableStore = await openReusable("saveslot-import-event-");
}, 120_000);

afterAll(async () => {
  // Closes the store and removes its directory.
  await reusableStore?.close();
}, 120_000);

/** The store as it was opened, emptied of whatever the case before left. */
async function open(): Promise<TenantStore> {
  if (reusableStore === undefined) throw new Error("the store is not open");
  await reusableStore.reset();
  return reusableStore.store;
}

/** An imported log: genesis, a connection, another connection revoked. */
async function importedLog(): Promise<{ store: TenantStore; desk: string; phone: string }> {
  const store = await open();
  await createTenant(store, ctx(0));
  const desk = (await issueConnection(store, ctx(1), { name: "desk", via: "token" })).id;
  const phone = (await issueConnection(store, ctx(2), { name: "phone", via: "token" })).id;
  await revokeConnection(store, ctx(3), { id: phone as never });
  return { store, desk, phone };
}

/** The manifest of an export of `store`'s log as it is now: it ends at the log's end. */
async function manifestOf(store: TenantStore) {
  const tail = await store.read(readTail);
  return manifest(tail?.seq ?? 0, tail?.hash);
}

const principals = (tx: ReadTx) =>
  tx
    .query<{ id: string; kind: string; state: string; registered_seq: unknown }>(
      "SELECT id, kind, state, registered_seq FROM principals ORDER BY id",
    )
    .then((r) => r.rows.map((x) => ({ ...x, registered_seq: Number(x.registered_seq) })));

const tenantId = (tx: ReadTx) =>
  tx
    .query<{ value: string }>("SELECT value FROM meta WHERE key = 'tenant_id'")
    .then((r) => r.rows[0]?.value);

describe("tenant.imported", () => {
  it(
    "follows the last imported event, with a new node, the export's restore count plus one, and the export",
    async () => {
      const { store } = await importedLog();
      const r = await appendImportEvent(store, {
        user: IMPORTER as never,
        tenant: TARGET as never,
        manifest: (await manifestOf(store)) as never,
        now: "2026-11-10T09:00:00.000Z" as never,
        node: NODE as never,
      });
      expect(r).toEqual({ seq: 5, importedUpto: 4, restoreCount: 1, node_id: NODE });
      const [e] = await store.read((tx) => readEvents(tx, 5, 5));
      expect(e?.header).toMatchObject({
        type: "tenant.imported",
        seq: 5,
        actor: IMPORTER,
        node_id: NODE,
        restore_count: 1,
        imported_upto: 4,
      });
      expect(Object.fromEntries(e?.blocks ?? [])).toEqual({
        tenant: {
          state: "present",
          value: {
            tenant_id: TARGET,
            previous_tenant_id: SOURCE,
            storage_format: STORAGE_FORMAT_VERSION,
            event_format: 1,
          },
        },
        user: { state: "present", value: { principal: IMPORTER, kind: "user" } },
        export: {
          state: "present",
          value: { exported_at: "2026-11-10T08:00:00.000Z", pending_deletions: "placeholder" },
        },
      });
      expect((await store.read((tx) => verifyLog(tx))).chain).toEqual({ intact: true });
    },
    T,
  );

  it(
    "disables every principal still active before it but system; registers its user",
    async () => {
      const { store, desk, phone } = await importedLog();
      await appendImportEvent(store, {
        user: IMPORTER as never,
        tenant: TARGET as never,
        manifest: (await manifestOf(store)) as never,
        now: "2026-11-10T09:00:00.000Z" as never,
      });
      expect(await store.read(principals)).toEqual(
        [
          { id: desk, kind: "connection", state: "disabled", registered_seq: 2 },
          { id: phone, kind: "connection", state: "revoked", registered_seq: 3 },
          { id: "system", kind: "system", state: "active", registered_seq: 1 },
          { id: USER, kind: "user", state: "disabled", registered_seq: 1 },
          { id: IMPORTER, kind: "user", state: "active", registered_seq: 5 },
        ].sort((a, b) => (a.id < b.id ? -1 : 1)),
      );
      expect(await store.read(tenantId)).toBe(TARGET);
    },
    T,
  );

  it(
    "a connection revoked before the import stays revoked, one still active is disabled; a replay agrees",
    async () => {
      const { store, desk, phone } = await importedLog();
      await appendImportEvent(store, {
        user: IMPORTER as never,
        tenant: TARGET as never,
        manifest: (await manifestOf(store)) as never,
        now: "2026-11-10T09:00:00.000Z" as never,
      });
      const after = await store.read(principals);
      expect([desk, phone].map((id) => after.find((x) => x.id === id)?.state)).toEqual([
        "disabled",
        "revoked",
      ]);
      // The whole log replayed into an empty storage gives the same principals (K12): the same
      // store, emptied, takes the log back.
      const rows = await store.read(async (tx) => ({
        events: (await tx.query("SELECT * FROM events ORDER BY seq")).rows,
        content: (await tx.query("SELECT * FROM content ORDER BY seq, path")).rows,
      }));
      const replica = await open();
      expect(await replica.read(readTail)).toBeUndefined();
      await replica.write(async (tx) => {
        for (const [table, rs] of Object.entries(rows)) {
          for (const r of rs) {
            const cols = Object.keys(r as object);
            await tx.query(
              `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
              Object.values(r as object) as never,
            );
          }
        }
        await applyEvents(tx, await readEvents(tx, 1, (await readTail(tx))?.seq ?? 0));
      });
      expect(await replica.read(principals)).toEqual(after);
      expect(await replica.read(tenantId)).toBe(TARGET);
    },
    T,
  );

  it(
    "leaves the importing user active, with its registration, when the imported log registered them",
    async () => {
      const { store, desk } = await importedLog();
      await appendImportEvent(store, {
        user: USER as never,
        tenant: TARGET as never,
        manifest: (await manifestOf(store)) as never,
        now: "2026-11-10T09:00:00.000Z" as never,
      });
      const rows = await store.read(principals);
      expect(rows.find((x) => x.id === USER)).toEqual({
        id: USER,
        kind: "user",
        state: "active",
        registered_seq: 1,
      });
      expect(rows.find((x) => x.id === desk)?.state).toBe("disabled");
    },
    T,
  );

  it(
    "makes the current restore count the import's, and its point the last imported event",
    async () => {
      const { store } = await importedLog();
      const latest = () => store.read((tx) => restorePoint(tx));
      expect(await latest()).toEqual({ restoreCount: 0, seq: null, point: null });
      await appendImportEvent(store, {
        user: IMPORTER as never,
        tenant: TARGET as never,
        manifest: (await manifestOf(store)) as never,
        now: "2026-11-10T09:00:00.000Z" as never,
      });
      expect(await latest()).toEqual({ restoreCount: 1, seq: 5, point: 4 });
      expect(await store.read((tx) => restorePoint(tx, { before: 5 }))).toEqual({
        restoreCount: 0,
        seq: null,
        point: null,
      });
      // A restore after the import: the latest of the two counts.
      await store.write((tx) =>
        appendOperation(tx, {
          actor: "system" as never,
          now: "2026-11-10T10:00:00.000Z" as never,
          events: [
            {
              type: "tenant.restored",
              trigger: "restore",
              node_id: NODE,
              restore_id: `rs_${"6".repeat(16)}`,
              restore_count: 2,
              restored_to: 5,
              high_water: 5,
              blocks: {},
            } as never,
          ],
        }),
      );
      expect(await latest()).toEqual({ restoreCount: 2, seq: 6, point: 5 });
      expect(await store.read((tx) => restorePoint(tx, { before: 6 }))).toEqual({
        restoreCount: 1,
        seq: 5,
        point: 4,
      });
    },
    T,
  );

  it(
    "needs an imported log to follow",
    async () => {
      const store = await open();
      await expect(
        appendImportEvent(store, {
          user: IMPORTER as never,
          tenant: TARGET as never,
          manifest: manifest(0) as never,
          now: "2026-11-10T09:00:00.000Z" as never,
        }),
      ).rejects.toThrow(OpsError);
      expect(await store.read(readTail)).toBeUndefined();
    },
    T,
  );

  it(
    "the principals as of the log's end are the principals table's, one by one",
    async () => {
      const { store } = await importedLog();
      await appendImportEvent(store, {
        user: IMPORTER as never,
        tenant: TARGET as never,
        manifest: (await manifestOf(store)) as never,
        now: "2026-11-10T09:00:00.000Z" as never,
      });
      const table = await store.read(principals);
      const asOf = await store.read((tx) =>
        actorsAsOf(
          tx,
          table.map((x) => x.id),
          5,
        ),
      );
      // The table's `active` is no state in `actorsAsOf`.
      expect(table.map((x) => [x.id, asOf.get(x.id)?.state ?? "active"])).toEqual(
        table.map((x) => [x.id, x.state]),
      );
    },
    T,
  );

  describe("refused, nothing appended", () => {
    const refused = async (
      store: TenantStore,
      restore_count: unknown,
      m: object = {},
      o: object = {},
    ): Promise<{ code: string } | "appended"> => {
      const before = await store.read(readTail);
      try {
        await appendImportEvent(store, {
          user: IMPORTER as never,
          tenant: TARGET as never,
          manifest: { ...(await manifestOf(store)), restore_count, ...m } as never,
          now: "2026-11-10T09:00:00.000Z" as never,
          node: NODE as never,
          ...o,
        });
        return "appended";
      } catch (e) {
        if (!(e instanceof ImportEventError || e instanceof OpsError)) throw e;
        expect(await store.read(readTail)).toEqual(before);
        return { code: e.code };
      }
    };

    it.each([
      ["a negative restore count", -1],
      ["a restore count not a number", true],
      ["a restore count whose import's would not fit INTEGER", MAX_MANIFEST_RESTORE_COUNT + 1],
    ])(
      "%s in the manifest",
      async (_, count) => {
        const { store } = await importedLog();
        expect(await refused(store, count)).toEqual({ code: "manifest_restore_count" });
      },
      T,
    );

    it(
      "a manifest's restore count other than the imported log's own",
      async () => {
        const { store } = await importedLog();
        // The imported log was restored twice: its own count is 2.
        await store.write((tx) =>
          appendOperation(tx, {
            actor: "system" as never,
            now: "2026-11-10T05:00:00.000Z" as never,
            events: [
              {
                type: "tenant.restored",
                trigger: "restore",
                node_id: NODE,
                restore_id: `rs_${"6".repeat(16)}`,
                restore_count: 2,
                restored_to: 4,
                high_water: 4,
                blocks: {},
              } as never,
            ],
          }),
        );
        expect(await refused(store, 1)).toEqual({ code: "manifest_restore_count" });
        expect(await refused(store, 3)).toEqual({ code: "manifest_restore_count" });
        expect(await refused(store, 2)).toBe("appended");
      },
      T,
    );

    it(
      "a log not ending at the manifest's end, one past it with an import's event or another event: internal",
      async () => {
        const { store } = await importedLog();
        const m = await manifestOf(store);
        expect(await refused(store, 0, { upto: 3 })).toEqual({ code: "internal" });
        expect(await refused(store, 0, { upto: 5 })).toEqual({ code: "internal" });
        expect(await refused(store, 0, { upto_hash: "0".repeat(64) })).toEqual({
          code: "internal",
        });
        expect(await refused(store, 0, m)).toBe("appended");
        // The same manifest again, its log now ending in the import's event: of the same node or
        // another, nothing is appended.
        expect(await refused(store, 0, m)).toEqual({ code: "internal" });
        const other = { node: `n_${"4".repeat(26)}` };
        expect(await refused(store, 0, m, other)).toEqual({ code: "internal" });
        // One past the end, but not an import's event.
        const atImport = await manifestOf(store);
        await store.write((tx) =>
          appendOperation(tx, {
            actor: IMPORTER as never,
            now: "2026-11-10T09:30:00.000Z" as never,
            events: [
              {
                type: "principal.revoked",
                blocks: {
                  ctx: { now: "2026-11-10T09:30:00.000Z", ruleset_version: 1 },
                  principal: { principal: `ci_${"3".repeat(26)}` },
                },
              } as never,
            ],
          }),
        );
        expect(await refused(store, 1, atImport)).toEqual({ code: "internal" });
      },
      T,
    );

    it(
      "a log ending in an import's event at the manifest's end (an export of an imported tenant): appended",
      async () => {
        const { store } = await importedLog();
        expect(await refused(store, 0)).toBe("appended");
        // The staging log is now the imported log and its import: its own count is 1.
        expect(await refused(store, 1, {}, { node: `n_${"4".repeat(26)}` })).toBe("appended");
        expect(await store.read((tx) => restorePoint(tx))).toMatchObject({ restoreCount: 2 });
      },
      T,
    );
  });
});
