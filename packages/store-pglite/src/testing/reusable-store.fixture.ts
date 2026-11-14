// A store reused across the samples of a property test: opening PGlite costs seconds (it builds
// a new database), emptying one costs milliseconds. `reset` empties the store back to the state
// it was opened in: every kernel table emptied (identities restarted), `meta` as it was, every
// other table (the physical tables apply created) dropped. `snapshot` lists every table's rows, so
// a test can check that a reset leaves nothing of the sample before it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KERNEL_TABLES, type ReadTx } from "@fluxvita/saveslot-kernel";
import { PgliteBackend, type PgliteTenantStore } from "../backend.ts";

const KERNEL = new Set(KERNEL_TABLES.map((t) => t.name));

/** Every table of the public schema with all its rows, as sorted JSON text. */
export async function snapshot(tx: ReadTx): Promise<Record<string, string[]>> {
  const names = await tx.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const big = (_: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);
  const out: Record<string, string[]> = {};
  for (const { tablename } of names.rows) {
    const rows = await tx.query(`SELECT * FROM "${tablename}"`);
    out[tablename] = rows.rows.map((x) => JSON.stringify(x, big)).sort();
  }
  return out;
}

export interface ReusableStore {
  readonly store: PgliteTenantStore;
  /** Empties the store back to the state it was opened in. */
  reset(): Promise<void>;
  /** The state it was opened in (every table's rows). */
  readonly blank: Record<string, string[]>;
  close(): Promise<void>;
}

export async function openReusable(prefix: string): Promise<ReusableStore> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const store = await new PgliteBackend().open(
    { kind: "pglite", dir: join(root, "tenant") },
    { create: true },
  );
  const meta = await store.read((tx) =>
    tx.query<{ key: string; value: string }>("SELECT key, value FROM meta"),
  );
  const blank = await store.read(snapshot);
  return {
    store,
    blank,
    reset: () =>
      store.write(async (tx) => {
        const names = await tx.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
        );
        const kernel = names.rows.map((r) => r.tablename).filter((n) => KERNEL.has(n));
        for (const { tablename } of names.rows) {
          if (!KERNEL.has(tablename)) await tx.query(`DROP TABLE "${tablename}" CASCADE`);
        }
        await tx.query(
          `TRUNCATE ${kernel.map((n) => `"${n}"`).join(", ")} RESTART IDENTITY CASCADE`,
        );
        for (const r of meta.rows) {
          await tx.query("INSERT INTO meta (key, value) VALUES ($1, $2)", [r.key, r.value]);
        }
      }),
    close: async () => {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
