// Experiment 8, supplementary probe: can an old PGlite instance see an ownership epoch written by a
// new instance on the same directory (the situation after a lost lock)? Two PGlite instances in
// one process, no lock (this is exactly what the lock exists to prevent; the directory is thrown
// away afterwards).
//
//   node --conditions=source experiments/exp8/stale-epoch-probe.ts

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { outDir, scratch } from "../lib/util.ts";

const dir = join(scratch("exp8-stale-epoch"), "pgdata");
const read = async (pg: PGlite) =>
  Number(
    (await pg.query<{ value: string }>("SELECT value FROM meta WHERE key = 'ownership_epoch'"))
      .rows[0]?.value,
  );

const old = await PGlite.create({ dataDir: dir });
await old.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
await old.exec("INSERT INTO meta VALUES ('ownership_epoch', '1')");
const oldBefore = await read(old);

const fresh = await PGlite.create({ dataDir: dir });
await fresh.exec("UPDATE meta SET value = '2' WHERE key = 'ownership_epoch'");
const freshSees = await read(fresh);

const oldAfter = await read(old);
const oldAfterForUpdate = await old.transaction(async (tx) =>
  Number(
    (
      await tx.query<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'ownership_epoch' FOR UPDATE",
      )
    ).rows[0]?.value,
  ),
);
const result = {
  oldInstanceBefore: oldBefore,
  newInstanceAfterIncrement: freshSees,
  oldInstanceAfter: oldAfter,
  oldInstanceAfterForUpdate: oldAfterForUpdate,
  oldInstanceSeesTakeover: oldAfterForUpdate === freshSees,
};
writeFileSync(
  join(outDir("exp8"), "stale-epoch-probe.json"),
  `${JSON.stringify(result, null, 2)}\n`,
);
console.log(JSON.stringify(result, null, 2));
process.exit(0);
