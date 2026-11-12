// Test fixture run as a separate process: opens a store and reports the outcome as one JSON line
// on stdout. With "hold", it keeps the store open until stdin closes.
//   node --conditions=source open-store.fixture.ts <dir> [hold]

import { PgliteBackend } from "../backend.ts";
import { PgliteStoreError } from "../errors.ts";

const [dir, mode] = process.argv.slice(2);
if (!dir) throw new Error("usage: open-store.fixture.ts <dir> [hold]");

try {
  const store = await new PgliteBackend().open({ kind: "pglite", dir }, { create: true });
  process.stdout.write(`${JSON.stringify({ opened: true, epoch: store.epoch })}\n`);
  if (mode === "hold") {
    process.stdin.resume();
    await new Promise((r) => process.stdin.on("end", r));
  }
  await store.close();
} catch (e) {
  const code = e instanceof PgliteStoreError ? e.code : String(e);
  process.stdout.write(`${JSON.stringify({ opened: false, code })}\n`);
}
