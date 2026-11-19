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

import {
  cellFromEnv,
  dropRunDatabases,
  dropStaleDatabases,
  runPrefix,
} from "../../store-postgres/src/testing/server.fixture.ts";

let prefix: string | undefined;

export async function setup(): Promise<void> {
  const cell = cellFromEnv();
  if (cell === undefined) return;
  // Kept from now: by the teardown the temporary directory may be the process's own again.
  prefix = runPrefix();
  const stale = await dropStaleDatabases(cell);
  if (stale.length > 0) {
    console.error(`test-databases: dropped ${stale.length} left by runs that are gone`);
  }
}

export async function teardown(): Promise<void> {
  const cell = cellFromEnv();
  if (cell === undefined || prefix === undefined) return;
  await dropRunDatabases(cell, prefix);
}
