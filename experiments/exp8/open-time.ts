// Experiment 8, the baseline for `kill --store`: how long a clean full open (lock, PGlite start,
// epoch) takes on this machine, with no crash to recover from. Each open is a fresh process on the
// same directory; the first one creates the database.
//
//   node --conditions=source experiments/exp8/open-time.ts [--rounds 20]
//
// Results: experiments/out/exp8/open-time.json.

import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { arg, EXPERIMENTS, outDir, scratch, summary } from "../lib/util.ts";

const rounds = Number(arg("rounds", "20"));
const dir = join(scratch("exp8-open-time"), "tenant");
const openMs: number[] = [];
for (let r = 1; r <= rounds; r++) {
  const p = spawnSync(
    process.execPath,
    ["--conditions=source", "--no-warnings", join(EXPERIMENTS, "exp8", "open-once.ts"), dir],
    { encoding: "utf8" },
  );
  if (p.status !== 0) throw new Error(`round ${r}: ${p.stderr}`);
  const last = p.stdout.trim().split("\n").at(-1) ?? "";
  openMs.push(Number(JSON.parse(last).openMs));
}
const o = {
  experiment: "open-time",
  rounds,
  createMs: openMs[0],
  reopenMs: summary(openMs.slice(1)),
  platform: process.platform,
  node: process.version,
};
const file = join(outDir("exp8"), "open-time.json");
writeFileSync(file, `${JSON.stringify(o, null, 2)}\n`);
console.log(JSON.stringify(o, null, 1));
console.log(`written ${file}`);
