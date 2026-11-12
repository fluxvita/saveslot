// A contender or holder process for experiment 8. One JSON line per event on stdout.
//
//   child.ts contend <candidate> <dir> [store]   ready → waits for "go <startAt>" → one attempt;
//                                                 a winner holds until stdin closes
//   child.ts retry   <candidate> <dir> [store]   ready → waits for "go <killAt>" → retries every
//                                                 5 ms until it gets the lock; reports the delay
//   child.ts hold    <candidate> <dir>           takes the lock and holds it until killed
//
// With "store", the attempt is a full PgliteBackend.open (lock, PGlite start, epoch) instead of
// the lock alone.

import { mkdirSync } from "node:fs";
import { createInterface } from "node:readline";
import {
  type DirLockHandle,
  PgliteBackend,
  PgliteStoreError,
} from "@fluxvita/saveslot-store-pglite";
import { nowMs } from "../lib/util.ts";
import { candidate } from "./candidates.ts";

const [mode, cand, dirArg, store] = process.argv.slice(2);
if (!mode || !cand || !dirArg) throw new Error("usage: child.ts <mode> <candidate> <dir> [store]");
const dir: string = dirArg;
const lock = candidate(cand);
const backend = new PgliteBackend({ lock });
mkdirSync(dir, { recursive: true });

const say = (o: object) => process.stdout.write(`${JSON.stringify(o)}\n`);

async function attempt(): Promise<{ release: () => Promise<void> }> {
  if (store) {
    const s = await backend.open({ kind: "pglite", dir }, { create: true });
    return { release: () => s.close() };
  }
  const h: DirLockHandle = await lock.acquire(dir);
  return { release: () => h.release() };
}

const stdin = createInterface({ input: process.stdin });
const nextLine = () => new Promise<string>((r) => stdin.once("line", r));
const stdinClosed = new Promise<void>((r) => stdin.once("close", r));

if (mode === "hold") {
  await attempt();
  say({ held: true });
  setInterval(() => {}, 1 << 30);
} else if (mode === "contend") {
  say({ ready: true });
  const startAt = Number((await nextLine()).split(" ")[1]);
  while (nowMs() < startAt) {}
  try {
    const h = await attempt();
    say({ acquired: true, at: nowMs() });
    await stdinClosed;
    await h.release();
  } catch (e) {
    say({ acquired: false, code: e instanceof PgliteStoreError ? e.code : String(e) });
  }
  process.exit(0);
} else if (mode === "retry") {
  say({ ready: true });
  const killAt = Number((await nextLine()).split(" ")[1]);
  let attempts = 0;
  for (;;) {
    attempts++;
    try {
      const h = await attempt();
      say({ acquired: true, elapsedMs: nowMs() - killAt, attempts });
      await h.release();
      break;
    } catch (e) {
      if (!(e instanceof PgliteStoreError && e.code === "store_locked")) {
        say({ acquired: false, error: String(e), elapsedMs: nowMs() - killAt });
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }
  process.exit(0);
} else {
  throw new Error(`unknown mode ${mode}`);
}
