// Vitest global setup: the test databases of a run on PostgreSQL do not outlive it.
//
// Tests that open their stores on PostgreSQL (the test backend with SAVESLOT_TEST_BACKEND=postgres,
// and store-postgres's own tests) make a database for each store, named for the run. The files
// that make them know only directories, or drop their own in a hook a killed worker never runs;
// so, when the run ends, this drops every database the run made, and when a run starts, those of
// runs that are no longer there. Without SAVESLOT_TEST_POSTGRES_URL there is no server, and this
// does nothing.
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
  startRunPrefix,
} from "../../store-postgres/src/testing/server.fixture.ts";

let prefix: string | undefined;

export async function setup(): Promise<void> {
  // Kept from now: by the teardown the temporary directory may be the process's own again.
  prefix = startRunPrefix();
  const cell = cellFromEnv();
  if (cell === undefined) return;
  const stale = await dropStaleDatabases(cell);
  if (stale.length > 0) {
    console.error(`test-databases: dropped ${stale.length} left by runs that are gone`);
  }
}

export async function teardown(): Promise<void> {
  const cell = cellFromEnv();
  if (cell === undefined || prefix === undefined) return;
  const { left, error } = await dropRunDatabases(cell, prefix);
  // Said where it is seen: what is left is dropped by the next run on this machine.
  if (left.length > 0) {
    console.error(
      `test-databases: ${left.length} of this run's databases are still there after dropping them (first: ${left[0]}); first error: ${error?.message ?? "none"}`,
    );
  }
}
