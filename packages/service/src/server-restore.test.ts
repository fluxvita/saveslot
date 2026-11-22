// A server-mode tenant restored from a backup (02-architecture §8; 06-cli §4.1 `server restore`), on
// either backend (`pnpm test:postgres` runs this file on PostgreSQL). What a put-back database looks
// like to the flow is a log that ends before the control plane's high water mark: that is how these
// tests make one, the same on both backends. Fictional IDs.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RestoreError,
  readTail,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { deletionEntry } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "../../test-backend/src/index.fixture.ts";
import type { TenantId } from "./control-plane.ts";
import { initControlPlane, type ServerControlPlane } from "./server-control-plane.ts";
import { restoreTenantFromBackup, ServerRestoreError } from "./server-restore.ts";
import { createServerTenant } from "./server-tenant.ts";

const T = 120_000;
const NOW = "2026-11-21T09:00:00.000Z";
const CELL = "main";
const root = mkdtempSync(join(tmpdir(), "saveslot-server-restore-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);

/** A server tenant's database is a directory of the test backend; closes are counted. */
let closes = 0;
const backend: StorageBackend = {
  open: async (ref: TenantRef, opts) => {
    if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
    const s = await testBackend().open(
      { kind: "pglite", dir: join(root, ref.cell, ref.database) },
      opts,
    );
    const close = s.close.bind(s);
    return Object.assign(s, {
      close: async () => {
        closes++;
        await close();
      },
    });
  },
};

let control: TenantStore;
let cp: ServerControlPlane;
beforeAll(async () => {
  control = await testBackend().open(
    { kind: "pglite", dir: join(root, "control") },
    { create: true },
  );
  cp = await initControlPlane(control);
}, T);
afterAll(async () => {
  await control?.close();
}, T);

let users = 0;
async function tenant(): Promise<TenantId> {
  const owner = `u_${String(++users).padStart(26, "0")}` as const;
  const e = await createServerTenant({
    control: cp,
    backend,
    owner,
    cell: CELL,
    cells: new Set([CELL]),
    now: NOW,
  });
  return e.id;
}

/** The tenant's log's end. */
async function logEnd(id: TenantId): Promise<number> {
  const e = await cp.tenant(id);
  const s = await backend.open((e as NonNullable<typeof e>).ref, { create: false });
  try {
    return (await s.read((tx) => readTail(tx)))?.seq ?? 0;
  } finally {
    await s.close();
  }
}

/** As if the database had been put back from a backup: the live log had gone `ahead` further. */
async function putBack(id: TenantId, ahead: number): Promise<number> {
  const high = (await logEnd(id)) + ahead;
  await cp.anchors.advanceHighWater(id, high);
  return high;
}

describe("restoreTenantFromBackup", () => {
  it(
    "restored: tenant.restored after the high water mark, which then is the log's end",
    async () => {
      const id = await tenant();
      const high = await putBack(id, 7);
      const before = closes;
      const r = await restoreTenantFromBackup({ control: cp, backend, tenant: id, now: NOW });
      // Its storage was opened once, and closed after.
      expect(closes).toBe(before + 1);
      expect(r).toMatchObject({ restoreCount: 1, resumed: false, eventWasThere: false });
      // No seq is used twice: the event follows the high water mark, not the put-back log's end.
      expect(r.restoredSeq).toBe(high + 1);
      expect(r.logEnd).toBe(r.restoredSeq);
      const a = await cp.anchors.read(id);
      expect(a).toMatchObject({ highWater: r.logEnd, restoreCount: 1 });
      expect(a.restoreInProgress).toBeUndefined();
      expect(await logEnd(id)).toBe(r.logEnd);
    },
    T,
  );

  it(
    "a restore stopped half way is taken up by running it again",
    async () => {
      const id = await tenant();
      await putBack(id, 3);
      const begun = await cp.anchors.beginRestore(id, "rs_0000000000000001");
      expect(begun.restoreInProgress).toBe("rs_0000000000000001");
      const r = await restoreTenantFromBackup({ control: cp, backend, tenant: id, now: NOW });
      expect(r).toMatchObject({ restore: "rs_0000000000000001", resumed: true });
      expect((await cp.anchors.read(id)).restoreInProgress).toBeUndefined();
    },
    T,
  );

  it(
    "a deletion in the registry: refused before anything changes",
    async () => {
      const id = await tenant();
      const high = await putBack(id, 2);
      await cp.anchors.putDeletion(id, deletionEntry(1));
      const end = await logEnd(id);
      const e = await restoreTenantFromBackup({ control: cp, backend, tenant: id, now: NOW }).catch(
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(RestoreError);
      expect(e).toMatchObject({ code: "deletion_backfill_not_implemented" });
      expect(await logEnd(id)).toBe(end);
      expect(await cp.anchors.read(id)).toMatchObject({ highWater: high, restoreCount: 0 });
    },
    T,
  );

  it(
    "a tenant the directory does not have, or has not finished: refused, nothing opened",
    async () => {
      const before = closes;
      await expect(
        restoreTenantFromBackup({
          control: cp,
          backend,
          tenant: `tn_${"9".repeat(26)}` as TenantId,
          now: NOW,
        }),
      ).rejects.toMatchObject({ name: "ServerRestoreError", code: "unknown_tenant" });
      const creating = `tn_${"8".repeat(26)}` as TenantId;
      await cp.registerTenant({
        id: creating,
        owner: `u_${"8".repeat(26)}`,
        ref: { kind: "postgres", cell: CELL, database: `tn_${"8".repeat(26)}` },
      });
      const e = await restoreTenantFromBackup({
        control: cp,
        backend,
        tenant: creating,
        now: NOW,
      }).catch((x: unknown) => x);
      expect(e).toBeInstanceOf(ServerRestoreError);
      expect(e).toMatchObject({ code: "tenant_not_active" });
      expect(closes).toBe(before);
    },
    T,
  );
});
