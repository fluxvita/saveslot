// The PostgreSQL server tests run against: where it is, plain SQL on it, and names for the
// databases a run makes on it. No test framework in here: the run's global setup uses it too.
//
// SAVESLOT_TEST_POSTGRES_URL names the server: `postgres://user[:password]@host[:port]/postgres`,
// or with a socket's directory `postgres:///postgres?host=/tmp`. The user must be allowed to create
// databases.
//
// A test database is `sst_r<run>_<rest>`: `<run>` says which run of the tests made it (the name of
// the run's temporary directory, in hex), so that what a run leaves can be dropped when it ends, and
// what a killed run left, by the next one.

import { existsSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import type { SqlValue } from "@fluxvita/saveslot-kernel";
import { Connection, type PostgresCell, type Result } from "../connection.ts";

/** The cell a test URL names. */
export function cellOf(url: string): PostgresCell {
  const u = new URL(url);
  const user = decodeURIComponent(u.username) || u.searchParams.get("user") || userInfo().username;
  const database = u.pathname.replace(/^\//, "");
  return {
    host: u.searchParams.get("host") ?? (decodeURIComponent(u.hostname) || "localhost"),
    user,
    ...(u.port !== "" ? { port: Number(u.port) } : {}),
    ...(u.password !== "" ? { password: decodeURIComponent(u.password) } : {}),
    ...(database !== "" ? { maintenanceDatabase: database } : {}),
  };
}

/** The cell SAVESLOT_TEST_POSTGRES_URL names, or undefined when it names none. */
export function cellFromEnv(): PostgresCell | undefined {
  const url = process.env["SAVESLOT_TEST_POSTGRES_URL"];
  return url !== undefined && url !== "" ? cellOf(url) : undefined;
}

/** Runs statements on `database` of the cell over a connection of its own. */
export async function sqlOn(
  cell: PostgresCell,
  database: string,
  text: string,
  params?: readonly SqlValue[],
): Promise<Result> {
  const c = await Connection.connect(cell, database);
  try {
    return await c.run(text, params);
  } finally {
    await c.end();
  }
}

/** The run's temporary directory (scripts/test-tmp.ts makes it: `<base>/sst-XXXXXX`, TMPDIR its `t`). */
const runDir = (): string => dirname(tmpdir());

const RUN = /^sst_r((?:[0-9a-f]{2})+)_/;

/** The prefix of this run's test databases. */
export function runPrefix(): string {
  return `sst_r${Buffer.from(basename(runDir())).toString("hex")}_`;
}

/** A name for a test database of this run; `rest` is lower-case letters, digits and `_`. */
export const testDatabase = (rest: string): string => `${runPrefix()}${rest}`;

async function drop(cell: PostgresCell, names: readonly string[]): Promise<void> {
  const maintenance = cell.maintenanceDatabase ?? "postgres";
  for (const name of names) {
    await sqlOn(cell, maintenance, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(
      () => {},
    );
  }
}

async function testDatabases(cell: PostgresCell): Promise<string[]> {
  const r = await sqlOn(
    cell,
    cell.maintenanceDatabase ?? "postgres",
    "SELECT datname FROM pg_database WHERE datname LIKE 'sst\\_r%' ORDER BY datname",
    [],
  );
  return r.rows.map((x) => String(x["datname"]));
}

/** Drops the test databases of the run with this prefix (this run's, by default). Returns their names. */
export async function dropRunDatabases(
  cell: PostgresCell,
  prefix: string = runPrefix(),
): Promise<string[]> {
  const mine = (await testDatabases(cell)).filter((n) => n.startsWith(prefix));
  await drop(cell, mine);
  return mine;
}

/**
 * Drops the test databases of runs that are no longer there: those whose run directory, beside
 * this run's, does not exist. Returns their names.
 */
export async function dropStaleDatabases(cell: PostgresCell): Promise<string[]> {
  const base = dirname(runDir());
  const stale = (await testDatabases(cell)).filter((n) => {
    const m = RUN.exec(n);
    if (!m) return false;
    const run = Buffer.from(m[1] as string, "hex").toString();
    return /^sst-\w+$/.test(run) && !existsSync(join(base, run));
  });
  await drop(cell, stale);
  return stale;
}
