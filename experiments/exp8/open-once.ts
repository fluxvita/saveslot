// One clean PgliteBackend.open and close on <dir>; prints the open time. Started by open-time.ts.

import { PgliteBackend } from "@fluxvita/saveslot-store-pglite";

const dir = process.argv[2];
if (!dir) throw new Error("usage: open-once.ts <dir>");
const t0 = performance.now();
const s = await new PgliteBackend().open({ kind: "pglite", dir }, { create: true });
const t1 = performance.now();
await s.close();
console.log(JSON.stringify({ openMs: t1 - t0 }));
