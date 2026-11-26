// Samples of a storage format, server mode (docs/zh-CN/process/decisions/data-compatibility.md
// §4.5, §4.6): a control database and two tenants' databases written through `runServer`, dumped,
// restored into new databases and read again; and every server sample kept in the repository
// opened by this version. Only on PostgreSQL (`pnpm test:postgres` runs this file): a sample is a
// set of pg_dump scripts. `scripts/make-format-sample.ts` runs this file with
// SAVESLOT_FORMAT_SAMPLE_OUT to leave the sample there.
//
// Passwords are hashed with cheap scrypt parameters unless the sample is left for the repository:
// each hash records its own parameters, and a kept sample has the product's.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addLocalUser,
  CursorKeys,
  initControlPlane,
  initLocalAccounts,
  initOAuthTables,
  scratchDatabaseOf,
  type TenantId,
  type TenantPoolOptions,
  TenantReconciler,
  writeUserSession,
} from "@fluxvita/saveslot-service";
import { useScryptForTests } from "@fluxvita/saveslot-service/testing";
import { BUILTIN_LOCALE, type ControlDatabase } from "@fluxvita/saveslot-store-postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cellFromEnv, sqlOn } from "../../store-postgres/src/testing/server.fixture.ts";
import { databaseOf, TEST_BACKEND, testBackend } from "../../test-backend/src/index.fixture.ts";
import {
  CURRENT_FORMAT,
  dumpDatabase,
  dumpScript,
  expectedOf,
  REPO,
  SAMPLE_SWITCHED,
  SAMPLES_DIR,
  type ServerSampleExpected,
  sampledFormats,
  writeSampleHistory,
} from "./format-sample.fixture.ts";
import { type RunningServer, runServer } from "./run-server.ts";
import type { ServerConfig } from "./server-config.ts";

type Store = Awaited<ReturnType<ReturnType<typeof testBackend>["open"]>>;

const T = 300_000;
const CELL = "main";
const SESSION_ENDS = "2099-01-01T00:00:00.000Z";
/** Where the script wants the sample left; a temporary directory otherwise. */
const OUT = process.env["SAVESLOT_FORMAT_SAMPLE_OUT"];
const ON_POSTGRES = TEST_BACKEND === "postgres";
const root = mkdtempSync(join(tmpdir(), "saveslot-format-sample-server-"));
const open: { close(): Promise<void> }[] = [];

beforeAll(() => {
  if (OUT === undefined) useScryptForTests({ N: 2 ** 10, r: 8, p: 1 });
});
afterAll(async () => {
  useScryptForTests(undefined);
  for (const x of open.reverse()) await x.close().catch(() => {});
  rmSync(root, { recursive: true, force: true });
}, T);

let n = 0;

/** A deployment's storage on the test server: a control database and its tenants' databases. */
function deployment() {
  const control = join(root, `control${n}`);
  const tenants = join(root, `tenants${n++}`);
  const dirOf = (database: string) => join(tenants, CELL, database);
  const backend: TenantPoolOptions["backend"] = {
    open: (ref, opts) => {
      if (ref.kind !== "postgres") throw new Error("a server tenant's storage is a database");
      return testBackend().open({ kind: "pglite", dir: dirOf(ref.database) }, opts);
    },
  };
  return { control, dirOf, backend };
}

async function serve(store: Store, backend: TenantPoolOptions["backend"]): Promise<RunningServer> {
  const keys = mkdtempSync(join(root, "keys-"));
  const config: ServerConfig = {
    control: { cell: { host: "unused", user: "unused" }, database: "unused" },
    cell: { host: "unused", user: "unused" },
    cellName: CELL,
    publicUrl: "http://127.0.0.1:8080",
    handleKeyFile: join(keys, "handle-key"),
    listen: { host: "127.0.0.1", port: 0 },
    trustedProxies: [],
    allowedOrigins: [],
  };
  await CursorKeys.createFile(config.handleKeyFile);
  const db: ControlDatabase = {
    read: store.read.bind(store),
    write: store.write.bind(store),
    close: async () => {},
    onLost: () => {},
  };
  const server = await runServer({
    config,
    version: "sample",
    openControl: async () => db,
    backend,
  });
  open.push(server);
  return server;
}

/** The server named by SAVESLOT_TEST_POSTGRES_URL; the tests that call this run only with one. */
function cell() {
  const c = cellFromEnv();
  if (c === undefined) throw new Error("SAVESLOT_TEST_POSTGRES_URL names no server");
  return c;
}

/** Makes the sample: two local accounts, each with the sample's history in a tenant of its own. */
async function makeSample(out: string): Promise<ServerSampleExpected> {
  const d = deployment();
  const store = await testBackend().open({ kind: "pglite", dir: d.control }, { create: true });
  open.push(store);
  const cp = await initControlPlane(store);
  await initOAuthTables(store);
  const accounts = await initLocalAccounts(store);
  const server = await serve(store, d.backend);
  const tenants: ServerSampleExpected["tenants"][number][] = [];
  for (const name of ["sample_one", "sample_two"]) {
    const { user, tenant } = await addLocalUser(accounts, {
      control: cp,
      backend: d.backend,
      name,
      password: "correct horse battery",
      cell: CELL,
      cells: new Set([CELL]),
      now: new Date().toISOString(),
    });
    const session = await store.write((tx) =>
      writeUserSession(tx, user, { expiresAt: SESSION_ENDS }),
    );
    const entry = await cp.tenant(tenant);
    if (entry === undefined || entry.ref.kind !== "postgres") {
      throw new Error("the sample's tenant has no database");
    }
    const expected = await writeSampleHistory(server.address, session, {
      switched: SAMPLE_SWITCHED,
    });
    tenants.push({ name, tenant, database: entry.ref.database, session, expected });
  }
  await server.close();
  await store.close();

  const c = cell();
  const from = {
    host: c.host,
    user: c.user,
    ...(c.port !== undefined ? { port: c.port } : {}),
    ...(typeof c.password === "string" ? { password: c.password } : {}),
  };
  mkdirSync(out, { recursive: true });
  dumpDatabase(from, databaseOf(d.control), join(out, "control.sql"));
  for (const t of tenants) {
    dumpDatabase(from, databaseOf(d.dirOf(t.database)), join(out, `tenant-${t.database}.sql`));
  }
  const sample: ServerSampleExpected = { storage_format: CURRENT_FORMAT, tenants };
  writeFileSync(join(out, "expected.json"), `${JSON.stringify(sample, null, 2)}\n`);
  return sample;
}

/** Restores a dump into the database that stands for `dir`, made here. */
async function restore(dir: string, file: string): Promise<void> {
  const c = cell();
  mkdirSync(dir, { recursive: true });
  // As the backend makes a tenant's database (store-postgres's backend.ts).
  await sqlOn(
    c,
    c.maintenanceDatabase ?? "postgres",
    `CREATE DATABASE "${databaseOf(dir)}" TEMPLATE template0 ENCODING 'UTF8'
       LOCALE_PROVIDER builtin BUILTIN_LOCALE '${BUILTIN_LOCALE}' LOCALE 'C'`,
  );
  await sqlOn(c, databaseOf(dir), dumpScript(file));
}

/** Restores the sample in `dir` into new databases, opens it with this version and checks it. */
async function readSample(dir: string): Promise<void> {
  const sample = JSON.parse(
    readFileSync(join(dir, "expected.json"), "utf8"),
  ) as ServerSampleExpected;
  const d = deployment();
  await restore(d.control, join(dir, "control.sql"));
  for (const t of sample.tenants) {
    await restore(d.dirOf(t.database), join(dir, `tenant-${t.database}.sql`));
  }
  const store = await testBackend().open({ kind: "pglite", dir: d.control });
  open.push(store);
  const server = await serve(store, d.backend);
  for (const t of sample.tenants) {
    // The session issued when the sample was made is still taken.
    const now = await expectedOf(server.address, t.session, {
      switched: t.expected.switched === true,
    });
    // Reads made since the sample was dumped are more reads, and nothing else.
    expect({ ...now, reads_at_least: t.expected.reads_at_least }).toEqual(t.expected);
    expect(now.reads_at_least).toBeGreaterThanOrEqual(t.expected.reads_at_least);
    expect(now.storage_format).toBe(sample.storage_format);
  }
  await server.close();
  // K12: each tenant's log replayed into an empty database gives the tables the sample holds.
  const reconciler = new TenantReconciler({
    scratch: {
      open: (tenant) =>
        d.backend.open(
          { kind: "postgres", cell: CELL, database: scratchDatabaseOf(tenant) },
          { create: true },
        ),
      // Dropped with the run's other databases.
      discard: async () => {},
    },
  });
  for (const t of sample.tenants) {
    const live = await d.backend.open({ kind: "postgres", cell: CELL, database: t.database }, {});
    try {
      const r = await reconciler.reconcile(t.tenant as TenantId, (fn) => fn(live));
      expect(r.mismatches).toEqual([]);
      expect(r.compared_to).toBe(t.expected.log_end);
      expect(r.tables.length).toBeGreaterThan(10);
    } finally {
      await live.close();
    }
  }
  await store.close();
}

describe.skipIf(!ON_POSTGRES)("a sample of the current storage format, server mode", () => {
  const out = OUT ?? join(root, "sample");
  let sample: ServerSampleExpected;

  beforeAll(async () => {
    sample = await makeSample(out);
  }, T);

  it("holds two tenants, each with what the history wrote", () => {
    expect(sample.tenants.map((t) => t.name)).toEqual(["sample_one", "sample_two"]);
    expect(new Set(sample.tenants.map((t) => t.database)).size).toBe(2);
    for (const t of sample.tenants) {
      expect(t.expected).toMatchObject({
        storage_format: CURRENT_FORMAT,
        budget: { "2026-10-05": 5000, "2026-11-15": 4000 },
        open_items: { conflict: 1, awaiting_confirmation: 1 },
      });
    }
  });

  it(
    "dumped and restored into new databases, opens with the same values, and replays to the same tables",
    () => readSample(out),
    T,
  );
});

// None is kept until the first release's sample is added; then every format's is read.
const KEPT = sampledFormats("server");
describe.skipIf(!ON_POSTGRES || KEPT.length === 0)(
  "the samples kept in the repository, server mode",
  () => {
    it.each(KEPT)(
      "$name: opens with this version, with the values it was dumped with",
      async ({ format, name }) => {
        const dir = join(REPO, SAMPLES_DIR, name);
        const sample = JSON.parse(
          readFileSync(join(dir, "expected.json"), "utf8"),
        ) as ServerSampleExpected;
        expect(sample.storage_format).toBe(format);
        await readSample(dir);
      },
      T,
    );
  },
);
