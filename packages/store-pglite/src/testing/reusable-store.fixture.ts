// A store reused across the samples of a property test: opening PGlite costs seconds (it builds
// a new database), emptying one costs milliseconds. `reset` empties the store back to the state
// it was opened in: every kernel table emptied (identities restarted), `meta` as it was, every
// other table of the public schema (the physical tables apply created) dropped, every schema and
// every view, materialized view, sequence (one not owned by a column), function and type of the
// public schema made since dropped, and the store's read buffer (kept on the store object, not in
// the database) emptied. `snapshot` lists every table's rows, so a test can check that a reset
// leaves nothing of the sample before it. reusable-store.fixture.test.ts holds `reset` to that.
//
// Not within `reset`: the state of the session (`SET`, temporary tables, prepared statements,
// session advisory locks), and changes to a kernel table itself (a column, an index, a trigger,
// the table dropped). A test using a reusable store must not make them; one that needs to opens a
// store of its own.
//
// A test that timed out is failed but not stopped: it goes on reading and writing the store, and
// what it writes after the next test's reset fails that test for no fault of its own ("log is not
// empty", a duplicate `seq`). So `reset` first waits for every read and write of the store still
// running (at most `STALE_WAIT`: one that hangs fails the reset with a message, not a timeout of
// the hook), resets, and then fails, saying so: the test it was called for fails on what an
// earlier one left, not on a broken store. A read or write the earlier test starts after the
// reset is not seen.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KERNEL_TABLES,
  type ReadTx,
  readBufferOf,
  type TenantStore,
  type Tx,
} from "@fluxvita/saveslot-kernel";
import type { PgliteTenantStore } from "../backend.ts";
import { testBackend } from "./test-backend.fixture.ts";

const KERNEL = new Set(KERNEL_TABLES.map((t) => t.name));

/** What `reset` drops or keeps, each with the kind and the name its DROP takes. */
interface DbObject {
  readonly kind: string;
  readonly name: string;
  /** The table's own name, for a table. */
  readonly rel: string | null;
}

// Neither what an extension brings nor what goes with a table (its row type, a column's sequence).
const NOT_OWNED = (classid: string, oid: string, types: string) =>
  `NOT EXISTS (SELECT 1 FROM pg_depend d
     WHERE d.classid = '${classid}'::regclass AND d.objid = ${oid} AND d.deptype IN (${types}))`;

const OBJECTS = `
SELECT 'SCHEMA' AS kind, format('%I', nspname) AS name, NULL AS rel FROM pg_namespace
  WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
UNION ALL
SELECT CASE c.relkind WHEN 'v' THEN 'VIEW' WHEN 'm' THEN 'MATERIALIZED VIEW'
         WHEN 'S' THEN 'SEQUENCE' ELSE 'TABLE' END,
       format('public.%I', c.relname), CASE WHEN c.relkind IN ('r', 'p') THEN c.relname END
  FROM pg_class c
  WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'S')
    AND ${NOT_OWNED("pg_class", "c.oid", "'a', 'i', 'e'")}
UNION ALL
SELECT CASE p.prokind WHEN 'p' THEN 'PROCEDURE' WHEN 'a' THEN 'AGGREGATE' ELSE 'FUNCTION' END,
       format('public.%I(%s)', p.proname, pg_get_function_identity_arguments(p.oid)), NULL
  FROM pg_proc p
  WHERE p.pronamespace = 'public'::regnamespace AND ${NOT_OWNED("pg_proc", "p.oid", "'e'")}
UNION ALL
SELECT CASE t.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END, format('public.%I', t.typname), NULL
  FROM pg_type t
  WHERE t.typnamespace = 'public'::regnamespace
    AND (t.typtype IN ('e', 'd', 'r')
      OR (t.typtype = 'c' AND (SELECT relkind FROM pg_class WHERE oid = t.typrelid) = 'c'))
    AND ${NOT_OWNED("pg_type", "t.oid", "'e'")}`;

const keyOf = (o: DbObject) => `${o.kind} ${o.name}`;

/** Every table of the public schema with all its rows, as sorted JSON text. */
export async function snapshot(tx: ReadTx): Promise<Record<string, string[]>> {
  const names = await tx.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
  );
  const big = (_: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);
  const out: Record<string, string[]> = {};
  for (const { tablename } of names.rows) {
    const rows = await tx.query(`SELECT * FROM "${tablename}"`);
    out[tablename] = rows.rows.map((x) => JSON.stringify(x, big)).sort();
  }
  return out;
}

/** A store that can be emptied back to the state it was in when this was made of it. */
export interface Reusable<S extends TenantStore> {
  readonly store: S;
  /** Empties the store back to the state it was opened in. */
  reset(): Promise<void>;
  /** The state it was opened in (every table's rows). */
  readonly blank: Record<string, string[]>;
}

export interface ReusableStore extends Reusable<PgliteTenantStore> {
  /** The store's directory: on PostgreSQL, what names its database (`secondConnection`). */
  readonly dir: string;
  close(): Promise<void>;
}

/** The longest `reset` waits for the reads and writes of the store still running. */
export const STALE_WAIT = 30_000;

/**
 * Makes a store just opened reusable, on either backend; closing it stays with who opened it.
 * From then on the store's `read` and `write` are counted while they run.
 */
export async function reusable<S extends TenantStore>(
  store: S,
  staleWait = STALE_WAIT,
): Promise<Reusable<S>> {
  const meta = await store.read((tx) =>
    tx.query<{ key: string; value: string }>("SELECT key, value FROM meta"),
  );
  const kept = new Set((await store.read((tx) => tx.query<DbObject>(OBJECTS))).rows.map(keyOf));
  const blank = await store.read(snapshot);
  const running = new Set<Promise<unknown>>();
  const track = <T>(p: Promise<T>): Promise<T> => {
    running.add(p);
    const done = () => running.delete(p);
    p.then(done, done);
    return p;
  };
  const read = store.read.bind(store);
  const write = store.write.bind(store);
  const recordReads = store.recordReads?.bind(store);
  Object.assign(store, {
    read: <T>(fn: (tx: ReadTx) => Promise<T>) => track(read(fn)),
    write: <T>(fn: (tx: Tx) => Promise<T>) => track(write(fn)),
    ...(recordReads !== undefined
      ? { recordReads: <T>(fn: (tx: Tx) => Promise<T>) => track(recordReads(fn)) }
      : {}),
  });
  return {
    store,
    blank,
    reset: async () => {
      const left = running.size;
      if (left > 0) {
        let timer: NodeJS.Timeout | undefined;
        const waited = await Promise.race([
          Promise.allSettled([...running]).then(() => true),
          new Promise<false>((r) => {
            timer = setTimeout(() => r(false), staleWait);
          }),
        ]);
        clearTimeout(timer);
        if (!waited) {
          throw new Error(
            `reset: ${running.size} read(s) or write(s) of this store still running after ${staleWait} ms, left by an earlier test or sample (one that timed out goes on running); the store is not reset`,
          );
        }
      }
      await write(async (tx) => {
        const objects = (await tx.query<DbObject>(OBJECTS)).rows;
        const drops = objects.filter((o) =>
          o.kind === "TABLE" ? !KERNEL.has(o.rel as string) : !kept.has(keyOf(o)),
        );
        const kernel = objects.filter((o) => o.kind === "TABLE" && KERNEL.has(o.rel as string));
        // One statement list: what a drop takes with it (CASCADE) is gone when its turn comes.
        await tx.exec(
          [
            ...drops.map((o) => `DROP ${o.kind} IF EXISTS ${o.name} CASCADE`),
            `TRUNCATE ${kernel.map((o) => o.name).join(", ")} RESTART IDENTITY CASCADE`,
          ].join(";\n"),
        );
        for (const r of meta.rows) {
          await tx.query("INSERT INTO meta (key, value) VALUES ($1, $2)", [r.key, r.value]);
        }
      });
      // Reads a sample left would count as the next sample's: whether a writer had read an item
      // decides what its write does to it.
      readBufferOf(store).take();
      if (left > 0) {
        throw new Error(
          `reset: ${left} read(s) or write(s) of this store were still running, left by an earlier test or sample (one that timed out goes on running); waited for them and reset the store, but what fails after this may be theirs`,
        );
      }
    },
  };
}

/**
 * `buffered`: the store keeps its reads' records in the read buffer on either backend, as PGlite's
 * does (PostgreSQL's `recordReads` hidden), for a test of what a read records, which looks at the
 * buffer; when a record is written is reads-recorded.test.ts's.
 */
export async function openReusable(
  prefix: string,
  o: { readonly buffered?: boolean } = {},
): Promise<ReusableStore> {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const dir = join(root, "tenant");
  const store = await testBackend().open({ kind: "pglite", dir }, { create: true });
  if (o.buffered === true) Object.assign(store, { recordReads: undefined });
  return {
    ...(await reusable(store)),
    dir,
    close: async () => {
      await store.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}
