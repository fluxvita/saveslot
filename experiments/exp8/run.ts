// Experiment 8 runner (pre-dev-w0-experiments 实验 8). Results: experiments/out/exp8/*.json.
//
//   node --conditions=source experiments/exp8/run.ts contend --candidate A [--rounds 100] [--procs 10] [--store]
//   node --conditions=source experiments/exp8/run.ts kill    --candidate A [--rounds 100] [--store]
//   node --conditions=source experiments/exp8/run.ts hang    --candidate A [--stop-seconds 30]
//   node --conditions=source experiments/exp8/run.ts same-process --candidate A

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PgliteBackend, PgliteStoreError } from "@fluxvita/saveslot-store-pglite";
import { arg, exited, Lines, node, nowMs, outDir, scratch, sleep, summary } from "../lib/util.ts";
import { candidate } from "./candidates.ts";

const cmd = process.argv[2];
const cand = arg("candidate");
const store = process.argv.includes("--store");
const tag = `${cmd}-${cand}${store ? "-store" : ""}`;
const out = (o: object) => {
  const file = join(outDir("exp8"), `${tag}.json`);
  writeFileSync(
    file,
    `${JSON.stringify({ ...o, platform: process.platform, node: process.version }, null, 2)}\n`,
  );
  console.log(
    JSON.stringify(
      o,
      (k, v) => (k === "rounds" && Array.isArray(v) ? `[${v.length} rounds]` : v),
      1,
    ),
  );
  console.log(`written ${file}`);
};

type Msg = Record<string, unknown> | undefined;

async function contend() {
  const rounds = Number(arg("rounds", "100"));
  const procs = Number(arg("procs", "10"));
  const results: { round: number; acquired: number; refused: Record<string, number> }[] = [];
  let violations = 0;
  for (let r = 1; r <= rounds; r++) {
    const dir = join(scratch("exp8-contend"), "tenant");
    const kids = Array.from({ length: procs }, () =>
      node("exp8/child.ts", ["contend", cand, dir, ...(store ? ["store"] : [])]),
    );
    const lines = kids.map((k) => new Lines(k));
    for (const l of lines) {
      const m = (await l.next()) as Msg;
      if (!m?.["ready"]) throw new Error(`child not ready: ${JSON.stringify(m)}`);
    }
    const startAt = nowMs() + 100;
    for (const k of kids) k.stdin?.write(`go ${startAt}\n`);
    const outcomes = (await Promise.all(lines.map((l) => l.next(60_000)))) as Msg[];
    const acquired = outcomes.filter((o) => o?.["acquired"] === true).length;
    const refused: Record<string, number> = {};
    for (const o of outcomes) {
      if (o?.["acquired"] === false) {
        const c = String(o["code"]);
        refused[c] = (refused[c] ?? 0) + 1;
      }
    }
    if (acquired !== 1 || (refused["store_locked"] ?? 0) !== procs - 1) violations++;
    results.push({ round: r, acquired, refused });
    for (const k of kids) k.stdin?.end();
    await Promise.all(kids.map(exited));
    if (acquired !== 1) console.log(`round ${r}: ${acquired} holders`, outcomes);
  }
  out({
    experiment: "contend",
    candidate: cand,
    store,
    attempts: rounds * procs,
    roundsWithExactlyOneHolder: results.filter((x) => x.acquired === 1).length,
    roundsWithTwoOrMoreHolders: results.filter((x) => x.acquired > 1).length,
    roundsWithNoHolder: results.filter((x) => x.acquired === 0).length,
    roundsViolating: violations,
    rounds: results,
  });
}

async function kill() {
  const rounds = Number(arg("rounds", "100"));
  const delays: number[] = [];
  const failures: unknown[] = [];
  const dir = join(scratch("exp8-kill"), "tenant");
  for (let r = 1; r <= rounds; r++) {
    const holder = store
      ? node("exp8/writer.ts", [
          "--candidate",
          cand,
          "--dir",
          dir,
          "--who",
          "holder",
          "--every",
          "20",
        ])
      : node("exp8/child.ts", ["hold", cand, dir]);
    const hl = new Lines(holder);
    const first = (await hl.next()) as Msg;
    if (!(first?.["held"] || first?.["opened"]))
      throw new Error(`holder: ${JSON.stringify(first)}`);
    if (store) await hl.next(); // at least one committed write
    const contender = node("exp8/child.ts", ["retry", cand, dir, ...(store ? ["store"] : [])]);
    const cl = new Lines(contender);
    await cl.next();
    await sleep(50 + Math.random() * 200);
    const killAt = nowMs();
    holder.kill("SIGKILL");
    contender.stdin?.write(`go ${killAt}\n`);
    const res = (await cl.next(60_000)) as Msg;
    if (res?.["acquired"] === true) delays.push(Number(res["elapsedMs"]));
    else failures.push({ round: r, res });
    await Promise.all([exited(holder), exited(contender)]);
  }
  out({
    experiment: "kill",
    candidate: cand,
    store,
    rounds,
    succeeded: delays.length,
    failures,
    reopenDelayMs: summary(delays),
    within1s: delays.filter((d) => d <= 1000).length,
  });
}

async function hang() {
  const stopSeconds = Number(arg("stop-seconds", "30"));
  const dir = join(scratch("exp8-hang"), "tenant");
  const holder = node("exp8/writer.ts", ["--candidate", cand, "--dir", dir, "--who", "holder"]);
  const hl = new Lines(holder);
  const holderLog: Msg[] = [];
  const pump = async (l: Lines, log: Msg[]) => {
    for (;;) {
      const m = (await l.next(600_000)) as Msg;
      if (m === undefined) return;
      log.push(m);
    }
  };
  const holderDone = pump(hl, holderLog);
  while (holderLog.filter((m) => m?.["w"]).length < 10) await sleep(50);

  holder.kill("SIGSTOP");
  const stoppedAt = nowMs();
  const lastAckBeforeStop = Math.max(...holderLog.map((m) => Number(m?.["w"] ?? 0)));
  const contender = node("exp8/writer.ts", [
    "--candidate",
    cand,
    "--dir",
    dir,
    "--who",
    "contender",
    "--retry-open",
    "--every",
    "200",
  ]);
  const contenderLog: Msg[] = [];
  const contenderDone = pump(new Lines(contender), contenderLog);
  await sleep(stopSeconds * 1000);
  const resumedAt = nowMs();
  holder.kill("SIGCONT");
  // Let the holder run for a while after resuming.
  await sleep(3000);
  holder.stdin?.end();
  await exited(holder);
  await holderDone;
  contender.stdin?.end();
  await exited(contender);
  await contenderDone;

  // Inspect the data with the store itself (amcheck included).
  const s = await new PgliteBackend({ contrib: ["amcheck"] }).open({ kind: "pglite", dir }, {});
  const rows = await s.read((tx) =>
    tx.query<{ who: string; n: number; afterResume: number; maxI: number }>(
      `SELECT who, count(*)::int AS n, count(*) FILTER (WHERE at >= $1)::int AS "afterResume",
              max(i)::int AS "maxI" FROM hang_rows GROUP BY who ORDER BY who`,
      [Math.floor(resumedAt)],
    ),
  );
  const amcheck = await s.write(async (tx) => {
    await tx.exec("CREATE EXTENSION IF NOT EXISTS amcheck");
    const heap = await tx.query<{ c: number }>(
      "SELECT count(*)::int AS c FROM verify_heapam('hang_rows')",
    );
    return { heapCorruptions: heap.rows[0]?.c };
  });
  await s.close();

  const contenderOpened = contenderLog.find((m) => m?.["opened"]);
  const holderAfterResume = holderLog.filter((m) => Number(m?.["at"] ?? 0) >= resumedAt);
  out({
    experiment: "hang",
    candidate: cand,
    stopSeconds,
    lastAckBeforeStop,
    contenderOpenRefusals: contenderLog.filter((m) => m?.["openRefused"]).length,
    contenderOpenedAfterMs: contenderOpened ? Number(contenderOpened["at"]) - stoppedAt : null,
    contenderEpoch: contenderOpened?.["epoch"] ?? null,
    holderFirstEventAfterResume: holderAfterResume[0] ?? null,
    holderCommitsAfterResume: holderAfterResume.filter((m) => m?.["w"]).length,
    rowsByWho: rows.rows,
    amcheck,
  });
}

async function sameProcess() {
  const dir = join(scratch("exp8-same"), "tenant");
  const lock = candidate(cand);
  await import("node:fs").then((fs) => fs.mkdirSync(dir, { recursive: true }));
  const h = await lock.acquire(dir);
  let second: string;
  try {
    const h2 = await lock.acquire(dir);
    second = "acquired";
    await h2.release();
  } catch (e) {
    second = e instanceof PgliteStoreError ? e.code : String(e);
  }
  await h.release();
  const h3 = await lock.acquire(dir);
  await h3.release();
  out({
    experiment: "same-process",
    candidate: cand,
    secondAcquireInSameProcess: second,
    afterRelease: "acquired",
  });
}

switch (cmd) {
  case "contend":
    await contend();
    break;
  case "kill":
    await kill();
    break;
  case "hang":
    await hang();
    break;
  case "same-process":
    await sameProcess();
    break;
  default:
    throw new Error(`unknown command ${cmd}`);
}
process.exit(0);
