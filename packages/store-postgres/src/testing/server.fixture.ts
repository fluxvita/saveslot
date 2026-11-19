// The PostgreSQL server tests run against: where it is, plain SQL on it, and names for the
// databases a run makes on it. No test framework in here: the run's global setup uses it too.
//
// SAVESLOT_TEST_POSTGRES_URL names the server: `postgres://user[:password]@host[:port]/postgres`,
// or with a socket's directory `postgres:///postgres?host=/tmp`. The user must be allowed to create
// databases.
//
// A test database is `sst_h<machine>_r<run>_<rest>`: `<run>` says which run of the tests made it
// (the name of the run's temporary directory, in hex), so that what a run leaves can be dropped when
// it ends, and what a killed run left, by the next one. `<machine>` says on which machine that run
// was: a run's directory can only be looked for on the machine it was made on, so a run drops what
// is left of its own machine's runs only, and machines that share a server (a host and a container,
// two developers) leave each other's databases alone.
//
// The machine's mark is made at random the first time tests run there and kept in a file of the
// user's state directory (`machineFile`): it does not change with the network, as a host name can,
// nor across restarts; a container has a home of its own, and so a mark of its own.
//
// A run's prefix is worked out once, by its global setup, and handed to every process of the run
// in SAVESLOT_TEST_DATABASE_PREFIX: what a run makes and what it drops at its end are named by the
// same value, whatever happens to the mark's source meanwhile.

import { randomBytes } from "node:crypto";
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
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

const RUN = /^sst_h([0-9a-f]{8})_r((?:[0-9a-f]{2})+)_/;

const MARK = /^[0-9a-f]{8}$/;

/** Where this machine's mark is kept: SAVESLOT_TEST_MACHINE_FILE, or the user's state directory. */
export function machineFile(): string {
  const given = process.env["SAVESLOT_TEST_MACHINE_FILE"];
  if (given !== undefined && given !== "") return given;
  const state = process.env["XDG_STATE_HOME"] || join(homedir(), ".local", "state");
  return join(state, "saveslot-tests", "machine");
}

/**
 * This machine's mark: 8 hex digits, made at random the first time and kept in `file` from then on.
 * Two runs starting at once agree: the file is put in place whole, and only once.
 */
export function machineMark(file: string = machineFile()): string {
  if (!existsSync(file)) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const draft = `${file}.${process.pid}.${randomBytes(4).toString("hex")}`;
    writeFileSync(draft, `${randomBytes(4).toString("hex")}\n`, { mode: 0o600 });
    try {
      linkSync(draft, file);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    } finally {
      rmSync(draft, { force: true });
    }
  }
  const mark = readFileSync(file, "utf8").trim();
  if (!MARK.test(mark)) {
    throw new Error(
      `${file} does not hold a machine mark (8 hex digits): remove it, and the next run makes one`,
    );
  }
  return mark;
}

/** The prefix of the test databases of the run with the directory of that name, on that machine. */
export function runPrefix(run: string, mark: string): string {
  return `sst_h${mark}_r${Buffer.from(run).toString("hex")}_`;
}

/** Where a run's global setup hands its prefix to the run's processes. */
export const PREFIX_ENV = "SAVESLOT_TEST_DATABASE_PREFIX";

/** Works out this run's prefix (this machine, this run's directory) and hands it on. Global setup only. */
export function startRunPrefix(): string {
  const prefix = runPrefix(basename(runDir()), machineMark());
  process.env[PREFIX_ENV] = prefix;
  return prefix;
}

/** This run's prefix, as its global setup worked it out. */
export function thisRunPrefix(): string {
  const prefix = process.env[PREFIX_ENV];
  if (prefix === undefined || !RUN.test(prefix)) {
    throw new Error(
      `${PREFIX_ENV} is not set: the run's global setup (packages/test-backend/src/databases.fixture.ts) sets it`,
    );
  }
  return prefix;
}

/** A name for a test database of this run; `rest` is lower-case letters, digits and `_`. */
export const testDatabase = (rest: string): string => `${thisRunPrefix()}${rest}`;

/**
 * At most this many drops at once: each holds a connection of its own while it waits. As many as
 * a test file makes, so that a file's drops wait for the same checkpoints; two runs on one server
 * stay well within PostgreSQL's default of 100 connections.
 */
export const DROPS_AT_ONCE = 32;

/**
 * Drops the databases `names` of the cell, several at once. A DROP DATABASE waits for a
 * checkpoint, and drops waiting at the same time share one: one after another, N drops wait for N
 * checkpoints in turn, behind those of every other file doing the same. One that fails does not
 * stop the others: what it leaves is dropped by the run's end, or by the next run. Returns the
 * first failure, if any. `run` is how a statement is run (`sqlOn`; another in this fixture's own
 * tests).
 */
export async function dropDatabases(
  cell: PostgresCell,
  names: readonly string[],
  run: typeof sqlOn = sqlOn,
): Promise<Error | undefined> {
  const maintenance = cell.maintenanceDatabase ?? "postgres";
  const left = [...names];
  let first: Error | undefined;
  const dropping = async () => {
    for (let name = left.shift(); name !== undefined; name = left.shift()) {
      await run(cell, maintenance, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(
        (e: unknown) => {
          first ??= e instanceof Error ? e : new Error(String(e));
        },
      );
    }
  };
  await Promise.all(Array.from({ length: Math.min(DROPS_AT_ONCE, left.length) }, dropping));
  return first;
}

async function testDatabases(cell: PostgresCell): Promise<string[]> {
  const r = await sqlOn(
    cell,
    cell.maintenanceDatabase ?? "postgres",
    "SELECT datname FROM pg_database WHERE datname LIKE 'sst\\_h%' ORDER BY datname",
    [],
  );
  return r.rows.map((x) => String(x["datname"]));
}

/**
 * Drops the test databases of the run with this prefix (this run's, by default), then looks again.
 * Returns those it dropped, those still there, and the first failure.
 */
export async function dropRunDatabases(
  cell: PostgresCell,
  prefix: string = thisRunPrefix(),
): Promise<{ dropped: string[]; left: string[]; error: Error | undefined }> {
  const ofRun = async () => (await testDatabases(cell)).filter((n) => n.startsWith(prefix));
  const dropped = await ofRun();
  const error = await dropDatabases(cell, dropped);
  return { dropped, left: await ofRun(), error };
}

/**
 * Of the databases `names`, the test databases of runs on the machine of mark `mark` that are no
 * longer there: those whose run directory `runThere` does not find. Another machine's are not
 * looked at: its run directories are not here to be found.
 */
export function staleDatabases(
  names: readonly string[],
  mark: string,
  runThere: (run: string) => boolean,
): string[] {
  return names.filter((n) => {
    const m = RUN.exec(n);
    if (!m || m[1] !== mark) return false;
    const run = Buffer.from(m[2] as string, "hex").toString();
    return /^sst-\w+$/.test(run) && !runThere(run);
  });
}

/**
 * Drops the test databases of this machine's runs that are no longer there (`staleDatabases`,
 * the run directories looked for beside this run's; the machine, this run's). Returns their names.
 */
export async function dropStaleDatabases(cell: PostgresCell): Promise<string[]> {
  const base = dirname(runDir());
  const mark = (RUN.exec(thisRunPrefix()) as RegExpExecArray)[1] as string;
  const stale = staleDatabases(await testDatabases(cell), mark, (run) =>
    existsSync(join(base, run)),
  );
  await dropDatabases(cell, stale);
  return stale;
}
