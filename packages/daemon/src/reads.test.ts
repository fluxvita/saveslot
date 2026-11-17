// The local tenant's buffered reads (02-architecture §7 «read_log 的持久性»), against a real store:
// `flushLocalReads` writes them, and closing the tenant writes what is left before the storage
// closes. (The daemon calls the first on a timer and the second when it stops.)

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeLocalTenant,
  flushLocalReads,
  type LocalTenant,
  openLocalTenant,
} from "@fluxvita/saveslot-service";
import { createLocalHome, recordTestRead, writtenReads } from "@fluxvita/saveslot-service/testing";

import { afterAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-reads-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function open(home: string): Promise<LocalTenant> {
  const r = await openLocalTenant({ home, backend: testBackend() });
  if (!r.ok) throw new Error(r.failure);
  return r.tenant;
}

describe("the local tenant's reads", () => {
  it("are written by flushLocalReads, and by closing the tenant", async () => {
    const home = join(root, "h");
    await createLocalHome(home, testBackend());
    const t = await open(home);
    const r1 = recordTestRead(t);
    const r2 = recordTestRead(t);
    expect(await flushLocalReads(t)).toBe(2);
    expect(await writtenReads(t.store)).toEqual([r1, r2]);
    expect(await flushLocalReads(t)).toBe(0);
    const r3 = recordTestRead(t);
    expect(await closeLocalTenant(t)).toEqual({});

    const again = await open(home);
    try {
      expect(await writtenReads(again.store)).toEqual([r1, r2, r3]);
    } finally {
      await closeLocalTenant(again);
    }
  }, 60_000);
});
