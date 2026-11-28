// PgliteBackend / PgliteTenantStore: the DB Worker, transactions, the single-writer lock, the
// ownership epoch and the storage format check (02-architecture §7, §8).

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Worker } from "node:worker_threads";
import { META_KEYS, STORAGE_FORMAT_VERSION } from "@fluxvita/saveslot-kernel";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createPgdata,
  creation,
  PGDATA_DIR,
  PgliteBackend,
  type PgliteTenantStore,
} from "./backend.ts";
import { PgliteStoreError } from "./errors.ts";
import type { DirLock } from "./lock.ts";
import { newToken, writeOwner } from "./owner.ts";
import type { Envelope } from "./protocol.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const roots: string[] = [];
function tenantDir(): string {
  const root = mkdtempSync(join(tmpdir(), "saveslot-store-pglite-"));
  roots.push(root);
  return join(root, "tenant");
}
// Each store directory is tens of megabytes; removing them can be slow on a busy disk.
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

const backend = testBackend();
const ref = (dir: string) => ({ kind: "pglite", dir }) as const;

async function withStore<T>(dir: string, f: (s: PgliteTenantStore) => Promise<T>): Promise<T> {
  const s = await backend.open(ref(dir), { create: true });
  try {
    return await f(s);
  } finally {
    await s.close();
  }
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PgliteStoreError) return e.code;
    throw e;
  }
  return "no error";
}

const count = (s: PgliteTenantStore, table: string) =>
  s.read(async (tx) => {
    const r = await tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    return r.rows[0]?.n;
  });

const T = 60_000;

describe("the WAL of a local home stays bounded (single-user mode has no checkpointer)", () => {
  it(
    "a write's commit past the threshold is followed by a checkpoint; the WAL size settings hold",
    async () => {
      const dir = tenantDir();
      // The statistics are gathered as the product does, not after every write: an ANALYZE after
      // the checkpoint writes WAL of its own (SAVESLOT_TEST_ANALYZE=always).
      const s = await testBackend({ checkpointAfterBytes: 1024 * 1024, analyze: "stale" }).open(
        ref(dir),
        {
          create: true,
        },
      );
      try {
        const redo = () =>
          s.read(async (tx) => {
            const r = await tx.query<{ redo: string; since: string }>(
              `SELECT redo_lsn::text AS redo,
                      pg_wal_lsn_diff(pg_current_wal_insert_lsn(), redo_lsn)::text AS since
               FROM pg_control_checkpoint()`,
            );
            return r.rows[0] as { redo: string; since: string };
          });
        const settings = await s.read((tx) =>
          tx.query<{ name: string; setting: string }>(
            "SELECT name, setting FROM pg_settings WHERE name IN ('max_wal_size', 'min_wal_size') ORDER BY name",
          ),
        );
        expect(settings.rows).toEqual([
          { name: "max_wal_size", setting: "64" },
          { name: "min_wal_size", setting: "32" },
        ]);
        await s.write((tx) => tx.exec("CREATE TABLE t (k INT PRIMARY KEY, v TEXT)"));
        const before = await redo();
        // About 4 MiB of WAL, in four commits: each past 1 MiB is followed by a checkpoint.
        for (let i = 0; i < 4; i++) {
          await s.write((tx) =>
            tx.exec(
              `INSERT INTO t SELECT g, repeat('x', 1000) FROM generate_series(${i * 1000 + 1}, ${(i + 1) * 1000}) g`,
            ),
          );
        }
        const after = await redo();
        expect(after.redo).not.toBe(before.redo);
        expect(Number(after.since)).toBeLessThan(1024 * 1024);
        expect(await count(s, "t")).toBe(4000);
      } finally {
        await s.close();
      }
    },
    T,
  );
});

describe("the checkpoint after a write", () => {
  /** Requests the main thread sends to DB Workers while `f` runs; `swap` may replace one. */
  async function watchingRequests<T>(
    f: (kinds: string[]) => Promise<T>,
    swap: (env: Envelope) => Envelope = (env) => env,
  ): Promise<T> {
    const post = Worker.prototype.postMessage;
    const kinds: string[] = [];
    const spy = vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      value: unknown,
    ) {
      const env = value as Envelope;
      kinds.push(env.request.kind);
      post.call(this, swap(env));
    });
    try {
      return await f(kinds);
    } finally {
      spy.mockRestore();
    }
  }

  it(
    "a checkpoint that fails ends the worker: the write before it stands, the store is failed, one line is logged",
    async () => {
      const dir = tenantDir();
      const events: unknown[] = [];
      await watchingRequests(
        async () => {
          const s = await testBackend({
            checkpointAfterBytes: 1,
            // Only the checkpoint's line is looked for: no ANALYZE of its own (always, in a run
            // with SAVESLOT_TEST_ANALYZE=always) adds one.
            analyze: "stale",
            onEvent: (event, fields) => events.push([event, fields]),
          }).open(ref(dir), { create: true });
          try {
            await s.write((tx) => tx.exec("CREATE TABLE t (k INT)"));
            expect(await codeOf(s.write((tx) => tx.exec("INSERT INTO t VALUES (1)")))).toBe(
              "worker_failed",
            );
            expect(await codeOf(s.read((tx) => tx.query("SELECT 1")))).toBe("worker_failed");
          } finally {
            await s.close();
          }
        },
        // A checkpoint that throws: in its place, a statement outside any transaction, which the
        // worker refuses.
        (env) =>
          env.request.kind === "checkpoint"
            ? { id: env.id, request: { kind: "query", sql: "SELECT 1", params: [] } }
            : env,
      );
      expect(events).toEqual([["checkpoint_failed", { code: "unknown" }]]);
      // What was committed before the checkpoint is there on reopen.
      await withStore(dir, async (s) => expect(await count(s, "t")).toBe(0));
    },
    T,
  );

  it(
    "is not sent once another opener took the storage over",
    async () => {
      const dir = tenantDir();
      await watchingRequests(async (kinds) => {
        const s = await testBackend({ checkpointAfterBytes: 1 }).open(ref(dir), { create: true });
        try {
          await s.write((tx) => tx.exec("CREATE TABLE t (k INT)"));
          await s.read((tx) => tx.query("SELECT 1"));
          expect(kinds.filter((k) => k === "checkpoint")).toHaveLength(1);
          kinds.length = 0;
          // The takeover lands after the write's reply and before the checkpoint queued behind it:
          // this callback runs before the queue moves on to its next job.
          await s
            .write((tx) => tx.exec("INSERT INTO t VALUES (1)"))
            .then(() => writeOwner(dir, { token: newToken(), startedAt: "", epoch: null }));
          expect(await codeOf(s.read((tx) => tx.query("SELECT 1")))).toBe("ownership_lost");
          expect(kinds).toEqual(["begin", "exec", "commit"]);
        } finally {
          await s.close();
        }
      });
    },
    T,
  );
});

describe("transactions through the DB Worker", () => {
  it(
    "writes, reads back, and keeps the data across close and reopen",
    async () => {
      const dir = tenantDir();
      await withStore(dir, async (s) => {
        expect(s.formatVersion).toBe(STORAGE_FORMAT_VERSION);
        await s.write(async (tx) => {
          await tx.exec("CREATE TABLE t (k TEXT PRIMARY KEY, v BIGINT)");
          const r = await tx.query("INSERT INTO t VALUES ($1, $2), ($3, $4)", ["a", 1, "b", 2n]);
          expect(r.affectedRows).toBe(2);
        });
        const rows = await s.read((tx) => tx.query("SELECT k, v::text AS v FROM t ORDER BY k"));
        expect(rows.rows).toEqual([
          { k: "a", v: "1" },
          { k: "b", v: "2" },
        ]);
      });
      await withStore(dir, async (s) => {
        expect(await count(s, "t")).toBe(2);
        // The fixed session settings are applied to the connection.
        const tz = await s.read((tx) => tx.query<{ tz: string }>("SHOW TIME ZONE"));
        expect(tz.rows[0]).toEqual({ TimeZone: "UTC" });
      });
    },
    T,
  );

  it(
    "rolls back when the callback throws, and rejects with the callback's error",
    async () => {
      await withStore(tenantDir(), async (s) => {
        await s.write((tx) => tx.exec("CREATE TABLE t (k TEXT)"));
        const boom = new Error("boom");
        await expect(
          s.write(async (tx) => {
            await tx.query("INSERT INTO t VALUES ('x')");
            throw boom;
          }),
        ).rejects.toBe(boom);
        expect(await count(s, "t")).toBe(0);
      });
    },
    T,
  );

  it(
    "does not commit a transaction in which a statement failed, even if the callback swallowed it",
    async () => {
      await withStore(tenantDir(), async (s) => {
        await s.write((tx) => tx.exec("CREATE TABLE t (k TEXT PRIMARY KEY)"));
        const code = await codeOf(
          s.write(async (tx) => {
            await tx.query("INSERT INTO t VALUES ('x')");
            await tx.query("INSERT INTO t VALUES ('x')").catch(() => {});
          }),
        );
        expect(code).toBe("transaction_failed");
        expect(await count(s, "t")).toBe(0);
        // The store is still usable.
        await s.write((tx) => tx.query("INSERT INTO t VALUES ('y')"));
        expect(await count(s, "t")).toBe(1);
      });
    },
    T,
  );

  it(
    "runs reads and writes one at a time, in call order",
    async () => {
      await withStore(tenantDir(), async (s) => {
        await s.write((tx) => tx.exec("CREATE TABLE t (n INT)"));
        const log: string[] = [];
        const pause = () => new Promise((r) => setTimeout(r, 30));
        const w = (name: string) =>
          s.write(async (tx) => {
            log.push(`${name}+`);
            await pause();
            await tx.query("INSERT INTO t VALUES (1)");
            log.push(`${name}-`);
          });
        const r = (name: string) =>
          s.read(async (tx) => {
            log.push(`${name}+`);
            await pause();
            const c = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM t");
            log.push(`${name}-${c.rows[0]?.n}`);
          });
        await Promise.all([w("w1"), r("r1"), w("w2"), r("r2"), w("w3")]);
        expect(log).toEqual([
          "w1+",
          "w1-",
          "r1+",
          "r1-1",
          "w2+",
          "w2-",
          "r2+",
          "r2-2",
          "w3+",
          "w3-",
        ]);
      });
    },
    T,
  );

  it(
    "refuses use of a transaction after it finished, and writes in a read transaction",
    async () => {
      await withStore(tenantDir(), async (s) => {
        await s.write((tx) => tx.exec("CREATE TABLE t (n INT)"));
        let leaked: { query: (sql: string) => Promise<unknown> } | undefined;
        await s.read(async (tx) => {
          leaked = tx;
        });
        await expect(leaked?.query("SELECT 1")).rejects.toThrow(/already finished/);
        const code = await codeOf(s.read((tx) => tx.query("INSERT INTO t VALUES (1)")));
        expect(code).toBe("query_failed");
        expect(await count(s, "t")).toBe(0);
      });
    },
    T,
  );
});

describe("opening", () => {
  it(
    "refuses a missing storage unless asked to create it",
    async () => {
      // Made for real, not copied from the test backend's template: making it is the subject.
      const real = testBackend({ template: false });
      const dir = tenantDir();
      expect(await codeOf(real.open(ref(dir), {}))).toBe("store_not_found");
      await (await real.open(ref(dir), { create: true })).close();
      const s = await real.open(ref(dir), {});
      await s.close();
    },
    T,
  );

  it(
    "refuses a second open of the same directory in the same process until the first closes",
    async () => {
      const dir = tenantDir();
      const s = await backend.open(ref(dir), { create: true });
      expect(await codeOf(backend.open(ref(dir), { create: true }))).toBe("store_locked");
      await s.close();
      const again = await backend.open(ref(dir), {});
      await again.close();
    },
    T,
  );

  it(
    "refuses an open from another process while one process holds the storage",
    async () => {
      const dir = tenantDir();
      // Another process holds it; this process is refused.
      const child = spawnFixture(dir, "hold");
      expect(await firstLine(child)).toMatchObject({ opened: true });
      expect(await codeOf(backend.open(ref(dir), {}))).toBe("store_locked");
      child.stdin?.end();
      await exited(child);
      // This process holds it; another process is refused.
      const s = await backend.open(ref(dir), {});
      const other = spawnFixture(dir);
      expect(await firstLine(other)).toEqual({ opened: false, code: "store_locked" });
      await exited(other);
      await s.close();
    },
    T,
  );

  it(
    "refuses a storage format newer than the supported one, and releases the lock",
    async () => {
      const dir = tenantDir();
      await withStore(dir, (s) =>
        s.write((tx) =>
          tx.query("UPDATE meta SET value = $1 WHERE key = $2", [
            String(STORAGE_FORMAT_VERSION + 1),
            META_KEYS.storageFormat,
          ]),
        ),
      );
      expect(await codeOf(backend.open(ref(dir), {}))).toBe("format_too_new");
      // Refused again for the same reason, not because the first attempt kept the lock.
      expect(await codeOf(backend.open(ref(dir), {}))).toBe("format_too_new");
    },
    T,
  );

  it(
    "refuses a store of an older, development format: initialize it anew",
    async () => {
      const dir = tenantDir();
      await withStore(dir, (s) =>
        s.write((tx) =>
          tx.query("UPDATE meta SET value = $1 WHERE key = $2", [
            String(STORAGE_FORMAT_VERSION - 1),
            META_KEYS.storageFormat,
          ]),
        ),
      );
      const e = await backend.open(ref(dir), {}).then(
        () => undefined,
        (x: unknown) => x as { code?: string; message?: string },
      );
      expect(e?.code).toBe("format_too_old");
      expect(e?.message).toContain("initialize the store anew");
      expect(await codeOf(backend.open(ref(dir), {}))).toBe("format_too_old");
    },
    T,
  );
});

// Making a storage, by PgliteBackend itself: its steps, what a making stopped halfway leaves, and
// createPgdata. The test backend copies most tests' storages from a template made once, so this
// is where the steps of making one are tested.
describe("making a storage", () => {
  const making = new PgliteBackend({ durability: "pglite-default" });

  it(
    "makes it in pgdata.creating and moves it to pgdata once whole: the format's meta rows, the epoch moved by the open",
    async () => {
      const dir = tenantDir();
      const s = await making.open(ref(dir), { create: true });
      try {
        expect(s.epoch).toBe(1);
        const meta = await s.read((tx) =>
          tx.query<{ key: string; value: string }>("SELECT key, value FROM meta ORDER BY key"),
        );
        expect(Object.fromEntries(meta.rows.map((r) => [r.key, r.value]))).toEqual(
          Object.fromEntries(
            creation("pglite-default").metaRows.map(([k, v]) => [
              k,
              k === META_KEYS.ownershipEpoch ? "1" : v,
            ]),
          ),
        );
      } finally {
        await s.close();
      }
      expect(readdirSync(dir)).toContain(PGDATA_DIR);
      expect(readdirSync(dir)).not.toContain("pgdata.creating");
      expect(existsSync(join(dir, PGDATA_DIR, "PG_VERSION"))).toBe(true);
    },
    T,
  );

  it(
    "a pgdata.creating left by a making that stopped halfway is cleared, and the storage made whole",
    async () => {
      const dir = tenantDir();
      mkdirSync(join(dir, "pgdata.creating", "base"), { recursive: true });
      writeFileSync(join(dir, "pgdata.creating", "base", "half"), "half made\n");
      const s = await making.open(ref(dir), { create: true });
      try {
        expect(await count(s, "meta")).toBe(creation("pglite-default").metaRows.length);
      } finally {
        await s.close();
      }
      expect(readdirSync(dir)).not.toContain("pgdata.creating");
      expect(existsSync(join(dir, PGDATA_DIR, "base", "half"))).toBe(false);
    },
    T,
  );

  it(
    "a pgdata that holds no storage: not_a_store, with or without create, and left as it is",
    async () => {
      const dir = tenantDir();
      mkdirSync(join(dir, PGDATA_DIR), { recursive: true });
      writeFileSync(join(dir, PGDATA_DIR, "mine"), "not a database\n");
      expect(await codeOf(making.open(ref(dir), {}))).toBe("not_a_store");
      expect(await codeOf(making.open(ref(dir), { create: true }))).toBe("not_a_store");
      expect(readdirSync(join(dir, PGDATA_DIR))).toEqual(["mine"]);
    },
    T,
  );

  it(
    "createPgdata makes what opening with create makes: opened, the same tables and rows",
    async () => {
      const made = tenantDir();
      mkdirSync(made);
      await createPgdata(join(made, PGDATA_DIR), "pglite-default");
      const rows = async (s: PgliteTenantStore) =>
        s.read(async (tx) => {
          const t = await tx.query<{ t: string }>(
            "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' ORDER BY 1",
          );
          const meta = await tx.query("SELECT key, value FROM meta ORDER BY key");
          return { tables: t.rows.map((r) => r.t), meta: meta.rows };
        });
      const a = await making.open(ref(made), {});
      const b = await making.open(ref(tenantDir()), { create: true });
      try {
        expect(a.epoch).toBe(1);
        expect(await rows(a)).toEqual(await rows(b));
      } finally {
        await a.close();
        await b.close();
      }
    },
    T,
  );
});

describe("ownership epoch", () => {
  it(
    "increments the epoch on every open and records it in meta",
    async () => {
      const dir = tenantDir();
      const epochs: number[] = [];
      for (let i = 0; i < 3; i++) {
        await withStore(dir, async (s) => {
          const r = await s.read((tx) =>
            tx.query<{ value: string }>("SELECT value FROM meta WHERE key = $1", [
              META_KEYS.ownershipEpoch,
            ]),
          );
          expect(Number(r.rows[0]?.value)).toBe(s.epoch);
          epochs.push(s.epoch);
        });
      }
      expect(epochs).toEqual([1, 2, 3]);
    },
    T,
  );

  it(
    "stops a write whose epoch no longer matches the one in meta",
    async () => {
      await withStore(tenantDir(), async (s) => {
        await s.write((tx) => tx.exec("CREATE TABLE t (n INT)"));
        await s.write((tx) =>
          tx.query("UPDATE meta SET value = (value::bigint + 1)::text WHERE key = $1", [
            META_KEYS.ownershipEpoch,
          ]),
        );
        const code = await codeOf(s.write((tx) => tx.query("INSERT INTO t VALUES (1)")));
        expect(code).toBe("ownership_lost");
        // The store gave the tenant up: reads are refused too.
        expect(await codeOf(count(s, "t"))).toBe("ownership_lost");
      });
    },
    T,
  );

  it(
    "stops a stale store from writing after another opener took over (lock lost)",
    async () => {
      // A lock that never refuses stands in for a lost lock.
      const noLock: DirLock = { name: "none", acquire: async () => ({ release: async () => {} }) };
      const unlocked = testBackend({ lock: noLock });
      const dir = tenantDir();
      const stale = await unlocked.open(ref(dir), { create: true });
      await stale.write((tx) => tx.exec("CREATE TABLE t (who TEXT)"));
      await stale.write((tx) => tx.query("INSERT INTO t VALUES ('stale-before')"));

      const fresh = await unlocked.open(ref(dir), {});
      expect(fresh.epoch).toBe(stale.epoch + 1);

      const code = await codeOf(
        stale.write((tx) => tx.query("INSERT INTO t VALUES ('stale-after')")),
      );
      expect(code).toBe("ownership_lost");
      await stale.close();

      await fresh.write((tx) => tx.query("INSERT INTO t VALUES ('fresh')"));
      const rows = await fresh.read((tx) =>
        tx.query<{ who: string }>("SELECT who FROM t ORDER BY who"),
      );
      expect(rows.rows.map((r) => r.who)).toEqual(["fresh", "stale-before"]);
      await fresh.close();
    },
    T,
  );
});

describe("durability configuration", () => {
  it(
    'passes PostgreSQL\'s WAL fsync to the host on every commit with "host-fsync" only',
    async () => {
      const commits = 5;
      const walSyncs = async (b: PgliteBackend) => {
        const s = await b.open(ref(tenantDir()), { create: true });
        try {
          await s.write((tx) => tx.exec("CREATE TABLE t (n INT)"));
          const before = await s.hostSyncStats();
          for (let i = 0; i < commits; i++)
            await s.write((tx) => tx.query("INSERT INTO t VALUES (1)"));
          const after = await s.hostSyncStats();
          return after.wal - before.wal;
        } finally {
          await s.close();
        }
      };
      expect(
        await walSyncs(new PgliteBackend({ durability: "host-fsync" })),
      ).toBeGreaterThanOrEqual(commits);
      expect(await walSyncs(new PgliteBackend({ durability: "pglite-default" }))).toBe(0);
    },
    T,
  );

  it(
    'uses "host-fsync" when no durability is given (tests open their stores with another one)',
    async () => {
      const s = await new PgliteBackend().open(ref(tenantDir()), { create: true });
      try {
        const settings = await s.read((tx) =>
          tx.query<{ name: string; setting: string }>(
            "SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'wal_sync_method') ORDER BY name",
          ),
        );
        expect(settings.rows).toEqual([
          { name: "fsync", setting: "on" },
          { name: "wal_sync_method", setting: "fsync" },
        ]);
        const before = await s.hostSyncStats();
        await s.write((tx) => tx.exec("CREATE TABLE t (n INT)"));
        expect((await s.hostSyncStats()).wal).toBeGreaterThan(before.wal);
      } finally {
        await s.close();
      }
    },
    T,
  );

  it(
    "does not offer snapshot (purge-residue.test.ts has the residue clean-up)",
    async () => {
      await withStore(tenantDir(), async (s) => {
        await expect(s.snapshot()).rejects.toThrow(/not in v1/);
      });
    },
    T,
  );
});

// ---- helpers for the cross-process test ----

const FIXTURE = join(import.meta.dirname, "testing", "open-store.fixture.ts");

function spawnFixture(dir: string, mode?: "hold"): ChildProcess {
  return spawn(
    process.execPath,
    // Wasm code GC off, as the test forks have it (vitest.config.ts, nodejs/node#66366).
    [
      "--no-wasm-code-gc",
      "--conditions=source",
      "--no-warnings",
      FIXTURE,
      dir,
      ...(mode ? [mode] : []),
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
}

function firstLine(child: ChildProcess): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const stdout = child.stdout;
    if (!stdout) return reject(new Error("no stdout"));
    const rl = createInterface({ input: stdout });
    rl.once("line", (l) => resolve(JSON.parse(l)));
    child.once("exit", (code) => reject(new Error(`fixture exited (${code}) without output`)));
  });
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((r) => {
    if (child.exitCode !== null) r();
    else child.once("exit", () => r());
  });
}
