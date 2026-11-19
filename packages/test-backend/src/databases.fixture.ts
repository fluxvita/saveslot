// Vitest global setup: the test databases of a run on PostgreSQL do not outlive it.
//
// Tests that open their stores on PostgreSQL (the test backend with SAVESLOT_TEST_BACKEND=postgres,
// and store-postgres's own tests) make a database for each store, named for the run, and drop
// none: when the run ends, this drops every database the run made, all together, when no test
// writes any more (a DROP DATABASE waits for a checkpoint, and drops waiting together share one);
// when a run starts, those of runs that are no longer there. It says how many it dropped and how
// long that took, and once, at the start, what the server is (its version, and whether it syncs
// to disk: what a checkpoint costs). Without SAVESLOT_TEST_POSTGRES_URL there is no server, and
// none of this is done.
//
// The run's end has Vitest's `teardownTimeout` (vitest.config.ts) to drop them in.
//
// After scripts/test-tmp.ts in the list of global setups: a run is told from another by its
// temporary directory.
//
// The run's prefix is worked out here, once, and handed to every process of the run
// (server.fixture.ts, `startRunPrefix`), with or without a server: the names a test works out
// without one are the run's too.

import {
  cellFromEnv,
  dropRunDatabases,
  dropStaleDatabases,
  sqlOn,
  startRunPrefix,
} from "../../store-postgres/src/testing/server.fixture.ts";

let prefix: string | undefined;

export async function setup(): Promise<void> {
  // Kept from now: by the teardown the temporary directory may be the process's own again.
  prefix = startRunPrefix();
  const cell = cellFromEnv();
  if (cell === undefined) return;
  const server = await sqlOn(
    cell,
    cell.maintenanceDatabase ?? "postgres",
    "SELECT current_setting('server_version') AS version, current_setting('fsync') AS fsync, current_setting('full_page_writes') AS fpw",
    [],
  );
  const s = server.rows[0] ?? {};
  console.error(
    `test-databases: PostgreSQL ${String(s["version"])}, fsync ${String(s["fsync"])}, full_page_writes ${String(s["fpw"])}`,
  );
  const stale = await dropStaleDatabases(cell);
  if (stale.length > 0) {
    console.error(`test-databases: dropped ${stale.length} left by runs that are gone`);
  }
}

export async function teardown(): Promise<void> {
  const cell = cellFromEnv();
  if (cell === undefined || prefix === undefined) return;
  const started = Date.now();
  const { dropped, left, error } = await dropRunDatabases(cell, prefix);
  console.error(
    `test-databases: dropped this run's ${dropped.length - left.length} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  // Said where it is seen: what is left is dropped by the next run on this machine.
  if (left.length > 0) {
    console.error(
      `test-databases: ${left.length} of this run's databases are still there after dropping them (first: ${left[0]}); first error: ${error?.message ?? "none"}`,
    );
  }
}
