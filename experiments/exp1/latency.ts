// Experiment 1, commit latency: the workload transaction N times on a fresh store, measuring the
// time from `store.write(…)` to its resolution (no observer round trip).
//
//   node --conditions=source experiments/exp1/latency.ts --durability host-fsync [--n 10000] [--dir <parent>]

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Durability, PgliteBackend } from "@fluxvita/saveslot-store-pglite";
import { arg, nowMs, outDir, scratch, summary } from "../lib/util.ts";
import { DDL, GENESIS, writeOne } from "./workload.ts";

const durability = arg("durability") as Durability;
const n = Number(arg("n", "10000"));
const parent = process.argv.includes("--dir") ? arg("dir") : scratch("exp1-latency");
const store = await new PgliteBackend({ durability }).open(
  { kind: "pglite", dir: join(parent, `tenant-${durability}`) },
  { create: true },
);
await store.write((tx) => tx.exec(DDL));
const before = await store.hostSyncStats();
const lat: number[] = [];
let hash = GENESIS;
const t0 = nowMs();
for (let i = 1; i <= n; i++) {
  const s = nowMs();
  hash = await store.write((tx) => writeOne(tx, i, hash));
  lat.push(nowMs() - s);
}
const wall = nowMs() - t0;
const after = await store.hostSyncStats();
await store.close();
const result = {
  durability,
  transactions: n,
  latencyMs: summary(lat),
  meanMs: Math.round((lat.reduce((a, b) => a + b, 0) / n) * 1000) / 1000,
  wallSeconds: Math.round(wall) / 1000,
  hostFsyncs: { wal: after.wal - before.wal, total: after.total - before.total },
  dirParent: parent,
  platform: process.platform,
  node: process.version,
};
writeFileSync(
  join(outDir("exp1"), `latency-${durability}.json`),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
