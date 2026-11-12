// A full-store writer for experiment 8: opens the store with a candidate lock (retrying while the
// lock is held, if asked) and inserts one row every `--every` ms until stdin closes.
//
//   writer.ts --candidate A --dir <dir> --who holder [--retry-open] [--every 100]
//
// Output (JSON lines): {opened, epoch} · {w: i, at} per committed row ·
// {refused: code, at} for a write the store refused · {openRefused: code} per refused open.

import { mkdirSync } from "node:fs";
import { PgliteBackend, PgliteStoreError } from "@fluxvita/saveslot-store-pglite";
import { arg, nowMs, sleep } from "../lib/util.ts";
import { candidate } from "./candidates.ts";

const dir = arg("dir");
const who = arg("who");
const every = Number(arg("every", "100"));
const retryOpen = process.argv.includes("--retry-open");
const backend = new PgliteBackend({ lock: candidate(arg("candidate")) });
const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);
mkdirSync(dir, { recursive: true });

let stop = false;
process.stdin.resume();
process.stdin.on("end", () => {
  stop = true;
});

let store: Awaited<ReturnType<PgliteBackend["open"]>> | undefined;
while (!store && !stop) {
  try {
    store = await backend.open({ kind: "pglite", dir }, { create: true });
  } catch (e) {
    const code = e instanceof PgliteStoreError ? e.code : String(e);
    say({ openRefused: code, at: nowMs() });
    if (!retryOpen) process.exit(1);
    await sleep(500);
  }
}
if (!store) process.exit(0);
say({ opened: true, epoch: store.epoch, at: nowMs() });
await store.write((tx) =>
  tx.exec("CREATE TABLE IF NOT EXISTS hang_rows (who TEXT, i INT, at DOUBLE PRECISION)"),
);

let i = 0;
while (!stop) {
  i++;
  try {
    await store.write((tx) =>
      tx.query("INSERT INTO hang_rows VALUES ($1, $2, $3)", [who, i, Date.now()]),
    );
    say({ w: i, at: nowMs() });
  } catch (e) {
    say({ refused: e instanceof PgliteStoreError ? e.code : String(e), i, at: nowMs() });
    break;
  }
  await sleep(every);
}
await store.close();
process.exit(0);
