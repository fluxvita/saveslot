// The PostgreSQL the tests of this package run against, and databases of their own on it.
//
// SAVESLOT_TEST_POSTGRES_URL names it: `postgres://user[:password]@host[:port]/postgres`, or with a
// socket's directory `postgres:///postgres?host=/tmp`. The user must be allowed to create
// databases. Each test database is `sst_…` and is dropped when its file ends.
//
// Without the variable the tests that need a server are skipped, and say so; with
// SAVESLOT_TEST_POSTGRES_REQUIRED=1 its absence is an error instead, so that a job meant to run
// them cannot pass by skipping them.

import type { SqlValue } from "@fluxvita/saveslot-kernel";
import { afterAll } from "vitest";
import { PostgresBackend } from "../backend.ts";
import type { PostgresCell } from "../connection.ts";
import { cellFromEnv, sqlOn, testDatabase } from "./server.fixture.ts";

export { cellOf } from "./server.fixture.ts";

export const CELL = "test";

/** The cell to test against, or undefined when none is given (said once, on stderr). */
export function testCell(): PostgresCell | undefined {
  const cell = cellFromEnv();
  if (cell !== undefined) return cell;
  if (process.env["SAVESLOT_TEST_POSTGRES_REQUIRED"] === "1") {
    throw new Error("SAVESLOT_TEST_POSTGRES_REQUIRED=1, but SAVESLOT_TEST_POSTGRES_URL is not set");
  }
  // Straight to stderr: what a file writes to the console while it is collected is not shown.
  process.stderr.write(
    "skipped: the tests against PostgreSQL (SAVESLOT_TEST_POSTGRES_URL names no server to run them on)\n",
  );
  return undefined;
}

let serial = 0;

/**
 * What a test file works with on the server: a backend, databases of its own, plain SQL on them.
 * Without a cell (the file's tests are skipped) it is made all the same, and never used.
 */
export function testPostgres(given: PostgresCell | undefined) {
  const cell = given ?? { host: "no-server-given", user: "nobody" };
  const made: string[] = [];
  const maintenance = cell.maintenanceDatabase ?? "postgres";

  const sql = (database: string, text: string, params?: readonly SqlValue[]) =>
    sqlOn(cell, database, text, params);

  afterAll(async () => {
    for (const name of made) {
      await sql(maintenance, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    }
  }, 60_000);

  return {
    cell,
    backend: new PostgresBackend({ cells: { [CELL]: cell } }),
    /** A name no database has yet; whatever is made under it is dropped at the end. */
    name(): string {
      const n = testDatabase(`${process.pid}_${serial++}`);
      made.push(n);
      return n;
    },
    ref: (database: string) => ({ kind: "postgres", database, cell: CELL }) as const,
    sql,
    /** Runs a statement on the maintenance database (CREATE DATABASE and the like). */
    admin: (text: string, params?: readonly SqlValue[]) => sql(maintenance, text, params),
  };
}
