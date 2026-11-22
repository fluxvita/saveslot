// Runs on PostgreSQL the tests that open their stores through the test backend
// (02-architecture §11 «测试矩阵»: the kernel's tests run on both backends), store-postgres's own, and
// the server mode's control plane (service), whose database is PostgreSQL in that mode.
//
// Usage: SAVESLOT_TEST_POSTGRES_URL=postgres://… node scripts/test-postgres.ts [vitest arguments…]
//
// The tests are those of packages/store-pglite/src: they hold the kernel's tests on a real store,
// and with SAVESLOT_TEST_BACKEND=postgres the test backend gives them PostgreSQL where they ask for
// PGlite (packages/test-backend). No test file is changed for it. Left out, by name and with the
// reason, are the files that test PGlite's backend itself.
//
// Three files there start PGlite themselves, in memory, and are the same on any run:
// format-v1.test.ts, derived-eval.prop.test.ts and rsql-exec.prop.test.ts.

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const TESTED = [
  "packages/store-pglite/src",
  "packages/store-postgres/src",
  "packages/test-backend/src",
  // The server mode's control plane, whose database is PostgreSQL there.
  "packages/service/src/server-control-plane.test.ts",
  "packages/service/src/server-tenant.test.ts",
  "packages/service/src/tenant-pool.test.ts",
  "packages/service/src/server-auth.test.ts",
  // The server mode's connection tokens: a control plane and a tenant store, both PostgreSQL there.
  "packages/service/src/server-connections.test.ts",
  // `saveslot server init` on the control database.
  "packages/daemon/src/server-commands.test.ts",
];

/** Files not run on PostgreSQL, each with why. */
export const EXCLUDED: readonly { readonly file: string; readonly why: string }[] = [
  {
    file: "packages/store-pglite/src/backend.test.ts",
    why: "tests PgliteBackend itself: the lock on the data directory, the owner file, the DB Worker, host fsync, and its own error class. What answers to these on PostgreSQL is tested in packages/store-postgres/src/backend.test.ts and edges.test.ts.",
  },
];

if (import.meta.main) {
  const url = process.env["SAVESLOT_TEST_POSTGRES_URL"];
  if (url === undefined || url === "") {
    console.error(
      "SAVESLOT_TEST_POSTGRES_URL is not set: it names the PostgreSQL to run the tests on.",
    );
    process.exit(2);
  }
  for (const x of EXCLUDED) console.error(`not run on PostgreSQL: ${x.file}\n  ${x.why}`);
  const repo = resolve(import.meta.dirname, "..");
  const r = spawnSync(
    process.execPath,
    [
      resolve(repo, "node_modules/vitest/vitest.mjs"),
      "run",
      ...TESTED,
      ...EXCLUDED.flatMap((x) => ["--exclude", x.file]),
      ...process.argv.slice(2),
    ],
    {
      cwd: repo,
      stdio: "inherit",
      // Required: a run asked to be on PostgreSQL must not pass by skipping what needs it.
      env: {
        ...process.env,
        SAVESLOT_TEST_BACKEND: "postgres",
        SAVESLOT_TEST_POSTGRES_REQUIRED: "1",
      },
    },
  );
  process.exit(r.status ?? 1);
}
