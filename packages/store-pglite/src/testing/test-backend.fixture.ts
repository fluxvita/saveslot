// The backend that tests open their stores with. By default it does not pass PostgreSQL's fsync to
// the host (durability "pglite-default"). With "host-fsync" every commit and every checkpoint
// calls fs.fsyncSync on the host, which on macOS is fcntl(F_FULLFSYNC) (see durability.ts): the
// drive flushes its cache to the medium, one request at a time for the whole drive. Test files
// running in parallel then queue behind each other's flushes; the suite's time grows with the
// number of flushes, not with the number of workers, and a file at the end of the queue can spend
// over a minute closing its store. On Linux the same call is a plain fsync and costs little.
//
// What the default leaves out is only a power loss: a killed process loses nothing that reached
// the operating system, and opening after a kill still replays the WAL. The fsync path itself is
// covered by the tests that pass durability "host-fsync" explicitly, by the service tests (the
// service opens with the backend's default), and by the full runs that set
// SAVESLOT_TEST_DURABILITY=host-fsync, which makes every store opened here use it.
//
// The product default does not change: PgliteBackend without options uses "host-fsync".

import { PgliteBackend, type PgliteBackendOptions } from "../backend.ts";
import type { Durability } from "../protocol.ts";

function fromEnv(): Durability {
  const v = process.env["SAVESLOT_TEST_DURABILITY"];
  if (v === undefined || v === "") return "pglite-default";
  if (v === "host-fsync" || v === "pglite-default") return v;
  throw new Error(`SAVESLOT_TEST_DURABILITY must be "host-fsync" or "pglite-default", not "${v}"`);
}

/** The durability tests open their stores with. */
export const TEST_DURABILITY: Durability = fromEnv();

/** A backend for tests: `TEST_DURABILITY` unless the options name a durability. */
export function testBackend(opts: PgliteBackendOptions = {}): PgliteBackend {
  return new PgliteBackend({ durability: TEST_DURABILITY, ...opts });
}
