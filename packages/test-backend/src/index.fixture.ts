// The backend that tests open their stores with (02-architecture §11 «测试矩阵»: the kernel's
// tests run on both backends).
//
// By default it is PGlite, without passing PostgreSQL's fsync to the host (durability
// "pglite-default"). With "host-fsync" every commit and every checkpoint calls fs.fsyncSync on the
// host, which on macOS is fcntl(F_FULLFSYNC) (see store-pglite's durability.ts): the drive flushes
// its cache to the medium, one request at a time for the whole drive. Test files running in
// parallel then queue behind each other's flushes; the suite's time grows with the number of
// flushes, not with the number of workers, and a file at the end of the queue can spend over a
// minute closing its store. On Linux the same call is a plain fsync and costs little.
//
// What the default leaves out is only a power loss: a killed process loses nothing that reached
// the operating system, and opening after a kill still replays the WAL. The fsync path itself is
// covered by the tests that pass durability "host-fsync" explicitly, by the service tests (the
// service opens with the backend's default), and by the full runs that set
// SAVESLOT_TEST_DURABILITY=host-fsync, which makes every store opened here use it.
//
// The product default does not change: PgliteBackend without options uses "host-fsync".
//
// A new PGlite storage is copied from the run's template for its creation parameters rather than
// made, unless `template` is false (store-template.fixture.ts).
//
// With SAVESLOT_TEST_BACKEND=postgres it is PostgreSQL in PGlite's place, on the server
// SAVESLOT_TEST_POSTGRES_URL names: the tests go on asking for the storage of a directory, and
// each directory is given a database of its own. No test file knows; what a test asks of PGlite
// itself (its lock, its owner file, its worker, its durability) it does not get, and such tests are
// left out of a run on PostgreSQL by name, each with its reason (scripts/test-postgres.ts).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { TenantRef } from "@fluxvita/saveslot-kernel";
import {
  type Durability,
  PgliteBackend,
  type PgliteBackendOptions,
  PgliteStoreError,
} from "@fluxvita/saveslot-store-pglite";
import { discardDatabase, PostgresBackend } from "@fluxvita/saveslot-store-postgres";
import { copyTemplate, TEMPLATES_ENV } from "./store-template.fixture.ts";

/** The server mode's drop guard, for the tests that drop a tenant's databases by their names. */
export { checkDiscard } from "@fluxvita/saveslot-store-postgres";

import {
  cellFromEnv,
  sqlOn,
  testDatabase,
} from "../../store-postgres/src/testing/server.fixture.ts";

/** What PostgreSQL takes as a database's name here, for the packages that keep a copy to compare. */
export { DATABASE_NAME as POSTGRES_DATABASE_NAME } from "@fluxvita/saveslot-store-postgres";

function durabilityFromEnv(): Durability {
  const v = process.env["SAVESLOT_TEST_DURABILITY"];
  if (v === undefined || v === "") return "pglite-default";
  if (v === "host-fsync" || v === "pglite-default") return v;
  throw new Error(`SAVESLOT_TEST_DURABILITY must be "host-fsync" or "pglite-default", not "${v}"`);
}

/** The durability tests open their stores with. */
export const TEST_DURABILITY: Durability = durabilityFromEnv();

export type TestBackendKind = "pglite" | "postgres";

function kindFromEnv(): TestBackendKind {
  const v = process.env["SAVESLOT_TEST_BACKEND"];
  if (v === undefined || v === "" || v === "pglite") return "pglite";
  if (v === "postgres") return "postgres";
  throw new Error(`SAVESLOT_TEST_BACKEND must be "pglite" or "postgres", not "${v}"`);
}

/** The backend tests open their stores on. */
export const TEST_BACKEND: TestBackendKind = kindFromEnv();

const CELL = "test";

/** The database that stands for a directory: the same directory, the same database. */
export const databaseOf = (dir: string): string =>
  testDatabase(createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 24));

/**
 * PostgreSQL where the tests ask for PGlite: a reference to a directory opens the database that
 * stands for it. The directory is made as PGlite makes it, and one that is not there is no
 * storage, so that what tests do around a store (make it, look for it, remove it) goes on working.
 */
function postgresInPlaceOfPglite() {
  const cell = cellFromEnv();
  if (cell === undefined) {
    throw new Error(
      "SAVESLOT_TEST_BACKEND=postgres, but SAVESLOT_TEST_POSTGRES_URL names no server to run on",
    );
  }
  const backend = new PostgresBackend({ cells: { [CELL]: cell } });
  return {
    async open(tenant: TenantRef, opts: { readonly create?: boolean } = {}) {
      if (tenant.kind !== "pglite") {
        throw new TypeError(
          `the test backend opens the storage of a directory, not a ${tenant.kind} tenant`,
        );
      }
      const dir = resolve(tenant.dir);
      if (opts.create) mkdirSync(dir, { recursive: true });
      else if (!existsSync(dir)) {
        throw new PgliteStoreError("store_not_found", `no storage at ${dir}`);
      }
      const store = await backend.open(
        { kind: "postgres", database: databaseOf(dir), cell: CELL },
        opts,
      );
      return Object.assign(store, { dir });
    },
  };
}

/** PGlite's backend, a new storage copied from the run's template for its parameters. */
class TemplatedPgliteBackend extends PgliteBackend {
  readonly #durability: Durability;
  readonly #root: string;

  constructor(opts: PgliteBackendOptions & { readonly durability: Durability }, root: string) {
    super(opts);
    this.#durability = opts.durability;
    this.#root = root;
  }

  override async open(tenant: TenantRef, opts: { readonly create?: boolean } = {}) {
    if (opts.create && tenant.kind === "pglite") {
      await copyTemplate(this.#root, resolve(tenant.dir), this.#durability);
    }
    return super.open(tenant, opts);
  }
}

export interface TestBackendOptions extends PgliteBackendOptions {
  /**
   * Whether a new PGlite storage is copied from the run's template (store-template.fixture.ts).
   * Default true; false for a test whose subject is making a storage.
   */
  readonly template?: boolean;
}

/**
 * A backend for tests. On PGlite: `TEST_DURABILITY` unless the options name a durability; a new
 * storage copied from the run's template unless `template` is false. On PostgreSQL the options
 * are PGlite's own and are not used.
 */
export function testBackend(opts: TestBackendOptions = {}): PgliteBackend {
  if (TEST_BACKEND === "postgres") return postgresInPlaceOfPglite() as unknown as PgliteBackend;
  const { template = true, ...rest } = opts;
  const o = { durability: TEST_DURABILITY, ...rest };
  const root = process.env[TEMPLATES_ENV];
  if (!template || root === undefined || root === "") return new PgliteBackend(o);
  return new TemplatedPgliteBackend(o, root);
}

/**
 * Drops the storage that stands for a directory, as the server mode drops a database: on
 * PostgreSQL the database itself, by store-postgres's own `discardDatabase` (its `DROP DATABASE …
 * WITH (FORCE)`; the name is the directory's, so its guard on a tenant's names has nothing to tell
 * apart here and is tested on its own in store-postgres); on PGlite the directory removed. Nothing
 * when it is gone. The storage must be closed.
 */
export async function dropTestStorage(dir: string): Promise<void> {
  if (TEST_BACKEND === "postgres") {
    const cell = cellFromEnv();
    if (cell === undefined) {
      throw new Error(
        "SAVESLOT_TEST_BACKEND=postgres, but SAVESLOT_TEST_POSTGRES_URL names no server to run on",
      );
    }
    const database = databaseOf(dir);
    await discardDatabase(cell, { tenantDatabase: database, current: "", database });
  }
  rmSync(resolve(dir), { recursive: true, force: true });
}

/** Whether the storage that stands for a directory is there: on PostgreSQL, asked of the server. */
export async function testStorageExists(dir: string): Promise<boolean> {
  if (TEST_BACKEND !== "postgres") return existsSync(resolve(dir));
  const cell = cellFromEnv();
  if (cell === undefined) throw new Error("SAVESLOT_TEST_POSTGRES_URL names no server");
  const r = await sqlOn(
    cell,
    cell.maintenanceDatabase ?? "postgres",
    "SELECT 1 FROM pg_database WHERE datname = $1",
    [databaseOf(dir)],
  );
  return r.rows.length === 1;
}
