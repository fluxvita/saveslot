// Test fixture run as a separate process: opens the PGlite data directory <dir> with host fsync,
// creates <tables> tables of one row each, writes one line ("ready") on stdout, and waits to be
// killed. A SIGKILL then leaves the directory as a crash does.
//   node --conditions=source crash-writer.fixture.ts <dir> <tables>

import { PGlite } from "@electric-sql/pglite";
import { nodeFs, startParams } from "../durability.ts";

const [dir, tables] = process.argv.slice(2);
if (!dir || !tables) throw new Error("usage: crash-writer.fixture.ts <dir> <tables>");

const pg = await PGlite.create({
  fs: nodeFs(dir, "host-fsync"),
  startParams: startParams("host-fsync"),
});
for (let i = 0; i < Number(tables); i++) {
  await pg.exec(
    `CREATE TABLE t${i} (id int PRIMARY KEY, note text); INSERT INTO t${i} VALUES (1, 'n');`,
  );
}
process.stdout.write("ready\n");
await new Promise(() => {});
