// Experiment 1 writer: runs the workload transaction in a loop on a store and reports each committed
// event number to the observer, waiting for the observer's "ok" before the next transaction.
//
//   node --conditions=source experiments/exp1/writer.ts --dir <tenant dir> --durability host-fsync
//        --observer 127.0.0.1:<port> [--mode normal|midtx] [--max <n>] [--trace]
//
// --mode midtx   after the inserts of a transaction, print {"intx": n} and wait 100 ms before
//                returning from the callback (so a kill lands between the writes and COMMIT)
// --trace        print one line per commit with timestamps and the host fsync counters (step 1)
// --delay <ms>   wait this long after "ready" before the first transaction (to attach a tracer)
// SIGUSR2        stop the DB Worker abruptly (like a crash, without killing the process), reopen
//                the store in this process, close it and exit ("terminate the worker" variant)

import { connect } from "node:net";
import { createInterface } from "node:readline";
import {
  type Durability,
  PgliteBackend,
  type PgliteTenantStore,
} from "@fluxvita/saveslot-store-pglite";
import { arg, nowMs, sleep } from "../lib/util.ts";
import { DDL, tail, writeOne } from "./workload.ts";

const dir = arg("dir");
const durability = arg("durability") as Durability;
const [obsHost, obsPort] = arg("observer").split(":");
const mode = arg("mode", "normal");
const maxN = Number(arg("max", "0"));
const trace = process.argv.includes("--trace");
const delay = Number(arg("delay", "0"));
const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

const backend = new PgliteBackend({ durability });
let store: PgliteTenantStore = await backend.open({ kind: "pglite", dir }, { create: true });
await store.write((tx) => tx.exec(DDL));
let { n, hash } = await store.read(tail);
say({ ready: true, pid: process.pid, from: n, epoch: store.epoch });

const sock = connect(Number(obsPort), obsHost);
await new Promise<void>((r, j) => {
  sock.once("connect", () => r());
  sock.once("error", j);
});
const replies = createInterface({ input: sock });
const nextReply = () => new Promise<string>((r) => replies.once("line", r));
if (delay > 0) await sleep(delay);

let terminating = false;
process.on("SIGUSR2", () => {
  terminating = true;
  void store.terminateWorker();
});

while (maxN === 0 || n < maxN) {
  const next = n + 1;
  const t0 = nowMs();
  const before = trace ? await store.hostSyncStats() : undefined;
  let newHash: string;
  try {
    newHash = await store.write(async (tx) => {
      const h = await writeOne(tx, next, hash);
      if (mode === "midtx") {
        say({ intx: next });
        await sleep(100);
      }
      return h;
    });
  } catch (e) {
    if (!terminating) throw e;
    break;
  }
  const committedAt = nowMs();
  n = next;
  hash = newHash;
  sock.write(`ack ${n}\n`);
  await nextReply();
  if (trace && before) {
    const after = await store.hostSyncStats();
    say({
      n,
      commitStart: t0,
      committedAt,
      ackedAt: nowMs(),
      walFsyncs: after.wal - before.wal,
      allFsyncs: after.total - before.total,
    });
  }
  if (terminating) break;
}

if (terminating) {
  // The worker was stopped mid-flight. Reopen in the same process: the lock must be free again.
  await store.close();
  store = await backend.open({ kind: "pglite", dir }, {});
  say({ reopenedInProcess: true, epoch: store.epoch, lastAcked: n });
}
await store.close();
sock.end();
say({ done: true, lastAcked: n });
process.exit(0);
