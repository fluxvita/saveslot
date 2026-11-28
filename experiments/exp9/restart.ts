// Experiment 9, restart after a crash against the number of files (the base-table count).
//
//   node --conditions=source experiments/exp9/restart.ts --dir <empty parent dir> [--tables 0,10,100,1000]
//        [--rounds 5]
//
// For each table count: a new store with that many base tables (in slots of up to 20 tables, one
// row written to each), then `--rounds` times: a child opens the store and writes in a loop, is
// killed with SIGKILL mid-write, and a new child opens the store again and reads the catalog. The
// second child reports the time from the start of the open to the store being ready, to the first
// catalog, and the host fsync calls made during the open (the store's own counter, which wraps
// Node's fsync: no root needed). Files are counted under the data directory. One JSON line per
// table count; the data directory is deleted after each.

import { spawn } from "node:child_process";
import { readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { arg } from "../lib/util.ts";
import { Clock, createHome, op, percentiles } from "./lib.ts";

const parent = arg("dir");
const counts = arg("tables", "0,10,100,1000").split(",").map(Number);
const rounds = Number(arg("rounds", "5"));
const PER_SLOT = 20;
const CHILD = join(import.meta.dirname, "restart-child.ts");

const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

function files(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true }))
    n += e.isDirectory() ? files(join(dir, e.name)) : 1;
  return n;
}

const tableDoc = (i: number) => ({
  name: `t${i}`,
  kind: "base",
  description: `table ${i}`,
  time: { type: "none" },
  fields: [{ name: "v", type: "text", required: true, description: "a value" }],
});

/** Runs the child; resolves with its JSON lines once `until` returns true for one, or it exits. */
function child(args: string[], until: (o: Record<string, unknown>) => boolean) {
  const c = spawn(process.execPath, ["--conditions=source", CHILD, ...args], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines: Record<string, unknown>[] = [];
  const done = new Promise<Record<string, unknown>[]>((resolve) => {
    const rl = createInterface({ input: c.stdout });
    rl.on("line", (l) => {
      const o = JSON.parse(l) as Record<string, unknown>;
      lines.push(o);
      if (until(o)) resolve(lines);
    });
    c.on("exit", () => resolve(lines));
  });
  return { c, done };
}

for (const n of counts) {
  const dir = join(parent, `data-${n}`);
  rmSync(dir, { recursive: true, force: true });
  const clock = new Clock();
  const h = await createHome(dir, clock);
  // The table the writing child writes to, outside the count.
  await op.draft(h, clock, {
    slot: "crash",
    base_version: null,
    timezone: "Asia/Shanghai",
    tables: [tableDoc(0)],
  });
  for (let s = 0; s * PER_SLOT < n; s++) {
    const k = Math.min(PER_SLOT, n - s * PER_SLOT);
    const tables = Array.from({ length: k }, (_, j) => tableDoc(s * PER_SLOT + j));
    await op.draft(h, clock, {
      slot: `s${s}`,
      base_version: null,
      timezone: "Asia/Shanghai",
      tables,
    });
    await op.write(h, clock, {
      sv: 1,
      evidence: [{ kind: "tool_result", text: "seed" }],
      ops: tables.map((t) => ({ intent: "insert", table: `s${s}.${t.name}`, set: { v: "x" } })),
    });
  }
  await h.store.close();
  writeFileSync(join(parent, "home.json"), JSON.stringify({ tenant: h.tenant, user: h.user }));
  const fileCount = files(dir);
  const ready: number[] = [];
  const toCatalog: number[] = [];
  const fsyncs: number[] = [];
  const walFsyncs: number[] = [];
  for (let r = 0; r < rounds; r++) {
    const w = child(["write", dir, join(parent, "home.json")], (o) => o["writing"] === true);
    await w.done;
    await new Promise((res) => setTimeout(res, 300));
    w.c.kill("SIGKILL");
    await new Promise((res) => w.c.once("exit", res));
    const o = child(["open", dir, join(parent, "home.json")], (x) => "ready_ms" in x);
    const [res] = (await o.done).filter((x) => "ready_ms" in x);
    if (o.c.exitCode === null) await new Promise((res) => o.c.once("exit", res));
    if (!res) throw new Error(`round ${r}: the reopening child reported nothing`);
    ready.push(res["ready_ms"] as number);
    toCatalog.push(res["catalog_ms"] as number);
    fsyncs.push(res["fsync_total"] as number);
    walFsyncs.push(res["fsync_wal"] as number);
  }
  say({
    tables: n,
    files: fileCount,
    ready_ms: percentiles(ready),
    to_first_catalog_ms: percentiles(toCatalog),
    fsync_total: fsyncs,
    fsync_wal: walFsyncs,
  });
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
}
