// Experiment 1, step 2 (pre-dev-w0-experiments, experiment 1, step 2): fault rounds on one data
// directory.
//
//   node --conditions=source experiments/exp1/kill-loop.ts --variant kill --durability host-fsync --rounds 1000
//
// Variants:
//   kill    start the writer → wait 0.5–5 s → SIGKILL the writer process
//   worker  start the writer → wait until it is ready, then 0.5–5 s → stop only its DB Worker
//           (SIGUSR2; the writer reopens the store in the same process)
//   midtx   start the writer in midtx mode → wait 0.5–5 s → SIGKILL as soon as the writer is
//           inside a transaction (writes sent, COMMIT not sent)
// Each round then runs the checker (a separate process) with the observer's confirmed number, and
// continues with the same directory. Rounds: experiments/out/exp1/<variant>-<durability>.jsonl;
// summary: …-summary.json. Stops at the first failed round unless --keep-going.

import { appendFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { arg, exited, Lines, node, nowMs, outDir, scratch, sleep, summary } from "../lib/util.ts";

const variant = arg("variant");
const durability = arg("durability");
const rounds = Number(arg("rounds"));
const keepGoing = process.argv.includes("--keep-going");
const dir = process.argv.includes("--dir") ? arg("dir") : join(scratch("exp1"), "tenant");
const out = outDir("exp1");
const log = join(out, `${variant}-${durability}.jsonl`);
writeFileSync(log, "");

const observer = node("exp1/observer.ts");
const ol = new Lines(observer);
const { port } = (await ol.next()) as { port: number };

async function confirmed(): Promise<number> {
  const s = connect(port, "127.0.0.1");
  await new Promise<void>((r) => s.once("connect", () => r()));
  const rl = createInterface({ input: s });
  rl.on("error", () => {});
  s.write("max\n");
  const line = await new Promise<string>((r) => rl.once("line", r));
  s.end();
  return Number(line);
}

// Create the storage once before the rounds: with "host-fsync" creation syncs every file of the new
// data directory and can take longer than the shortest wait; a round killed during creation leaves
// no storage (creation is atomic) and would not test anything else.
{
  const w = node("exp1/writer.ts", [
    "--dir",
    dir,
    "--durability",
    durability,
    "--observer",
    `127.0.0.1:${port}`,
    "--max",
    "1",
  ]);
  await exited(w);
}

const randomWait = () => 500 + Math.random() * 4500;
let failed = 0;
const openMs: number[] = [];
const committedPerRound: number[] = [];
let prevConfirmed = 0;

for (let r = 1; r <= rounds; r++) {
  const writer = node("exp1/writer.ts", [
    "--dir",
    dir,
    "--durability",
    durability,
    "--observer",
    `127.0.0.1:${port}`,
    "--mode",
    variant === "midtx" ? "midtx" : "normal",
  ]);
  const wl = new Lines(writer);
  const spawnedAt = nowMs();
  let readyAt: number | undefined;
  let note = "";

  const drain = async (until?: (m: Record<string, unknown>) => boolean) => {
    for (;;) {
      const m = (await wl.next(600_000)) as Record<string, unknown> | undefined;
      if (m === undefined) return undefined;
      if (m["ready"]) readyAt = nowMs();
      if (until?.(m)) return m;
    }
  };

  if (variant === "kill") {
    void drain();
    await sleep(randomWait());
    note = readyAt ? "killed while writing" : "killed during open";
    writer.kill("SIGKILL");
  } else if (variant === "midtx") {
    const wait = randomWait();
    const pending = drain((m) => m["intx"] !== undefined && nowMs() - spawnedAt >= wait);
    const m = await pending;
    writer.kill("SIGKILL");
    note = m ? `killed inside transaction ${m["intx"]}` : "writer ended before a transaction";
  } else if (variant === "worker") {
    await drain((m) => m["ready"] === true);
    await sleep(randomWait());
    const done = drain((m) => m["done"] === true || m["reopenedInProcess"] === true);
    writer.kill("SIGUSR2");
    const m = await done;
    note = m?.["reopenedInProcess"]
      ? "worker stopped; reopened in process"
      : `writer: ${JSON.stringify(m)}`;
    if (!m?.["reopenedInProcess"]) failed++;
  } else {
    throw new Error(`unknown variant ${variant}`);
  }
  await exited(writer);

  const conf = await confirmed();
  const checker = node("exp1/check.ts", [
    "--dir",
    dir,
    "--durability",
    durability,
    "--confirmed",
    String(conf),
  ]);
  const res = (await new Lines(checker).next(600_000)) as Record<string, unknown>;
  await exited(checker);
  const ok = res?.["ok"] === true;
  if (!ok) failed++;
  if (typeof res?.["openMs"] === "number") openMs.push(res["openMs"] as number);
  committedPerRound.push(conf - prevConfirmed);
  prevConfirmed = conf;
  const line = {
    round: r,
    note,
    confirmed: conf,
    ...res,
    amcheckErrors: (res?.["amcheckErrors"] as unknown[])?.slice(0, 5),
  };
  appendFileSync(log, `${JSON.stringify(line)}\n`);
  if (r % 25 === 0 || !ok) console.log(JSON.stringify({ round: r, ok, confirmed: conf, failed }));
  if (!ok && !keepGoing) break;
}

observer.kill("SIGTERM");
const s = {
  variant,
  durability,
  roundsPlanned: rounds,
  roundsRun: committedPerRound.length,
  failedRounds: failed,
  finalConfirmed: prevConfirmed,
  confirmedCommitsPerRound: summary(committedPerRound),
  checkerOpenMs: summary(openMs),
  dir,
  platform: process.platform,
  node: process.version,
};
writeFileSync(
  join(out, `${variant}-${durability}-summary.json`),
  `${JSON.stringify(s, null, 2)}\n`,
);
console.log(JSON.stringify(s, null, 2));
process.exit(failed ? 1 : 0);
