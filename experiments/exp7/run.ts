// Experiment 7 runner (pre-dev-w0-experiments, experiment 7: plaintext residue after a physical
// deletion). Results: experiments/out/exp7/*.json.
//
//   node --conditions=source experiments/exp7/run.ts --backend pglite|postgres --candidate A|B|C|D
//        [--rounds 20] [--crash] [--rows 2000] [--steps stat,wal]
//
// One round: write fresh marker strings into every class of place (positive control: close, search
// every file of the data directory, every class must hit), reopen, delete the rows (with --crash,
// kill the database right after the delete commits), run the candidate's cleanup, close, search
// again (every class must have zero hits, for this round's markers and all earlier ones).
//
// Candidates (the spec's A–D; --steps adds steps to A–C):
//   A  VACUUM the tables + ANALYZE + CHECKPOINT x2
//   B  VACUUM FULL the tables + ANALYZE + CHECKPOINT x2
//   C  B + the write-ahead log: wal_recycle = off, pg_switch_wal(), CHECKPOINT
//   D  no in-place cleanup: copy the surviving rows into a brand new data directory, swap, remove the old
// Steps: `stat` also VACUUM FULL pg_statistic (ANALYZE leaves the old statistics tuples behind as
// dead tuples); `wal` switches the log and checkpoints with wal_recycle off (what C adds to B).

import { renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { arg, exited, Lines, node, nowMs, outDir, scratch } from "../lib/util.ts";
import {
  byClass,
  CLASSES,
  type Class,
  type Db,
  DELETE_SQL,
  type Engine,
  insertSql,
  type Markers,
  newMarkers,
  PgliteEngine,
  PostgresEngine,
  SCHEMA,
  search,
  TABLES,
  WAIT_XMIN,
} from "./lib.ts";

async function cleanup(cand: string, steps: Set<string>, db: Db): Promise<void> {
  if (cand === "A") for (const t of TABLES) await db.exec(`VACUUM ${t}`);
  else for (const t of TABLES) await db.exec(`VACUUM FULL ${t}`);
  if (steps.has("stat")) await db.exec("VACUUM FULL pg_statistic");
  await db.exec("ANALYZE");
  // `statafter`: the statistics rewritten after ANALYZE, which is what leaves the old statistics
  // rows dead (before it, they are still the live statistics of the old data).
  // `waitxmin`: first wait until no other session holds a snapshot (autovacuum's, after a
  // restart): VACUUM FULL keeps a dead row any open snapshot may still see.
  if (steps.has("waitxmin")) await db.exec(WAIT_XMIN);
  if (steps.has("statafter")) await db.exec("VACUUM FULL pg_statistic");
  if (steps.has("wal") || cand === "C") {
    await db.exec("CHECKPOINT");
    await db.exec("SELECT pg_switch_wal()");
  }
  await db.exec("CHECKPOINT");
  await db.exec("CHECKPOINT");
}

async function main() {
  if (process.argv[2] === "child-delete") {
    // --crash on PGlite: delete, tell the parent, wait to be killed.
    const dir = arg("dir");
    const e = new PgliteEngine(dir);
    const db = await e.open({ noRecycle: process.argv.includes("--no-recycle") });
    await db.exec(DELETE_SQL.join("\n"));
    console.log(JSON.stringify({ ready: true }));
    await new Promise(() => {});
    return;
  }

  const backend = arg("backend");
  const cand = arg("candidate");
  const rounds = Number(arg("rounds", "20"));
  const rows = Number(arg("rows", "2000"));
  const crash = process.argv.includes("--crash");
  const steps = new Set(arg("steps", "").split(",").filter(Boolean));
  const noRecycle = cand === "C" || steps.has("wal");
  const tag = `${backend}-${cand}${steps.size ? `+${[...steps].join("+")}` : ""}${crash ? "-crash" : ""}`;

  let engine: Engine =
    backend === "pglite"
      ? new PgliteEngine(join(scratch("exp7"), "pgdata"))
      : new PostgresEngine(join(scratch("exp7"), "pgdata"));
  const root0 = engine.dir;
  const all: Markers[] = [];
  const perRound: object[] = [];
  const cleanTimes: number[] = [];

  {
    const db = await engine.open({ noRecycle });
    await db.exec(SCHEMA);
    await db.close();
  }

  for (let r = 1; r <= rounds; r++) {
    const m = newMarkers();
    all.push(m);

    let db = await engine.open({ noRecycle });
    await db.exec(insertSql(m, rows));
    await db.close();
    const pos = search(engine.root(), [m]);
    const posByClass = byClass(pos.hits);

    if (crash && engine.name === "pglite") {
      const child = node("exp7/run.ts", [
        "child-delete",
        "--dir",
        engine.dir,
        ...(noRecycle ? ["--no-recycle"] : []),
      ]);
      const lines = new Lines(child);
      await lines.next();
      child.kill("SIGKILL");
      await exited(child);
      db = await engine.open({ noRecycle });
    } else if (crash) {
      db = await engine.open({ noRecycle });
      await db.exec(DELETE_SQL.join("\n"));
      await engine.crash(db);
      db = await engine.open({ noRecycle });
    } else {
      db = await engine.open({ noRecycle });
      await db.exec(DELETE_SQL.join("\n"));
    }

    let notRemovable: number | undefined;
    const t0 = nowMs();
    if (cand === "D") {
      const fresh = engine.at(`${root0}.rebuild`);
      await engine.copyTo(db, fresh);
      await db.close();
      rmSync(engine.dir, { recursive: true, force: true });
      renameSync(fresh.dir, engine.dir);
      if (engine.name === "postgres") engine = engine.at(engine.dir);
    } else {
      // `blocker`: another session holds a snapshot through the cleanup (the check below must
      // then report dead rows it could not remove).
      const release =
        steps.has("blocker") && engine.holdSnapshot ? await engine.holdSnapshot() : undefined;
      await cleanup(cand, steps, db);
      // `verify`: the success check the store would make, VACUUM's own report on pg_statistic.
      if (steps.has("verify") && engine.vacuumVerbose) {
        const report = await engine.vacuumVerbose("pg_statistic");
        const m = /(\d+) are dead but not yet removable/.exec(report);
        notRemovable = m ? Number(m[1]) : Number.NaN;
      }
      release?.();
      await db.close();
    }
    cleanTimes.push(Math.round(nowMs() - t0));

    const post = search(engine.root(), all);
    const postByClass = byClass(post.hits);
    const hit = Object.values(postByClass).some((n) => n > 0);
    // Find out what the hit file is: before anything else touches the directory (a fresh start
    // would run recovery and checkpoints), copy the facts; the file list is taken from pg_class.
    const rel = hit && engine.relfiles ? await engine.relfiles() : undefined;
    const lsHit = hit ? post.detail.map((d) => d.file) : [];
    perRound.push({
      round: r,
      positive: posByClass,
      after: postByClass,
      ...(notRemovable !== undefined ? { notRemovable } : {}),
      files: post.files,
      bytes: post.bytes,
      ...(hit
        ? {
            hitFiles: [...new Set(post.hits.map((h) => `${h[0]} (${h[1]})`))],
            hitDetail: post.detail,
            relfiles: rel,
            hitFilesNow: lsHit,
          }
        : {}),
    });
    console.log(
      JSON.stringify({
        tag,
        round: r,
        positive: posByClass,
        after: postByClass,
        cleanMs: cleanTimes[r - 1],
      }),
    );
  }

  const positiveOk = CLASSES.every((c) =>
    perRound.every((x) => ((x as { positive: Record<Class, number> }).positive[c] ?? 0) >= 1),
  );
  const zero = perRound.every((x) =>
    Object.values((x as { after: Record<string, number> }).after).every((n) => n === 0),
  );
  const file = join(outDir("exp7"), `${tag}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ tag, backend, candidate: cand, steps: [...steps], crash, rounds, rows, positiveControlHoldsEveryRound: positiveOk, zeroHitsEveryRound: zero, cleanMs: cleanTimes, perRound, platform: process.platform, node: process.version }, null, 2)}\n`,
  );
  console.log(JSON.stringify({ tag, positiveOk, zero, file }));
  if (statSync(file).size === 0) process.exit(1);
}

await main();
