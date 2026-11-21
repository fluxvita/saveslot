// Shared by the experiment 7 runner and the timing run: the marker classes, the SQL, the two
// engines (PGlite, PostgreSQL 18 started from Homebrew's binaries) and the byte search.

import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { nodeFs, startParams } from "../../packages/store-pglite/src/durability.ts";
import { scratch } from "../lib/util.ts";

const PG_BIN = "/opt/homebrew/opt/postgresql@18/bin";

/** The places a marker is put (the clearance list in 03-deletion.md "删除之后"; the same names are the report's columns). */
export const CLASSES = [
  "short",
  "long",
  "plain_col",
  "indexed_col",
  "high_freq",
  "group_key",
  "rolled_back",
] as const;
export type Class = (typeof CLASSES)[number];

export const TABLES = ["content", "biz", "freq", "derived"];

/**
 * Waits (at most 60 s) until no other session of this database, nor a process of no database,
 * holds a snapshot or a transaction id. Another database's snapshots do not keep this one's dead
 * catalog rows (measured), so they are not waited on. `backend_xmin` and `backend_xid` are shown to
 * every role (PostgreSQL 18; `backend_type` and `state` are not), so no extra grant is needed.
 */
export const WAIT_XMIN = `DO $$ BEGIN
  FOR i IN 1..1200 LOOP
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM pg_stat_activity
      WHERE pid <> pg_backend_pid()
        AND coalesce(datname, current_database()) = current_database()
        AND (backend_xmin IS NOT NULL OR backend_xid IS NOT NULL));
    PERFORM pg_sleep(0.05);
  END LOOP;
END $$`;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS content (id serial PRIMARY KEY, body text);
CREATE TABLE IF NOT EXISTS biz (id serial PRIMARY KEY, name text, note text);
CREATE INDEX IF NOT EXISTS biz_name ON biz (name);
CREATE TABLE IF NOT EXISTS freq (id serial PRIMARY KEY, tag text);
CREATE TABLE IF NOT EXISTS derived (id serial PRIMARY KEY, gkey text, checksum text);
`;

export type Markers = Record<Class, string>;
export const newMarkers = (): Markers =>
  Object.fromEntries(CLASSES.map((c) => [c, `XP7M_${randomBytes(16).toString("hex")}`])) as Markers;

export function insertSql(m: Markers, rows: number): string {
  return `
INSERT INTO content (body) VALUES ('${m.short}');
INSERT INTO content (body)
  SELECT (SELECT string_agg(md5(random()::text), '') FROM generate_series(1, 300)) || '${m.long}';
INSERT INTO biz (name, note) VALUES ('keep-${m.plain_col.slice(0, 8)}', '${m.plain_col}');
INSERT INTO biz (name, note) VALUES ('${m.indexed_col}', 'x');
INSERT INTO freq (tag) SELECT '${m.high_freq}' FROM generate_series(1, 300);
INSERT INTO freq (tag) SELECT md5(random()::text) FROM generate_series(1, 300);
INSERT INTO derived (gkey, checksum) VALUES ('${m.group_key}', 'c');
INSERT INTO content (body) SELECT md5(random()::text) FROM generate_series(1, ${rows});
INSERT INTO biz (name, note) SELECT md5(random()::text), md5(random()::text) FROM generate_series(1, ${rows});
ANALYZE;
BEGIN;
INSERT INTO content (body) VALUES ('${m.rolled_back}');
ROLLBACK;
`;
}

// What the physical deletion does: the rows holding the markers are deleted.
export const DELETE_SQL = TABLES.map((t) => {
  const cols: Record<string, string[]> = {
    content: ["body"],
    biz: ["name", "note"],
    freq: ["tag"],
    derived: ["gkey"],
  };
  const cond = (cols[t] as string[]).map((c) => `position('XP7M_' in ${c}) > 0`).join(" OR ");
  return `DELETE FROM ${t} WHERE ${cond};`;
});

export interface Db {
  /** Runs one statement or a script; VACUUM and CHECKPOINT go one per call (no transaction block). */
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

export interface Engine {
  readonly name: string;
  readonly dir: string;
  open(opts: { noRecycle: boolean }): Promise<Db>;
  /** Kills the database without a shutdown checkpoint, as a crash would. */
  crash(db: Db): Promise<void>;
  /** Times n single-row autocommit inserts, in milliseconds each. */
  insertTimes(db: Db, n: number): Promise<number[]>;
  /** Starts an insert and returns how long it took, in ms (it may wait behind other work). */
  oneInsert(db: Db): Promise<number>;
  /** `VACUUM (VERBOSE)` of a table, its report (PostgreSQL only). */
  vacuumVerbose?(table: string): Promise<string>;
  /** Opens another session that holds a snapshot until the returned function is called (PostgreSQL only). */
  holdSnapshot?(): Promise<() => void>;
  /** pg_class file paths, when the engine can say (PostgreSQL); opens and closes the server. */
  relfiles?(): Promise<string>;
  /** Copies the surviving rows into a fresh engine rooted at `to` (candidate D). */
  copyTo(db: Db, to: Engine): Promise<void>;
  /** Directory holding every file of the database (the search root). */
  root(): string;
  at(dir: string): Engine;
}

export class PgliteEngine implements Engine {
  readonly name = "pglite";
  readonly dir: string;
  readonly durable: boolean;
  /** `durable`: the store's real configuration (fsync on, host fsync), as the timing run needs. */
  constructor(dir: string, durable = false) {
    this.dir = dir;
    this.durable = durable;
  }
  root() {
    return this.dir;
  }
  at(dir: string) {
    return new PgliteEngine(dir, this.durable);
  }
  async open(opts: { noRecycle: boolean }): Promise<Db> {
    mkdirSync(this.dir, { recursive: true });
    const recycle = opts.noRecycle ? ["-c", "wal_recycle=off"] : [];
    const pg = this.durable
      ? await PGlite.create({
          fs: nodeFs(this.dir, "host-fsync"),
          startParams: [...startParams("host-fsync"), ...recycle],
        })
      : await PGlite.create(this.dir, { startParams: [...PGlite.defaultStartParams, ...recycle] });
    return {
      exec: async (sql) => {
        await pg.exec(sql);
      },
      close: () => pg.close(),
      pg,
    } as Db;
  }
  async insertTimes(db: Db, n: number): Promise<number[]> {
    const pg = (db as unknown as { pg: PGlite }).pg;
    const out: number[] = [];
    for (let i = 0; i < n; i++) {
      const t0 = performance.now();
      await pg.exec("INSERT INTO content (body) VALUES (md5(random()::text))");
      out.push(performance.now() - t0);
    }
    return out;
  }
  async oneInsert(db: Db): Promise<number> {
    const t0 = performance.now();
    await db.exec("INSERT INTO content (body) VALUES ('late')");
    return performance.now() - t0;
  }
  async crash(): Promise<void> {
    throw new Error(
      "PGlite is crashed by killing its process (--crash runs the delete in a child)",
    );
  }
  async copyTo(db: Db, to: Engine): Promise<void> {
    const pg = (db as unknown as { pg: PGlite }).pg;
    const dst = await to.open({ noRecycle: false });
    const dpg = (dst as unknown as { pg: PGlite }).pg;
    await dpg.exec(SCHEMA);
    for (const t of TABLES) {
      const r = await pg.query<{ j: string }>(
        `SELECT coalesce(json_agg(x), '[]')::text AS j FROM ${t} x`,
      );
      const j = (r.rows[0] as { j: string }).j;
      await dpg.query(
        `INSERT INTO ${t} SELECT * FROM json_populate_recordset(NULL::${t}, $1::json)`,
        [j],
      );
    }
    await dpg.exec("ANALYZE");
    await dst.close();
  }
}

function pgBin(name: string, args: string[], input?: string) {
  const r = spawnSync(join(PG_BIN, name), args, { encoding: "utf8", input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${name} ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}

export class PostgresEngine implements Engine {
  readonly name = "postgres";
  static #port = 54700 + Math.floor(Math.random() * 200);
  readonly sock: string;
  readonly port: number;
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    this.sock = scratch("pgsock");
    this.port = PostgresEngine.#port++;
  }
  root() {
    return this.dir;
  }
  at(dir: string) {
    return new PostgresEngine(dir);
  }
  #start(noRecycle: boolean) {
    if (!existsSync(join(this.dir, "PG_VERSION"))) {
      mkdirSync(this.dir, { recursive: true });
      pgBin("initdb", [
        "-D",
        this.dir,
        "-U",
        "postgres",
        "--auth=trust",
        "-E",
        "UTF8",
        "--no-locale",
      ]);
    }
    const o = `-k ${this.sock} -c listen_addresses= -p ${this.port} -c wal_recycle=${noRecycle ? "off" : "on"}`;
    pgBin("pg_ctl", ["-D", this.dir, "-w", "-l", join(this.sock, "log"), "-o", o, "start"]);
  }
  #sql(sql: string) {
    pgBin(
      "psql",
      [
        "-X",
        "-q",
        "-h",
        this.sock,
        "-p",
        String(this.port),
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "-",
      ],
      sql,
    );
  }
  async open(opts: { noRecycle: boolean }): Promise<Db> {
    this.#start(opts.noRecycle);
    return {
      exec: async (sql) => this.#sql(sql),
      close: async () => {
        pgBin("pg_ctl", ["-D", this.dir, "-w", "-m", "fast", "stop"]);
      },
    };
  }
  async crash(): Promise<void> {
    pgBin("pg_ctl", ["-D", this.dir, "-w", "-m", "immediate", "stop"]);
  }
  async insertTimes(_db: Db, n: number): Promise<number[]> {
    const r = spawnSync(
      join(PG_BIN, "psql"),
      [
        "-X",
        "-q",
        "-At",
        "-h",
        this.sock,
        "-p",
        String(this.port),
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        `DO $$ DECLARE t timestamptz; ms double precision[] := '{}'; BEGIN FOR i IN 1..${n} LOOP t := clock_timestamp(); INSERT INTO content (body) VALUES (md5(random()::text)); COMMIT; ms := ms || (extract(epoch from clock_timestamp() - t) * 1000); END LOOP; RAISE NOTICE '%', ms; END $$`,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    const m = /NOTICE:\s+\{([^}]*)\}/.exec(r.stderr);
    return (m?.[1] ?? "").split(",").map(Number);
  }
  async oneInsert(db: Db): Promise<number> {
    const t0 = performance.now();
    await db.exec(`INSERT INTO content (body) VALUES ('late')`);
    return performance.now() - t0;
  }
  async vacuumVerbose(table: string): Promise<string> {
    const r = spawnSync(
      join(PG_BIN, "psql"),
      [
        "-X",
        "-q",
        "-h",
        this.sock,
        "-p",
        String(this.port),
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        `VACUUM (VERBOSE) ${table}`,
      ],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(r.stderr);
    return r.stderr;
  }
  async holdSnapshot(): Promise<() => void> {
    const child = spawn(
      join(PG_BIN, "psql"),
      [
        "-X",
        "-q",
        "-h",
        this.sock,
        "-p",
        String(this.port),
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        "BEGIN ISOLATION LEVEL REPEATABLE READ; SELECT count(*) FROM pg_class; SELECT pg_sleep(600); COMMIT;",
      ],
      { stdio: "ignore" },
    );
    // Until the session shows a snapshot.
    for (let i = 0; i < 200; i++) {
      const r = spawnSync(
        join(PG_BIN, "psql"),
        [
          "-X",
          "-q",
          "-At",
          "-h",
          this.sock,
          "-p",
          String(this.port),
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-c",
          "SELECT count(*) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_xmin IS NOT NULL AND query LIKE '%pg_sleep(600)%'",
        ],
        { encoding: "utf8" },
      );
      if (r.stdout.trim() === "1") break;
      await new Promise((res) => setTimeout(res, 50));
    }
    return () => {
      child.kill("SIGTERM");
      spawnSync(join(PG_BIN, "psql"), [
        "-X",
        "-q",
        "-h",
        this.sock,
        "-p",
        String(this.port),
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(600)%' AND pid <> pg_backend_pid()",
      ]);
    };
  }
  async relfiles(): Promise<string> {
    this.#start(false);
    try {
      const stats = pgBin("psql", [
        "-X",
        "-q",
        "-At",
        "-h",
        this.sock,
        "-p",
        String(this.port),
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        "SELECT starelid::regclass::text || ' attnum ' || staattnum || ' relfilenode ' || (SELECT relfilenode FROM pg_class WHERE oid = 2619) FROM pg_statistic WHERE stavalues1::text LIKE '%XP7M_%' OR stavalues2::text LIKE '%XP7M_%' OR stavalues3::text LIKE '%XP7M_%'",
      ]);
      const files = pgBin("psql", [
        "-X",
        "-q",
        "-At",
        "-h",
        this.sock,
        "-p",
        String(this.port),
        "-U",
        "postgres",
        "-d",
        "postgres",
        "-c",
        "SELECT oid::regclass::text || ' ' || pg_relation_filepath(oid) FROM pg_class WHERE relname IN ('pg_statistic','pg_statistic_relid_att_inh_index') OR relname LIKE 'pg_toast_2619%'",
      ]);
      return (
        `STATROWS:\n${stats}\nFILES:\n${files}\nALL:\n` +
        pgBin("psql", [
          "-X",
          "-q",
          "-At",
          "-h",
          this.sock,
          "-p",
          String(this.port),
          "-U",
          "postgres",
          "-d",
          "postgres",
          "-c",
          "SELECT pg_relation_filepath(oid) || ' ' || relname || ' ' || relkind::text FROM pg_class WHERE pg_relation_filepath(oid) IS NOT NULL AND relnamespace = 'public'::regnamespace OR relname LIKE 'pg_toast_%' AND pg_relation_filepath(oid) IS NOT NULL ORDER BY 1",
        ])
      );
    } finally {
      pgBin("pg_ctl", ["-D", this.dir, "-w", "-m", "fast", "stop"]);
    }
  }
  async copyTo(_db: Db, to: Engine): Promise<void> {
    const dump = pgBin("pg_dump", [
      "-h",
      this.sock,
      "-p",
      String(this.port),
      "-U",
      "postgres",
      "-d",
      "postgres",
      "--inserts",
    ]);
    const dst = await to.open({ noRecycle: false });
    await dst.exec(dump);
    await dst.exec("ANALYZE");
    await dst.close();
  }
}

/** Every marker found in every file under `root`: [relative path, class, marker]. */
export function search(
  root: string,
  all: Markers[],
): {
  hits: [string, Class][];
  detail: {
    file: string;
    cls: Class;
    offset: number;
    size: number;
    mtime: string;
    marker: string;
  }[];
  files: number;
  bytes: number;
} {
  const needles = all.flatMap((m) => CLASSES.map((c) => [c, Buffer.from(m[c])] as const));
  const hits: [string, Class][] = [];
  const detail: {
    file: string;
    cls: Class;
    offset: number;
    size: number;
    mtime: string;
    marker: string;
  }[] = [];
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        const b = readFileSync(p);
        files++;
        bytes += b.length;
        for (const [c, n] of needles) {
          const at = b.indexOf(n);
          if (at >= 0) {
            hits.push([relative(root, p), c]);
            detail.push({
              file: relative(root, p),
              cls: c,
              offset: at,
              marker: n.toString("utf8"),
              size: b.length,
              mtime: statSync(p).mtime.toISOString(),
            });
          }
        }
      }
    }
  };
  walk(root);
  return { hits, detail, files, bytes };
}

export const byClass = (h: [string, Class][]) =>
  Object.fromEntries(CLASSES.map((c) => [c, h.filter((x) => x[1] === c).length])) as Record<
    Class,
    number
  >;
