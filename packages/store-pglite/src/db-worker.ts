// The DB Worker: owns the tenant's PGlite instance (02-architecture §7). Every read and write of
// the tenant goes through this thread, one request at a time. See protocol.ts for the messages.
//
// This file must not import workspace packages at run time (only types): the worker is started
// from the package's own files and resolves imports without the workspace's "source" condition.

import { parentPort } from "node:worker_threads";
import { type Extension, PGlite } from "@electric-sql/pglite";
import { type UpgradeStep, upgradePath } from "@fluxvita/saveslot-kernel";
import { expectedSettings, hostSyncStats, nodeFs, startParams } from "./durability.ts";
import type {
  AnalyzeMode,
  AnalyzeReply,
  CreateParams,
  Durability,
  Envelope,
  ErrorCode,
  MaintainReply,
  MaintainStep,
  OpenParams,
  OpenResult,
  QueryReply,
  Reply,
  Request,
  UpgradeReply,
  WireError,
} from "./protocol.ts";

class WorkerError extends Error {
  readonly code: ErrorCode;
  readonly sqlState: string | undefined;
  constructor(code: ErrorCode, message: string, sqlState?: string) {
    super(message);
    this.code = code;
    this.sqlState = sqlState;
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
    // Older than any released version wrote: a store from development, not upgraded, refused with
    // what to do. From there to this kernel's format: upgraded, after the checks below.
    if (formatVersion < p.oldestFormat) {
      throw new WorkerError(
        "format_too_old",
        `storage format ${formatVersion} is a development format older than ${p.oldestFormat}; initialize the store anew with this version`,
      );
    }
    if (formatVersion > p.supportedFormat) {
      throw new WorkerError(
        "format_too_new",
        `storage format ${formatVersion} is newer than the supported format ${p.supportedFormat}; upgrade saveslot`,
      );
    }

    // The fixed session settings it was created with are the ones applied now (02-architecture
    // §8): an upgrade's statements, and everything after, run under them.
    const made = await pg.query<{ value: string }>("SELECT value FROM meta WHERE key = $1", [
      p.metaKeys.sessionSettings,
    ]);
    if (made.rows[0]?.value !== JSON.stringify(p.sessionSettings)) {
      throw new WorkerError(
        "session_settings_mismatch",
        "the storage was created with other fixed session settings than this version's",
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
    checkpointAfterBytes = p.checkpointAfterBytes;
    analyzeMode = p.analyze;
    upgradeTo = p.supportedFormat;
    upgradeSteps = p.upgradeSteps;
    formatKey = p.metaKeys.storageFormat;
    // An older format: upgraded by the `upgrade` request that follows, then analyzed.
    if (formatVersion < p.supportedFormat) {
      return {
        formatVersion,
        epoch,
        analyzed: { ran: false },
        upgrade: { from: formatVersion, to: p.supportedFormat },
      };
    }
    // Statistics before the store serves (02-architecture §7 «统计信息»): a failure is reported,
    // not thrown; the open goes on.
    let analyzed: OpenResult["analyzed"];
    try {
      analyzed = await analyze();
    } catch (e) {
      const w = toWire(e);
      analyzed = { failed: w.sqlState ?? w.code ?? "unknown" };
    }
    return { formatVersion, epoch, analyzed };
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

/** WAL since the last checkpoint, in bytes, past which `checkpoint` runs one. */
let checkpointAfterBytes = Number.POSITIVE_INFINITY;

/**
 * A checkpoint when the WAL since the last one passed `checkpointAfterBytes`. PostgreSQL in
 * single-user mode (as PGlite runs it) has no checkpointer and requests none when the WAL reaches
 * `max_wal_size` (it does so only under a postmaster), so without this the WAL of a local home
 * grows with every write until the next start. A checkpoint lets the segments before it be
 * recycled or removed (`min_wal_size` / `max_wal_size`, durability.ts). The main thread asks for it
 * after a write's reply, once it has checked again that it still owns the storage. A failure is
 * thrown: the instance may be broken (a failed fsync is a PANIC), so the main thread ends this
 * worker.
 */
async function checkpoint(): Promise<null> {
  const pg = requireDb();
  if (session) throw new Error("a transaction is open in the DB Worker");
  const r = await pg.query<{ d: string }>(
    "SELECT pg_wal_lsn_diff(pg_current_wal_insert_lsn(), redo_lsn)::text AS d FROM pg_control_checkpoint()",
  );
  if (Number(r.rows[0]?.d ?? 0) > checkpointAfterBytes) await pg.exec("CHECKPOINT");
  return null;
}

/** See OpenParams `analyze`. */
let analyzeMode: AnalyzeMode = "stale";

/** The format the open store is upgraded to, by these steps, the format kept under this key. */
let upgradeTo = 0;
let upgradeSteps: readonly UpgradeStep[] = [];
let formatKey = "";

/**
 * The next step of the upgrade of the open store to `upgradeTo` (02-architecture §8
 * «格式版本、导出、导入与恢复»), one per request, so the main thread says which step it is on: in a
 * transaction of its own whose last statement sets the format, so a store stopped half way is of
 * the format of its last step done, and the next open goes on from there. After the last step,
 * ANALYZE, whatever the statistics say: new tables, columns and indexes need theirs.
 */
async function upgrade(): Promise<UpgradeReply> {
  const pg = requireDb();
  if (session) throw new Error("a transaction is open in the DB Worker");
  const r = await pg.query<{ value: string }>("SELECT value FROM meta WHERE key = $1", [formatKey]);
  let current = Number(r.rows[0]?.value);
  const step = upgradePath(current, upgradeTo, upgradeSteps)[0];
  if (step !== undefined) {
    try {
      await pg.transaction(async (tx) => {
        if (step.sql.trim() !== "") await tx.exec(step.sql);
        await tx.query("UPDATE meta SET value = $1 WHERE key = $2", [
          String(step.from + 1),
          formatKey,
        ]);
      });
    } catch (e) {
      const w = toWire(e);
      throw new WorkerError(
        "upgrade_failed",
        `upgrading storage format ${step.from} to ${step.from + 1}: ${w.message}`,
        w.sqlState,
      );
    }
    current = step.from + 1;
  }
  if (current < upgradeTo) return { formatVersion: current };
  const mode = analyzeMode;
  analyzeMode = "always";
  let analyzed: UpgradeReply["analyzed"];
  try {
    analyzed = await analyze();
  } catch (e) {
    const w = toWire(e);
    analyzed = { failed: w.sqlState ?? w.code ?? "unknown" };
  } finally {
    analyzeMode = mode;
  }
  return { formatVersion: current, analyzed };
}

/**
 * The planner's statistics are stale when the log has grown past what they last counted by more
 * than PostgreSQL's autovacuum asks before it analyzes a table (`autovacuum_analyze_threshold` 50,
 * `autovacuum_analyze_scale_factor` 0.1; a table never analyzed counts 0 rows). PGlite runs
 * PostgreSQL in single-user mode, with no autovacuum: nothing else gathers them. `events` stands
 * for the store: every write appends to it, and the other tables grow with it; its `seq` is dense,
 * so the last one is about its number of rows. Two lookups: the catalog, and the end of a key.
 */
const ANALYZE_THRESHOLD = 50;
const ANALYZE_SCALE = 0.1;
/** The statistics target `content` is analyzed with (see `analyze`); PostgreSQL's default is 100. */
const CONTENT_STATISTICS_TARGET = 10;

async function stale(pg: PGlite): Promise<boolean> {
  const r = await pg.query<{ counted: number; end: number | null }>(
    `SELECT c.reltuples::float8 AS counted, (SELECT max(seq) FROM events)::float8 AS "end"
     FROM pg_class c WHERE c.oid = 'public.events'::regclass`,
  );
  const counted = Math.max(0, Number(r.rows[0]?.counted ?? -1));
  return Number(r.rows[0]?.end ?? 0) > counted + ANALYZE_THRESHOLD + ANALYZE_SCALE * counted;
}

/**
 * ANALYZE of the store's tables, when the statistics are stale (or always, in tests). Outside any
 * transaction, and only between requests: it changes the planner's statistics only, never a row,
 * so it is not in the log and replay does not see it.
 *
 * ANALYZE commits table by table (here, outside a transaction, and `content` in one of its own),
 * so one that fails or is stopped half way leaves the tables before it done. `events` goes last: its count is what `stale`
 * reads, so the statistics stay stale, and are gathered again at the next check, until a run gets
 * through to it.
 */
async function analyze(): Promise<AnalyzeReply> {
  const pg = requireDb();
  if (session) throw new Error("a transaction is open in the DB Worker");
  if (analyzeMode === "stale" && !(await stale(pg))) return { ran: false };
  const begun = performance.now();
  await analyzeTables(pg);
  return { ran: true, ms: Math.round(performance.now() - begun) };
}

/** ANALYZE of the store's tables, the content and header columns left out (see `analyze`). */
async function analyzeTables(pg: PGlite): Promise<void> {
  const others = await pg.query<{ name: string }>(
    `SELECT quote_ident(relname) AS name FROM pg_class
     WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p')
       AND relname NOT IN ('events', 'content')
     ORDER BY relname`,
  );
  if (others.rows.length > 0) await pg.exec(`ANALYZE ${others.rows.map((r) => r.name).join(", ")}`);
  // `content` with a sample of 3,000 rows instead of 30,000 (300 × the statistics target): it is
  // by far the largest table and ANALYZE's time goes into reading its sampled pages, while no plan
  // the kernel needs turns on a histogram of it (its rows are found by key; its LIKE predicates
  // are on rows already found by key or are scans either way). In a transaction of its own, so
  // that the setting ends with it, whether it commits or fails.
  //
  // Neither `content.body` nor `events.header` is analyzed: their statistics would hold samples of
  // the user's content (the most common values are the values), a copy of it no plan needs. Every
  // other column is (the column list leaves those two out; the row count is updated all the same).
  const content = await columnsBut(pg, "content", "body");
  await pg.transaction(async (tx) => {
    await tx.exec(`SET LOCAL default_statistics_target = ${CONTENT_STATISTICS_TARGET}`);
    await tx.exec(`ANALYZE content (${content})`);
  });
  await pg.exec(`ANALYZE events (${await columnsBut(pg, "events", "header")})`);
}

/**
 * One step of the in-place residue clean-up (02-architecture §7 «残留清理的做法»), its statement
 * fixed here; the main thread sends the steps in order, each once it has checked it still owns the
 * storage. Outside any transaction, between requests, as a checkpoint: refused with one open. A
 * statement that fails is thrown, and the main thread ends this worker (`worker_failed`): the
 * instance may be broken, as after a failed checkpoint.
 * - `rewrite`: `VACUUM FULL` of one of the store's tables, named, checked to be one.
 * - `analyze`: ANALYZE as after a write (`analyzeTables`): it replaces the statistics of the data
 *   before the deletion, and leaves the old statistics rows dead.
 * - `rewrite_statistics`: `VACUUM FULL pg_statistic`, after ANALYZE, which leaves those rows dead.
 *   No other session holds a snapshot here (PostgreSQL in single-user mode): nothing to wait for.
 * - `checkpoint`, `switch_wal`: the log written so far is no longer needed, and with
 *   `wal_recycle = off` (durability.ts) the segments holding it are removed, not reused.
 * - `check`: `VACUUM (VERBOSE) pg_statistic`, its count of rows dead but not yet removable.
 */
async function maintain(step: MaintainStep): Promise<MaintainReply> {
  const pg = requireDb();
  if (session) throw new Error("a transaction is open in the DB Worker");
  switch (step.op) {
    case "rewrite": {
      const r = await pg.query<{ name: string }>(
        `SELECT quote_ident(relname) AS name FROM pg_class
         WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relname = $1`,
        [step.table],
      );
      const name = r.rows[0]?.name;
      if (name === undefined) throw new Error(`not a table of the store: ${step.table}`);
      await pg.exec(`VACUUM FULL public.${name}`);
      return {};
    }
    case "analyze":
      await analyzeTables(pg);
      return {};
    case "rewrite_statistics":
      await pg.exec("VACUUM FULL pg_statistic");
      return {};
    case "checkpoint":
      await pg.exec("CHECKPOINT");
      return {};
    case "switch_wal":
      await pg.query("SELECT pg_switch_wal()");
      return {};
    case "check": {
      const lines: string[] = [];
      await pg.query("VACUUM (VERBOSE) pg_statistic", [], {
        onNotice: (n) => lines.push(n.message ?? ""),
      });
      const m = /(\d+) are dead but not yet removable/.exec(lines.join("\n"));
      if (m === null)
        throw new Error("VACUUM (VERBOSE) pg_statistic reported no count of dead rows");
      return { notRemovable: Number(m[1]) };
    }
  }
}

/** The columns of `table`, quoted and comma-separated, but `without`: for ANALYZE's column list. */
async function columnsBut(pg: PGlite, table: string, without: string): Promise<string> {
  const r = await pg.query<{ c: string | null }>(
    `SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum) AS c FROM pg_attribute
     WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped AND attname <> $2`,
    [`public.${table}`, without],
  );
  const c = r.rows[0]?.c;
  if (c === null || c === undefined) throw new Error(`no columns of ${table} to analyze`);
  return c;
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
    case "checkpoint":
      return checkpoint();
    case "maintain":
      return maintain(req.step);
    case "analyze":
      return analyze();
    case "upgrade":
      return upgrade();
    case "stats":
      return hostSyncStats();
    case "close":
      return close();
  }
}

function toWire(e: unknown): WireError {
  if (e instanceof WorkerError) {
    return e.sqlState !== undefined
      ? { message: e.message, code: e.code, sqlState: e.sqlState }
      : { message: e.message, code: e.code };
  }
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
