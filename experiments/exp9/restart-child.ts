// The child of restart.ts.
//
//   restart-child.ts write <dir> <home.json>   opens the store, says {"writing": true} after the
//                                               first write, and writes until killed
//   restart-child.ts open  <dir> <home.json>   opens the store, reads the catalog, reports
//                                               {"ready_ms", "catalog_ms", "fsync_total", "fsync_wal"}

import { readFileSync } from "node:fs";
import { backend, Clock, type Home, op } from "./lib.ts";

const [mode, dir, homeFile] = process.argv.slice(2) as [string, string, string];
const { tenant, user } = JSON.parse(readFileSync(homeFile, "utf8")) as {
  tenant: string;
  user: string;
};
const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
const clock = new Clock(Date.now());

const t0 = performance.now();
const store = await backend.open({ kind: "pglite", dir }, {});
const h: Home = { dir, tenant, user, store };
if (mode === "open") {
  const ready = performance.now() - t0;
  await op.catalog(h, clock, {});
  const catalog = performance.now() - t0;
  const s = await store.hostSyncStats();
  say({ ready_ms: ready, catalog_ms: catalog, fsync_total: s.total, fsync_wal: s.wal });
  await store.close();
} else {
  for (let i = 0; ; i++) {
    await op.write(h, clock, {
      sv: 1,
      evidence: [{ kind: "tool_result", text: `w${i}` }],
      ops: [{ intent: "insert", table: "crash.t0", set: { v: `w${i}` } }],
    });
    if (i === 0) say({ writing: true });
  }
}
