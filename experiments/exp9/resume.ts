// Experiment 9: measure shape C again on a store a run left behind (run.ts died in a measurement).
//
//   node --conditions=source experiments/exp9/resume.ts --dir <the run's --dir> --point <n>
//        [--rerun 10] [--sample 21] [--seed 7] [--min-free-gib 40]
//
// Opens <dir>/data as it is: the tenant and user from the store, the row count from the table.
// New rows continue the generator's sequence. --rerun: that many build requests (1,000 rows each)
// are written and timed first, standing in for the build batches whose timings were lost or
// disturbed. --sample: rows read back through `query` (evenly spread over the rows written, by
// the generator's day and minute) to stand in for the run's correction sample, which lived in
// memory; the middle one is the history target. Then measure.ts at --point, each step with a
// start and an end line. The data directory is kept.

import { loadRsql } from "../../packages/kernel/src/rules/index.ts";
import { arg } from "../lib/util.ts";
import { backend, Clock, type Home, op } from "./lib.ts";
import { measure, type Run, say, step, time } from "./measure.ts";
import { dayOf, type Receipt, ShapeC } from "./shapes.ts";

const GIB = 1024 ** 3;
const parent = arg("dir");
const point = Number(arg("point"));
const rerun = Number(arg("rerun", "10"));
const samples = Number(arg("sample", "21"));
const seed = Number(arg("seed", "7"));
const minFree = Number(arg("min-free-gib", "40")) * GIB;
const dir = `${parent}/data`;

const store = await step("open", () => backend.open({ kind: "pglite", dir }, {}));
// The service loads the rule evaluator when it opens a tenant (ops/open-tenant.ts); run.ts got it
// from its schema draft. Writes to a slot with derived tables need it.
await loadRsql();
const found = await step("read_store_state", () =>
  store.read(async (tx) => {
    const meta = await tx.query<{ value: string }>(`SELECT value FROM meta WHERE key = 'tenant_id'`);
    const head = await tx.query<{ actor: string; at: string }>(
      `SELECT actor, header::json->>'at' AS at FROM events ORDER BY seq DESC LIMIT 1`,
    );
    const n = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM t_t1_v1`);
    return {
      tenant: meta.rows[0]?.value as string,
      user: head.rows[0]?.actor as string,
      lastAt: head.rows[0]?.at as string,
      rows: Number(n.rows[0]?.n),
    };
  }),
);
say({ resumed: found });

const h: Home = { dir, tenant: found.tenant, user: found.user, store };
// The run's clock stepped a millisecond a call; carry on a second after its last event.
const clock = new Clock(Date.parse(found.lastAt) + 1000);
const shape = new ShapeC(seed, found.rows);

async function put(params: Record<string, unknown>): Promise<number> {
  const [ms, r] = await time(() => op.write(h, clock, params));
  shape.seen(params, r as unknown as Receipt);
  return ms;
}
const run: Run = { h, clock, shape, parent, minFree, replay: true, put, rows: found.rows };

await step("rebuild_sample", async () => {
  for (let k = 0; k < samples; k++) {
    const i = Math.floor((k * (found.rows - 1)) / (samples - 1) / 100) * 100;
    const r = (await op.query(h, clock, {
      table: "sensor.readings",
      where: [
        { field: "day", op: "=", value: dayOf("2016-01-01", Math.floor(i / 1440)) },
        { field: "minute", op: "=", value: String(i % 1440) },
      ],
    })) as { rows: { row: string; ver: string }[] };
    const x = r.rows[0];
    if (x === undefined) throw new Error(`row ${i} not found`);
    shape.sampled(x.row, x.ver);
  }
});

const buildMs: number[] = [];
await step("write_build_rerun", async () => {
  for (let i = 0; i < rerun; i++) {
    const { params, rows } = shape.build(1000);
    const ms = await put(params);
    buildMs.push(ms);
    run.rows += rows;
    say({ rerun_batch: i + 1, rows: run.rows, ms: Math.round(ms) });
  }
});

await measure(run, point, buildMs);
await h.store.close();
say({ done: true });
