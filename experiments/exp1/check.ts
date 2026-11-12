// Experiment 1 checker: reopens the store after a fault and runs checks 1–6. One JSON line.
//
//   node --conditions=source experiments/exp1/check.ts --dir <tenant dir> --durability host-fsync --confirmed <n>
//
// Exit code 0 when every check passed, 1 otherwise.

import { type Durability, PgliteBackend } from "@fluxvita/saveslot-store-pglite";
import { arg, nowMs } from "../lib/util.ts";
import { check } from "./workload.ts";

const dir = arg("dir");
const durability = arg("durability") as Durability;
const confirmed = Number(arg("confirmed"));

const t0 = nowMs();
let store: Awaited<ReturnType<PgliteBackend["open"]>>;
try {
  store = await new PgliteBackend({ durability, contrib: ["amcheck"] }).open(
    { kind: "pglite", dir },
    {},
  );
} catch (e) {
  process.stdout.write(`${JSON.stringify({ ok: false, opened: false, error: String(e) })}\n`);
  process.exit(1);
}
const openMs = nowMs() - t0;
const r = await check(store, confirmed);
await store.close();
const ok =
  !r.lostConfirmed &&
  r.gaps === 0 &&
  r.badChain === 0 &&
  r.badChecksum === 0 &&
  r.tablesInconsistent === 0 &&
  r.amcheckErrors.length === 0;
process.stdout.write(`${JSON.stringify({ ok, opened: true, openMs, ...r })}\n`);
process.exit(ok ? 0 : 1);
