// Experiment 7, candidate D′: the rebuild a managed PostgreSQL allows. Results:
// experiments/out/exp7/dprime-*.json.
//
//   node --conditions=source experiments/exp7/dprime.ts [--rounds 3] [--rows 2000]
//        [--chunk-mib 32] [--cap-mib 4096] [--aged true] [--idle-s 330]
//
// Candidate D rebuilt a whole instance (a new data directory, the old one removed with its log).
// A managed instance allows less: a new database in the same instance, the old one dropped, and
// no CHECKPOINT, pg_switch_wal() or wal_recycle (the role is not a superuser and is not granted
// them). One round, on an instance started with PostgreSQL's defaults:
//
// 1. A tenant database t1: the schema, marker strings in every class of place, then the rows
//    holding them deleted (the physical deletion).
// 2. The rebuild: a new database t2 from a dump of t1 (only the surviving rows), t1 dropped.
// 3. Search every file of the data directory while the instance runs (a shutdown would write a
//    checkpoint, which a managed instance does on its own schedule): the hits, by place.
// 4. Ordinary writes to t2 in chunks, searching after each, until nothing is found or the cap:
//    how much log the instance writes before the deleted text is gone from its files.

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { arg, nowMs, outDir, scratch, sleep } from "../lib/util.ts";
import {
  byClass,
  DELETE_SQL,
  insertSql,
  type Markers,
  newMarkers,
  SCHEMA,
  search as searchOnce,
} from "./lib.ts";

const PG_BIN = "/opt/homebrew/opt/postgresql@18/bin";

function bin(name: string, args: string[], input?: string): string {
  const r = spawnSync(join(PG_BIN, name), args, { encoding: "utf8", input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`${name} ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

class Instance {
  readonly dir = scratch("exp7dprime");
  readonly sock = scratch("pgsock");
  readonly port = 55100 + Math.floor(Math.random() * 400);
  start() {
    bin("initdb", ["-D", this.dir, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--no-locale"]);
    const o = `-k ${this.sock} -c listen_addresses= -p ${this.port}`;
    bin("pg_ctl", ["-D", this.dir, "-w", "-l", join(this.sock, "log"), "-o", o, "start"]);
  }
  sql(db: string, sql: string): string {
    return bin(
      "psql",
      ["-X", "-q", "-At", "-h", this.sock, "-p", String(this.port), "-U", "postgres"].concat([
        "-d",
        db,
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        "-",
      ]),
      sql,
    ).trim();
  }
  dump(db: string): string {
    return bin("pg_dump", ["-h", this.sock, "-p", String(this.port), "-U", "postgres", db]);
  }
  /** Stops without a shutdown checkpoint and removes the directory. */
  remove() {
    bin("pg_ctl", ["-D", this.dir, "-w", "-m", "immediate", "stop"]);
    rmSync(this.dir, { recursive: true, force: true });
    rmSync(this.sock, { recursive: true, force: true });
  }
}

/** `search` while the instance runs: a log segment renamed or removed under it, searched again. */
function search(root: string, all: Markers[]): ReturnType<typeof searchOnce> {
  for (let i = 0; ; i++) {
    try {
      return searchOnce(root, all);
    } catch (e) {
      if (i >= 5 || (e as { code?: string }).code !== "ENOENT") throw e;
    }
  }
}

/** Where a hit is: the log, a database's files (by name), the shared catalogs, or elsewhere. */
function place(file: string, oids: Map<string, string>): string {
  if (file.startsWith("pg_wal/")) return "pg_wal";
  const m = /^base\/(\d+)\//.exec(file);
  if (m !== null) return `base/${oids.get(m[1] as string) ?? m[1]}`;
  if (file.startsWith("global/")) return "global";
  return file.split("/")[0] as string;
}

function dirBytes(d: string): number {
  let n = 0;
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) n += dirBytes(p);
    else if (e.isFile()) n += statSync(p).size;
  }
  return n;
}

async function round(rows: number, chunkMiB: number, capMiB: number, aged: boolean, idleS: number) {
  const pg = new Instance();
  pg.start();
  try {
    const settings = Object.fromEntries(
      pg
        .sql(
          "postgres",
          "SELECT name || '=' || setting || coalesce(unit, '') FROM pg_settings WHERE name IN ('max_wal_size', 'min_wal_size', 'checkpoint_timeout', 'wal_recycle', 'wal_segment_size', 'full_page_writes')",
        )
        .split("\n")
        .map((l) => l.split("=") as [string, string]),
    );
    const m: Markers = newMarkers();
    pg.sql("postgres", "CREATE DATABASE t1");
    pg.sql("t1", SCHEMA + insertSql(m, rows));
    const oid = (db: string) =>
      pg.sql("postgres", `SELECT oid FROM pg_database WHERE datname = '${db}'`);
    const oids = new Map([[oid("t1"), "t1"]]);
    const by = (hits: [string, string][]) => {
      const out: Record<string, number> = {};
      for (const [f] of hits) out[place(f, oids)] = (out[place(f, oids)] ?? 0) + 1;
      return out;
    };
    // `aged`: the tenant's data has been through the instance's own checkpoint before the
    // deletion (the usual case: it is in the table files, not only in the log).
    if (aged) pg.sql("postgres", "CHECKPOINT");
    const control = search(pg.dir, [m]);
    pg.sql("t1", DELETE_SQL.join("\n"));
    const afterDelete = search(pg.dir, [m]);

    const checkpoints = () =>
      pg
        .sql("postgres", "SELECT num_timed || ',' || num_requested FROM pg_stat_checkpointer")
        .split(",")
        .map(Number);
    const ckBefore = checkpoints();
    const t0 = nowMs();
    pg.sql("postgres", "CREATE DATABASE t2");
    oids.set(oid("t2"), "t2");
    pg.sql("t2", pg.dump("t1"));
    pg.sql("t2", "ANALYZE");
    pg.sql("postgres", "DROP DATABASE t1");
    const rebuildMs = Math.round(nowMs() - t0);
    const ckAfter = checkpoints();
    const lsn0 = pg.sql("postgres", "SELECT pg_current_wal_lsn()");
    const afterRebuild = search(pg.dir, [m]);
    // `idle-s`: no writes for that long after the rebuild (past checkpoint_timeout, a timed
    // checkpoint runs, as it would on a managed instance), then the search again.
    let afterIdle: Record<string, number> | undefined;
    let checkpointsDuringIdle: number[] | undefined;
    if (idleS > 0) {
      const before = checkpoints();
      await sleep(idleS * 1000);
      const after = checkpoints();
      checkpointsDuringIdle = [
        (after[0] as number) - (before[0] as number),
        (after[1] as number) - (before[1] as number),
      ];
      afterIdle = by(search(pg.dir, [m]).hits);
    }

    // Ordinary writes until the deleted text is gone from every file, or the cap.
    const trail: { walMiB: number; ms: number; hits: Record<string, number> }[] = [];
    const tw = nowMs();
    let gone =
      afterIdle !== undefined
        ? Object.keys(afterIdle).length === 0
        : afterRebuild.hits.length === 0;
    let wal = 0;
    while (!gone && wal < capMiB) {
      // About chunkMiB of log: 1 KiB rows, plus their index entries and page images.
      pg.sql(
        "t2",
        `INSERT INTO content (body) SELECT repeat(md5(random()::text), 32) FROM generate_series(1, ${chunkMiB * 700})`,
      );
      wal = Math.round(
        Number(pg.sql("postgres", `SELECT pg_wal_lsn_diff(pg_current_wal_lsn(), '${lsn0}')`)) /
          (1 << 20),
      );
      const s = search(pg.dir, [m]);
      trail.push({ walMiB: wal, ms: Math.round(nowMs() - tw), hits: by(s.hits) });
      gone = s.hits.length === 0;
    }
    return {
      settings,
      rows,
      control: { byClass: byClass(control.hits), byPlace: by(control.hits) },
      afterDelete: { byClass: byClass(afterDelete.hits), byPlace: by(afterDelete.hits) },
      aged,
      rebuildMs,
      // [timed, requested] checkpoints from before the rebuild to after it: the rebuild's own.
      checkpointsDuringRebuild: [
        (ckAfter[0] as number) - (ckBefore[0] as number),
        (ckAfter[1] as number) - (ckBefore[1] as number),
      ],
      afterRebuild: {
        byClass: byClass(afterRebuild.hits),
        byPlace: by(afterRebuild.hits),
        files: afterRebuild.detail.map((d) => ({ file: d.file, cls: d.cls })),
      },
      ...(afterIdle !== undefined ? { idleS, checkpointsDuringIdle, afterIdle } : {}),
      pgWalMiB: Math.round(dirBytes(join(pg.dir, "pg_wal")) / (1 << 20)),
      trail,
      goneAfterWalMiB: gone ? wal : null,
    };
  } finally {
    pg.remove();
  }
}

async function main() {
  const rounds = Number(arg("rounds", "3"));
  const rows = Number(arg("rows", "2000"));
  const chunk = Number(arg("chunk-mib", "32"));
  const cap = Number(arg("cap-mib", "4096"));
  const aged = arg("aged", "false") === "true";
  const idle = Number(arg("idle-s", "0"));
  const out = [];
  for (let i = 0; i < rounds; i++) {
    const r = await round(rows, chunk, cap, aged, idle);
    out.push(r);
    console.log(
      JSON.stringify({
        round: i,
        afterRebuild: r.afterRebuild.byPlace,
        afterIdle: r.afterIdle,
        checkpointsDuringIdle: r.checkpointsDuringIdle,
        goneAfterWalMiB: r.goneAfterWalMiB,
        checkpointsDuringRebuild: r.checkpointsDuringRebuild,
        rebuildMs: r.rebuildMs,
      }),
    );
  }
  const file = join(outDir("exp7"), `dprime-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`results: ${relative(process.cwd(), file)}`);
}

await main();
