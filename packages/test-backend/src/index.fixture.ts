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
// With SAVESLOT_TEST_BACKEND=postgres it is PostgreSQL in PGlite's place, on the server
// SAVESLOT_TEST_POSTGRES_URL names: the tests go on asking for the storage of a directory, and
// each directory is given a database of its own. No test file knows; what a test asks of PGlite
// itself (its lock, its owner file, its worker, its durability) it does not get, and such tests are
// left out of a run on PostgreSQL by name, each with its reason (scripts/test-postgres.ts).

import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { TenantRef } from "@fluxvita/saveslot-kernel";
import {
  type Durability,
  PgliteBackend,
  type PgliteBackendOptions,
  PgliteStoreError,
} from "@fluxvita/saveslot-store-pglite";
import { PostgresBackend } from "@fluxvita/saveslot-store-postgres";
import { cellFromEnv, testDatabase } from "../../store-postgres/src/testing/server.fixture.ts";

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

/**
 * A backend for tests. On PGlite: `TEST_DURABILITY` unless the options name a durability. On
 * PostgreSQL the options are PGlite's own and are not used.
 */
export function testBackend(opts: PgliteBackendOptions = {}): PgliteBackend {
  if (TEST_BACKEND === "postgres") return postgresInPlaceOfPglite() as unknown as PgliteBackend;
  return new PgliteBackend({ durability: TEST_DURABILITY, ...opts });
}
