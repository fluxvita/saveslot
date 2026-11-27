// The test backend: PGlite by default; PostgreSQL in its place when the run asks for it, with a
// database standing for each directory.

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { PgliteBackend, PgliteStoreError } from "@fluxvita/saveslot-store-pglite";
import { DATABASE_NAME, PostgresTenantStore } from "@fluxvita/saveslot-store-postgres";
import { afterAll, describe, expect, it } from "vitest";
import {
  cellFromEnv,
  machineMark,
  PREFIX_ENV,
  runPrefix,
  sqlOn,
  staleDatabases,
  testDatabase,
  thisRunPrefix,
} from "../../store-postgres/src/testing/server.fixture.ts";
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

describe("the test databases a starting run drops: those its own machine's gone runs left", () => {
  // Names only: no server, and nothing made on one. dropStaleDatabases lists the server's
  // databases and drops what this gives, at the start of every run with a server.
  const here = "0a1b2c3d";
  const there = "4e5f6a7b";
  const gone = "sst-gone01";
  const running = "sst-live01";
  const runThere = (run: string) => run === running;
  const names = [
    `${runPrefix(gone, here)}a`,
    `${runPrefix(gone, here)}b`,
    `${runPrefix(running, here)}a`,
    `${runPrefix(gone, there)}a`,
    `${runPrefix(running, there)}a`,
    // Not of a run as test-tmp makes them, nor of a test at all.
    `${runPrefix("elsewhere", here)}a`,
    `sst_r${Buffer.from(gone).toString("hex")}_a`,
    "postgres",
    "tenant_one",
  ];

  it("drops this machine's runs that are gone, every database of each, and nothing else", () => {
    expect(staleDatabases(names, here, runThere)).toEqual([
      `${runPrefix(gone, here)}a`,
      `${runPrefix(gone, here)}b`,
    ]);
  });

  it("leaves another machine's alone, whether its run directory is found here or not", () => {
    expect(staleDatabases(names, there, () => true)).toEqual([]);
    expect(staleDatabases(names, there, () => false)).toEqual([
      `${runPrefix(gone, there)}a`,
      `${runPrefix(running, there)}a`,
    ]);
    expect(staleDatabases(names, here, () => false)).not.toContain(`${runPrefix(gone, there)}a`);
  });
});

describe("a machine's mark", () => {
  it("is made the first time, 8 hex digits in a file of the user's own; then read back the same", () => {
    const file = join(root, "state", "saveslot-tests", "machine");
    const mark = machineMark(file);
    expect(mark).toMatch(/^[0-9a-f]{8}$/);
    expect(readFileSync(file, "utf8")).toBe(`${mark}\n`);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(machineMark(file)).toBe(mark);
  });

  it("two machines (two files) have two marks", () => {
    expect(machineMark(join(root, "one", "machine"))).not.toBe(
      machineMark(join(root, "two", "machine")),
    );
  });

  it("a file that does not hold one is refused, with what to do", () => {
    const file = join(root, "bad-machine");
    writeFileSync(file, "my-laptop\n");
    expect(() => machineMark(file)).toThrow(
      `${file} does not hold a machine mark (8 hex digits): remove it, and the next run makes one`,
    );
  });
});

describe("this run's prefix: worked out once, by the run's global setup", () => {
  it("is handed to this process, and is this run's on this machine", () => {
    const prefix = process.env[PREFIX_ENV] as string;
    expect(prefix).toBe(runPrefix(basename(dirname(tmpdir())), machineMark()));
    expect(thisRunPrefix()).toBe(prefix);
    expect(testDatabase("x")).toBe(`${prefix}x`);
  });

  it("a database is named with it whatever the mark's source says later: the prefix the run's end drops by", () => {
    const prefix = thisRunPrefix();
    const before = process.env["SAVESLOT_TEST_MACHINE_FILE"];
    // The mark's source changes under the run (a host name that changed, a file replaced).
    const other = join(root, "changed", "machine");
    machineMark(other);
    writeFileSync(other, "ffffffff\n");
    process.env["SAVESLOT_TEST_MACHINE_FILE"] = other;
    try {
      expect(machineMark()).toBe("ffffffff");
      expect(prefix).not.toContain("ffffffff");
      // What a test makes, and what the run's end looks for.
      expect(testDatabase("y").startsWith(prefix)).toBe(true);
      expect(thisRunPrefix()).toBe(prefix);
    } finally {
      if (before === undefined) delete process.env["SAVESLOT_TEST_MACHINE_FILE"];
      else process.env["SAVESLOT_TEST_MACHINE_FILE"] = before;
    }
  });

  it("without the setup's prefix, a name is refused rather than worked out again", () => {
    const prefix = process.env[PREFIX_ENV];
    delete process.env[PREFIX_ENV];
    try {
      expect(() => testDatabase("z")).toThrow(`${PREFIX_ENV} is not set`);
    } finally {
      process.env[PREFIX_ENV] = prefix;
    }
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
      // The directory is made, as PGlite makes it: tests look for it and remove it.
      expect(existsSync(dir)).toBe(true);
      expect(await exists(databaseOf(dir))).toBe(true);
      await store.write((tx) => tx.exec("CREATE TABLE kept (x INT); INSERT INTO kept VALUES (1)"));
    } finally {
      await store.close();
    }
    const again = await testBackend().open({ kind: "pglite", dir }, {});
    try {
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
