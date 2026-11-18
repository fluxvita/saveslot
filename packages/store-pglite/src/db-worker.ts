// The DB Worker: owns the tenant's PGlite instance (02-architecture §7). Every read and write of
// the tenant goes through this thread, one request at a time. See protocol.ts for the messages.
//
// This file must not import workspace packages at run time (only types): the worker is started
// from the package's own files and resolves imports without the workspace's "source" condition.

import { parentPort } from "node:worker_threads";
import { type Extension, PGlite } from "@electric-sql/pglite";
import { expectedSettings, hostSyncStats, nodeFs, startParams } from "./durability.ts";
import type {
  CreateParams,
  Durability,
  Envelope,
  ErrorCode,
  OpenParams,
  OpenResult,
  QueryReply,
  Reply,
  Request,
  WireError,
} from "./protocol.ts";

class WorkerError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

let db: PGlite | undefined;
let session: { mode: "read" | "write"; failed: boolean } | undefined;

async function startPglite(
  pgdata: string,
  durability: Durability,
  contrib: readonly string[] = [],
): Promise<PGlite> {
  const extensions: Record<string, Extension> = {};
  for (const name of contrib) {
    const mod = (await import(`@electric-sql/pglite/contrib/${name}`)) as Record<string, Extension>;
    const ext = mod[name];
    if (!ext) throw new Error(`PGlite contrib module ${name} has no export named ${name}`);
    extensions[name] = ext;
  }
  const pg = await PGlite.create({
    fs: nodeFs(pgdata, durability),
    startParams: startParams(durability),
    extensions,
  });
  try {
    const want = expectedSettings(durability);
    const names = Object.keys(want);
    const r = await pg.query<{ name: string; setting: string }>(
      "SELECT name, setting FROM pg_settings WHERE name = ANY($1)",
      [names],
    );
    const got = Object.fromEntries(r.rows.map((x) => [x.name, x.setting]));
    for (const n of names) {
      if (got[n] !== want[n]) {
        throw new WorkerError(
          "durability_not_applied",
          `PGlite setting ${n} is ${got[n] ?? "missing"}, expected ${want[n]} for durability "${durability}"`,
        );
      }
    }
    return pg;
  } catch (e) {
    await pg.close().catch(() => {});
    throw e;
  }
}

async function applySessionSettings(pg: PGlite, settings: readonly string[]): Promise<void> {
  for (const s of settings) await pg.exec(s);
}

async function create(p: CreateParams): Promise<null> {
  const pg = await startPglite(p.pgdata, p.durability);
  try {
    await applySessionSettings(pg, p.sessionSettings);
    await pg.transaction(async (tx) => {
      await tx.exec(p.ddl);
      for (const [k, v] of p.metaRows) {
        await tx.query("INSERT INTO meta (key, value) VALUES ($1, $2)", [k, v]);
      }
    });
  } finally {
    await pg.close();
  }
  return null;
}

async function open(p: OpenParams): Promise<OpenResult> {
  if (db) throw new Error("the worker already has an open database");
  const pg = await startPglite(p.pgdata, p.durability, p.contrib);
  try {
    // The database encoding cannot be set per session; it must be UTF8 (02-architecture §8).
    const enc = await pg.query<{ e: string }>("SELECT current_setting('server_encoding') AS e");
    if (enc.rows[0]?.e !== "UTF8") {
      throw new WorkerError("bad_encoding", `database encoding is ${enc.rows[0]?.e}, not UTF8`);
    }
    await applySessionSettings(pg, p.sessionSettings);

    const hasMeta = await pg.query<{ t: string | null }>("SELECT to_regclass('public.meta') AS t");
    if (hasMeta.rows[0]?.t == null) {
      throw new WorkerError(
        "not_a_store",
        "the directory holds no saveslot storage (no meta table)",
      );
    }
    const fmt = await pg.query<{ value: string }>("SELECT value FROM meta WHERE key = $1", [
      p.metaKeys.storageFormat,
    ]);
    const formatVersion = Number(fmt.rows[0]?.value);
    if (!Number.isInteger(formatVersion) || formatVersion < 1) {
      throw new WorkerError("not_a_store", "the storage has no valid storage format version");
    }
    // An older format is a store from development (no data has been published in one): not
    // migrated, refused with what to do.
    if (formatVersion < p.supportedFormat) {
      throw new WorkerError(
        "format_too_old",
        `storage format ${formatVersion} is a development format older than ${p.supportedFormat}; initialize the store anew with this version`,
      );
    }
    if (formatVersion > p.supportedFormat) {
      throw new WorkerError(
        "format_too_new",
        `storage format ${formatVersion} is newer than the supported format ${p.supportedFormat}; upgrade saveslot`,
      );
    }

    // Ownership epoch + 1 (02-architecture §7).
    const walSyncsBefore = hostSyncStats().wal;
    const epoch = await pg.transaction(async (tx) => {
      const r = await tx.query<{ value: string }>(
        `INSERT INTO meta (key, value) VALUES ($1, '1')
         ON CONFLICT (key) DO UPDATE SET value = (meta.value::bigint + 1)::text
         RETURNING value`,
        [p.metaKeys.ownershipEpoch],
      );
      return Number(r.rows[0]?.value);
    });
    // The epoch commit doubles as a self-test: with "host-fsync" it must have reached the host.
    if (p.durability === "host-fsync" && hostSyncStats().wal === walSyncsBefore) {
      throw new WorkerError(
        "durability_not_applied",
        "a commit did not fsync the write-ahead log on the host; the NODEFS fsync hook is not in effect",
      );
    }
    db = pg;
    epochKey = p.metaKeys.ownershipEpoch;
    return { formatVersion, epoch };
  } catch (e) {
    await pg.close().catch(() => {});
    throw e;
  }
}

let epochKey = "";

function requireDb(): PGlite {
  if (!db) throw new WorkerError("store_closed", "the database is not open");
  return db;
}

async function begin(mode: "read" | "write", epoch: number): Promise<null> {
  const pg = requireDb();
  if (session) throw new Error("a transaction is already open in the DB Worker");
  await pg.exec(mode === "read" ? "BEGIN READ ONLY" : "BEGIN");
  session = { mode, failed: false };
  if (mode === "write") {
    // Check the ownership epoch under the row lock at the start of every write transaction.
    const r = await pg.query<{ value: string }>(
      "SELECT value FROM meta WHERE key = $1 FOR UPDATE",
      [epochKey],
    );
    const stored = Number(r.rows[0]?.value);
    if (stored !== epoch) {
      await pg.exec("ROLLBACK");
      session = undefined;
      throw new WorkerError(
        "ownership_lost",
        `ownership epoch is ${stored}, this store opened it as ${epoch}: another opener took over`,
      );
    }
  }
  return null;
}

async function inSession<T>(f: (pg: PGlite) => Promise<T>): Promise<T> {
  const pg = requireDb();
  const s = session;
  if (!s) throw new Error("no transaction is open");
  try {
    return await f(pg);
  } catch (e) {
    s.failed = true;
    throw e;
  }
}

async function commit(): Promise<null> {
  const pg = requireDb();
  const s = session;
  if (!s) throw new Error("no transaction is open");
  session = undefined;
  if (s.failed) {
    // PostgreSQL would turn COMMIT into ROLLBACK silently; make it an error instead.
    await pg.exec("ROLLBACK");
    throw new WorkerError(
      "transaction_failed",
      "a statement in this transaction failed; the transaction was rolled back",
    );
  }
  await pg.exec("COMMIT");
  return null;
}

async function rollback(): Promise<null> {
  const pg = requireDb();
  if (!session) return null;
  session = undefined;
  await pg.exec("ROLLBACK");
  return null;
}

async function close(): Promise<null> {
  const pg = db;
  db = undefined;
  if (pg) {
    if (session) {
      session = undefined;
      await pg.exec("ROLLBACK").catch(() => {});
    }
    await pg.close();
  }
  return null;
}

async function handle(req: Request): Promise<unknown> {
  switch (req.kind) {
    case "create":
      return create(req.params);
    case "open":
      return open(req.params);
    case "begin":
      return begin(req.mode, req.epoch);
    case "query":
      return inSession(async (pg): Promise<QueryReply> => {
        const r = await pg.query<Record<string, unknown>>(req.sql, [...req.params]);
        return r.affectedRows === undefined
          ? { rows: r.rows }
          : { rows: r.rows, affectedRows: r.affectedRows };
      });
    case "exec":
      return inSession(async (pg) => {
        await pg.exec(req.sql);
        return null;
      });
    case "commit":
      return commit();
    case "rollback":
      return rollback();
    case "stats":
      return hostSyncStats();
    case "close":
      return close();
  }
}

function toWire(e: unknown): WireError {
  if (e instanceof WorkerError) return { message: e.message, code: e.code };
  if (e instanceof Error) {
    const sqlState = (e as { code?: unknown }).code;
    return typeof sqlState === "string" ? { message: e.message, sqlState } : { message: e.message };
  }
  return { message: String(e) };
}

const port = parentPort;
if (!port) throw new Error("db-worker.ts must run in a worker thread");

let chain: Promise<void> = Promise.resolve();
port.on("message", (env: Envelope) => {
  chain = chain.then(async () => {
    let reply: Reply;
    try {
      reply = { id: env.id, ok: true, value: await handle(env.request) };
    } catch (e) {
      reply = { id: env.id, ok: false, error: toWire(e) };
    }
    port.postMessage(reply);
  });
});
