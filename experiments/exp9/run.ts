// Experiment 9 runner (capacity, local PGlite side).
//
//   node --conditions=source experiments/exp9/run.ts --shape A|B|C|C-state --points <n,n,...>
//        --dir <empty parent dir for the data> [--correct 0.01] [--seed 7] [--min-free-gib 40]
//        [--max-hours h]   stop growing after h hours, measure where it got to, end the run
//        [--replay false]  no replay from empty at any point
//
// Points count rows (C), segments (C-state) or events (A, B). One store grows through the points
// in order; at each point the measurements run, then it grows on. Before growing to the next
// point, the free disk space after the growth (estimated from the bytes per unit so far, plus
// 20 %) must stay at or above --min-free-gib, or the run stops there. The replay from empty runs
// at a point only if a copy of the store fits under the same rule. --correct: after every 100k
// rows, one correction to that share of them (C-corrected). One JSON line per point on stdout,
// with a start and an end line around each measurement step (measure.ts); the data directory is
// deleted at the end, and kept when a step fails.

import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { templateDocument } from "../../packages/cli/src/templates.ts";
import { arg } from "../lib/util.ts";
import { Clock, createHome, dirBytes, eventCount, type Home, op } from "./lib.ts";
import { freeBytes, measure, type Run, say, time } from "./measure.ts";
import { type Receipt, type Shape, ShapeA, ShapeB, ShapeC, ShapeCState } from "./shapes.ts";

const GIB = 1024 ** 3;
const shapeName = arg("shape", "C");
const points = arg("points")
  .split(",")
  .map((s) => Number(s));
const parent = arg("dir");
const correctShare = Number(arg("correct", "0"));
const seed = Number(arg("seed", "7"));
const minFree = Number(arg("min-free-gib", "40")) * GIB;
const maxMs = Number(arg("max-hours", "0")) * 3_600_000;
const replay = arg("replay", "true") !== "false";
const started = performance.now();

const shape: Shape = (() => {
  switch (shapeName) {
    case "A":
      return new ShapeA(
        seed,
        [
          ["running", "health"],
          ["spending", "ledger"],
          ["budget", "plan"],
        ].map(
          ([t, s]) => templateDocument(t as string, s as string, "Asia/Shanghai")?.doc as never,
        ),
      );
    case "B":
      return new ShapeB(seed);
    case "C":
      return new ShapeC(seed);
    case "C-state":
      return new ShapeCState(seed);
    default:
      throw new Error(`unknown shape ${shapeName}`);
  }
})();

mkdirSync(parent, { recursive: true });
const dir = join(parent, "data");
const clock = new Clock();
const h: Home = await createHome(dir, clock);
for (const d of shape.documents) await op.draft(h, clock, d);

/** Writes one request and lets the shape see its receipt. */
async function put(params: Record<string, unknown>): Promise<number> {
  const [ms, r] = await time(() => op.write(h, clock, params));
  shape.seen(params, r as unknown as Receipt);
  return ms;
}
const run: Run = { h, clock, shape, parent, minFree, replay, put, rows: 0 };

const units = async () => (shape.unit === "rows" ? run.rows : await eventCount(h));
let buildMs: number[] = [];
let sinceCorrect = 0;
for (const point of points) {
  const done = await units();
  if (done > 0) {
    const need = (dirBytes(dir) / done) * (point - done) * 1.2;
    if (freeBytes(parent) - need < minFree) {
      say({
        shape: shape.name,
        point,
        stopped: "growth would leave less than the minimum free space",
        free_gib: freeBytes(parent) / GIB,
        need_gib: need / GIB,
      });
      break;
    }
  }
  let u = done;
  let requests = 0;
  while (u < point) {
    if (maxMs > 0 && performance.now() - started > maxMs) break;
    const { params, rows: added } = shape.build(point - u);
    const ms = await put(params);
    run.rows += added;
    sinceCorrect += added;
    requests++;
    buildMs.push(ms);
    if (correctShare > 0 && sinceCorrect >= 100_000) {
      for (let c = 0; c < (sinceCorrect * correctShare) / 1000; c++) {
        const p = shape.correct(1000);
        if (p) await put(p);
      }
      sinceCorrect = 0;
    }
    u = shape.unit === "rows" ? run.rows : requests % 20 === 0 ? await eventCount(h) : u + added;
    if (shape.unit === "events" && u >= point) u = await eventCount(h);
    if (requests % 100 === 0)
      say({
        progress: u,
        rows: run.rows,
        last_ms: Math.round(ms),
        free_gib: freeBytes(parent) / GIB,
        rss_mib: process.memoryUsage().rss / 1048576,
      });
  }
  if (u < point) {
    say({
      shape: shape.name,
      point,
      stopped: "time cap",
      reached: u,
      hours: (performance.now() - started) / 3_600_000,
    });
    await measure(run, u, buildMs);
    break;
  }
  await measure(run, point, buildMs);
  buildMs = [];
}
await h.store.close();
rmSync(dir, { recursive: true, force: true });
say({
  done: true,
  commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
});
