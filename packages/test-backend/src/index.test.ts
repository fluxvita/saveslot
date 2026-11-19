// The test backend: PGlite by default; PostgreSQL in its place when the run asks for it, with a
// database standing for each directory.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgliteBackend, PgliteStoreError } from "@fluxvita/saveslot-store-pglite";
import { DATABASE_NAME, PostgresTenantStore } from "@fluxvita/saveslot-store-postgres";
import { afterAll, describe, expect, it } from "vitest";
import { cellFromEnv, sqlOn } from "../../store-postgres/src/testing/server.fixture.ts";
import { databaseOf, TEST_BACKEND, testBackend } from "./index.fixture.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-test-backend-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("the database that stands for a directory", () => {
  it("is one name a tenant's database may have, the same for the same directory however written", () => {
    const a = databaseOf(join(root, "a"));
    expect(a).toMatch(DATABASE_NAME);
    expect(databaseOf(join(root, "x", "..", "a"))).toBe(a);
    expect(databaseOf(join(root, "b"))).not.toBe(a);
  });
});

describe.skipIf(TEST_BACKEND !== "pglite")("by default", () => {
  it("is PGlite's backend", () => {
    expect(testBackend()).toBeInstanceOf(PgliteBackend);
  });
});

describe.skipIf(TEST_BACKEND !== "postgres")("with SAVESLOT_TEST_BACKEND=postgres", () => {
  const cell = cellFromEnv();
  const exists = async (database: string) =>
    (
      await sqlOn(
        cell as NonNullable<typeof cell>,
        "postgres",
        "SELECT count(*)::int4 AS n FROM pg_database WHERE datname = $1",
        [database],
      )
    ).rows[0]?.["n"] === 1;

  it("a directory's storage is a PostgreSQL store on the database that stands for it; opened again, the same one", async () => {
    const dir = join(root, "tenant");
    const store = await testBackend().open({ kind: "pglite", dir }, { create: true });
    try {
      expect(store).toBeInstanceOf(PostgresTenantStore);
      expect(store.dir).toBe(dir);
      expect(store.epoch).toBe(1);
      // The directory is made, as PGlite makes it: tests look for it and remove it.
      expect(existsSync(dir)).toBe(true);
      expect(await exists(databaseOf(dir))).toBe(true);
      await store.write((tx) => tx.exec("CREATE TABLE kept (x INT); INSERT INTO kept VALUES (1)"));
    } finally {
      await store.close();
    }
    const again = await testBackend().open({ kind: "pglite", dir }, {});
    try {
      expect(again.epoch).toBe(2);
      const r = await again.read((tx) => tx.query("SELECT x FROM kept"));
      expect(r.rows).toEqual([{ x: 1 }]);
    } finally {
      await again.close();
    }
  }, 60_000);

  it("a directory that is not there is no storage, by PGlite's own error; and no database is made", async () => {
    const dir = join(root, "never-made");
    const e = await testBackend()
      .open({ kind: "pglite", dir }, {})
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(PgliteStoreError);
    expect((e as PgliteStoreError).code).toBe("store_not_found");
    expect(await exists(databaseOf(dir))).toBe(false);
  }, 60_000);
});
