// A read's record across the store that made it (02-architecture §7 «read_log 的持久性»): on
// PostgreSQL (the server mode) a read is written before it answers, so a write without `ver` on
// another store of the tenant (another process, or the same one after its connection went away)
// falls back to it. And after a restore from a backup (§8): the reads the backup did not have are
// gone with the database put back, and the reads after the restore are at later positions than any
// the backup kept, so `my_last_read` and the version last read are the ones after it.

import { cpSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  createOpsContext,
  history,
  query,
  restoreTenant,
  type TenantStore,
  write,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";
import { afterAll, describe, expect, it } from "vitest";
import { databaseOf, TEST_BACKEND } from "../../test-backend/src/index.fixture.ts";
import { maintenanceSql } from "../../test-backend/src/second-connection.fixture.ts";
import { openReusable } from "./testing/reusable-store.fixture.ts";
import { buildTenant, NOW, TENANT, USER } from "./testing/sql-tenant.fixture.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const T = 120_000;
const roots: string[] = [];
const open: TenantStore[] = [];
afterAll(async () => {
  for (const s of open) await s.close().catch(() => {});
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, T);

const ctx = (task: string) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: NOW,
    confirmation: null,
  });

/** A tenant built in a store of its own: its directory, the store, and a row of `spend`. */
async function tenant(prefix: string) {
  const r = await openReusable(prefix);
  roots.push(dirname(r.dir));
  const { rows } = await buildTenant(r);
  return { dir: r.dir, store: r.store as TenantStore, row: rows.r1 };
}

async function reopen(dir: string): Promise<TenantStore> {
  const s = await testBackend().open({ kind: "pglite", dir }, {});
  open.push(s);
  return s;
}

const correct = (store: TenantStore, task: string, row: string, note: string) =>
  write(store, ctx(task), {
    sv: 1,
    ops: [{ intent: "correct", table: "spend", row, set: { note } }],
  });

const insert = (store: TenantStore, task: string, note: string) =>
  write(store, ctx(task), {
    sv: 1,
    ops: [
      { intent: "insert", table: "spend", set: { date: "2026-11-07", category: "food", note } },
    ],
  });

const readsOf = (store: TenantStore, task: string) =>
  store.read(async (tx) => {
    const r = await tx.query<{ read_id: string; pos: unknown }>(
      "SELECT read_id, pos FROM read_log WHERE task = $1 ORDER BY n",
      [task] as never,
    );
    return r.rows.map((x) => ({ read: x.read_id, pos: Number(x.pos) }));
  });

describe.skipIf(TEST_BACKEND !== "postgres")("a read on one store, a write on another", () => {
  it(
    "the store that read is gone without writing: a write without ver on the next one falls back to the read",
    async () => {
      const t = tenant("saveslot-reads-across-");
      const { dir, store, row } = await t;
      await query(store, ctx("across"), { table: "spend" });
      // Another opener of the tenant (another process; or this one after its connection went
      // away, opened again): the first store wrote nothing since the read and is never closed
      // by its owner.
      const next = await reopen(dir);
      const r = await correct(next, "across", row, "written on the other store");
      expect(r.status).toBe("saved");
    },
    T,
  );
});

describe.skipIf(TEST_BACKEND !== "postgres")("two stores of one tenant (two processes)", () => {
  it(
    "write by turns, each reading the other's; neither refused, no ownership taken",
    async () => {
      const { dir, store } = await tenant("saveslot-two-writers-");
      const other = await reopen(dir);
      const rows = async (s: TenantStore) =>
        ((await query(s, ctx("count"), { table: "spend" })) as unknown as { rows: unknown[] }).rows
          .length;
      const before = await rows(store);
      await insert(store, "one", "from the first");
      await insert(other, "two", "from the second");
      await insert(store, "three", "from the first again");
      expect([await rows(store), await rows(other)]).toEqual([before + 3, before + 3]);
    },
    T,
  );
});

describe.skipIf(TEST_BACKEND !== "postgres")("two stores recording reads of the same rows", () => {
  it(
    "read in opposite orders at once, again and again: every read answered (no deadlock between the records)",
    async () => {
      const { dir, store } = await tenant("saveslot-reads-order-");
      const other = await reopen(dir);
      const refused: string[] = [];
      for (let i = 0; i < 40; i++) {
        const both = await Promise.allSettled([
          query(store, ctx("order"), { table: "spend", order: [{ field: "note", dir: "asc" }] }),
          query(other, ctx("order"), { table: "spend", order: [{ field: "note", dir: "desc" }] }),
        ]);
        for (const r of both) {
          if (r.status === "rejected") refused.push(String((r.reason as Error).name));
        }
      }
      expect(refused).toEqual([]);
    },
    T,
  );
});

describe("after a restore from a backup", () => {
  it(
    "reads the backup lacked are gone; my_last_read and the version last read are the reads after the restore",
    async () => {
      const t = await tenant("saveslot-reads-restore-");
      const { dir, row } = t;
      let store = t.store;
      const anchor = openFileAnchorStore(join(dirname(dir), "anchor.json"));
      const task = "restored";
      // The backup, taken with the tenant closed.
      await store.close();
      const backup = `${dir}-backup`;
      if (TEST_BACKEND === "postgres") {
        await maintenanceSql(
          `CREATE DATABASE "${databaseOf(backup)}" TEMPLATE "${databaseOf(dir)}"`,
        );
      } else cpSync(dir, backup, { recursive: true });
      // The live tenant went further, and was read there.
      store = await reopen(dir);
      await insert(store, `${task}-w`, "after the backup");
      await query(store, ctx(task), { table: "spend" });
      // Written (PGlite's buffer is written by a write).
      const end = (await insert(store, `${task}-w`, "after the read")).seq;
      const lost = await readsOf(store, task);
      expect(lost).toHaveLength(1);
      await anchor.advanceHighWater(TENANT, end);
      await store.close();
      // The backup put back in the tenant's place.
      if (TEST_BACKEND === "postgres") {
        await maintenanceSql(`DROP DATABASE "${databaseOf(dir)}"`);
        await maintenanceSql(
          `ALTER DATABASE "${databaseOf(backup)}" RENAME TO "${databaseOf(dir)}"`,
        );
      } else {
        rmSync(dir, { recursive: true, force: true });
        renameSync(backup, dir);
      }
      store = await reopen(dir);
      const restored = await restoreTenant({
        store,
        anchor,
        tenant: TENANT as `tn_${string}`,
        now: NOW,
      });
      expect(restored.restoredSeq).toBeGreaterThan(end);
      // The read the backup did not have is not there.
      expect(await readsOf(store, task)).toEqual([]);
      // Read again after the restore: later than any read the backup kept.
      await query(store, ctx(task), { table: "spend" });
      const since = (await history(store, ctx(task), {
        mode: "changes",
        table: "spend",
        since: "my_last_read",
      })) as unknown as { since: number };
      expect(since.since).toBeGreaterThanOrEqual(restored.restoredSeq);
      expect(since.since).toBeGreaterThan((lost[0] as { pos: number }).pos);
      // A write without ver falls back to the read after the restore.
      expect((await correct(store, task, row, "after the restore")).status).toBe("saved");
    },
    T,
  );
});
