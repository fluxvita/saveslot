// A local home for tests, as `saveslot init` will make it (06-cli §3 «分步做»): the home and
// `control/` at 0700, the tenant storage with its genesis event, `control/tenant.json`. No anchor
// file: a tenant never written reads as the empty anchor. Fictional IDs.
// Exported as `@fluxvita/saveslot-service/testing`; tests only.

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createOpsContext,
  createTenant,
  newReadId,
  readBufferOf,
  type StorageBackend,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { controlDir, type LocalTenant, tenantFile } from "./local-tenant.ts";

export const TEST_TENANT = `tn_${"8".repeat(26)}` as const;
export const TEST_USER = `u_${"1".repeat(26)}` as const;

/** Creates `home` with its data directory at `<home>/data`; returns the data directory. */
export async function createLocalHome(home: string, backend: StorageBackend): Promise<string> {
  const dataDir = join(home, "data");
  await mkdir(controlDir(home), { recursive: true, mode: 0o700 });
  const store = await backend.open({ kind: "pglite", dir: dataDir }, { create: true });
  try {
    await createTenant(
      store,
      createOpsContext({
        tenant: TEST_TENANT,
        actor: TEST_USER,
        trigger: null,
        task: null,
        visibility: { kind: "all" },
        idempotency_key_window: 86_400_000,
        idempotency_window: 86_400_000,
        now: "2026-11-14T08:00:00.000Z",
        confirmation: null,
      }),
    );
  } finally {
    await store.close();
  }
  await writeFile(
    tenantFile(home),
    `${JSON.stringify({ format: 1, user: TEST_USER, tenant: TEST_TENANT })}\n`,
    { mode: 0o600 },
  );
  return dataDir;
}

/** `control/anchor.json` as the file anchor store writes it, for one tenant. */
export function anchorFileText(a: {
  readonly highWater: number;
  readonly restoreCount?: number;
  readonly restoreInProgress?: string;
  readonly importInProgress?: string;
}): string {
  return `${JSON.stringify({
    format: 1,
    generation: 1,
    tenants: {
      [TEST_TENANT]: {
        deletions: [],
        highWater: a.highWater,
        restoreCount: a.restoreCount ?? 0,
        ...(a.restoreInProgress !== undefined ? { restoreInProgress: a.restoreInProgress } : {}),
        ...(a.importInProgress !== undefined ? { importInProgress: a.importInProgress } : {}),
      },
    },
  })}\n`;
}

/** Records a read in the tenant's read buffer as a read operation would; returns its ID. */
export function recordTestRead(t: LocalTenant): string {
  const read = newReadId();
  readBufferOf(t.store).record({
    read,
    actor: TEST_USER,
    task: null,
    at: "2026-11-15T08:00:00.000Z",
    pos: 1,
    operation: "catalog",
    rows: [],
    coarse: [],
    lastRead: [],
  } as never);
  return read;
}

/** The read IDs written to the tenant's read_log, in the order recorded. */
export async function writtenReads(store: TenantStore): Promise<string[]> {
  const r = await store.read((tx) =>
    tx.query<{ read_id: string }>("SELECT read_id FROM read_log ORDER BY n"),
  );
  return r.rows.map((x) => x.read_id);
}
