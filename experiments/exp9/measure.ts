// Experiment 9: the measurements at one point, shared by run.ts and resume.ts. Every step writes a
// line when it starts and when it ends (`{"step", "phase": "start" | "end", "at", "ms"}`), so a run
// that dies part way shows which step it died in; a step that throws writes `"phase": "failed"` with
// the error as the store gave it (message, code, sqlState, stack) and the run ends there.

import { rmSync, statfsSync } from "node:fs";
import { join } from "node:path";
import {
  type Clock,
  dirBytes,
  eventCount,
  type Home,
  op,
  percentiles,
  relationSizes,
  reopen,
  replayFromEmpty,
} from "./lib.ts";
import type { Shape } from "./shapes.ts";

const GIB = 1024 ** 3;

export interface Run {
  readonly h: Home;
  readonly clock: Clock;
  readonly shape: Shape;
  /** Parent of the data directory; the replay copy goes beside it. */
  readonly parent: string;
  readonly minFree: number;
  /** false: no replay from empty at any point. */
  readonly replay: boolean;
  /** Writes one request, lets the shape see its receipt, returns milliseconds. */
  readonly put: (params: Record<string, unknown>) => Promise<number>;
  rows: number;
}

export const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

export const freeBytes = (dir: string) => {
  const s = statfsSync(dir);
  return s.bavail * s.bsize;
};

export const time = async <T>(f: () => Promise<T>): Promise<[number, T]> => {
  const t0 = performance.now();
  const r = await f();
  return [performance.now() - t0, r];
};

/** Thrown after a failed step has been written out. */
export class StepFailed extends Error {}

/** Runs one step between a start line and an end (or failed) line. */
export async function step<T>(name: string, f: () => Promise<T>): Promise<T> {
  say({ step: name, phase: "start", at: new Date().toISOString() });
  const t0 = performance.now();
  try {
    const r = await f();
    say({ step: name, phase: "end", at: new Date().toISOString(), ms: performance.now() - t0 });
    return r;
  } catch (e) {
    const x = e as { message?: string; code?: string; sqlState?: string; stack?: string };
    say({
      step: name,
      phase: "failed",
      at: new Date().toISOString(),
      ms: performance.now() - t0,
      message: x.message ?? String(e),
      code: x.code,
      sqlState: x.sqlState,
      stack: x.stack,
      rss_mib: process.memoryUsage().rss / 1048576,
    });
    throw new StepFailed(name);
  }
}

export async function measure(run: Run, point: number, buildMs: number[]) {
  const { h, clock, shape, put } = run;
  const dir = h.dir;
  const out: Record<string, unknown> = {
    shape: shape.name,
    point,
    rows: run.rows,
    at: new Date().toISOString(),
  };
  out["write_build"] = percentiles(buildMs);
  const ins: number[] = [];
  const cor: number[] = [];
  const hundred: number[] = [];
  await step("write_1+correct_1", async () => {
    for (let i = 0; i < 20; i++) {
      ins.push(await put(shape.insert(1)));
      run.rows += 1;
      const c = shape.correct(1);
      if (c) cor.push(await put(c));
    }
  });
  await step("write_100", async () => {
    for (let i = 0; i < 10; i++) {
      hundred.push(await put(shape.insert(100)));
      run.rows += 100;
    }
  });
  out["write_1"] = percentiles(ins);
  out["correct_1"] = percentiles(cor);
  out["write_100"] = percentiles(hundred);
  for (const [name, params] of Object.entries(shape.reads())) {
    const ms: number[] = [];
    await step(`read_${name}`, async () => {
      for (let i = 0; i < 10; i++) ms.push((await time(() => op.query(h, clock, params)))[0]);
    });
    out[`read_${name}`] = percentiles(ms);
  }
  const target = shape.historyTarget();
  if (target) {
    const half = Math.floor((await step("event_count", () => eventCount(h))) / 2);
    const ms: number[] = [];
    await step("read_history_as_of", async () => {
      for (let i = 0; i < 10; i++)
        ms.push(
          (await time(() => op.history(h, clock, { mode: "as_of", ...target, as_of: half })))[0],
        );
    });
    out["read_history_as_of"] = percentiles(ms);
  }
  out["events"] = await step("event_count", () => eventCount(h));
  out["dir_bytes"] = dirBytes(dir);
  out["pg_wal_bytes"] = dirBytes(join(dir, "pgdata", "pg_wal"));
  out["relations"] = await step("relation_sizes", () => relationSizes(h));
  out["bytes_per_row"] = (out["dir_bytes"] as number) / run.rows;
  out["events_per_row"] = (out["events"] as number) / run.rows;
  // Cold start to the first catalog, 5 times (in process; the OS page cache is not dropped).
  const cold: number[] = [];
  await step("cold_start_to_catalog", async () => {
    for (let i = 0; i < 5; i++) {
      const open = await reopen(h);
      const [cat] = await time(() => op.catalog(h, clock, {}));
      cold.push(open + cat);
    }
  });
  out["cold_start_to_catalog"] = percentiles(cold);
  out["peak_rss_mib"] = process.resourceUsage().maxRSS / 1024;
  const size = out["dir_bytes"] as number;
  if (!run.replay) out["replay_skipped"] = "--replay false";
  else if (freeBytes(run.parent) - size * 1.2 >= run.minFree) {
    const to = join(run.parent, "replay");
    rmSync(to, { recursive: true, force: true });
    try {
      out["replay_from_empty_ms"] = await step("replay_from_empty", () => replayFromEmpty(h, to));
      out["replay_dir_bytes"] = dirBytes(to);
    } catch (e) {
      out["replay_failed"] = String((e as Error).stack ?? e);
    }
    rmSync(to, { recursive: true, force: true });
  } else out["replay_skipped"] = "a copy would leave less than the minimum free space";
  out["free_gib_after"] = freeBytes(run.parent) / GIB;
  say(out);
}
