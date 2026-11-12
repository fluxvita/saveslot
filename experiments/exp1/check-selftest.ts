// Experiment 1: shows that each check of check.ts fails on the damage it exists to catch.
//
//   node --conditions=source experiments/exp1/check-selftest.ts

import { join } from "node:path";
import type { Tx } from "@fluxvita/saveslot-kernel";
import { PgliteBackend } from "@fluxvita/saveslot-store-pglite";
import { scratch } from "../lib/util.ts";
import { type CheckResult, check, DDL, GENESIS, writeOne } from "./workload.ts";

const backend = new PgliteBackend({ durability: "pglite-default", contrib: ["amcheck"] });

async function run(name: string, confirmed: number, damage: (tx: Tx) => Promise<unknown>) {
  const s = await backend.open(
    { kind: "pglite", dir: join(scratch("exp1-selftest"), "t") },
    { create: true },
  );
  await s.write((tx) => tx.exec(DDL));
  let h = GENESIS;
  for (let n = 1; n <= 20; n++) h = await s.write((tx) => writeOne(tx, n, h));
  await s.write(damage);
  const r: CheckResult = await check(s, confirmed);
  await s.close();
  const failedOn = Object.entries(r)
    .filter(([k, v]) =>
      k === "amcheckErrors"
        ? (v as unknown[]).length > 0
        : v === true || (typeof v === "number" && k !== "maxN" && k !== "confirmed" && v > 0),
    )
    .map(([k]) => k);
  console.log(JSON.stringify({ case: name, failedOn }));
}

await run("intact", 20, async () => {});
await run("confirmed commit missing", 21, async () => {});
await run("gap in event numbers", 20, (tx) => tx.query("DELETE FROM exp_events WHERE n = 7"));
await run("broken hash chain", 20, (tx) =>
  tx.query("UPDATE exp_events SET prev_hash = $1 WHERE n = 9", [GENESIS]),
);
await run("content checksum mismatch", 20, (tx) =>
  tx.query("UPDATE exp_content SET body = 'x' || substr(body, 2) WHERE n = 3"),
);
await run("tables disagree", 20, (tx) => tx.query("UPDATE exp_business SET total = total - 1"));
process.exit(0);
