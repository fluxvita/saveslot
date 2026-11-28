// Experiment 7, cost of the cleanup (the decisions it feeds: pre-dev-w0-experiments, experiment 7,
// pass criterion 4). On a tenant of --rows rows: write latency as it is (wal_recycle on / off),
// then the cleanup step by step with its time, and how long a write arriving during it waits.
//
//   node --conditions=source experiments/exp7/timing.ts --backend pglite|postgres --rows 10000
//        --recycle on|off [--candidate C|D]

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { arg, nowMs, outDir, scratch, summary } from "../lib/util.ts";
import {
  type Db,
  DELETE_SQL,
  type Engine,
  insertSql,
  newMarkers,
  PgliteEngine,
  PostgresEngine,
  SCHEMA,
  TABLES,
  WAIT_XMIN,
} from "./lib.ts";

const backend = arg("backend");
const rows = Number(arg("rows", "10000"));
const recycle = arg("recycle", "off") === "on";
const cand = arg("candidate", "C");
const noRecycle = !recycle;
const dir = join(scratch("exp7t"), "pgdata");
const engine: Engine = backend === "pglite" ? new PgliteEngine(dir, true) : new PostgresEngine(dir);

const steps: { step: string; ms: number }[] = [];
async function timed(db: Db, step: string, sql: string) {
  const t0 = nowMs();
  await db.exec(sql);
  steps.push({ step, ms: Math.round(nowMs() - t0) });
}

const db = await engine.open({ noRecycle });
await db.exec(SCHEMA);
const t0 = nowMs();
await db.exec(insertSql(newMarkers(), rows));
const loadMs = Math.round(nowMs() - t0);
await db.exec("CHECKPOINT");
const baseline = summary(await engine.insertTimes(db, 300));
await db.exec(DELETE_SQL.join("\n"));

const t1 = nowMs();
let late: number | undefined;
let cleanup: Promise<void>;
if (cand === "D") {
  const fresh = engine.at(`${dir}.rebuild`);
  cleanup = engine.copyTo(db, fresh);
  late = undefined;
  await cleanup;
  steps.push({
    step: "rebuild (copy survivors into a new data directory)",
    ms: Math.round(nowMs() - t1),
  });
} else {
  const run = async () => {
    // The adopted order (experiment 7's conclusion): the statistics rewritten after ANALYZE, once
    // no other session holds a snapshot (PostgreSQL; PGlite has no other session).
    for (const t of TABLES) await timed(db, `VACUUM FULL ${t}`, `VACUUM FULL ${t}`);
    await timed(db, "ANALYZE", "ANALYZE");
    if (backend === "postgres") await timed(db, "wait for snapshots", WAIT_XMIN);
    await timed(db, "VACUUM FULL pg_statistic", "VACUUM FULL pg_statistic");
    await timed(db, "CHECKPOINT", "CHECKPOINT");
    await timed(db, "pg_switch_wal", "SELECT pg_switch_wal()");
    await timed(db, "CHECKPOINT", "CHECKPOINT");
    await timed(db, "CHECKPOINT", "CHECKPOINT");
  };
  cleanup = run();
  // A write that arrives while the cleanup runs. PGlite: it queues behind it. PostgreSQL: it is
  // its own connection and waits only on locks.
  const waits: number[] = [];
  let done = false;
  const probe = (async () => {
    while (!done) {
      waits.push(await engine.oneInsert(db));
      await new Promise((r) => setTimeout(r, 20));
    }
  })();
  await cleanup;
  done = true;
  await probe;
  late = Math.max(...waits);
}
const totalMs = Math.round(nowMs() - t1);
await db.close();

const out = {
  backend,
  rows,
  wal_recycle: recycle ? "on" : "off",
  candidate: cand,
  loadMs,
  baselineInsertMs: baseline,
  steps,
  cleanupTotalMs: totalMs,
  longestWriteDuringCleanupMs: late === undefined ? null : Math.round(late),
  platform: process.platform,
  node: process.version,
};
const file = join(
  outDir("exp7"),
  `timing-final-${backend}-${rows}-recycle-${recycle ? "on" : "off"}-${cand}${process.env["EXP7_REP"] ? `.rep${process.env["EXP7_REP"]}` : ""}.json`,
);
writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
console.log(JSON.stringify(out));
